// SECURITY FIX — P2-3/P2-4: this service no longer sends userEmail /
// senderEmail / editorEmail / recipientEmail as identity. The server
// derives identity from the locora_session cookie. Caller arguments
// are kept for call-site compatibility but are NOT sent. For a first
// message to an organiser, send organizerId (see MessagesPage) and let
// the server resolve the recipient email from the stored event.
import { apiClient, ApiError } from './api-client';

// Private attendee <-> organizer messages (see api/messages.ts).
//
// Deliberately NO localStorage fallback here, unlike registrations:
// a message that only lives in one browser would look "sent" while the
// other person never receives it. If the API is down or the table is
// missing, sends throw and the UI says so instead of faking success.
// Reads likewise return only what the server has.

export interface MessageAttachment {
  name: string;
  size: number;
  type: string;
  url: string;
  path: string;
}

export interface ReplySnapshot {
  id: string;
  senderEmail: string;
  senderName?: string;
  text: string;
  attachmentName?: string;
  deleted?: boolean;
}

export interface EventMessage {
  id: string;
  // Row kind in the messages table: absent for private messages,
  // "community" for group-chat rows. The private inbox filters
  // community rows out (server-side, and defensively in
  // getMessages below); the community chat shows only them.
  type?: string;
  eventId: string;
  eventTitle?: string;
  senderEmail: string;
  senderName?: string;
  recipientEmail: string;
  // Server-derived counterparty name for the thread list: without it,
  // a sender-side thread showed the viewer's OWN name (the senderName
  // was the only name stored). Falls back to the legacy senderName
  // logic for rows written before this field existed.
  recipientName?: string;
  text?: string;
  attachment?: MessageAttachment | null;
  read?: boolean;
  edited?: boolean;
  editedAt?: string;
  hiddenFor?: string[];
  // Delete-for-everyone is now a tombstone, not a row deletion (the
  // public attachment URL used to keep serving after the row vanished).
  deletedForEveryone?: boolean;
  deletedAt?: string;
  // Reply quote: frozen server-side at send time (see api/messages.ts
  // buildReplySnapshot). The snapshot is the quote's display data —
  // never the full quoted text, never URLs. If the quoted message is
  // deleted later, the server scrubs the snapshot to text:"" with
  // deleted:true instead of removing the reply.
  replyToId?: string;
  replySnapshot?: ReplySnapshot;
  createdAt: string;
  // Community read state, server-derived (never emails): how many
  // members have seen this message, and whether I have. Private
  // messages use `read` instead.
  seenCount?: number;
  seenByMe?: boolean;
  // Realtime broadcast payloads (private channels) carry these so
  // the receiver can file + render without any email in the payload:
  // `own` (am I the sender) and the thread key for private chats.
  own?: boolean;
  threadKey?: string;
}

export interface MessageThread {
  key: string;
  eventId: string;
  eventTitle: string;
  otherEmail: string;
  otherName: string;
  messages: EventMessage[];
  lastAt: string;
  unread: number;
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const ALLOWED_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'gif', 'webp',
  'mp4', 'webm', 'mov',
  'pdf',
  'doc', 'docx',
  'xls', 'xlsx', 'xlsm',
];

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One thread per (event, attendee, organizer): the key is the event
// plus both participants' emails, sorted so either side computes the
// same key for the same conversation.
export function threadKey(eventId: string, a: string, b: string): string {
  const [first, second] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `${eventId}|${first}|${second}`;
}

// Opaque thread routing key for Realtime payloads — the same
// function as `threadKeyHash` in api/messages.ts (keep the two in
// sync). The payload must never carry raw emails (DB-H1), so the
// key is `eventId|hash(sorted pair)` instead of `eventId|a|b`.
// cyrb53 is a small deterministic hash, NOT cryptographic — it
// only files a payload into a thread inside an already-private
// channel. `threadKey` above stays for local-only thread identity
// (selected thread, grouping); it is never sent over the wire.
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function threadKeyHash(eventId: string, a: string, b: string): string {
  const pair = [a.toLowerCase().trim(), b.toLowerCase().trim()].sort().join('|');
  return `${eventId}|${cyrb53(pair).toString(16)}`;
}

export function groupThreads(messages: EventMessage[], meEmail: string): MessageThread[] {
  const me = meEmail.toLowerCase();
  const byKey = new Map<string, MessageThread>();
  for (const m of messages) {
    const otherEmail = m.senderEmail.toLowerCase() === me ? m.recipientEmail : m.senderEmail;
    const otherName =
      m.senderEmail.toLowerCase() === me
        ? m.recipientName || m.senderName || m.recipientEmail
        : m.senderName || m.senderEmail;
    const key = threadKey(m.eventId, m.senderEmail, m.recipientEmail);
    const thread = byKey.get(key) || {
      key,
      eventId: m.eventId,
      eventTitle: m.eventTitle || 'Event',
      otherEmail,
      otherName,
      messages: [],
      lastAt: '',
      unread: 0,
    };
    thread.messages.push(m);
    if ((m.createdAt || '') > (thread.lastAt || '')) thread.lastAt = m.createdAt;
    if (m.recipientEmail.toLowerCase() === me && !m.read) thread.unread += 1;
    byKey.set(key, thread);
  }
  const threads = [...byKey.values()];
  for (const t of threads) {
    t.messages.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  }
  threads.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  return threads;
}

function extensionOf(fileName: string): string {
  const parts = fileName.split('.');
  if (parts.length < 2) return '';
  return (parts.pop() || '').toLowerCase();
}

// Returns an error string, or null when the file may be sent.
export function validateAttachment(file: File): string | null {
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'File must be no bigger than 20MB.';
  const ext = extensionOf(file.name);
  // iPhone photos default to HEIC, which is not in the allowlist:
  // say so plainly at pick time instead of the generic message.
  if (ext === 'heic' || ext === 'heif') {
    return "iPhone HEIC photos aren't supported — send JPG/PNG instead (Photos → Share → Save as JPG, or switch the camera to Most Compatible).";
  }
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return 'File type not allowed — video, image, PDF, Word or spreadsheet only.';
  }
  return null;
}

// ---- Shared chat UI helpers (used by MessagesPage + CommunityChat) ----

// Day separator label for a message date: Today / Yesterday / date.
export function dayLabel(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOf(now) - startOf(d)) / (24 * 60 * 60 * 1000));
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

// Time only (no date) for a bubble: grouped timestamps show the date
// once, as a separator — not repeated on every bubble.
export function fmtChatTime(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Scroll guard: auto-scroll only when the user is already near the
// bottom (within 120px). Reading older history must never be yanked
// away by a new message arriving.
export function isNearBottom(el: HTMLElement | null, thresholdPx = 120): boolean {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
}

// Reconcile "stored but response lost" sends (2026-11-06): a send can
// reach the server and be stored, yet the client sees a network
// failure ("Failed to fetch") and marks the bubble failed — while the
// real copy arrives on the next poll / refetch / Realtime event. The
// server DOES store the idempotencyKey on the row, but
// stripMessageForViewer() deletes it for every viewer (it is
// bearer-ish — a recipient could reuse it), so the client CANNOT
// match on it. Match instead on sender + exact text + attachment
// name inside a tight 60s window around the temp bubble's createdAt
// (temp time is the client clock; 60s absorbs clock skew). Only
// FAILED bubbles are ever dropped — in-flight ones still await their
// own response. A dropped bubble is always represented by the
// matching server row, so no message is lost, and it is never shown
// twice.
export function reconcileFailedPending<
  T extends {
    failed?: boolean;
    senderEmail?: string;
    text?: string;
    attachment?: { name?: string } | null;
    createdAt?: string;
  },
>(
  pending: T[],
  serverMessages: Array<{
    senderEmail?: string;
    text?: string;
    attachment?: { name?: string } | null;
    createdAt?: string;
  }>,
  meEmail: string,
): T[] {
  const me = (meEmail || '').toLowerCase();
  if (!me || pending.length === 0 || serverMessages.length === 0) return pending;
  const used = new Set<number>();
  return pending.filter((p) => {
    if (!p.failed) return true;
    if ((p.senderEmail || '').toLowerCase() !== me) return true;
    const pText = (p.text || '').trim();
    const pName = p.attachment?.name || '';
    const pMs = Date.parse(p.createdAt || '');
    for (let i = 0; i < serverMessages.length; i++) {
      if (used.has(i)) continue;
      const s = serverMessages[i];
      if ((s.senderEmail || '').toLowerCase() !== me) continue;
      if ((s.text || '').trim() !== pText) continue;
      if ((s.attachment?.name || '') !== pName) continue;
      const sMs = Date.parse(s.createdAt || '');
      if (!Number.isFinite(pMs) || !Number.isFinite(sMs)) continue;
      if (Math.abs(sMs - pMs) > 60 * 1000) continue;
      used.add(i);
      return false;
    }
    return true;
  });
}

export interface SendMessageInput {
  eventId: string;
  senderEmail?: string;
  senderName?: string;
  recipientEmail?: string;
  organizerId?: string;
  text?: string;
  attachment?: { name: string; size: number; type: string; path: string };
  // Optional quote target: the server validates it (same event +
  // same thread pair, not deleted) and builds the frozen snapshot.
  // A caller-supplied snapshot is never sent or trusted.
  replyToId?: string;
  // Stable per draft: a retry reuses the same key and the server
  // returns the already-created row instead of a duplicate message.
  idempotencyKey?: string;
}

// Cached private Realtime channel name for this session (see
// getRealtimeChannel in the service below). `undefined` = not
// fetched yet; null = Realtime is not configured.
let cachedRealtimeChannel: string | null | undefined;

export const messagesService = {
  async getMessages(_userEmail?: string): Promise<EventMessage[]> {
    const data = await apiClient.request<{ messages: EventMessage[] }>('/messages');
    const list = Array.isArray(data.messages) ? data.messages : [];
    // Defense in depth: the server already excludes community rows
    // from the private inbox, but a community row must never render
    // as a private thread even if a server filter is ever missed —
    // its recipient is the "community:<eventId>" marker, not a user.
    return list.filter((m) => m.type !== 'community');
  },

  // One page of the private inbox (newest `limit`, default 50).
  // `before` pages backwards (older than a createdAt cursor),
  // `since` fetches only rows newer than a createdAt floor — the
  // polls use `since` + a client-side id dedupe, so a poll no
  // longer re-downloads the whole history. No options = the old
  // full-list behaviour (the server keeps that for compatibility).
  async getMessagesPage(opts?: {
    limit?: number;
    before?: string;
    since?: string;
  }): Promise<{ messages: EventMessage[]; hasMore: boolean }> {
    const data = await apiClient.request<{ messages: EventMessage[]; hasMore?: boolean }>('/messages', {
      params: {
        limit: opts?.limit,
        before: opts?.before,
        since: opts?.since,
      },
    });
    const list = Array.isArray(data.messages) ? data.messages : [];
    return {
      messages: list.filter((m) => m.type !== 'community'),
      hasMore: data.hasMore === true,
    };
  },

  // My private Realtime channel name (HMAC, server-issued — see
  // realtime-service.ts). Cached for the session: the name is
  // deterministic per user, so one fetch is enough. Null while
  // Realtime is not configured (VITE_SUPABASE_* / SESSION_SECRET
  // missing) — callers then stay on polling.
  async getRealtimeChannel(): Promise<string | null> {
    if (cachedRealtimeChannel !== undefined) return cachedRealtimeChannel;
    try {
      const data = await apiClient.request<{ realtimeChannel?: string | null }>('/messages', {
        params: { action: 'channel' },
      });
      cachedRealtimeChannel =
        typeof data.realtimeChannel === 'string' && data.realtimeChannel ? data.realtimeChannel : null;
    } catch {
      cachedRealtimeChannel = null;
    }
    return cachedRealtimeChannel;
  },

  // Returns null on failure so callers can keep the previous count:
  // the old code returned 0 on any error, so a transient failure
  // silently cleared a real unread badge.
  async getUnreadCount(_userEmail?: string): Promise<number | null> {
    try {
      const data = await apiClient.request<{ count: number }>('/messages', {
        params: { unreadCount: 1 },
      });
      return typeof data.count === 'number' ? data.count : 0;
    } catch {
      return null;
    }
  },

  async sendMessage(input: SendMessageInput): Promise<EventMessage> {
    // Identity (sender) is the session, never the input. organizerId,
    // when present, lets the server resolve the recipient from the
    // stored event (P2-4); recipientEmail is only sent as a fallback
    // for existing threads, and the server still validates it.
    const { senderEmail: _s, ...rest } = input as any;
    const data = await apiClient.request<{ message: EventMessage }>('/messages', {
      method: 'POST',
      body: JSON.stringify(rest),
    });
    return data.message;
  },

  // "Delete for me": hides the message for this user only, any time.
  async hideMessage(id: string, _userEmail?: string): Promise<void> {
    await apiClient.request('/messages', {
      method: 'POST',
      body: JSON.stringify({ action: 'hide', id }),
    });
  },

  // "Delete for everyone": tombstones the row (text + attachment
  // cleared, deletedForEveryone flag set) within a 24h window — the
  // server enforces both, and verifies the Storage object is really
  // gone before tombstoning, so a public attachment URL can never
  // outlive its message.
  async deleteForEveryone(id: string, _userEmail?: string): Promise<void> {
    await apiClient.request('/messages', {
      params: { id },
      method: 'DELETE',
    });
  },

  // Block / unblock a thread counterparty (server stores a block row
  // in the messages table; blocked threads refuse new messages both
  // ways until the blocker unblocks).
  async blockUser(eventId: string, blockedEmail: string): Promise<void> {
    await apiClient.request('/messages', {
      method: 'POST',
      body: JSON.stringify({ action: 'block', eventId, blockedEmail }),
    });
  },

  async unblockUser(eventId: string, blockedEmail: string): Promise<void> {
    await apiClient.request('/messages', {
      method: 'POST',
      body: JSON.stringify({ action: 'unblock', eventId, blockedEmail }),
    });
  },

  // Remove an uploaded attachment that never made it into a sent
  // message (e.g. the send failed after the upload): without this,
  // orphaned files stayed public in Storage forever.
  async deleteUpload(path: string): Promise<void> {
    await apiClient.request('/messages', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete-upload', path }),
    });
  },

  // Edit own text within 1 hour of sending (server enforces both).
  async editMessage(id: string, _editorEmail: string, text: string): Promise<EventMessage> {
    const data = await apiClient.request<{ message: EventMessage }>('/messages', {
      params: { id },
      method: 'PATCH',
      body: JSON.stringify({ text }),
    });
    return data.message;
  },

  async markAsRead(id: string, _recipientEmail?: string): Promise<void> {
    try {
      await apiClient.request('/messages', {
        params: { id },
        method: 'PATCH',
        body: JSON.stringify({}),
      });
    } catch (err) {
      // Read receipts are cosmetic; a failure here must never break chat.
      console.warn('markAsRead failed:', err);
    }
  },

  async requestUploadUrl(input: {
    eventId: string;
    senderEmail?: string;
    recipientEmail?: string;
    organizerId?: string;
    fileName: string;
    fileSize: number;
    fileType: string;
  }): Promise<{ uploadUrl: string; publicUrl: string; path: string }> {
    const { senderEmail: _s, ...rest } = input as any;
    return apiClient.request('/messages', {
      method: 'POST',
      body: JSON.stringify({ action: 'upload-url', ...rest }),
    });
  },

  // Direct browser -> Supabase Storage PUT. The file never passes
  // through Vercel (which caps payloads around 4.5MB). XHR (not
  // fetch) so the caller gets REAL upload progress: a 20MB file on
  // a slow connection shows a progress bar instead of looking stuck.
  // onProgress receives 0..1 as bytes are sent.
  async uploadFile(uploadUrl: string, file: File, onProgress?: (fraction: number) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      if (xhr.upload && typeof onProgress === 'function') {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (typeof onProgress === 'function') onProgress(1);
          resolve();
        } else {
          reject(new ApiError(`Upload failed (${xhr.status})`, xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError('Upload failed (network error)', 0));
      xhr.send(file);
    });
  },

  // Batch mark-as-read: one call for many ids (the old client
  // PATCHed each unread message individually, then reloaded).
  // Returns how many were newly marked. Community rows append the
  // viewer to readBy (seenCount/seenByMe) instead of setting read.
  async markMessagesRead(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    try {
      const data = await apiClient.request<{ marked?: number }>('/messages', {
        method: 'POST',
        body: JSON.stringify({ action: 'mark-read', ids }),
      });
      return typeof data.marked === 'number' ? data.marked : 0;
    } catch {
      return 0;
    }
  },

  // Typing indicator (ephemeral, nothing stored). Call throttled
  // (~2s) while typing; the server broadcasts it to the other
  // side. `community` + eventId for group/global rooms.
  async sendTyping(input: {
    eventId: string;
    recipientEmail?: string;
    community?: boolean;
  }): Promise<void> {
    try {
      await apiClient.request('/messages', {
        method: 'POST',
        body: JSON.stringify({ action: 'typing', ...input }),
      });
    } catch {
      // Typing is cosmetic; a failure must never break the composer.
    }
  },

  // ---- Community chat (one group chat per event) ----
  // Same /api/messages endpoint, ?community=1. The server enforces
  // membership (confirmed registrant / organizer / admin) on every
  // call; a 403 here means "locked", not a broken chat — callers
  // should render the locked placeholder, not an error banner.
  // No email alerts are sent for community messages, by design.
  async getCommunityMessages(
    eventId: string,
  ): Promise<{ messages: EventMessage[]; member: boolean; canPost: boolean; isOrganizer: boolean }> {
    const data = await apiClient.request<{
      messages: EventMessage[];
      member: boolean;
      canPost: boolean;
      isOrganizer: boolean;
    }>('/messages', { params: { community: 1, eventId } });
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      member: data.member === true,
      canPost: data.canPost === true,
      isOrganizer: data.isOrganizer === true,
    };
  },

  // One page of a community room (newest `limit`, default 50).
  // Same `before`/`since` cursor semantics as getMessagesPage —
  // the polls use `since` + a client-side id dedupe.
  async getCommunityMessagesPage(
    eventId: string,
    opts?: { limit?: number; before?: string; since?: string },
  ): Promise<{ messages: EventMessage[]; member: boolean; canPost: boolean; isOrganizer: boolean; hasMore: boolean }> {
    const data = await apiClient.request<{
      messages: EventMessage[];
      member: boolean;
      canPost: boolean;
      isOrganizer: boolean;
      hasMore?: boolean;
    }>('/messages', {
      params: {
        community: 1,
        eventId,
        limit: opts?.limit,
        before: opts?.before,
        since: opts?.since,
      },
    });
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      member: data.member === true,
      canPost: data.canPost === true,
      isOrganizer: data.isOrganizer === true,
      hasMore: data.hasMore === true,
    };
  },

  async sendCommunityMessage(input: {
    eventId: string;
    text?: string;
    attachment?: { name: string; size: number; type: string; path: string };
    idempotencyKey?: string;
    replyToId?: string;
  }): Promise<EventMessage> {
    const data = await apiClient.request<{ message: EventMessage }>('/messages', {
      method: 'POST',
      body: JSON.stringify({ community: true, ...input }),
    });
    return data.message;
  },

  async requestCommunityUploadUrl(input: {
    eventId: string;
    fileName: string;
    fileSize: number;
    fileType: string;
  }): Promise<{ uploadUrl: string; publicUrl: string; path: string }> {
    return apiClient.request('/messages', {
      method: 'POST',
      body: JSON.stringify({ action: 'upload-url', community: true, ...input }),
    });
  },

  // Edit own community message (server enforces 1h window + current
  // membership). Delete (DELETE ?id=) is shared with private
  // messages: the server tombstones it, and the organizer/admin may
  // delete any community message.

  // ---- Global community chat (one site-wide room) ----
  // Same /api/messages community endpoints with eventId "global".
  // Any signed-in user is a member; the server enforces the session.
  // Moderation (delete-any) is admins + approved organizers.
  async getGlobalCommunityMessages(): Promise<{
    messages: EventMessage[];
    member: boolean;
    canPost: boolean;
    isOrganizer: boolean;
  }> {
    return this.getCommunityMessages("global");
  },

  async sendGlobalCommunityMessage(input: {
    text?: string;
    attachment?: { name: string; size: number; type: string; path: string };
    idempotencyKey?: string;
    replyToId?: string;
  }): Promise<EventMessage> {
    return this.sendCommunityMessage({ ...input, eventId: "global" });
  },

  async requestGlobalCommunityUploadUrl(input: {
    fileName: string;
    fileSize: number;
    fileType: string;
  }): Promise<{ uploadUrl: string; publicUrl: string; path: string }> {
    return this.requestCommunityUploadUrl({ ...input, eventId: "global" });
  },
};
