// Community chat — one group chat per event, plus the site-wide
// global room (mode="global", eventId "global").
//
// Event mode — who can see/post: signed-in users with a CONFIRMED
// registration for this event, plus the event organizer and admins.
// Guests and signed-in non-registered users see only a locked
// placeholder — the server enforces this on every call (403 with
// member:false), so the placeholder here is display only, never
// the access check.
//
// Global mode — who can see/post: ANY signed-in user. No event,
// no registration check; the route guard + the session check on
// the server are the gates. Moderation is admins + approved
// organizers (server DELETE), shown via the isOrganizer flag.
//
// Privacy (both modes): only sender NAMES are shown, never emails
// or phones. The server strips hiddenFor/idempotencyKey/editHistory
// from returned rows (same stripMessageForViewer as private messages).
//
// Privacy: only sender NAMES are shown, never emails or phones.
// The server strips hiddenFor/idempotencyKey/editHistory from
// returned rows (same stripMessageForViewer as private messages).
//
// Delivery: 3s polling while open, 30s safety net when the
// Realtime ping channel is live. Pings are content-free
// (id only, see realtime-service.ts) on channel `community:<eventId>`
// (event mode) or `community:global` (global mode).
// No email alerts are ever sent for community messages.
//
// Replies reuse the private-message pattern: replyToId + a frozen
// server snapshot, quote bar above the composer, tap a quote to
// jump to the original. Edits: own message, within 1 hour (server
// enforces). Deletes: own message, or ANY message for the
// organizer/admin (server tombstones it, no 24h window for
// moderation). Attachments reuse the private upload-url + magic-byte
// verification path (community:true).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileText, MessageCircle, Paperclip, Reply, Send, Users, X } from 'lucide-react';
import Avatar from '../ui/Avatar';
import { ConfirmDialog } from '../ui/Modal';
import { authService } from '../../services/auth-service';
import {
  EventMessage,
  formatFileSize,
  messagesService,
  validateAttachment,
  dayLabel,
  fmtChatTime,
  isNearBottom,
  lastVisibleKey,
  PENDING_DEDUPE_WINDOW_MS,
  reconcileFailedPending,
  safeLinkUrl,
  newTempId,
} from '../../services/messages-service';
import {
  subscribeToPrivateChannel,
  subscribeToCommunity,
  type RealtimeFullEvent,
  type RealtimeMessage,
} from '../../services/realtime-service';
import { ApiError } from '../../services/api-client';

function quoteText(m: EventMessage): string {
  if (m.deletedForEveryone) return 'This message was deleted';
  if (m.text && m.text.trim()) return m.text.trim();
  if (m.attachment) return `Sent an attachment: ${m.attachment.name}`;
  return 'Message';
}

// WhatsApp-style quote above a reply's text, rendered from the
// frozen server snapshot (never by re-reading the original).
// Memoised (M14): pure given its props — without this, every poll
// tick / typing pulse re-renders every quote in the list.
const QuoteView = React.memo(function QuoteView({
  m,
  meEmail,
  onJump,
}: {
  m: EventMessage;
  meEmail: string;
  onJump: (id: string) => void;
}) {
  const snap = m.replySnapshot;
  if (!m.replyToId || !snap) return null;
  const deleted = snap.deleted === true;
  const senderLabel = deleted
    ? ''
    : (snap.senderEmail || '').toLowerCase() === meEmail
      ? 'You'
      : snap.senderName || snap.senderEmail;
  const body = deleted
    ? 'This message was deleted'
    : snap.text || (snap.attachmentName ? `Sent an attachment: ${snap.attachmentName}` : 'Message');
  return (
    <button
      type="button"
      onClick={() => {
        if (!deleted) onJump(snap.id);
      }}
      className="block w-full text-left border-l-2 border-[#C25E00] bg-black/10 rounded-r-lg px-2 py-1.5 space-y-0.5"
      title={deleted ? 'This message was deleted' : 'Jump to quoted message'}
    >
      {!deleted && (
        <span className="block text-[11px] font-bold text-[#C25E00] truncate">{senderLabel}</span>
      )}
      <span className="block text-[11px] leading-snug opacity-80 line-clamp-2 break-words">{body}</span>
    </button>
  );
});

// Memoised (M14): pure given its props.
// L9 (audit #4): attachment links go through safeLinkUrl — only
// https: / blob: URLs become anchors or media sources; anything else
// renders as plain text (name + size, no link).
const AttachmentView = React.memo(function AttachmentView({ m }: { m: EventMessage }) {
  const a = m.attachment;
  if (!a) return null;
  const url = safeLinkUrl(a.url);
  if (a.type.startsWith('image/')) {
    if (!url) {
      return <span className="block text-xs opacity-80">{a.name} · {formatFileSize(a.size)}</span>;
    }
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={a.name}
          className="max-h-64 max-w-full rounded-lg object-contain bg-[#F4F1EA]"
        />
        <span className="text-[11px] opacity-80 underline">
          {a.name} · {formatFileSize(a.size)}
        </span>
      </a>
    );
  }
  if (a.type.startsWith('video/')) {
    if (!url) {
      return <span className="block text-xs opacity-80">{a.name} · {formatFileSize(a.size)}</span>;
    }
    return (
      <span className="block">
        <video src={url} controls preload="metadata" className="max-h-64 max-w-full rounded-lg bg-black" />
        <span className="text-[11px] opacity-80">
          {a.name} · {formatFileSize(a.size)}
        </span>
      </span>
    );
  }
  if (!url) {
    return (
      <span className="inline-flex items-center gap-2 bg-white/10 border border-white/20 rounded-lg px-3 py-2">
        <FileText className="w-4 h-4 shrink-0" />
        <span className="text-xs font-medium break-all">{a.name}</span>
        <span className="text-[11px] opacity-80 whitespace-nowrap">{formatFileSize(a.size)}</span>
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg px-3 py-2 transition-colors"
    >
      <FileText className="w-4 h-4 shrink-0" />
      <span className="text-xs font-medium break-all">{a.name}</span>
      <span className="text-[11px] opacity-80 whitespace-nowrap">{formatFileSize(a.size)}</span>
      <Download className="w-3.5 h-3.5 shrink-0" />
    </a>
  );
});

type ChatMessage = EventMessage & {
  pending?: boolean;
  failed?: boolean;
  localFile?: File;
  localPreview?: string;
  // 0..1 while the attachment Storage PUT is running (XHR progress).
  uploadProgress?: number;
  // Stable per draft: retries reuse it so the server dedupes instead
  // of creating a second message.
  idempotencyKey?: string;
};

// A bubble still on its way out (or failed): local preview for
// images, name-only line for files, a real upload progress bar —
// NEVER an empty-src img or empty-href anchor (the old code ran
// the normal AttachmentView on a pending bubble whose url was '').
// Failed bubbles keep a Retry button, like the private inbox.
// Memoised (M14): pure given its props (uploadProgress changes
// re-render only that bubble).
const PendingAttachment = React.memo(function PendingAttachment({ m, onRetry }: { m: ChatMessage; onRetry: () => void }) {
  const progress = typeof m.uploadProgress === 'number' ? m.uploadProgress : undefined;
  return (
    <span className="block mt-1 space-y-1">
      {m.localPreview ? (
        <img
          src={m.localPreview}
          alt={m.attachment?.name || 'Uploading image'}
          className="max-h-64 max-w-full rounded-lg object-contain bg-[#F4F1EA]"
        />
      ) : m.attachment ? (
        <span className="block text-sm text-[#1E2320]">
          {m.attachment.name} · {formatFileSize(m.attachment.size)}
        </span>
      ) : null}
      {progress !== undefined && progress < 1 && (
        <span className="block">
          <span className="block h-1 bg-[#E2DFD8] rounded-full overflow-hidden">
            <span
              className="block h-full bg-[#1E3F35] rounded-full"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </span>
          <span className="text-[11px] text-[#8C887E]">Uploading… {Math.round(progress * 100)}%</span>
        </span>
      )}
      {m.failed && (
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-rose-600">Failed to send</span>
          <button
            type="button"
            onClick={onRetry}
            className="text-[11px] font-semibold text-[#1E3F35] underline"
          >
            Retry
          </button>
        </span>
      )}
    </span>
  );
});

export function CommunityChat({
  eventId,
  eventTitle,
  isRegistered,
  isOwner,
  mode = 'event',
  fullHeight = false,
}: {
  eventId: string;
  eventTitle: string;
  // Event mode only: whether the viewer is a confirmed registrant /
  // the event owner (drives the locked placeholder). Global mode
  // ignores them — any signed-in user is a member.
  isRegistered?: boolean;
  isOwner?: boolean;
  // "event": one group chat per event (membership-gated).
  // "global": the site-wide room (any signed-in user).
  mode?: 'event' | 'global';
  // Global page only: the chat fills the viewport like MessagesPage
  // (full-bleed, full height, inner scroll, pinned composer).
  // Event-page usage keeps the card sizing — never pass this there.
  fullHeight?: boolean;
}) {
  const isGlobal = mode === 'global';
  const [currentUser, setCurrentUser] = useState(() => authService.getCurrentUser());
  useEffect(() => authService.subscribe((u) => setCurrentUser(u)), []);
  const [status, setStatus] = useState<'loading' | 'locked' | 'member'>('loading');
  const [messages, setMessages] = useState<EventMessage[]>([]);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sendError, setSendError] = useState('');
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [replyTo, setReplyTo] = useState<EventMessage | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<EventMessage | null>(null);
  // M13: SEPARATE liveness flags for the private (full-payload) and
  // ping (content-free) channels. The old code shared one
  // `realtimeLive` flag between the two subscriptions, so a live
  // ping channel misreported a dead private channel as "live" (and
  // vice versa) — the poll interval and any status derived from it
  // were wrong for the channel that actually mattered. Polling
  // slows to the 30s safety net when EITHER channel is live.
  const [privateLive, setPrivateLive] = useState(false);
  const [pingLive, setPingLive] = useState(false);
  const realtimeLive = privateLive || pingLive;
  // Typing indicators (names only, ephemeral): several members may
  // type at once in a group chat, so this is a set, not one name.
  const [typingNames, setTypingNames] = useState<string[]>([]);
  const typingTimers = useRef(new Map<string, number>());
  const typingThrottle = useRef(0);
  // Pagination: first page is the newest 50; "Load older" pages
  // backwards. Polls fetch only rows newer than the newest loaded.
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // M14: user-initiated loads surface their failure instead of
  // failing silently — the error line + Retry below replace the old
  // "button stays for a retry" with no explanation.
  const [loadOlderError, setLoadOlderError] = useState('');
  const [jumpError, setJumpError] = useState('');
  // Scroll guard: auto-scroll only when already near the bottom;
  // otherwise a "New messages" pill appears instead of yanking the
  // reader away from older history.
  const listRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const lastSeenKeyRef = useRef('');
  const [newCount, setNewCount] = useState(0);
  const messagesRef = useRef<EventMessage[]>([]);
  messagesRef.current = messages;
  const pendingRef = useRef<ChatMessage[]>([]);
  pendingRef.current = pending;
  // L9 (audit #4): every image preview is a blob: URL from
  // URL.createObjectURL (handleSend). Revoke it the moment its bubble
  // leaves the pending list — on success, on reconcile, on unmount —
  // or every sent image leaks a blob URL for the life of the page.
  // Failed bubbles stay pending (Retry reuses the preview), so their
  // URLs stay alive until the send finally lands.
  const pendingPreviewsRef = useRef(new Map<string, string>());
  useEffect(() => {
    const seen = new Set<string>();
    for (const p of pending) {
      seen.add(p.id);
      if (p.localPreview) pendingPreviewsRef.current.set(p.id, p.localPreview);
    }
    for (const [id, url] of pendingPreviewsRef.current) {
      if (!seen.has(id)) {
        URL.revokeObjectURL(url);
        pendingPreviewsRef.current.delete(id);
      }
    }
  }, [pending]);
  useEffect(
    () => () => {
      for (const url of pendingPreviewsRef.current.values()) URL.revokeObjectURL(url);
      pendingPreviewsRef.current.clear();
    },
    [],
  );
  const pollCountRef = useRef(0);
  const pollInFlight = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const highlightTimer = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const meEmail = (currentUser?.email || '').toLowerCase();

  // Drop failed bubbles whose real copy has since arrived (see
  // reconcileFailedPending in messages-service.ts): a send can be
  // stored while its response is lost, leaving a failed bubble next
  // to the real message. When the last failed bubble goes, the red
  // composer error line goes with it.
  const reconcilePending = useCallback(
    (serverRows: EventMessage[]) => {
      const next = reconcileFailedPending(pendingRef.current, serverRows, meEmail);
      if (next.length !== pendingRef.current.length) {
        setPending(next);
        if (!next.some((p) => p.failed)) setSendError('');
      }
    },
    [meEmail],
  );

  // First page (newest 50) or a manual reload. Polls use pollNew
  // below instead — a reload here replaces the whole list.
  const load = useCallback(
    async (silent = false) => {
      if (!currentUser?.email) {
        setStatus('locked');
        return;
      }
      try {
        const data = await messagesService.getCommunityMessagesPage(eventId, { limit: 50 });
        setMessages(data.messages);
        reconcilePending(data.messages);
        setHasMore(data.hasMore);
        setIsOrganizer(data.isOrganizer);
        setStatus(data.member ? 'member' : 'locked');
        if (!silent) setLoadError('');
      } catch (err: any) {
        // 401/403 here is the locked state, not a broken chat: the
        // server is telling us this viewer is not a member.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setStatus('locked');
          return;
        }
        if (!silent) setLoadError(err?.message || 'Could not load the community chat.');
      }
    },
    [currentUser?.email, eventId, reconcilePending],
  );

  // Poll tick: fetch only rows newer than the newest loaded one and
  // merge them (dedupe by id). Every 10th tick does a full paged
  // reload instead, so edits / deletes / seen counts still arrive
  // when Realtime is off.
  const pollNew = useCallback(async () => {
    if (!currentUser?.email) return;
    pollCountRef.current += 1;
    if (pollCountRef.current % 10 === 0) {
      await load(true);
      return;
    }
    const loaded = messagesRef.current;
    if (loaded.length === 0) {
      await load(true);
      return;
    }
    const since = loaded.reduce(
      (max, m) => ((m.createdAt || '') > max ? (m.createdAt as string) : max),
      '',
    );
    try {
      const page = await messagesService.getCommunityMessagesPage(eventId, { since });
      if (page.messages.length > 0) {
        setMessages((prev) => {
          const ids = new Set(prev.map((m) => m.id));
          const fresh = page.messages.filter((m) => !ids.has(m.id));
          if (fresh.length === 0) return prev;
          return [...prev, ...fresh].sort(
            (a, b) =>
              (a.createdAt || '').localeCompare(b.createdAt || '') ||
              (a.id || '').localeCompare(b.id || ''),
          );
        });
        reconcilePending(page.messages);
      }
    } catch {
      // Silent poll failure: keep the last loaded list on screen.
    }
  }, [currentUser?.email, eventId, load, reconcilePending]);

  useEffect(() => {
    load();
    // Poll interval depends on Realtime: 3s while polling is the only
    // delivery path, 30s safety net once a channel is live. Each poll
    // now fetches only new rows (pollNew), not the whole history.
    const intervalMs = realtimeLive ? 30000 : 3000;
    const timer = setInterval(() => {
      // L9 (audit #4): skip ticks while the tab is hidden — a
      // background tab was polling every 3s forever. The
      // visibilitychange listener below resumes with an immediate
      // poll the moment the tab is visible again.
      if (document.hidden) return;
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      pollNew().finally(() => {
        pollInFlight.current = false;
      });
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden && !pollInFlight.current) {
        pollInFlight.current = true;
        pollNew().finally(() => {
          pollInFlight.current = false;
        });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, pollNew, realtimeLive]);

  // Apply one full-payload Realtime event to the local list (no
  // refetch). The payload carries no emails (names only): a message
  // from someone else keeps senderEmail '' (rendering uses the name,
  // and `own` decides mine/edit/delete) — the full row, with emails,
  // arrives on the next paged reload.
  const applyRealtimeMessage = useCallback(
    (data: RealtimeMessage) => {
      const quoted = data.replyToId
        ? messagesRef.current.find((m) => m.id === data.replyToId)
        : undefined;
      const merged: EventMessage = {
        type: 'community',
        id: data.id,
        eventId: data.eventId,
        eventTitle: data.eventTitle || eventTitle,
        senderEmail: data.own ? meEmail : '',
        senderName: data.senderName,
        recipientEmail: `community:${data.eventId}`,
        text: data.text,
        attachment: data.attachment,
        read: data.read,
        edited: data.edited,
        editedAt: data.editedAt,
        deletedForEveryone: data.deletedForEveryone,
        deletedAt: data.deletedAt,
        replyToId: data.replyToId,
        replySnapshot: data.replySnapshot
          ? { ...data.replySnapshot, senderEmail: quoted ? quoted.senderEmail : '' }
          : undefined,
        createdAt: data.createdAt,
        seenCount: data.seenCount,
      };
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === merged.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...prev[idx], ...merged };
          return next;
        }
        return [...prev, merged];
      });
      // A live copy of my own message means the send DID store even
      // if its POST response was lost — drop the failed bubble.
      // (Others' payloads carry senderEmail '', so they can never
      // match — the helper only drops my own failed bubbles.)
      reconcilePending([merged]);
    },
    [meEmail, eventTitle, reconcilePending],
  );

  // Realtime on my PRIVATE channel (event rooms only — full payload,
  // see realtime-service.ts): member messages render the moment they
  // arrive, with no refetch. Read receipts update seen counts live.
  // Typing arrives here too. Without VITE_SUPABASE_* this is a
  // silent no-op and polling above stays at 3s.
  useEffect(() => {
    if (isGlobal || !eventId || status !== 'member' || !meEmail) return;
    let unsubscribe = () => {};
    let cancelled = false;
    messagesService.getRealtimeChannel().then((channel) => {
      if (cancelled || !channel) return;
      unsubscribe = subscribeToPrivateChannel(
        channel,
        (ev: RealtimeFullEvent) => {
          if (ev.type === 'message' || ev.type === 'edited' || ev.type === 'deleted') {
            // Only this room's community payloads — private inbox
            // messages share the same channel and belong to the
            // Messages page, not this chat.
            if (ev.data.type === 'community' && ev.data.eventId === eventId) {
              applyRealtimeMessage(ev.data);
            }
          } else if (ev.type === 'read') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === ev.id
                  ? { ...m, seenCount: typeof ev.seenCount === 'number' ? ev.seenCount : m.seenCount }
                  : m,
              ),
            );
          } else if (ev.type === 'typing') {
            if (ev.eventId === eventId && ev.name) showTyping(ev.name);
          }
        },
        (s) => setPrivateLive(s === 'SUBSCRIBED'),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGlobal, eventId, status, meEmail, applyRealtimeMessage]);

  // Community pings (content-free, see realtime-service.ts): the
  // GLOBAL room's delivery path (ping-only by design — a ping
  // carries no content, so it is safe on the public channel) and
  // the fallback for event rooms over 200 members, where the server
  // fans out a ping instead of a full payload. A ping fetches only
  // new rows (pollNew). Global typing arrives here too (name only).
  // Without VITE_SUPABASE_* this is a silent no-op and polling
  // above stays at 3s.
  useEffect(() => {
    if (!eventId || status !== 'member') return;
    const unsubscribe = subscribeToCommunity(
      eventId,
      () => {
        pollNew();
      },
      (s) => setPingLive(s === 'SUBSCRIBED'),
      (t) => {
        if (isGlobal && t.name) showTyping(t.name);
      },
    );
    return unsubscribe;
  }, [eventId, status, isGlobal, pollNew]);

  // Server messages plus in-flight ones, oldest first. A pending
  // bubble is dropped once its server copy shows up (a poll or a
  // Realtime event can beat the post's own response by a hair); the
  // createdAt guard keeps a genuinely repeated message from
  // collapsing into the first copy. The window is the shared
  // PENDING_DEDUPE_WINDOW_MS (60s) — the same window
  // reconcileFailedPending uses, so a slow send never shows both
  // copies (M10). (Declared here, above the scroll effect, because
  // the effect keys on the visible tail.)
  const visible: ChatMessage[] = [
    ...messages,
    ...pending.filter(
      (p) =>
        !messages.some(
          (s) =>
            s.senderEmail === p.senderEmail &&
            (s.text || '') === (p.text || '') &&
            (s.attachment?.name || null) === (p.attachment?.name || null) &&
            Date.parse(s.createdAt) >= Date.parse(p.createdAt) &&
            Date.parse(s.createdAt) - Date.parse(p.createdAt) < PENDING_DEDUPE_WINDOW_MS,
        ),
    ),
  ].sort(
    (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || (a.id || '').localeCompare(b.id || ''),
  );

  // M10: identity of the visible tail (see lastVisibleKey). The
  // scroll effect below keys on this, not on list length alone.
  const tailKey = lastVisibleKey(visible);

  // Auto-scroll only when already near the bottom; otherwise count
  // the arrivals for the "New messages" pill.
  // M10: count ARRIVALS only. This used to fire on any length
  // increase, so prepending 50 older rows (loadOlder) counted a
  // "new message" while reading history. The tail key only changes
  // when a row is appended at the end — a prepend, a same-tail
  // reload, an edit or a tombstone leaves it unchanged.
  useEffect(() => {
    if (tailKey === lastSeenKeyRef.current) return;
    lastSeenKeyRef.current = tailKey;
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } else {
      setNewCount((c) => c + 1);
    }
  }, [visible.length, tailKey]);

  // Switching rooms (event / global) lands at the bottom, pill
  // cleared, tail tracker reset — the first page of the new room
  // is not an arrival.
  useEffect(() => {
    lastSeenKeyRef.current = '';
    nearBottomRef.current = true;
    setNewCount(0);
  }, [eventId]);

  function jumpToBottom() {
    nearBottomRef.current = true;
    setNewCount(0);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function onListScroll() {
    const near = isNearBottom(listRef.current);
    nearBottomRef.current = near;
    if (near) setNewCount(0);
  }

  function showTyping(name: string) {
    if (!name) return;
    setTypingNames((prev) => (prev.includes(name) ? prev : [...prev, name]));
    const old = typingTimers.current.get(name);
    if (old !== undefined) window.clearTimeout(old);
    typingTimers.current.set(
      name,
      window.setTimeout(() => {
        typingTimers.current.delete(name);
        setTypingNames((prev) => prev.filter((n) => n !== name));
      }, 3000),
    );
  }

  // Typing indicator (throttled ~2s): the server broadcasts it to
  // the room's members. One call per 2s of typing, not per keystroke.
  function sendTyping() {
    if (!currentUser?.email || status !== 'member') return;
    const now = Date.now();
    if (now - typingThrottle.current < 2000) return;
    typingThrottle.current = now;
    messagesService.sendTyping({ eventId, community: true });
  }

  // "Load older messages": one more page (50) before the oldest
  // loaded row, prepended. A failure shows an error + Retry (M14)
  // instead of failing silently.
  async function loadOlder() {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    setLoadOlderError('');
    try {
      const oldest = messages.reduce(
        (min, m) => ((m.createdAt || '') < min ? (m.createdAt as string) : min),
        messages[0].createdAt || '',
      );
      const page = await messagesService.getCommunityMessagesPage(eventId, { limit: 50, before: oldest });
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const fresh = page.messages.filter((m) => !ids.has(m.id));
        return [...fresh, ...prev].sort(
          (a, b) =>
            (a.createdAt || '').localeCompare(b.createdAt || '') ||
            (a.id || '').localeCompare(b.id || ''),
        );
      });
      setHasMore(page.hasMore);
    } catch {
      setLoadOlderError('Could not load older messages.');
    } finally {
      setLoadingOlder(false);
    }
  }

  // Marking this room read: one batched call for every message I
  // have not seen yet (not my own, not deleted). The server appends
  // me to readBy, so the sender's "Seen by N" updates live.
  useEffect(() => {
    if (status !== 'member' || !currentUser?.email) return;
    const unread = messages.filter(
      (m) => !m.seenByMe && (m.senderEmail || '').toLowerCase() !== meEmail && !m.deletedForEveryone,
    );
    if (unread.length === 0) return;
    const ids = unread.map((m) => m.id);
    messagesService.markMessagesRead(ids).then(() => {
      // M12 double-count guard: the increment applies ONLY to rows
      // still unseen at apply time. A double effect run (StrictMode)
      // or two overlapping polls used to add +1 twice for the same
      // read; the second apply now sees seenByMe and leaves the
      // count alone. The server guards the same way (skips emails
      // already in readBy, dedupes the list) and the read broadcast
      // carries the authoritative seenCount.
      setMessages((prev) =>
        prev.map((m) =>
          ids.includes(m.id) && !m.seenByMe
            ? { ...m, seenByMe: true, seenCount: (m.seenCount || 0) + 1 }
            : m,
        ),
      );
    });
  }, [status, messages, currentUser?.email, meEmail]);

  function startReply(m: EventMessage) {
    if (m.deletedForEveryone) return;
    // In-flight bubbles are not on the server yet: nothing to quote
    // there (failed ones get an inline Retry instead).
    if ((m as ChatMessage).pending || (m as ChatMessage).failed) return;
    setReplyTo(m);
    composerRef.current?.focus();
  }

  function jumpToQuoted(id: string) {
    // M14: a jump that still misses after a reload says so instead
    // of doing nothing — the quoted message may have been deleted
    // or never loaded.
    setJumpError('');
    const highlight = (el: HTMLDivElement | null | undefined) => {
      if (!el) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(id);
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => setHighlightId(null), 2000);
      return true;
    };
    if (highlight(messageRefs.current.get(id))) return;
    let loadFailed = false;
    load(true)
      .catch(() => {
        loadFailed = true;
      })
      .finally(() => {
        window.setTimeout(() => {
          if (!highlight(messageRefs.current.get(id))) {
            setJumpError(
              loadFailed
                ? 'Could not load the quoted message.'
                : 'Could not find that message — it may have been deleted.',
            );
          }
        }, 300);
      });
  }

  function canEdit(m: EventMessage): boolean {
    if ((m.senderEmail || '').toLowerCase() !== meEmail) return false;
    if (m.deletedForEveryone) return false;
    const ageMs = Date.now() - Date.parse(m.createdAt || '');
    return Number.isFinite(ageMs) && ageMs <= 60 * 60 * 1000;
  }

  function canDelete(m: EventMessage): boolean {
    if (m.deletedForEveryone) return false;
    return (m.senderEmail || '').toLowerCase() === meEmail || isOrganizer;
  }

  async function handleSend() {
    if (!currentUser?.email) return;
    const text = draft.trim();
    if (!text && !file) return;
    const sendingFile = file;
    const replyingTo = replyTo;
    const temp: ChatMessage = {
      id: newTempId(),
      type: 'community',
      eventId,
      eventTitle,
      senderEmail: currentUser.email,
      senderName: currentUser.name,
      recipientEmail: `community:${eventId}`,
      text,
      attachment: sendingFile
        ? { name: sendingFile.name, size: sendingFile.size, type: sendingFile.type, url: '', path: '' }
        : null,
      read: false,
      createdAt: new Date().toISOString(),
      pending: true,
      uploadProgress: sendingFile ? 0 : undefined,
      localFile: sendingFile || undefined,
      localPreview:
        sendingFile && sendingFile.type.startsWith('image/')
          ? URL.createObjectURL(sendingFile)
          : undefined,
      idempotencyKey: `community-${eventId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ...(replyingTo
        ? {
            replyToId: replyingTo.id,
            replySnapshot: {
              id: replyingTo.id,
              senderEmail: replyingTo.senderEmail,
              senderName: replyingTo.senderName || replyingTo.senderEmail,
              text: (replyingTo.text || '').trim().slice(0, 200),
              ...(replyingTo.attachment?.name
                ? { attachmentName: replyingTo.attachment.name }
                : {}),
              deleted: false,
            },
          }
        : {}),
    };
    setPending((prev) => [...prev, temp]);
    // My own send always scrolls into view (the scroll guard only
    // holds back OTHER people's arrivals while reading history).
    nearBottomRef.current = true;
    setNewCount(0);
    // The composer clears INSTANTLY on send tap — BEFORE the upload +
    // POST run (they take ~3s). The text / file / reply live on in
    // the optimistic bubble, which carries them for Retry if the send
    // fails, so clearing early can never lose them — and the box (and
    // the attachment chip) must never hold content that is already
    // showing as sent.
    setDraft('');
    setFile(null);
    setReplyTo(null);
    setSendError('');
    try {
      let attachmentMeta: { name: string; size: number; type: string; path: string } | undefined;
      if (sendingFile) {
        const validationError = validateAttachment(sendingFile);
        if (validationError) throw new Error(validationError);
        const { uploadUrl, path } = isGlobal
          ? await messagesService.requestGlobalCommunityUploadUrl({
              fileName: sendingFile.name,
              fileSize: sendingFile.size,
              fileType: sendingFile.type,
            })
          : await messagesService.requestCommunityUploadUrl({
              eventId,
              fileName: sendingFile.name,
              fileSize: sendingFile.size,
              fileType: sendingFile.type,
            });
        try {
          await messagesService.uploadFile(uploadUrl, sendingFile, (f) =>
            setPending((prev) =>
              prev.map((p) => (p.id === temp.id ? { ...p, uploadProgress: f } : p)),
            ),
          );
        } catch (err) {
          throw err;
        }
        attachmentMeta = { name: sendingFile.name, size: sendingFile.size, type: sendingFile.type, path };
      }
      let created: EventMessage;
      try {
        created = isGlobal
          ? await messagesService.sendGlobalCommunityMessage({
              text,
              attachment: attachmentMeta,
              idempotencyKey: temp.idempotencyKey,
              replyToId: replyingTo?.id,
            })
          : await messagesService.sendCommunityMessage({
              eventId,
              text,
              attachment: attachmentMeta,
              idempotencyKey: temp.idempotencyKey,
              replyToId: replyingTo?.id,
            });
      } catch (err) {
        if (attachmentMeta) {
          try {
            await messagesService.deleteUpload(attachmentMeta.path);
          } catch {
            /* best effort: the orphan cleanup must not mask the send error */
          }
        }
        throw err;
      }
      setPending((prev) => prev.filter((p) => p.id !== temp.id));
      setMessages((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
      // M11: no full reload here. The created row is already
      // appended above, and a full reload would replace the whole
      // list with the newest 50 — wiping older pages the user
      // already loaded and risking a scroll jump. The server already fanned the
      // full payload out to every member's private channel (global:
      // ping + refetch), so no client broadcast is needed either.
      // The full reload stays reserved for the ping fallback
      // (pollNew's periodic reload) and quote jumps.
    } catch (err: any) {
      // A failed send STAYS visible with a Retry button — it used to
      // vanish silently, which is why attachments looked like they
      // never delivered. The composer error line stays too.
      setPending((prev) =>
        prev.map((p) => (p.id === temp.id ? { ...p, pending: false, failed: true } : p)),
      );
      setSendError(err?.message || 'Could not send message. Please try again.');
    }
  }

  // Retry a failed bubble: same draft, same idempotency key (the
  // server dedupes instead of creating a second message), same file.
  async function retrySend(temp: ChatMessage) {
    if (!currentUser?.email) return;
    setPending((prev) =>
      prev.map((p) => (p.id === temp.id ? { ...p, failed: false, pending: true, uploadProgress: temp.localFile ? 0 : undefined } : p)),
    );
    // Same instant-clear rule as handleSend: the composer is already
    // empty (it cleared on the first tap), but clear again so a
    // retry can never leave a stale draft/file behind.
    setDraft('');
    setFile(null);
    setReplyTo(null);
    setSendError('');
    try {
      const sendingFile = temp.localFile || null;
      let attachmentMeta: { name: string; size: number; type: string; path: string } | undefined;
      if (sendingFile) {
        const validationError = validateAttachment(sendingFile);
        if (validationError) throw new Error(validationError);
        const { uploadUrl, path } = isGlobal
          ? await messagesService.requestGlobalCommunityUploadUrl({
              fileName: sendingFile.name,
              fileSize: sendingFile.size,
              fileType: sendingFile.type,
            })
          : await messagesService.requestCommunityUploadUrl({
              eventId,
              fileName: sendingFile.name,
              fileSize: sendingFile.size,
              fileType: sendingFile.type,
            });
        await messagesService.uploadFile(uploadUrl, sendingFile, (f) =>
          setPending((prev) =>
            prev.map((p) => (p.id === temp.id ? { ...p, uploadProgress: f } : p)),
          ),
        );
        attachmentMeta = { name: sendingFile.name, size: sendingFile.size, type: sendingFile.type, path };
      }
      let created: EventMessage;
      try {
        created = isGlobal
          ? await messagesService.sendGlobalCommunityMessage({
              text: temp.text || '',
              attachment: attachmentMeta,
              idempotencyKey: temp.idempotencyKey,
              replyToId: temp.replyToId,
            })
          : await messagesService.sendCommunityMessage({
              eventId,
              text: temp.text || '',
              attachment: attachmentMeta,
              idempotencyKey: temp.idempotencyKey,
              replyToId: temp.replyToId,
            });
      } catch (err) {
        if (attachmentMeta) {
          try {
            await messagesService.deleteUpload(attachmentMeta.path);
          } catch {
            /* best effort */
          }
        }
        throw err;
      }
      setPending((prev) => prev.filter((p) => p.id !== temp.id));
      setMessages((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
      // M11: no full reload — the created row is already appended
      // (see handleSend).
    } catch (err: any) {
      setPending((prev) =>
        prev.map((p) => (p.id === temp.id ? { ...p, pending: false, failed: true } : p)),
      );
      setSendError(err?.message || 'Could not send message. Please try again.');
    }
  }

  async function handleEditSave(m: EventMessage) {
    const text = editDraft.trim();
    if (!text) return;
    try {
      const updated = await messagesService.editMessage(m.id, meEmail, text);
      setMessages((prev) => prev.map((x) => (x.id === m.id ? updated : x)));
      setEditingId(null);
      setEditDraft('');
      // The server broadcasts the edited payload live; the optimistic
      // update above is already showing, so no reload is needed.
    } catch (err: any) {
      setSendError(err?.message || 'Could not edit message.');
    }
  }

  async function handleDeleteConfirm() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    setConfirmDelete(null);
    try {
      await messagesService.deleteForEveryone(target.id, target.senderEmail);
      setMessages((prev) =>
        prev.map((x) =>
          x.id === target.id ? { ...x, text: '', attachment: null, deletedForEveryone: true } : x,
        ),
      );
      // M11: no full reload — the tombstone above is already
      // showing, and the server broadcasts it live to every member
      // (pollNew covers Realtime-off). A reload here would replace
      // the whole list and drop older loaded pages.
    } catch (err: any) {
      setSendError(err?.message || 'Could not delete message.');
    }
  }

  return (
    <div
      className={
        fullHeight
          ? 'flex flex-col bg-white border-b border-[#E5E1D8] overflow-hidden h-[calc(100dvh-4rem-1px)]'
          : 'bg-white rounded-2xl border border-[#E5E1D8] shadow-sm overflow-hidden'
      }
    >
      <div className={`px-5 sm:px-6 pt-5 sm:pt-6 pb-4 flex items-start gap-3${fullHeight ? ' shrink-0' : ''}`}>
        <div className="w-10 h-10 rounded-full bg-[#1E3F35] text-white flex items-center justify-center shrink-0">
          <Users className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h2 className="font-editorial text-xl font-bold text-[#1E2320] leading-tight">Community Chat</h2>
          <p className="text-xs text-[#5F635D] mt-1 leading-relaxed">
            {isGlobal
              ? 'Chat with everyone on Locora. Any signed-in member can see and post here — no email alerts are sent for community messages.'
              : `Chat with everyone attending ${eventTitle}. Only confirmed attendees, the organizer and admins can see or post here — no email alerts are sent for community messages.`}
          </p>
        </div>
      </div>
      <div
        className={
          fullHeight
            ? 'flex-1 min-h-0 flex flex-col px-5 sm:px-6 pb-5 sm:pb-6 space-y-4'
            : 'px-5 sm:px-6 pb-5 sm:pb-6 space-y-4'
        }
      >

      {status === 'loading' && (
        <div className="space-y-3" aria-label="Loading the community chat">
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse flex gap-2.5">
              <div className="w-8 h-8 rounded-full bg-[#EBE7DF] shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-1/4 bg-[#EBE7DF] rounded" />
                <div className="h-3 w-3/4 bg-[#F4F1EA] rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      {status === 'locked' && (
        <div className="p-5 bg-[#F4F1EA] border border-[#E2DFD8] rounded-xl space-y-2 text-center sm:text-left">
          <p className="text-sm font-semibold text-[#1E2320] flex items-center justify-center sm:justify-start gap-2">
            <span className="w-8 h-8 rounded-full bg-white border border-[#E2DFD8] flex items-center justify-center shrink-0">
              <MessageCircle className="w-4 h-4 text-[#1E3F35]" />
            </span>
            Join this event to chat with attendees
          </p>
          <p className="text-xs text-[#5F635D] leading-relaxed">
            {isGlobal
              ? 'Sign in to join the community chat — everyone on Locora can read and post here.'
              : meEmail
                ? 'Register to join the community chat — only confirmed attendees, the organizer and admins can read or post here.'
                : 'Sign in and register for this event to join the community chat.'}
          </p>
          {!meEmail ? (
            <Link
              to="/login"
              className="inline-flex px-4 py-2 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors"
            >
              Sign in
            </Link>
          ) : !isGlobal && !isRegistered && !isOwner ? (
            <p className="text-[11px] text-[#8C887E]">
              Use the Register button on this page to get your pass, then come back here to chat.
            </p>
          ) : null}
        </div>
      )}

      {status === 'member' && (
        <>
          {loadError && <p className="text-xs text-rose-600">{loadError}</p>}
          {jumpError && <p className="text-xs text-rose-600">{jumpError}</p>}
          <div
            ref={listRef}
            onScroll={onListScroll}
            className={
              fullHeight
                ? 'space-y-3 flex-1 min-h-0 overflow-y-auto pr-1 bg-[#FAF8F5] rounded-xl p-3 sm:p-4'
                : 'space-y-3 max-h-[65vh] overflow-y-auto pr-1 bg-[#FAF8F5] rounded-xl p-3 sm:p-4'
            }
          >
            {hasMore && (
              <div className="flex justify-center pb-1">
                <button
                  type="button"
                  onClick={loadOlder}
                  disabled={loadingOlder}
                  className="px-3 py-1.5 text-[11px] font-semibold text-[#1E3F35] bg-[#F4F1EA] hover:bg-[#EBE7DF] border border-[#E2DFD8] rounded-full disabled:opacity-60"
                >
                  {loadingOlder ? 'Loading…' : 'Load older messages'}
                </button>
              </div>
            )}
            {loadOlderError && (
              <div className="flex justify-center pb-1">
                <p className="text-[11px] text-rose-600">
                  {loadOlderError}{' '}
                  <button type="button" onClick={loadOlder} className="font-semibold underline">
                    Retry
                  </button>
                </p>
              </div>
            )}
            {visible.length === 0 && (
              <p className="text-sm text-[#5F635D]">
                No messages yet — say hello to your fellow attendees.
              </p>
            )}
            {visible.map((m, idx) => {
              const mine = (m.senderEmail || '').toLowerCase() === meEmail;
              const deleted = m.deletedForEveryone === true;
              const prev = idx > 0 ? visible[idx - 1] : null;
              const showDay = !prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt);
              const chatMsg = m as ChatMessage;
              return (
                <React.Fragment key={m.id}>
                  {showDay && (
                    <div className="flex justify-center pt-1">
                      <span className="text-[10px] font-semibold text-[#8C887E] bg-[#F4F1EA] rounded-full px-3 py-1">
                        {dayLabel(m.createdAt)}
                      </span>
                    </div>
                  )}
                <div
                  ref={(el) => {
                    if (el) messageRefs.current.set(m.id, el);
                    else messageRefs.current.delete(m.id);
                  }}
                  onDoubleClick={() => startReply(m)}
                  className={`flex gap-2.5 ${highlightId === m.id ? 'bg-amber-50 rounded-lg p-1 -m-1' : ''} ${
                    chatMsg.pending ? 'opacity-70' : ''
                  }`}
                >
                  <Avatar
                    src=""
                    name={m.senderName || m.senderEmail}
                    className="w-8 h-8 rounded-full shrink-0"
                    initialClassName="text-xs"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-xs font-bold text-[#1E2320] truncate">
                        {mine ? 'You' : m.senderName || 'Attendee'}
                      </span>
                      <span className="text-[11px] text-[#8C887E]">{fmtChatTime(m.createdAt)}</span>
                      {m.edited && !deleted && (
                        <span className="text-[11px] text-[#8C887E]">edited</span>
                      )}
                      {mine && !deleted && !chatMsg.pending && !chatMsg.failed && (
                        <span className="text-[11px] text-[#8C887E]">
                          {(m.seenCount || 0) > 0 ? `✓✓ Seen by ${m.seenCount}` : '✓ Sent'}
                        </span>
                      )}
                    </div>
                    {!deleted && <QuoteView m={m} meEmail={meEmail} onJump={jumpToQuoted} />}
                    {editingId === m.id ? (
                      <div className="mt-1 space-y-2">
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          rows={2}
                          maxLength={2000}
                          aria-label="Edit message"
                          className="w-full text-sm border border-[#D0E2D9] rounded-lg p-2 focus:outline-hidden focus:ring-1 focus:ring-[#1E3F35]"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleEditSave(m)}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-[#1E3F35] rounded-lg"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(null);
                              setEditDraft('');
                            }}
                            className="px-3 py-1.5 text-xs font-medium text-[#5F635D] border border-[#E2DFD8] rounded-lg"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-[#1E2320] leading-relaxed break-words whitespace-pre-line">
                        {deleted ? 'This message was deleted' : m.text || ''}
                      </p>
                    )}
                    {!deleted && chatMsg.pending ? (
                      <PendingAttachment m={chatMsg} onRetry={() => retrySend(chatMsg)} />
                    ) : (
                      !deleted && <AttachmentView m={m} />
                    )}
                    {!deleted && !chatMsg.pending && !chatMsg.failed && (
                      <div className="flex gap-3 mt-1">
                        <button
                          type="button"
                          onClick={() => startReply(m)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[#1E3F35] hover:underline"
                        >
                          <Reply className="w-3 h-3" />
                          Reply
                        </button>
                        {canEdit(m) && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(m.id);
                              setEditDraft(m.text || '');
                            }}
                            className="text-[11px] font-medium text-[#5F635D] hover:underline"
                          >
                            Edit
                          </button>
                        )}
                        {canDelete(m) && (
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(m)}
                            className="text-[11px] font-medium text-rose-600 hover:underline"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                </React.Fragment>
              );
            })}
            {newCount > 0 && (
              <div className="sticky bottom-2 flex justify-center">
                <button
                  type="button"
                  onClick={jumpToBottom}
                  className="px-3 py-1.5 text-[11px] font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-full shadow-lg"
                >
                  {newCount} new message{newCount === 1 ? '' : 's'} ↓
                </button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <div className={`border-t border-[#E5E1D8] pt-4 space-y-2${fullHeight ? ' shrink-0' : ''}`}>
            {replyTo && (
              <div className="flex items-start justify-between gap-2 bg-[#F4F1EA] border border-[#E2DFD8] rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold text-[#C25E00]">
                    Replying to{' '}
                    {(replyTo.senderEmail || '').toLowerCase() === meEmail
                      ? 'You'
                      : replyTo.senderName || 'Attendee'}
                  </p>
                  <p className="text-[11px] text-[#5F635D] truncate">{quoteText(replyTo)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setReplyTo(null)}
                  aria-label="Cancel reply"
                  className="text-[#5F635D] hover:text-[#1E2320] shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
            {file && (
              <div className="flex items-center justify-between gap-2 bg-[#F4F1EA] border border-[#E2DFD8] rounded-lg px-3 py-2">
                <span className="text-[11px] text-[#1E2320] truncate">
                  {file.name} · {formatFileSize(file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  aria-label="Remove attachment"
                  className="text-[#5F635D] hover:text-[#1E2320] shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
            {typingNames.length > 0 && (
              <p className="text-[11px] text-[#5F635D] italic">
                {typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing…
              </p>
            )}
            <div className="flex items-end gap-2">
              <label className="shrink-0 p-2 text-[#1E3F35] hover:bg-[#F4F1EA] rounded-full cursor-pointer transition-colors">
                <Paperclip className="w-4 h-4" />
                <span className="sr-only">Attach a file</span>
                <input
                  type="file"
                  className="hidden"
                  accept=".jpg,.jpeg,.png,.gif,.webp,.mp4,.webm,.mov,.pdf,.doc,.docx,.xls,.xlsx,.xlsm"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      const err = validateAttachment(f);
                      if (err) setSendError(err);
                      else {
                        setFile(f);
                        setSendError('');
                      }
                    }
                    e.target.value = '';
                  }}
                />
              </label>
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  sendTyping();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                rows={2}
                maxLength={2000}
                placeholder="Message the community…"
                aria-label="Message the community"
                className="flex-1 text-sm border border-[#D0E2D9] rounded-2xl p-2.5 focus:outline-hidden focus:ring-1 focus:ring-[#1E3F35] resize-none"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!draft.trim() && !file}
                className="shrink-0 p-2.5 text-white bg-[#1E3F35] hover:bg-[#163028] rounded-full transition-colors disabled:opacity-40"
                aria-label="Send community message"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            {sendError && <p className="text-[11px] text-rose-600">{sendError}</p>}
            <p className="text-[11px] text-[#8C887E]">
              {isGlobal
                ? 'Everyone on Locora can see these messages. Be kind — admins and organizers can remove messages.'
                : 'Only confirmed attendees can see these messages. Be kind — the organizer can remove messages.'}
            </p>
          </div>
        </>
      )}
      </div>

      <ConfirmDialog
        isOpen={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDeleteConfirm}
        isDestructive
        title="Delete message?"
        message={
          confirmDelete && (confirmDelete.senderEmail || '').toLowerCase() !== meEmail
            ? isGlobal
              ? 'Delete this member’s message from the community chat? Everyone will see "This message was deleted".'
              : 'Delete this attendee’s message from the community chat? Everyone will see "This message was deleted".'
            : 'Delete your message from the community chat? Everyone will see "This message was deleted".'
        }
        confirmLabel="Delete"
      />
    </div>
  );
}
