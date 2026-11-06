// Instant chat delivery over Supabase Realtime broadcast channels.
//
// DESIGN (2026-11-06 — full-payload private channels; supersedes the
// 2026-11-05 ping-only design for private + event-community chats):
//
// The OLD ping-only design broadcast ONLY {type, id} on guessable
// channels (`inbox:<email>`, `community:<eventId>`). It fixed audit
// finding DB-H1 (no message content on a channel anyone could join),
// but a ping still forced a ~2s refetch, so delivery was never
// instant — and the send path itself took ~2-4s. The ping layer is
// KEPT below (broadcastPing / subscribeToInbox / subscribeToCommunity
// / broadcastToInbox / broadcastToCommunity) for the GLOBAL room,
// which has no bounded member list to fan out to.
//
// The NEW design broadcasts the FULL message payload — but only on
// a PRIVATE channel per user:
//
//   channel = "inbox:" + hex(HMAC-SHA256(SESSION_SECRET,
//       "locora-inbox:" + lowercase(email)))
//
// The HMAC is computed SERVER-side (api/messages.ts
// privateChannelName). The client learns ONLY ITS OWN channel name
// from GET /api/messages?action=channel (session-authenticated) via
// messagesService.getRealtimeChannel(). A client never learns
// another user's channel name, so it cannot subscribe to anyone
// else's live messages — the DB-H1 leak stays fixed, with no new
// table and no token distribution. If SESSION_SECRET ever rotates,
// every channel name changes at once (old subscribers just stop
// receiving — polling is the fallback).
//
// The server broadcasts over Supabase Realtime's REST endpoint
// (POST /realtime/v1/api/broadcast, service-role key) AFTER storing
// the row: private messages to the recipient's + sender's channels,
// event-community messages fanned out to every member's channel in
// ONE batched REST call (rooms over 200 members fall back to a ping
// on the public community channel). The receiver renders the payload
// IMMEDIATELY — no refetch. Polling stays as fallback (3s while
// Realtime is down, 30s safety net while SUBSCRIBED).
//
// Payloads carry NAMES only — never emails or phones (see
// buildRealtimePayload in api/messages.ts): senderEmail /
// recipientEmail are dropped, the reply snapshot drops its
// senderEmail, readBy collapses to seenCount, and a per-recipient
// `own` flag + `threadKey` replace the emails the client used to
// need for thread grouping.
//
// GLOBAL room (/community): any signed-in user may read it, but an
// anonymous stranger must not — and fan-out to "every signed-in
// user" is unbounded. Global therefore stays PING-ONLY on the public
// `community:global` channel (a ping carries no content) + a fast
// refetch via the paginated GET. Typing on global is likewise a
// name-only ping on that channel.
//
// Typing indicators are ephemeral broadcasts on the same private
// channels (private/event community) — sender emits while typing
// (throttled ~2s via POST /api/messages?action=typing), receiver
// shows "X is typing…" and clears after ~3s of silence.
//
// Read receipts: the `read` flag already exists server-side. A
// mark-as-read broadcasts {type:'read', id} to the sender's
// channel, so their ✓ flips to ✓✓ live.
//
// Setup (user, in Vercel Production — both are frontend-safe values,
// NOT secrets like the service-role key):
//   VITE_SUPABASE_URL      = the same Supabase project URL
//   VITE_SUPABASE_ANON_KEY = Project Settings -> API -> anon public key
//   (the dashboard now calls this the "Publishable key")
// Without both, getRealtimeClient() returns null and everything below
// is a silent no-op: the chats keep working on polling alone.
//
// HARD GATE: do NOT set VITE_SUPABASE_* in Vercel until
// supabase-setup.sql has been run in Supabase AND the V-1–V-11
// verification in db-rls-audit.md passes. The anon key is public the
// moment it ships to the browser; until RLS is verified, PostgREST
// access with that key could expose tables. See MESSAGES_SETUP.md.

import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';

// A ping carries an id only — never message content. The `message`
// field from the old design is deliberately absent: broadcastToInbox
// builds its payload from the id alone, so even a caller that passes
// a full message object cannot leak it onto the channel.
export type RealtimeEvent =
  | { type: 'message'; id: string }
  | { type: 'edited'; id: string }
  | { type: 'deleted'; id: string };

// Full-payload events on a user's PRIVATE channel (see header).
// `data` is the whitelisted broadcast payload built server-side by
// buildRealtimePayload: names only, no emails/phones. `own` says
// whether the viewer is the sender; `threadKey` files a private
// message into its thread without any email in the payload.
export interface RealtimeMessage {
  id: string;
  type?: string;
  eventId: string;
  eventTitle?: string;
  senderName: string;
  text: string;
  attachment: { name: string; size: number; type: string; url: string; path: string } | null;
  read: boolean;
  edited: boolean;
  editedAt?: string;
  deletedForEveryone: boolean;
  deletedAt?: string;
  replyToId?: string;
  replySnapshot?: {
    id: string;
    senderName: string;
    text: string;
    attachmentName?: string;
    deleted: boolean;
  };
  createdAt: string;
  own: boolean;
  threadKey?: string;
  seenCount?: number;
}

export type RealtimeFullEvent =
  | { type: 'message'; data: RealtimeMessage }
  | { type: 'edited'; data: RealtimeMessage }
  | { type: 'deleted'; data: RealtimeMessage }
  | { type: 'read'; id: string; seenCount?: number }
  | { type: 'typing'; name: string; eventId?: string; threadKey?: string };

export interface TypingEvent {
  name: string;
  eventId?: string;
  threadKey?: string;
}

let client: SupabaseClient | null | undefined;

export function getRealtimeClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  // import.meta.env exists under Vite; under plain node it does not,
  // so the optional chain keeps node tests from crashing on import.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const url = env?.VITE_SUPABASE_URL;
  const anon = env?.VITE_SUPABASE_ANON_KEY;
  client = url && anon ? createClient(url, anon) : null;
  return client;
}

function channelName(email: string): string {
  return `inbox:${email.toLowerCase()}`;
}

// Subscribe to content-free pings on one channel. Shared by the
// inbox and community channels below; onEvent receives pings only,
// the caller must refetch via the session-authenticated API.
// onTyping (optional) receives name-only typing pings on the same
// channel — used by the global room, where typing carries no
// content and the channel is public by design.
function subscribePing(
  channelName: string,
  onEvent: (event: RealtimeEvent) => void,
  onStatus?: (status: string) => void,
  onTyping?: (event: TypingEvent) => void,
): () => void {
  const sb = getRealtimeClient();
  if (!sb) return () => {};
  const channel: RealtimeChannel = sb.channel(channelName);
  const handlePing = (type: RealtimeEvent['type']) => ({ payload }: { payload?: { id?: unknown } }) => {
    if (typeof payload?.id === 'string' && payload.id) onEvent({ type, id: payload.id } as RealtimeEvent);
  };
  channel
    .on('broadcast', { event: 'message' }, handlePing('message'))
    .on('broadcast', { event: 'edited' }, handlePing('edited'))
    .on('broadcast', { event: 'deleted' }, handlePing('deleted'))
    .on('broadcast', { event: 'typing' }, ({ payload }: { payload?: { name?: unknown; eventId?: unknown; threadKey?: unknown } }) => {
      if (onTyping && typeof payload?.name === 'string' && payload.name) {
        onTyping({
          name: payload.name,
          eventId: typeof payload.eventId === 'string' ? payload.eventId : undefined,
          threadKey: typeof payload.threadKey === 'string' ? payload.threadKey : undefined,
        });
      }
    })
    .subscribe((status) => onStatus?.(status));
  return () => {
    sb.removeChannel(channel);
  };
}

// Subscribe to FULL-payload events on one PRIVATE channel (the
// caller's own, learned from the server — see header). The payload
// is rendered immediately by the caller; no refetch. onEvent
// receives message/edited/deleted payloads, read receipts and
// typing indicators. Returns an unsubscribe function. When the
// client is null (VITE_SUPABASE_* not set) this is a silent no-op
// and the caller keeps polling.
export function subscribeToPrivateChannel(
  privateChannel: string,
  onEvent: (event: RealtimeFullEvent) => void,
  onStatus?: (status: string) => void,
): () => void {
  const sb = getRealtimeClient();
  if (!sb || !privateChannel) return () => {};
  const channel: RealtimeChannel = sb.channel(privateChannel);
  const handleFull = (type: 'message' | 'edited' | 'deleted') => ({ payload }: { payload?: unknown }) => {
    if (payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string') {
      onEvent({ type, data: payload as RealtimeMessage } as RealtimeFullEvent);
    }
  };
  channel
    .on('broadcast', { event: 'message' }, handleFull('message'))
    .on('broadcast', { event: 'edited' }, handleFull('edited'))
    .on('broadcast', { event: 'deleted' }, handleFull('deleted'))
    .on('broadcast', { event: 'read' }, ({ payload }: { payload?: { id?: unknown; seenCount?: unknown } }) => {
      if (payload && typeof payload.id === 'string') {
        onEvent({
          type: 'read',
          id: payload.id,
          seenCount: typeof payload.seenCount === 'number' ? payload.seenCount : undefined,
        });
      }
    })
    .on('broadcast', { event: 'typing' }, ({ payload }: { payload?: { name?: unknown; eventId?: unknown; threadKey?: unknown } }) => {
      if (payload && typeof payload.name === 'string' && payload.name) {
        onEvent({
          type: 'typing',
          name: payload.name,
          eventId: typeof payload.eventId === 'string' ? payload.eventId : undefined,
          threadKey: typeof payload.threadKey === 'string' ? payload.threadKey : undefined,
        });
      }
    })
    .subscribe((status) => onStatus?.(status));
  return () => {
    sb.removeChannel(channel);
  };
}

// Push one content-free ping to one channel. Fire-and-forget safe:
// never throws, never blocks the sender's UI (a stuck subscription
// resolves after 3s at the latest). Only ever called AFTER the
// server call succeeded, so a ping always refers to a genuinely
// stored message — never an optimistic fake.
//
// SECURITY: the payload is built from the id ONLY. Even if a caller
// passes an object with a `message` property, it is dropped here.
async function broadcastPing(channelName: string, event: RealtimeEvent): Promise<void> {
  const sb = getRealtimeClient();
  if (!sb) return;
  const id = typeof event?.id === 'string' ? event.id : '';
  if (!id || !channelName) return;
  try {
    const channel: RealtimeChannel = sb.channel(channelName);
    const payload = { id };
    await new Promise<void>((resolve) => {
      const done = window.setTimeout(resolve, 3000);
      channel.subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        window.clearTimeout(done);
        channel
          .send({ type: 'broadcast', event: event.type, payload })
          .then(() => resolve())
          .catch(() => resolve());
      });
    });
    sb.removeChannel(channel);
  } catch {
    // Broadcast is speed only; the poll picks everything up anyway.
  }
}

// Subscribe the current user's inbox to instant pings. Returns an
// unsubscribe function. onStatus reports 'SUBSCRIBED' when live — the
// page uses it to slow polling to a 30s safety net while Realtime
// works. onEvent receives pings only; the caller must refetch via the
// session-authenticated API — never trust a ping's payload as data.
// NOTE: the inbox now primarily uses subscribeToPrivateChannel
// (full payload, see above); this ping subscription is retained for
// the global-room fallback path and for clients whose channel name
// has not loaded yet.
export function subscribeToInbox(
  email: string,
  onEvent: (event: RealtimeEvent) => void,
  onStatus?: (status: string) => void,
): () => void {
  return subscribePing(channelName(email), onEvent, onStatus);
}

// Subscribe to one event's community-chat pings. Channel:
//   community:<eventId>
// The event id is public (Discover lists it), so the channel name
// leaks nothing a stranger could not already see — and the ping
// itself carries only an opaque message id. A non-member subscriber
// learns WHEN a community message was posted, and nothing else: the
// refetch goes through the session-authenticated community GET,
// which enforces membership server-side. Same hard gate as the
// inbox: without VITE_SUPABASE_* this is a silent no-op and the
// community chat keeps working on 3s polling.
// This is now the GLOBAL room's delivery path (ping-only by design)
// plus the fallback for event rooms over 200 members; event rooms
// primarily use the private-channel fan-out (see header). onTyping
// receives name-only typing pings on the same channel.
export function subscribeToCommunity(
  eventId: string,
  onEvent: (event: RealtimeEvent) => void,
  onStatus?: (status: string) => void,
  onTyping?: (event: TypingEvent) => void,
): () => void {
  if (!eventId) return () => {};
  return subscribePing(`community:${eventId}`, onEvent, onStatus, onTyping);
}

// Push one content-free ping to the recipient's inbox channel.
export async function broadcastToInbox(
  recipientEmail: string,
  event: RealtimeEvent,
): Promise<void> {
  if (!recipientEmail) return;
  return broadcastPing(channelName(recipientEmail), event);
}

// Push one content-free ping to an event's community channel, so
// every member subscribed to that event refetches immediately.
// Same id-only rule as broadcastToInbox: no text, no sender, no
// event title, no attachment name or URL on the channel.
export async function broadcastToCommunity(
  eventId: string,
  event: RealtimeEvent,
): Promise<void> {
  if (!eventId) return;
  return broadcastPing(`community:${eventId}`, event);
}
