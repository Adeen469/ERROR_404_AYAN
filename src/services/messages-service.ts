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
  if (!ALLOWED_EXTENSIONS.includes(extensionOf(file.name))) {
    return 'File type not allowed — video, image, PDF, Word or spreadsheet only.';
  }
  return null;
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
  // through Vercel (which caps payloads around 4.5MB).
  async uploadFile(uploadUrl: string, file: File): Promise<void> {
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) {
      throw new ApiError(`Upload failed (${res.status})`, res.status);
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
};
