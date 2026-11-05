// Instant inbox delivery over Supabase Realtime broadcast channels.
//
// DESIGN (rebuilt 2026-11-05 — fixes DB-H1, the old design's leak):
//
// The OLD design broadcast the FULL message (text, sender, event,
// attachment URL) on a channel named `inbox:<email>`. That channel
// name is predictable from the email alone, so anyone who knew an
// email could subscribe and read that person's messages live —
// Supabase broadcast channels have no per-user auth by default, and
// the anon key is public by design. That design is NOT shipped.
//
// The NEW design broadcasts ONLY a content-free ping:
//
//   { type: 'message' | 'edited' | 'deleted', id: '<message id>' }
//
// No text, no sender, no event, no attachment name or URL, no names.
// The recipient's inbox treats a ping as "something changed, refetch
// now" and loads the real message through the normal session-
// authenticated GET /api/messages, which enforces participant checks
// server-side. Broadcast is speed, never the only path: if a ping is
// missed (offline, Realtime not configured, send failure), the
// regular poll still picks the message up.
//
// Why a ping and not a per-user unguessable channel token? A token
// channel would need the server to issue and store a 128-bit token
// per user — a new table/migration plus a token-distribution flow —
// and a token minted client-side would be guessable or leakable in
// exactly the way the old channel was. The ping needs no server
// change, no new table, and no token distribution, and it cannot leak
// message content even if the channel is subscribed by a stranger.
//
// RESIDUAL RISK (honest): the channel name is still
// `inbox:<email>`, so anyone who knows the email can subscribe and
// learn WHEN a message event happened for that inbox (activity
// timing) and the opaque message id. The id is useless on its own:
// the message API requires a valid locora_session for a participant,
// and the id reveals no content. If even timing metadata is
// unacceptable later, the fix is a server-issued per-user channel
// token (new table + endpoint) — not a client-side tweak.
//
// Setup (user, in Vercel Production — both are frontend-safe values,
// NOT secrets like the service-role key):
//   VITE_SUPABASE_URL      = the same Supabase project URL
//   VITE_SUPABASE_ANON_KEY = Project Settings -> API -> anon public key
// Without both, getRealtimeClient() returns null and everything below
// is a silent no-op: the inbox keeps working on polling alone.
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
function subscribePing(
  channelName: string,
  onEvent: (event: RealtimeEvent) => void,
  onStatus?: (status: string) => void,
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
export function subscribeToCommunity(
  eventId: string,
  onEvent: (event: RealtimeEvent) => void,
  onStatus?: (status: string) => void,
): () => void {
  if (!eventId) return () => {};
  return subscribePing(`community:${eventId}`, onEvent, onStatus);
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
