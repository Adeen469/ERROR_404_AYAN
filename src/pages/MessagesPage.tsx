import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  Eraser,
  FileText,
  MessageCircle,
  Paperclip,
  Pin,
  Reply,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { Modal } from '../components/ui/Modal';
import { authService } from '../services/auth-service';
import { eventsService } from '../services/events-service';
import {
  EventMessage,
  MessageThread,
  messagesService,
  groupThreads,
  threadKey,
  threadKeyHash,
  validateAttachment,
  formatFileSize,
  dayLabel,
  fmtChatTime,
  isNearBottom,
  lastVisibleKey,
  PENDING_DEDUPE_WINDOW_MS,
  reconcileFailedPending,
  safeLinkUrl,
  newTempId,
} from '../services/messages-service';
import {
  subscribeToPrivateChannel,
  type RealtimeFullEvent,
  type RealtimeMessage,
} from '../services/realtime-service';
import {
  sendChatbotMessage,
  CHATBOT_SUGGESTIONS,
  MAX_CHATBOT_SENT_HISTORY,
} from '../services/chatbot-service';
import {
  loadPrefs,
  savePrefs,
  sortThreadsByPin,
  isThreadHidden,
  isMessageCleared,
  type ThreadPrefs,
} from '../utils/conversation-prefs';
import Avatar from '../components/ui/Avatar';

function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString([], {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function snippetOf(m: EventMessage): string {
  if (m.deletedForEveryone) return 'This message was deleted';
  if (m.text && m.text.trim()) return m.text.trim();
  if (m.attachment) return `Sent an attachment: ${m.attachment.name}`;
  return 'Message';
}

// Loco inside Messages (WhatsApp's "message yourself"): a built-in
// AI conversation, not a server thread. Its history lives in
// localStorage on this device only — it never goes to /api/messages
// and never counts toward unread.
const AI_THREAD_KEY = 'loco-ai';
const AI_HISTORY_KEY = 'locora_messages_ai_history';
const AI_MAX_STORED = 50;

type AiChatMsg = { role: 'user' | 'assistant'; text: string; ts: number };

function loadAiHistory(): AiChatMsg[] {
  try {
    const raw = window.localStorage.getItem(AI_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m: any) =>
          m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string',
      )
      .map((m: any) => ({
        role: m.role as 'user' | 'assistant',
        text: m.text,
        ts: typeof m.ts === 'number' ? m.ts : Date.now(),
      }))
      .slice(-AI_MAX_STORED);
  } catch {
    return [];
  }
}

// A message still on its way out (or failed): shown instantly so
// sending feels immediate, then replaced by the server copy on
// confirm. Never sent to the server itself — deliver() below sends
// the real payload.
type ChatMessage = EventMessage & {
  threadKey?: string;
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

interface MenuState {
  x: number;
  y: number;
  message: EventMessage;
}

interface PendingDelete {
  id: string;
  scope: 'everyone' | 'me';
  message: EventMessage;
  timer: number;
}

// Memoised (audit #4 M14): pure given its props — without this,
// every poll tick / typing pulse re-renders every attachment in
// the list.
// L9 (audit #4): attachment links go through safeLinkUrl — only
// https: / blob: URLs become anchors or media sources. A tampered or
// legacy row carrying a javascript: / data: URL renders as plain text
// (name + size, no link) instead of a clickable anchor.
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
        <span className="text-[11px] opacity-80 underline">{a.name} · {formatFileSize(a.size)}</span>
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
        <span className="text-[11px] opacity-80">{a.name} · {formatFileSize(a.size)}</span>
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

function quoteText(m: EventMessage): string {
  if (m.deletedForEveryone) return 'This message was deleted';
  if (m.text && m.text.trim()) return m.text.trim();
  if (m.attachment) return `Sent an attachment: ${m.attachment.name}`;
  return 'Message';
}

// WhatsApp-style quote shown above a reply's text. Rendered from the
// frozen server snapshot (m.replySnapshot), never by re-reading the
// original — so it still reads correctly after the original is edited.
// Tapping it jumps to the original; a deleted / missing original
// shows "This message was deleted" and does nothing on tap.
// Memoised (audit #4 M14): pure given its props.
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
    : snap.senderEmail.toLowerCase() === meEmail
      ? 'You'
      : snap.senderName || snap.senderEmail;
  const body = deleted ? 'This message was deleted' : snap.text || (snap.attachmentName ? `Sent an attachment: ${snap.attachmentName}` : 'Message');
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
      <span className="block text-[11px] leading-snug opacity-80 line-clamp-2 break-words">
        {body}
      </span>
    </button>
  );
});

export function MessagesPage() {
  const [searchParams] = useSearchParams();
  // Subscribed, not captured once at mount: a sign-in/out while the
  // page is open used to leave it acting as the previous user.
  const [currentUser, setCurrentUser] = useState(() => authService.getCurrentUser());
  useEffect(() => authService.subscribe((u) => setCurrentUser(u)), []);
  const [messages, setMessages] = useState<EventMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');
  // Local list filter only (no refetch): matches the person, the
  // event, or the last message snippet.
  const [threadQuery, setThreadQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sendError, setSendError] = useState('');
  const [pendingThread, setPendingThread] = useState<MessageThread | null>(null);
  // In-flight bubbles (optimistic send) — kept apart from the server
  // list so a reload never wipes a message still uploading.
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  // Deletes awaiting their undo window: the message is hidden locally
  // the moment you confirm, and the real server call only runs when
  // the 3s toast expires (or immediately if you leave the page — see
  // the unmount flush below). Undo inside the window cancels it, so
  // no server-side restore is ever needed.
  const [pendingDeletes, setPendingDeletes] = useState<PendingDelete[]>([]);
  const pendingDeletesRef = useRef<PendingDelete[]>([]);
  pendingDeletesRef.current = pendingDeletes;
  const [confirmDelete, setConfirmDelete] = useState<{
    message: EventMessage;
    scope: 'everyone' | 'me';
  } | null>(null);
  const [toastHiddenId, setToastHiddenId] = useState<string | null>(null);
  const pressTimer = useRef<number | null>(null);
  // Conversation-list prefs (pin / delete / clear): local only,
  // localStorage-backed — the server never sees them.
  const [prefs, setPrefs] = useState<ThreadPrefs>(() => loadPrefs());
  // Loco AI chat (inside Messages): history lives on this device.
  const [aiMessages, setAiMessages] = useState<AiChatMsg[]>(() => loadAiHistory());
  const [aiSending, setAiSending] = useState(false);
  // Right-click / long-press menu on a conversation row.
  const [threadMenu, setThreadMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  // These four effects used to sit at the top of the component,
  // above the state they read — their dependency arrays are
  // evaluated during render, so the page threw "Cannot access ...
  // before initialization" on every open and landed on the error
  // boundary. They live below the declarations now; do not move
  // them back up. (Fix, 2026-11-06.)
  // Local-only prefs (pin / delete / clear) persist on this device.
  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);
  // AI chat history persists on this device only.
  useEffect(() => {
    try {
      window.localStorage.setItem(AI_HISTORY_KEY, JSON.stringify(aiMessages.slice(-AI_MAX_STORED)));
    } catch {
      // Storage full or unavailable — the chat still works for the session.
    }
  }, [aiMessages]);
  // (AI auto-scroll lives with the other scroll effects below —
  // it scrolls the window, so it must sit under the state it reads.)
  // Escape closes the conversation menu.
  useEffect(() => {
    if (!threadMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setThreadMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [threadMenu]);
  const [confirmThreadDelete, setConfirmThreadDelete] = useState<{
    key: string;
    name: string;
  } | null>(null);
  const [confirmThreadClear, setConfirmThreadClear] = useState<{
    key: string;
    name: string;
  } | null>(null);
  const threadPressTimer = useRef<number | null>(null);
  const threadTouchStart = useRef<{ x: number; y: number } | null>(null);
  const threadLongPressFired = useRef(false);
  const pollInFlight = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Reply state: the message being quoted in the composer. The quote
  // bar above the composer shows it; handleSend clears it instantly
  // on send tap (see below).
  const [replyTo, setReplyTo] = useState<EventMessage | null>(null);
  // Quote jump: the message id to highlight after jumpToQuoted.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Realtime: true once the ping channel is SUBSCRIBED — polling then
  // drops to a 30s safety net (see the polling effect below).
  const [realtimeLive, setRealtimeLive] = useState(false);
  // Typing indicator from the other side of the open thread.
  const [typing, setTyping] = useState<{ name: string; threadKey: string } | null>(null);
  const typingTimer = useRef<number | null>(null);
  const typingThrottle = useRef(0);
  // Pagination: the first page is the newest 50; "Load older" pages
  // backwards. Polls fetch only rows newer than the newest loaded.
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // M14: user-initiated loads surface their failure instead of
  // failing silently — the error line + Retry replace the old
  // "button stays for a retry" with no explanation.
  const [loadOlderError, setLoadOlderError] = useState('');
  const [jumpError, setJumpError] = useState('');
  // Scroll guard: auto-scroll only when already near the bottom;
  // otherwise a "New messages" pill appears instead of yanking the
  // reader away from older history.
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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Bubble elements by message id, for quote jumps (jumpToQuoted).
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  // Swipe-to-reply tracking (mobile): touch start point + time. A
  // right swipe (>60px, mostly horizontal, <500ms) starts a reply
  // and cancels the long-press menu timer.
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const meEmail = (currentUser?.email || '').toLowerCase();
  const queryEventId = searchParams.get('eventId') || '';
  // SECURITY FIX (P2-4): the deep link is /messages?eventId=x&to=organizer
  // — an opaque slug, never an email. The old ?with=<email> param is
  // deliberately ignored, so an organiser email can never leak via URL.
  const queryTo = searchParams.get('to') || '';

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
  const loadMessages = useCallback(
    async (silent = false) => {
      if (!currentUser?.email) return;
      if (!silent) setLoading(true);
      try {
        const page = await messagesService.getMessagesPage({ limit: 50 });
        setMessages(page.messages);
        reconcilePending(page.messages);
        setHasMore(page.hasMore);
        setLoadError('');
      } catch (err: any) {
        // Silent polls must never raise the red banner: a transient
        // failure (two tabs polling into a 429, a blip) is not a
        // broken inbox, and the last loaded list stays on screen.
        if (!silent) setLoadError(err?.message || 'Could not load messages.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [currentUser?.email, reconcilePending],
  );

  // Poll tick: fetch only rows newer than the newest loaded one and
  // merge them (dedupe by id). Every 10th tick does a full paged
  // reload instead, so edits / deletes / read flags from the other
  // side still arrive when Realtime is off.
  const pollNew = useCallback(async () => {
    if (!currentUser?.email) return;
    pollCountRef.current += 1;
    if (pollCountRef.current % 10 === 0) {
      await loadMessages(true);
      return;
    }
    const loaded = messagesRef.current;
    if (loaded.length === 0) {
      await loadMessages(true);
      return;
    }
    const since = loaded.reduce(
      (max, m) => ((m.createdAt || '') > max ? (m.createdAt as string) : max),
      '',
    );
    try {
      const page = await messagesService.getMessagesPage({ since });
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
  }, [currentUser?.email, loadMessages, reconcilePending]);

  useEffect(() => {
    loadMessages();
    // Poll interval depends on Realtime: 3s while polling is the only
    // delivery path, 30s safety net once the private channel is live
    // (full-payload events render immediately — see the subscribe
    // effect below). Each poll now fetches only new rows (pollNew),
    // not the whole history.
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
  }, [loadMessages, pollNew, realtimeLive]);

  // Apply one full-payload Realtime event to the local list (no
  // refetch). The payload carries no emails (names only), so a
  // message is filed into its thread via threadKey + a known
  // message from that thread (which supplies the emails). A
  // message for a thread we have never loaded falls back to a
  // paged reload, which creates the thread properly.
  const applyRealtimeMessage = useCallback(
    (data: RealtimeMessage) => {
      const key = data.threadKey || '';
      const known = key
        ? messagesRef.current.find((m) => threadKeyHash(m.eventId, m.senderEmail, m.recipientEmail) === key)
        : undefined;
      if (!known) {
        // New thread (or a message we cannot file): reload the page.
        loadMessages(true);
        return;
      }
      const otherEmail =
        known.senderEmail.toLowerCase() === meEmail ? known.recipientEmail : known.senderEmail;
      // The quote's sender is whoever wrote the quoted message, not
      // necessarily this message's sender — look it up when loaded.
      const quoted = data.replyToId
        ? messagesRef.current.find((m) => m.id === data.replyToId)
        : undefined;
      const merged: EventMessage = {
        ...known,
        id: data.id,
        eventId: data.eventId,
        eventTitle: data.eventTitle || known.eventTitle,
        senderEmail: data.own ? meEmail : otherEmail,
        senderName: data.senderName,
        recipientEmail: data.own ? otherEmail : meEmail,
        recipientName: known.recipientName,
        text: data.text,
        attachment: data.attachment,
        read: data.read,
        edited: data.edited,
        editedAt: data.editedAt,
        deletedForEveryone: data.deletedForEveryone,
        deletedAt: data.deletedAt,
        replyToId: data.replyToId,
        replySnapshot: data.replySnapshot
          ? {
              ...data.replySnapshot,
              senderEmail: quoted
                ? quoted.senderEmail
                : data.own
                  ? meEmail
                  : otherEmail,
            }
          : undefined,
        createdAt: data.createdAt,
        type: data.type,
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
      reconcilePending([merged]);
    },
    [meEmail, loadMessages, reconcilePending],
  );

  // Realtime on my PRIVATE channel (full payload, see
  // realtime-service.ts): messages render the moment they arrive,
  // with no refetch. Read receipts flip ✓ to ✓✓ live. Typing shows
  // in the open thread only. Without VITE_SUPABASE_* this is a
  // silent no-op and polling above stays at 3s.
  useEffect(() => {
    if (!meEmail) return;
    let unsubscribe = () => {};
    let cancelled = false;
    messagesService.getRealtimeChannel().then((channel) => {
      if (cancelled || !channel) return;
      unsubscribe = subscribeToPrivateChannel(
        channel,
        (ev: RealtimeFullEvent) => {
          if (ev.type === 'message' || ev.type === 'edited' || ev.type === 'deleted') {
            applyRealtimeMessage(ev.data);
          } else if (ev.type === 'read') {
            setMessages((prev) => prev.map((m) => (m.id === ev.id ? { ...m, read: true } : m)));
          } else if (ev.type === 'typing') {
            if (!ev.threadKey) return;
            // H9: the server sends the HASHED thread key
            // (threadKeyHash — payloads never carry emails), but the
            // selected thread's key is the RAW `eventId|a|b` key.
            // Comparing the two never matched, so typing never
            // showed. Normalise here: resolve the hash to the raw
            // key via a known message from that thread; if the
            // thread has no loaded message yet, keep the hash and
            // the render below compares against the hash too.
            const known = messagesRef.current.find(
              (m) => threadKeyHash(m.eventId, m.senderEmail, m.recipientEmail) === ev.threadKey,
            );
            setTyping({
              name: ev.name,
              threadKey: known
                ? threadKey(known.eventId, known.senderEmail, known.recipientEmail)
                : ev.threadKey,
            });
            if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
            typingTimer.current = window.setTimeout(() => setTyping(null), 3000);
          }
        },
        (status) => setRealtimeLive(status === 'SUBSCRIBED'),
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (typingTimer.current !== null) window.clearTimeout(typingTimer.current);
    };
  }, [meEmail, applyRealtimeMessage]);

  // Leaving the page inside an undo window must not resurrect a
  // confirmed delete: flush any still-pending deletes immediately.
  // (A full browser refresh inside the 3s window is the one exception
  // — the timers die with the page and the message comes back.)
  useEffect(() => {
    return () => {
      pendingDeletesRef.current.forEach((d) => {
        window.clearTimeout(d.timer);
        // 'everyone' deletes run as the sender; 'me' hides run as the
        // current user (meEmail is fixed at mount, so capturing it
        // in this mount-only effect is safe).
        const run =
          d.scope === 'everyone'
            ? messagesService.deleteForEveryone(d.id, d.message.senderEmail)
            : messagesService.hideMessage(d.id, meEmail);
        run.catch(() => {});
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link from an event page: /messages?eventId=x&to=organizer
  // prepares a fresh composer when no message exists yet (the first
  // send creates the thread server-side, with the server resolving the
  // recipient from the stored event). The organiser email is never in
  // the URL and never known to this page for a new thread.
  useEffect(() => {
    if (!queryEventId || queryTo !== 'organizer' || !currentUser?.email) return;
    const key = `${queryEventId}|organizer`;
    setSelectedKey(key);
    setMobileView('chat');
    let cancelled = false;
    eventsService
      .getEventById(queryEventId)
      .then((event) => {
        if (cancelled) return;
        setPendingThread((prev) =>
          prev && prev.key === key
            ? prev
            : {
                key,
                eventId: queryEventId,
                eventTitle: event?.title || 'Event',
                otherEmail: '',
                otherName: event?.organizer?.name || 'Organizer',
                messages: [],
                lastAt: '',
                unread: 0,
              },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setPendingThread({
          key,
          eventId: queryEventId,
          eventTitle: 'Event',
          otherEmail: '',
          otherName: 'Organizer',
          messages: [],
          lastAt: '',
          unread: 0,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [queryEventId, queryTo, currentUser?.email]);

  // Messages hidden by a confirmed (but not yet executed) delete stay
  // hidden through reloads inside the undo window — otherwise the 3s
  // poll would resurrect them before the toast expires.
  const visibleServerMessages = messages.filter(
    (m) => !pendingDeletes.some((d) => d.id === m.id),
  );
  // Clear chat hides every message at or before the clear moment, on
  // this device only. Filter before grouping so the row snippet,
  // lastAt and unread all follow the visible messages.
  const clearedMessages = visibleServerMessages.filter((m) => {
    const key = threadKey(m.eventId, m.senderEmail, m.recipientEmail);
    return !isMessageCleared(m.createdAt || '', prefs.clearedAt[key]);
  });
  const threads = groupThreads(clearedMessages, meEmail);
  const threadsWithPending: MessageThread[] = pendingThread
    ? threads.some((t) => t.key === pendingThread.key)
      ? threads
      : [pendingThread, ...threads]
    : threads;
  // Delete hides the row until a newer message arrives in that thread.
  const unhiddenThreads = threadsWithPending.filter(
    (t) => !isThreadHidden(t.key, t.lastAt, prefs.hidden),
  );
  const sortedRealThreads = sortThreadsByPin(unhiddenThreads, prefs.pinned);
  // The Loco AI chat is a built-in entry, not a server thread: it is
  // always first, never counts as unread, and never goes to
  // /api/messages. Its own clear-chat timestamp filters its history.
  const aiClearedAt = prefs.clearedAt[AI_THREAD_KEY];
  const visibleAiMessages =
    aiClearedAt === undefined
      ? aiMessages
      : aiMessages.filter((m) => m.ts > aiClearedAt);
  const aiThread: MessageThread = {
    key: AI_THREAD_KEY,
    eventId: '',
    eventTitle: 'AI Assistant',
    otherEmail: '',
    otherName: 'Loco',
    messages: [],
    lastAt:
      visibleAiMessages.length > 0
        ? new Date(visibleAiMessages[visibleAiMessages.length - 1].ts).toISOString()
        : '',
    unread: 0,
  };
  const allThreads: MessageThread[] = [aiThread, ...sortedRealThreads];
  const selected = allThreads.find((t) => t.key === selectedKey) || null;
  const isAiSelected = selectedKey === AI_THREAD_KEY;
  const threadQueryNorm = threadQuery.trim().toLowerCase();
  const filteredRealThreads = threadQueryNorm
    ? sortedRealThreads.filter((t) => {
        const last = t.messages.length > 0 ? snippetOf(t.messages[t.messages.length - 1]) : '';
        return (
          t.otherName.toLowerCase().includes(threadQueryNorm) ||
          t.eventTitle.toLowerCase().includes(threadQueryNorm) ||
          last.toLowerCase().includes(threadQueryNorm)
        );
      })
    : sortedRealThreads;
  // Loco stays at the top even while searching — it is a built-in
  // entry, not a server conversation.
  const visibleThreads = [aiThread, ...filteredRealThreads];
  const totalUnread = sortedRealThreads.reduce((n, t) => n + (t.unread || 0), 0);

  // Server messages plus in-flight ones for this thread, oldest
  // first. A pending bubble is dropped once its server copy shows up
  // (the 3s poll can beat the post's own response by a hair); the
  // createdAt guard keeps a genuinely repeated message ("Hi", "Hi")
  // from collapsing into the first copy. The window is the shared
  // PENDING_DEDUPE_WINDOW_MS (60s) — the same window
  // reconcileFailedPending uses, so a slow send never shows both
  // copies (M10).
  const visibleMessages: ChatMessage[] = selected
    ? [
        ...selected.messages,
        ...pending.filter(
          (p) =>
            p.threadKey === selected.key &&
            !selected.messages.some(
              (s) =>
                s.senderEmail === p.senderEmail &&
                (s.text || '') === (p.text || '') &&
                (s.attachment?.name || null) === (p.attachment?.name || null) &&
                Date.parse(s.createdAt) >= Date.parse(p.createdAt) &&
                Date.parse(s.createdAt) - Date.parse(p.createdAt) < PENDING_DEDUPE_WINDOW_MS,
            ),
        ),
      ].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    : [];

  // M10: identity of the visible tail (see lastVisibleKey). The
  // scroll effect below keys on this, not on list length alone.
  const tailKey = lastVisibleKey(visibleMessages);

  // The undo toast shows the most recent pending delete.
  const toastDelete =
    pendingDeletes.length > 0 ? pendingDeletes[pendingDeletes.length - 1] : null;
  const showDeleteToast = !!toastDelete && toastHiddenId !== toastDelete.id;

  // Menu eligibility, computed once per render: Delete for everyone is
  // the sender's only (a recipient uses Delete for me); Edit is own
  // text messages within 1 hour of sending (server enforces both too).
  const menuMessage = menu?.message || null;
  const menuIsOwn = !!menuMessage && menuMessage.senderEmail.toLowerCase() === meEmail;
  const menuCanEdit =
    !!menuMessage &&
    menuIsOwn &&
    !!menuMessage.text &&
    Date.now() - Date.parse(menuMessage.createdAt || '') < 60 * 60 * 1000;

  // Opening a thread marks its unread messages (addressed to me)
  // read — one batched call, then a local flag flip (no reload:
  // the server broadcasts the receipt to the sender live).
  useEffect(() => {
    if (!selected || !currentUser?.email) return;
    const unread = selected.messages.filter(
      (m) => m.recipientEmail.toLowerCase() === meEmail && !m.read,
    );
    if (unread.length === 0) return;
    const ids = unread.map((m) => m.id);
    messagesService.markMessagesRead(ids).then(() => {
      setMessages((prev) =>
        prev.map((m) => (ids.includes(m.id) ? { ...m, read: true } : m)),
      );
    });
  }, [selectedKey, messages, currentUser?.email, meEmail]);

  // Deep-link repair: the event page opens a dead pending key
  // (`<eventId>|organizer`) when no thread exists yet. As soon as the
  // real thread loads (or is created by the first send), switch to
  // its key — otherwise the pane goes blank after the first send,
  // because the pending key matches nothing anymore.
  useEffect(() => {
    if (!pendingThread || !queryEventId) return;
    const real = threads.find((t) => t.eventId === queryEventId);
    if (real) {
      setPendingThread(null);
      setSelectedKey(real.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, pendingThread, queryEventId]);

  // Draft persistence: a draft survives a thread switch and a reload
  // (sessionStorage, per thread) until it is sent successfully.
  const draftKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedKey || draftKeyRef.current === selectedKey) return;
    draftKeyRef.current = selectedKey;
    try {
      setDraft(sessionStorage.getItem(`locora_msg_draft_${selectedKey}`) || '');
    } catch {
      /* storage unavailable: drafts just don't persist */
    }
  }, [selectedKey]);
  useEffect(() => {
    if (!selectedKey) return;
    try {
      sessionStorage.setItem(`locora_msg_draft_${selectedKey}`, draft);
    } catch {
      /* ignore */
    }
  }, [draft, selectedKey]);

  // Auto-scroll only when already near the bottom; otherwise count
  // the arrivals for the "New messages" pill instead of yanking the
  // reader away from older history.
  // M10: count ARRIVALS only. This used to fire on any length
  // increase, so prepending 50 older rows (loadOlder) counted a
  // "new message" while reading history. The tail key only changes
  // when a row is appended at the end — a prepend, a same-tail
  // reload, an edit or a tombstone leaves it unchanged, so the
  // effect returns early and counts nothing.
  useEffect(() => {
    if (tailKey === lastSeenKeyRef.current) return;
    lastSeenKeyRef.current = tailKey;
    if (nearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } else {
      setNewCount((c) => c + 1);
    }
  }, [visibleMessages.length, tailKey]);

  // Switching threads always lands at the bottom, pill cleared.
  // The AI pane has no bottomRef (its list is page-scrolled), so it
  // scrolls the window to the document bottom instead.
  useEffect(() => {
    nearBottomRef.current = true;
    lastSeenKeyRef.current = '';
    setNewCount(0);
    if (selectedKey === AI_THREAD_KEY) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [selectedKey]);

  // The AI pane always lands at the bottom on a new message. The
  // page itself scrolls now (no inner list container), so this
  // scrolls the window — but never on mount or before the AI thread
  // is open, or opening the page would yank the reader to the bottom.
  const aiScrollInit = useRef(false);
  useEffect(() => {
    if (!isAiSelected) return;
    if (!aiScrollInit.current) {
      aiScrollInit.current = true;
      return;
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }, [aiMessages, aiSending, isAiSelected]);

  // Page-scroll equivalent of the old inner-list scroll handler: the
  // window is the scroller now, so near-bottom is measured against
  // the document. Attached once; it only reads refs + setNewCount.
  useEffect(() => {
    const onScroll = () => {
      const near = isNearBottom(document.documentElement);
      nearBottomRef.current = near;
      if (near) setNewCount(0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  function jumpToBottom() {
    nearBottomRef.current = true;
    setNewCount(0);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  // "Load older messages": one more page (50) before the oldest
  // loaded row, prepended. The scroll position stays roughly where
  // it was (the list grows upwards, the reader keeps reading).
  // A failure shows an error + Retry (M14) instead of failing
  // silently.
  async function loadOlder() {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    setLoadOlderError('');
    // Page scroll: the prepended rows push the reader's position
    // down by their height — remember the height now so the scroll
    // can be put back by exactly that much below.
    const prevHeight = document.documentElement.scrollHeight;
    try {
      const oldest = messages.reduce(
        (min, m) => ((m.createdAt || '') < min ? (m.createdAt as string) : min),
        messages[0].createdAt || '',
      );
      const page = await messagesService.getMessagesPage({ limit: 50, before: oldest });
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
      // Keep the message being read in place: scroll down by the
      // height the prepended rows added, after React has rendered them.
      window.setTimeout(() => {
        const delta = document.documentElement.scrollHeight - prevHeight;
        if (delta > 0) window.scrollBy(0, delta);
      }, 0);
    } catch {
      setLoadOlderError('Could not load older messages.');
    } finally {
      setLoadingOlder(false);
    }
  }

  function selectThread(key: string) {
    setSelectedKey(key);
    setMobileView('chat');
    setSendError('');
  }

  // ---- Replies ----
  // Typing indicator (throttled ~2s): the server broadcasts it to
  // the other side's private channel. Sending it on every keystroke
  // would spam the endpoint; the throttle keeps it to one call
  // per 2s of typing.
  function sendTyping() {
    if (!selected?.otherEmail || !currentUser?.email) return;
    const now = Date.now();
    if (now - typingThrottle.current < 2000) return;
    typingThrottle.current = now;
    messagesService.sendTyping({
      eventId: selected.eventId,
      recipientEmail: selected.otherEmail,
    });
  }

  function startReply(m: EventMessage) {
    if (m.deletedForEveryone) return;
    if ((m as ChatMessage).pending || (m as ChatMessage).failed) return;
    setReplyTo(m);
    composerRef.current?.focus();
  }

  // Tap a quote to jump to the original message: scroll it into view
  // and highlight it for 2s. If it is not in the loaded list (e.g. a
  // poll has not picked it up yet), reload once and retry; if it is
  // still missing (deleted, or not in this thread) show an error
  // (M14) instead of doing nothing — the quote itself already says
  // "This message was deleted" when the server scrubbed its snapshot.
  function jumpToQuoted(id: string) {
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
    // The quote may be older than the loaded page: fetch the full
    // list once (rare path) and retry the jump.
    if (!currentUser?.email) return;
    // L9 (audit #4): the full-list reload used to force hasMore=false,
    // hiding "Load older messages" even when older pages still exist
    // (getMessages caps at 10 pages / 500 messages). Preserve the
    // previous value — a genuinely complete list clears it on the next
    // "Load older" tap, which returns an empty page.
    const hadMore = hasMore;
    messagesService
      .getMessages(currentUser.email)
      .then((list) => {
        setMessages(list);
        setHasMore(hadMore);
        window.setTimeout(() => {
          if (!highlight(messageRefs.current.get(id))) {
            setJumpError('Could not find that message — it may have been deleted.');
          }
        }, 300);
      })
      .catch(() => {
        setJumpError('Could not load the quoted message.');
      });
  }

  // Block state is per-session: the server does not expose blocks on
  // read (GET never lists block rows), so the toggle resets on thread
  // change and block calls are idempotent server-side.
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    setBlocked(false);
    // A quote belongs to the thread it was started in.
    setReplyTo(null);
  }, [selectedKey]);

  async function handleBlockToggle() {
    if (!selected || !selected.otherEmail) return;
    closeMenu();
    try {
      if (blocked) {
        await messagesService.unblockUser(selected.eventId, selected.otherEmail);
        setBlocked(false);
      } else {
        await messagesService.blockUser(selected.eventId, selected.otherEmail);
        setBlocked(true);
      }
    } catch (err: any) {
      setSendError(err?.message || 'Could not change the block. Please try again.');
    }
  }

  // The actual network delivery, shared by fresh sends and retries:
  // upload first (if a file), then post the message. Returns the
  // created server copy so the caller can swap it in immediately.
  // Throws on failure.
  async function deliver(input: {
    eventId: string;
    recipientEmail: string;
    organizerId?: string;
    text: string;
    file?: File | null;
    idempotencyKey?: string;
    replyToId?: string;
    // Upload progress (0..1) for the pending bubble's progress bar.
    onProgress?: (fraction: number) => void;
  }): Promise<EventMessage> {
    if (!currentUser?.email) throw new Error('Sign in to send messages.');
    let attachmentMeta: { name: string; size: number; type: string; path: string } | undefined;
    if (input.file) {
      const validationError = validateAttachment(input.file);
      if (validationError) throw new Error(validationError);
      const { uploadUrl, path } = await messagesService.requestUploadUrl({
        eventId: input.eventId,
        senderEmail: currentUser.email,
        recipientEmail: input.recipientEmail,
        organizerId: input.organizerId,
        fileName: input.file.name,
        fileSize: input.file.size,
        fileType: input.file.type,
      });
      try {
        await messagesService.uploadFile(uploadUrl, input.file, input.onProgress);
      } catch (err) {
        // Upload itself failed: nothing was stored, nothing to clean.
        throw err;
      }
      attachmentMeta = { name: input.file.name, size: input.file.size, type: input.file.type, path };
    }
    try {
      return await messagesService.sendMessage({
        eventId: input.eventId,
        senderEmail: currentUser.email,
        senderName: currentUser.name,
        recipientEmail: input.recipientEmail || undefined,
        organizerId: input.organizerId,
        text: input.text,
        attachment: attachmentMeta,
        idempotencyKey: input.idempotencyKey,
        replyToId: input.replyToId,
      });
    } catch (err) {
      // The file uploaded but the message did not send: delete the
      // orphaned object instead of leaving it public in Storage
      // forever, then report the original failure.
      if (attachmentMeta) {
        try {
          await messagesService.deleteUpload(attachmentMeta.path);
        } catch {
          /* best effort: the orphan cleanup must not mask the send error */
        }
      }
      throw err;
    }
  }

  // Optimistic send: the bubble appears instantly as a normal sent
  // message — no "Sending…" limbo. On post success the server copy
  // swaps in during the same render (no gap, no duplicate, and the
  // message now has its real id, so menus work on it at once). The
  // silent reload after that is just consistency — visually a no-op.
  // On failure the bubble stays with a Retry button — a failed send
  // is never silently dropped, and the composer is never blocked
  // waiting on the network.
  async function handleSend() {
    if (!currentUser?.email || !selected) return;
    const text = draft.trim();
    if (!text && !file) return;
    const sendingFile = file;
    const replyingTo = replyTo;
    const temp: ChatMessage = {
      id: newTempId(),
      eventId: selected.eventId,
      eventTitle: selected.eventTitle,
      senderEmail: currentUser.email,
      senderName: currentUser.name,
      recipientEmail: selected.otherEmail,
      text,
      attachment: sendingFile
        ? { name: sendingFile.name, size: sendingFile.size, type: sendingFile.type, url: '', path: '' }
        : null,
      read: false,
      createdAt: new Date().toISOString(),
      threadKey: selected.key,
      pending: true,
      uploadProgress: sendingFile ? 0 : undefined,
      localFile: sendingFile || undefined,
      localPreview:
        sendingFile && sendingFile.type.startsWith('image/')
          ? URL.createObjectURL(sendingFile)
          : undefined,
      idempotencyKey: `msg-${selected.key}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      // Optimistic quote: the server rebuilds the frozen snapshot on
      // send, so this local copy is display-only until the server
      // copy swaps in.
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
    // The composer clears INSTANTLY on send tap — BEFORE the POST
    // runs (it takes ~3s). The text / file / reply live on in the
    // optimistic bubble, which carries them for Retry if the send
    // fails, so clearing early can never lose them — and the box
    // must never hold text that is already showing as sent.
    setDraft('');
    setFile(null);
    setReplyTo(null);
    setSendError('');
    try {
      const created = await deliver({
        eventId: selected.eventId,
        recipientEmail: selected.otherEmail,
        organizerId: selected.otherEmail ? undefined : 'organizer',
        text,
        file: sendingFile,
        idempotencyKey: temp.idempotencyKey,
        replyToId: replyingTo?.id,
        onProgress: (f) =>
          setPending((prev) =>
            prev.map((p) => (p.id === temp.id ? { ...p, uploadProgress: f } : p)),
          ),
      });
      setPending((prev) => prev.filter((p) => p.id !== temp.id));
      // Dedupe by id: the 3s poll can already have fetched this very
      // message before the post's own response arrived — appending
      // blindly showed it twice until the next poll.
      setMessages((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
      setPendingThread(null);
      // The server already broadcast the full payload to the other
      // side's private channel — no client ping is needed anymore.
      // Switch to the real thread key at once (the deep-link effect
      // also does this on the next poll, but waiting for it left the
      // pane blank after the first send).
      setSelectedKey(threadKey(created.eventId, created.senderEmail, created.recipientEmail));
    } catch (err: any) {
      setPending((prev) =>
        prev.map((p) => (p.id === temp.id ? { ...p, pending: false, failed: true } : p)),
      );
      setSendError(err?.message || 'Could not send the message. Please try again.');
    }
  }

  async function retrySend(temp: ChatMessage) {
    if (!currentUser?.email) return;
    setPending((prev) =>
      prev.map((p) => (p.id === temp.id ? { ...p, failed: false, pending: true } : p)),
    );
    // Same instant-clear rule as handleSend: the composer is already
    // empty (it cleared on the first tap), but clear again so a
    // retry can never leave a stale draft/file behind.
    setDraft('');
    setFile(null);
    setReplyTo(null);
    setSendError('');
    try {
      const created = await deliver({
        eventId: temp.eventId,
        recipientEmail: temp.recipientEmail,
        text: temp.text || '',
        file: temp.localFile || null,
        idempotencyKey: temp.idempotencyKey,
        replyToId: temp.replyToId,
        onProgress: (f) =>
          setPending((prev) =>
            prev.map((p) => (p.id === temp.id ? { ...p, uploadProgress: f } : p)),
          ),
      });
      setPending((prev) => prev.filter((p) => p.id !== temp.id));
      setMessages((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
      setSelectedKey(threadKey(created.eventId, created.senderEmail, created.recipientEmail));
    } catch (err: any) {
      setPending((prev) =>
        prev.map((p) => (p.id === temp.id ? { ...p, pending: false, failed: true } : p)),
      );
      setSendError(err?.message || 'Could not send the message. Please try again.');
    }
  }

  // ---- Press-and-hold / right-click menu ----
  function openMenu(m: EventMessage, clientX: number, clientY: number) {
    // In-flight bubbles are not on the server yet: nothing to delete
    // or edit there (failed ones get an inline Retry instead).
    if ((m as ChatMessage).pending || (m as ChatMessage).failed) return;
    const width = 224;
    const height = 280;
    setMenu({
      x: Math.max(8, Math.min(clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - height - 8)),
      message: m,
    });
  }

  function closeMenu() {
    setMenu(null);
  }

  // ---- Conversation list menu (pin / delete / clear) ----
  // All local, localStorage-backed: the server never sees them.
  function openThreadMenu(key: string, clientX: number, clientY: number) {
    const width = 224;
    const height = 200;
    setThreadMenu({
      x: Math.max(8, Math.min(clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - height - 8)),
      key,
    });
  }

  function closeThreadMenu() {
    setThreadMenu(null);
  }

  function clearThreadPress() {
    if (threadPressTimer.current !== null) {
      window.clearTimeout(threadPressTimer.current);
      threadPressTimer.current = null;
    }
  }

  function onThreadTouchStart(e: React.TouchEvent, key: string) {
    const touch = e.touches[0];
    clearThreadPress();
    threadTouchStart.current = { x: touch.clientX, y: touch.clientY };
    threadLongPressFired.current = false;
    threadPressTimer.current = window.setTimeout(() => {
      threadLongPressFired.current = true;
      if (typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate(10);
        } catch {
          /* vibration unsupported — the menu still opens */
        }
      }
      openThreadMenu(key, touch.clientX, touch.clientY);
    }, 500);
  }

  // A scroll (move > 10px) cancels the long-press menu timer, so
  // swiping through the list never also opens the menu.
  function onThreadTouchMove(e: React.TouchEvent) {
    const start = threadTouchStart.current;
    if (!start) return;
    const touch = e.touches[0];
    if (Math.abs(touch.clientX - start.x) > 10 || Math.abs(touch.clientY - start.y) > 10) {
      clearThreadPress();
      threadTouchStart.current = null;
    }
  }

  function onThreadTouchEnd() {
    threadTouchStart.current = null;
    clearThreadPress();
  }

  function togglePinThread(key: string) {
    closeThreadMenu();
    setPrefs((prev) => ({
      ...prev,
      pinned: prev.pinned.includes(key)
        ? prev.pinned.filter((k) => k !== key)
        : [...prev.pinned, key],
    }));
  }

  function askDeleteThread(key: string, name: string) {
    closeThreadMenu();
    setConfirmThreadDelete({ key, name });
  }

  function confirmDeleteThreadNow() {
    if (!confirmThreadDelete) return;
    const { key } = confirmThreadDelete;
    setConfirmThreadDelete(null);
    setPrefs((prev) => ({ ...prev, hidden: { ...prev.hidden, [key]: Date.now() } }));
    if (pendingThread && pendingThread.key === key) setPendingThread(null);
    if (selectedKey === key) {
      setSelectedKey(null);
      setMobileView('list');
    }
  }

  function askClearThread(key: string, name: string) {
    closeThreadMenu();
    setConfirmThreadClear({ key, name });
  }

  function confirmClearThreadNow() {
    if (!confirmThreadClear) return;
    const { key } = confirmThreadClear;
    setConfirmThreadClear(null);
    setPrefs((prev) => ({ ...prev, clearedAt: { ...prev.clearedAt, [key]: Date.now() } }));
  }

  // ---- Loco AI chat (inside Messages) ----
  // Same /api/chatbot call as the floating widget, via the shared
  // helper. A failed provider is the friendly fallback text, never
  // a raw error — and the keys are the same ones the widget uses, so
  // if they are rejected, Loco here shows the same fallback.
  async function handleAiSend(rawText?: string) {
    const text = (rawText ?? draft).trim();
    if (!text || aiSending) return;
    const userMsg: AiChatMsg = { role: 'user', text, ts: Date.now() };
    const history = [...visibleAiMessages, userMsg]
      .slice(-MAX_CHATBOT_SENT_HISTORY)
      .map((m) => ({ role: m.role, text: m.text }));
    setAiMessages((prev) => [...prev, userMsg]);
    setDraft('');
    setAiSending(true);
    try {
      const reply = await sendChatbotMessage(text, history);
      setAiMessages((prev) => [...prev, { role: 'assistant', text: reply, ts: Date.now() }]);
    } finally {
      setAiSending(false);
    }
  }

  function clearPress() {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  function onBubbleTouchStart(e: React.TouchEvent, m: EventMessage) {
    const touch = e.touches[0];
    clearPress();
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, t: Date.now() };
    pressTimer.current = window.setTimeout(
      () => openMenu(m, touch.clientX, touch.clientY),
      500,
    );
  }

  // Swipe right on a bubble (>60px, mostly horizontal, <500ms)
  // starts a reply. Moving far enough cancels the long-press menu
  // timer, so a swipe never also opens the menu.
  function onBubbleTouchMove(e: React.TouchEvent) {
    const start = touchStartRef.current;
    if (!start) return;
    const touch = e.touches[0];
    if (Math.abs(touch.clientX - start.x) > 60) clearPress();
  }

  function onBubbleTouchEnd(e: React.TouchEvent, m: EventMessage) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    clearPress();
    if (!start) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (dx > 60 && Math.abs(dy) < 40 && Date.now() - start.t < 500) {
      startReply(m);
    }
  }

  // Menu actions only OPEN the confirm dialog; nothing is deleted yet.
  function askDelete(m: EventMessage, scope: 'everyone' | 'me') {
    closeMenu();
    setConfirmDelete({ message: m, scope });
  }

  // Confirmed: hide locally at once, show the Undo toast, and only
  // run the real server call when the 3s window expires. If that call
  // then fails, the message is no longer hidden locally, so it comes
  // back on the next reload and the failure is shown — never a silent
  // pretend-delete.
  function confirmDeleteNow() {
    if (!confirmDelete) return;
    const { message, scope } = confirmDelete;
    setConfirmDelete(null);
    setToastHiddenId(null);
    // BUG (fixed): the old code dropped the local hide filter FIRST
    // and then fired the ~2s server call with no reload after it, so
    // the "deleted" message popped back into view and lingered until
    // a manual refresh (or a lucky poll) fetched the fresh list.
    // Now the filter stays on until the server call succeeds AND the
    // local list is updated — the message can never reappear.
    const timer = window.setTimeout(async () => {
      try {
        if (scope === 'everyone') {
          await messagesService.deleteForEveryone(message.id, message.senderEmail);
        } else {
          await messagesService.hideMessage(message.id, meEmail);
        }
        // Remove locally at once; the other side gets the tombstone
        // live via the server broadcast — no reload needed.
        setMessages((prev) => prev.filter((m) => m.id !== message.id));
        // Delete-for-me is local only and needs no broadcast.
      } catch (err: any) {
        // Server delete failed: the filter drops below, so the message
        // comes back and the failure is shown — never a silent
        // pretend-delete.
        setSendError(err?.message || 'Could not delete the message. Please try again.');
      }
      setPendingDeletes((prev) => prev.filter((d) => d.id !== message.id));
    }, 3000);
    setPendingDeletes((prev) => [
      ...prev.filter((d) => d.id !== message.id),
      { id: message.id, scope, message, timer },
    ]);
  }

  // Undo cancels the pending delete; the message was never removed
  // server-side, so it simply reappears.
  function undoDelete() {
    const last = pendingDeletes[pendingDeletes.length - 1];
    if (!last) return;
    window.clearTimeout(last.timer);
    setPendingDeletes((prev) => prev.filter((d) => d.id !== last.id));
    setToastHiddenId(null);
  }

  async function handleSaveEdit() {
    if (!editingId || !currentUser?.email) return;
    const text = editDraft.trim();
    if (!text) return;
    const id = editingId;
    const original = messages.find((m) => m.id === id);
    // Optimistic: the edited text shows at once instead of after the
    // ~2s patch + ~2s reload round trip. On failure it reverts.
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, text, edited: true, editedAt: new Date().toISOString() } : m,
      ),
    );
    setEditingId(null);
    setEditDraft('');
    try {
      await messagesService.editMessage(id, currentUser.email, text);
      // The server broadcasts the edited payload live; the optimistic
      // text above is already showing, so no reload is needed.
    } catch (err: any) {
      if (original) {
        setMessages((prev) => prev.map((m) => (m.id === id ? original : m)));
      }
      setSendError(err?.message || 'Could not edit the message.');
    }
  }

  if (!currentUser) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-md mx-auto bg-white rounded-2xl border border-[#E5E1D8] shadow-sm p-8 text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-full bg-[#F4F1EA] flex items-center justify-center">
            <MessageCircle className="w-8 h-8 text-[#1E3F35]" />
          </div>
          <h1 className="font-editorial text-xl font-bold text-[#1E2320]">Sign in to see your messages</h1>
          <p className="text-xs text-[#5F635D] leading-relaxed">
            Messages with event organizers live here once you are signed in.
          </p>
          <Link
            to="/login"
            className="inline-block px-4 py-2 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-full bg-[#1E3F35] text-white flex items-center justify-center shrink-0">
          <MessageCircle className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h1 className="font-editorial text-2xl font-bold text-[#1E2320] leading-tight">Messages</h1>
          <p className="text-xs text-[#5F635D]">Chats with event organizers, all in one place.</p>
        </div>
        {totalUnread > 0 && (
          <span className="ml-auto shrink-0 px-2.5 py-1 rounded-full bg-[#1E3F35] text-white text-[11px] font-bold">
            {totalUnread > 99 ? '99+' : totalUnread} unread
          </span>
        )}
      </div>

      {loadError && (
        <div className="mb-4 bg-white rounded-xl border border-red-200 p-4 flex items-center justify-between gap-3">
          <p className="text-xs text-red-700">{loadError}</p>
          <button
            type="button"
            onClick={() => loadMessages()}
            className="px-3 py-1.5 text-xs font-semibold text-[#1E2320] bg-[#F4F1EA] hover:bg-[#EBE7DF] border border-[#E2DFD8] rounded-lg shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Page-scroll layout: the card grows with its content and the
          whole page scrolls with the browser's main scrollbar — no
          fixed height and no inner scroll container on either pane,
          so the chat fits every resolution and the composer scrolls
          with the page. */}
      <div className="flex items-stretch bg-white rounded-2xl border border-[#E5E1D8] shadow-sm overflow-hidden">
        {/* Thread list */}
        <div
          className={`w-full md:w-[340px] lg:w-[360px] shrink-0 flex flex-col border-r border-[#E5E1D8] ${
            mobileView === 'chat' ? 'hidden md:flex' : 'flex'
          }`}
        >
          <div className="px-4 pt-4 pb-3 border-b border-[#EBE7DF] space-y-3 shrink-0">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold tracking-wider uppercase text-[#5F635D]">Conversations</p>
              <span className="text-[11px] text-[#8C887E]">
                {allThreads.length} {allThreads.length === 1 ? 'chat' : 'chats'}
              </span>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8C887E]" />
              <input
                type="text"
                value={threadQuery}
                onChange={(e) => setThreadQuery(e.target.value)}
                placeholder="Search people or events…"
                aria-label="Search conversations"
                className="w-full pl-9 pr-3 py-2 text-xs bg-[#FAF8F5] border border-[#E2DFD8] rounded-lg text-[#1E2320] placeholder:text-[#8C887E] focus:outline-hidden focus:border-[#1E3F35]"
              />
            </div>
          </div>
          {loading ? (
            <div className="p-4 space-y-3" aria-label="Loading conversations">
              {[0, 1, 2].map((i) => (
                <div key={i} className="animate-pulse space-y-2">
                  <div className="h-3 w-2/3 bg-[#EBE7DF] rounded" />
                  <div className="h-2.5 w-1/2 bg-[#F4F1EA] rounded" />
                </div>
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-[#EBE7DF]">
              {visibleThreads.map((t) => {
                const isAi = t.key === AI_THREAD_KEY;
                const isPinned = prefs.pinned.includes(t.key);
                const lastSnippet = isAi
                  ? visibleAiMessages.length > 0
                    ? visibleAiMessages[visibleAiMessages.length - 1].text
                    : 'Ask me anything about Locora'
                  : t.messages.length > 0
                    ? snippetOf(t.messages[t.messages.length - 1])
                    : 'No messages yet';
                return (
                  <li
                    key={t.key}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      clearThreadPress();
                      openThreadMenu(t.key, e.clientX, e.clientY);
                    }}
                    onTouchStart={(e) => onThreadTouchStart(e, t.key)}
                    onTouchMove={onThreadTouchMove}
                    onTouchEnd={onThreadTouchEnd}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        // A long-press that opened the menu must not
                        // also select the row on release.
                        if (threadLongPressFired.current) {
                          threadLongPressFired.current = false;
                          return;
                        }
                        selectThread(t.key);
                      }}
                      className={`w-full text-left px-4 py-3 flex gap-3 hover:bg-[#FAF8F5] transition-colors select-none ${
                        t.key === selectedKey ? 'bg-[#F4F1EA] shadow-[inset_3px_0_0_#1E3F35]' : ''
                      }`}
                      style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
                    >
                      {isAi ? (
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1E3F35] font-editorial text-base text-white"
                          aria-hidden="true"
                        >
                          L
                        </span>
                      ) : (
                        <Avatar
                          src=""
                          name={t.otherName}
                          className="w-10 h-10 rounded-full shrink-0"
                          initialClassName="text-sm"
                        />
                      )}
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-[#1E2320] truncate">{t.otherName}</span>
                          {isPinned && <Pin className="h-3 w-3 shrink-0 text-[#8C887E]" aria-label="Pinned" />}
                          {t.lastAt && (
                            <span className="ml-auto text-[10px] text-[#8C887E] whitespace-nowrap shrink-0">
                              {fmtTime(t.lastAt)}
                            </span>
                          )}
                        </span>
                        <span className="block text-[11px] font-medium text-[#1E3F35]/80 truncate mt-0.5">
                          {t.eventTitle}
                        </span>
                        <span className="flex items-center justify-between gap-2 mt-0.5">
                          <span
                            className={`block text-[11px] truncate ${
                              t.unread > 0 ? 'font-semibold text-[#1E2320]' : 'text-[#5F635D]'
                            }`}
                          >
                            {lastSnippet}
                          </span>
                          {t.unread > 0 && (
                            <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-[#1E3F35] text-white text-[10px] font-bold flex items-center justify-center">
                              {t.unread > 99 ? '99+' : t.unread}
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {sortedRealThreads.length === 0 && !threadQueryNorm && (
                <li className="px-4 py-6 text-center space-y-2">
                  <p className="text-xs font-semibold text-[#1E2320]">No messages yet</p>
                  <p className="text-[11px] text-[#5F635D] leading-relaxed">
                    Open an event and tap “Message organizer” to start a conversation.
                  </p>
                  <Link
                    to="/discover"
                    className="inline-block px-4 py-2 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors"
                  >
                    Discover events
                  </Link>
                </li>
              )}
              {threadQueryNorm && filteredRealThreads.length === 0 && (
                <li className="px-4 py-6 text-center space-y-2">
                  <p className="text-xs font-semibold text-[#1E2320]">
                    No conversations match “{threadQuery.trim()}”
                  </p>
                  <button
                    type="button"
                    onClick={() => setThreadQuery('')}
                    className="text-[11px] font-semibold text-[#1E3F35] hover:underline"
                  >
                    Clear search
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Chat pane */}
        <div
          className={`w-full md:flex-1 min-w-0 flex flex-col ${
            mobileView === 'chat' ? 'flex' : 'hidden md:flex'
          }`}
        >
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center space-y-3">
              <div className="w-16 h-16 rounded-full bg-[#F4F1EA] flex items-center justify-center">
                <MessageCircle className="w-7 h-7 text-[#1E3F35]" />
              </div>
              <p className="text-sm font-semibold text-[#1E2320]">Select a conversation</p>
              <p className="text-xs text-[#5F635D] max-w-xs leading-relaxed">
                Choose a chat on the left to read and reply — or start one from an event page.
              </p>
            </div>
          ) : (
            <>
              {isAiSelected ? (
                <div className="px-4 py-3 border-b border-[#EBE7DF] bg-white flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={() => setMobileView('list')}
                    className="md:hidden p-1.5 -ml-1 rounded-lg hover:bg-[#F4F1EA] text-[#5F635D]"
                    aria-label="Back to conversations"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1E3F35] font-editorial text-base text-white"
                    aria-hidden="true"
                  >
                    L
                  </span>
                  <div className="min-w-0">
                    <p className="font-editorial text-[15px] leading-tight text-[#1E2320] truncate">Loco</p>
                    <p className="flex items-center gap-1.5 text-[11px] text-[#5F635D]">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                      Locora assistant · Online
                    </p>
                  </div>
                </div>
              ) : (
              <div className="px-4 py-3 border-b border-[#EBE7DF] bg-white flex items-center gap-3 shrink-0">
                <button
                  type="button"
                  onClick={() => setMobileView('list')}
                  className="md:hidden p-1.5 -ml-1 rounded-lg hover:bg-[#F4F1EA] text-[#5F635D]"
                  aria-label="Back to conversations"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <Avatar
                  src=""
                  name={selected.otherName}
                  className="w-9 h-9 rounded-full shrink-0"
                  initialClassName="text-xs"
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-[#1E2320] truncate">{selected.otherName}</p>
                  <p className="text-[11px] text-[#5F635D] truncate">{selected.eventTitle}</p>
                </div>
                {selected.otherEmail && (
                  <button
                    type="button"
                    onClick={handleBlockToggle}
                    title={blocked ? 'Allow messages from this person again' : 'Stop messages in this conversation'}
                    className="ml-auto px-3 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 border border-rose-200 rounded-lg shrink-0"
                  >
                    {blocked ? 'Unblock' : 'Block'}
                  </button>
                )}
              </div>
              )}

              {isAiSelected ? (
                <div className="p-4 sm:p-5 space-y-3 bg-[#FAF8F5]">
                  {visibleAiMessages.length === 0 && !aiSending ? (
                    <div className="rounded-2xl border border-[#E7E3DB] bg-white p-5 max-w-md mx-auto mt-6">
                      <p className="font-editorial text-base text-[#1E2320]">Hi, I&apos;m Loco</p>
                      <p className="mt-1 text-sm leading-relaxed text-[#5F635D]">
                        Ask me anything about Locora — finding events, creating one, teams, refunds, or your bookings.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {CHATBOT_SUGGESTIONS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => void handleAiSend(s)}
                            className="rounded-full border border-[#1E3F35]/25 bg-[#FAF8F5] px-3.5 py-2 text-xs font-medium text-[#1E3F35] transition hover:bg-[#1E3F35] hover:text-white"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    visibleAiMessages.map((m, i) => (
                      <div
                        key={`${m.ts}-${i}`}
                        className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={
                            m.role === 'user'
                              ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-[#1E3F35] px-4 py-2.5 text-sm leading-relaxed text-white'
                              : 'max-w-[85%] rounded-2xl rounded-bl-sm border border-[#E5E1D8] bg-white px-4 py-2.5 text-sm leading-relaxed text-[#1E2320] shadow-xs'
                          }
                        >
                          <span className="whitespace-pre-wrap break-words">{m.text}</span>
                        </div>
                      </div>
                    ))
                  )}
                  {aiSending && (
                    <div className="flex justify-start">
                      <div
                        className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-[#E7E3DB] bg-white px-4 py-3"
                        aria-label="Loco is typing"
                      >
                        <span className="h-2 w-2 animate-bounce rounded-full bg-[#5F635D]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-[#5F635D] [animation-delay:150ms]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-[#5F635D] [animation-delay:300ms]" />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
              <div className="p-4 sm:p-5 space-y-3 bg-[#FAF8F5]">
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
                {jumpError && (
                  <p className="text-[11px] text-rose-600 text-center">{jumpError}</p>
                )}
                {visibleMessages.length === 0 ? (
                  <p className="text-xs text-[#5F635D] text-center pt-8">
                    No messages yet. Say hello — the organizer will get an email alert.
                  </p>
                ) : (
                  visibleMessages.map((m, idx) => {
                    const mine = m.senderEmail.toLowerCase() === meEmail;
                    const isEditing = editingId === m.id;
                    const prev = idx > 0 ? visibleMessages[idx - 1] : null;
                    const showDay = !prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt);
                    return (
                      <React.Fragment key={m.id}>
                        {showDay && (
                          <div className="flex justify-center pt-1">
                            <span className="text-[10px] font-semibold text-[#8C887E] bg-[#F4F1EA] rounded-full px-3 py-1">
                              {dayLabel(m.createdAt)}
                            </span>
                          </div>
                        )}
                      <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          ref={(el) => {
                            if (el) messageRefs.current.set(m.id, el);
                            else messageRefs.current.delete(m.id);
                          }}
                          className={`max-w-[85%] rounded-2xl px-3 py-2 space-y-1 select-none ${
                            mine
                              ? 'bg-[#1E3F35] text-white rounded-br-md'
                              : 'bg-white text-[#1E2320] rounded-bl-md border border-[#E5E1D8] shadow-xs'
                          }${highlightId === m.id ? ' ring-2 ring-[#C25E00]' : ''}`}
                          style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
                          // L9 (audit #4): reply was pointer-only
                          // (double-click / right-click / swipe). The
                          // bubble is now keyboard-focusable: Enter
                          // starts a reply, exactly like double-click.
                          // The target guard keeps Enter inside the
                          // edit textarea / quote button from replying.
                          tabIndex={0}
                          aria-label={`Message from ${mine ? 'you' : m.senderName || m.senderEmail}. Press Enter to reply.`}
                          onKeyDown={(e) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              startReply(m);
                            }
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            clearPress();
                            openMenu(m, e.clientX, e.clientY);
                          }}
                          onDoubleClick={() => startReply(m)}
                          onTouchStart={(e) => onBubbleTouchStart(e, m)}
                          onTouchEnd={(e) => onBubbleTouchEnd(e, m)}
                          onTouchMove={(e) => onBubbleTouchMove(e)}
                        >
                          {isEditing ? (
                            <div className="space-y-2 min-w-[220px]">
                              <textarea
                                value={editDraft}
                                onChange={(e) => setEditDraft(e.target.value)}
                                rows={2}
                                aria-label="Edit message"
                                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-2 text-[#1E2320] resize-none"
                              />
                              <div className="flex gap-2 justify-end">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingId(null);
                                    setEditDraft('');
                                  }}
                                  className="px-3 py-1.5 text-[11px] font-semibold text-white/80 hover:text-white"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={handleSaveEdit}
                                  disabled={!editDraft.trim()}
                                  className="px-3 py-1.5 text-[11px] font-semibold bg-white text-[#1E3F35] rounded-lg disabled:opacity-60"
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          ) : m.deletedForEveryone ? (
                            <p className="text-xs leading-relaxed italic opacity-70">
                              This message was deleted
                            </p>
                          ) : (
                            <>
                              <QuoteView m={m} meEmail={meEmail} onJump={jumpToQuoted} />
                              {m.text && (
                                <p className="text-xs leading-relaxed whitespace-pre-wrap break-words">{m.text}</p>
                              )}
                              {m.pending && m.localPreview ? (
                                <img
                                  src={m.localPreview}
                                  alt={m.attachment?.name || 'Uploading image'}
                                  className="max-h-64 max-w-full rounded-lg object-contain bg-[#F4F1EA]"
                                />
                              ) : m.pending && m.attachment ? (
                                <span className="text-xs opacity-80">
                                  {m.attachment.name} · {formatFileSize(m.attachment.size)}
                                </span>
                              ) : (
                                <AttachmentView m={m} />
                              )}
                              {m.pending && typeof m.uploadProgress === 'number' && m.uploadProgress < 1 && (
                                <span className="block">
                                  <span className="block h-1 bg-white/20 rounded-full overflow-hidden">
                                    <span
                                      className="block h-full bg-white/80 rounded-full"
                                      style={{ width: `${Math.round(m.uploadProgress * 100)}%` }}
                                    />
                                  </span>
                                  <span className="text-[10px] opacity-80">
                                    Uploading… {Math.round(m.uploadProgress * 100)}%
                                  </span>
                                </span>
                              )}
                              <p className={`text-[10px] ${mine ? 'text-white/70' : 'text-[#8C887E]'}`}>
                                {fmtChatTime(m.createdAt)}
                                {m.edited ? ' · edited' : ''}
                                {mine && !m.pending && !m.failed && (
                                  <span> · {m.read ? '✓✓ Seen' : '✓ Sent'}</span>
                                )}
                              </p>
                              {m.failed && (
                                <span className="flex items-center gap-2">
                                  <span className="text-[11px] font-semibold text-red-300">Failed to send</span>
                                  <button
                                    type="button"
                                    onClick={() => retrySend(m)}
                                    className="text-[11px] font-semibold underline"
                                  >
                                    Retry
                                  </button>
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      </React.Fragment>
                    );
                  })
                )}
                {newCount > 0 && (
                  <div className="pointer-events-none fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 justify-center">
                    <button
                      type="button"
                      onClick={jumpToBottom}
                      className="pointer-events-auto px-3 py-1.5 text-[11px] font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-full shadow-lg"
                    >
                      {newCount} new message{newCount === 1 ? '' : 's'} ↓
                    </button>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
              )}

              {isAiSelected ? (
              <div className="p-3 sm:p-4 border-t border-[#EBE7DF] bg-white space-y-2 shrink-0">
                <div className="flex items-end gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleAiSend();
                      }
                    }}
                    placeholder="Ask about Locora…"
                    aria-label="Message Loco"
                    rows={1}
                    disabled={aiSending}
                    className="flex-1 min-w-0 text-xs bg-white border border-[#E2DFD8] rounded-2xl px-4 py-2.5 text-[#1E2320] focus:border-[#1E3F35] resize-none disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => void handleAiSend()}
                    disabled={!draft.trim() || aiSending}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1E3F35] text-white transition hover:bg-[#163028] disabled:opacity-60"
                    aria-label="Send message"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-[10px] text-[#8C887E]">
                  Loco answers questions about Locora only — it never sees your private info.
                </p>
              </div>
              ) : (
              <div className="p-3 sm:p-4 border-t border-[#EBE7DF] bg-white space-y-2 shrink-0">
                {typing &&
                  (typing.threadKey === selected.key ||
                    typing.threadKey === threadKeyHash(selected.eventId, meEmail, selected.otherEmail)) && (
                  <p className="text-[11px] text-[#5F635D] italic">{typing.name} is typing…</p>
                )}
                {/* Reply quote bar (WhatsApp-style): shows the message
                    being quoted, X cancels it. Cleared on send, on
                    thread switch, and when the quoted message is gone. */}
                {replyTo && (
                  <div className="flex items-center gap-2 bg-[#F4F1EA] border border-[#E2DFD8] rounded-lg px-3 py-2">
                    <Reply className="w-4 h-4 text-[#C25E00] shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold text-[#C25E00] truncate">
                        Replying to{' '}
                        {replyTo.senderEmail.toLowerCase() === meEmail
                          ? 'You'
                          : replyTo.senderName || replyTo.senderEmail}
                      </p>
                      <p className="text-[11px] text-[#5F635D] truncate">{quoteText(replyTo)}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setReplyTo(null)}
                      className="text-[#8C887E] hover:text-[#1E2320] p-1 rounded-md shrink-0"
                      aria-label="Cancel reply"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                {file && (
                  <div className="flex items-center justify-between gap-2 bg-[#F4F1EA] border border-[#E2DFD8] rounded-lg px-3 py-2">
                    <span className="text-xs text-[#1E2320] truncate">
                      {file.name} · {formatFileSize(file.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setFile(null)}
                      className="text-[11px] font-semibold text-[#5F635D] hover:text-[#1E2320] shrink-0"
                    >
                      Remove
                    </button>
                  </div>
                )}
                {sendError && <p className="text-[11px] text-red-700">{sendError}</p>}
                <div className="flex items-end gap-2">
                  <label
                    className="p-2.5 rounded-full border border-[#E2DFD8] bg-white hover:bg-[#F4F1EA] text-[#5F635D] cursor-pointer shrink-0 transition-colors"
                    title="Attach a file (video, image, PDF, Word, spreadsheet — max 20MB)"
                  >
                    <Paperclip className="w-4 h-4" />
                    <input
                      type="file"
                      className="hidden"
                      aria-label="Attach a file"
                      accept=".jpg,.jpeg,.png,.gif,.webp,.mp4,.webm,.mov,.pdf,.doc,.docx,.xls,.xlsx,.xlsm"
                      onChange={(e) => {
                        const picked = e.target.files?.[0] || null;
                        if (picked) {
                          const err = validateAttachment(picked);
                          setSendError(err || '');
                          setFile(err ? null : picked);
                        }
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {/* Single-row box: text-xs line (16px) + p-2.5 + border
                      = 38px, exactly the buttons' height (icon 16px +
                      p-2.5 + border). The send button gets a matching
                      border in its own colour so it is 38px too, not
                      36px. Longer messages scroll inside the box. */}
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
                    placeholder="Write a message…"
                    aria-label="Write a message"
                    rows={1}
                    className="flex-1 min-w-0 text-xs bg-white border border-[#E2DFD8] rounded-2xl p-2.5 text-[#1E2320] focus:border-[#1E3F35] resize-none"
                  />
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!draft.trim() && !file}
                    className="p-2.5 rounded-full border border-[#1E3F35] bg-[#1E3F35] hover:bg-[#163028] text-white disabled:opacity-60 transition-colors shrink-0"
                    aria-label="Send message"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-[10px] text-[#8C887E]">
                  Attachments: video, image, PDF, Word or spreadsheet, max 20MB each.
                </p>
              </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right-click / long-press menu. The backdrop closes it on any
          tap elsewhere; Close does the same. Delete for everyone is
          the sender's only — recipients get Delete for me. Edit
          appears only for your own text within 1 hour of sending. */}
      {menu && menuMessage && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
          />
          <div
            className="fixed z-50 w-56 bg-white rounded-xl border border-[#E5E1D8] shadow-xl py-1"
            style={{ left: menu.x, top: menu.y }}
          >
            {!menuMessage.deletedForEveryone && (
              <button
                type="button"
                onClick={() => {
                  startReply(menuMessage);
                  closeMenu();
                }}
                className="block w-full text-left px-4 py-2 text-xs font-medium text-[#1E2320] hover:bg-[#F4F1EA]"
              >
                Reply
              </button>
            )}
            <p className="px-4 py-1.5 text-[11px] font-semibold text-[#8C887E] uppercase tracking-wider">
              Delete
            </p>
            {menuIsOwn && (
              <button
                type="button"
                onClick={() => askDelete(menuMessage, 'everyone')}
                className="block w-full text-left px-4 py-2 text-xs font-medium text-red-700 hover:bg-[#F4F1EA]"
              >
                Delete for everyone
              </button>
            )}
            <button
              type="button"
              onClick={() => askDelete(menuMessage, 'me')}
              className="block w-full text-left px-4 py-2 text-xs text-[#1E2320] hover:bg-[#F4F1EA]"
            >
              Delete for me
            </button>
            {menuCanEdit && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(menuMessage.id);
                  setEditDraft(menuMessage.text || '');
                  closeMenu();
                }}
                className="block w-full text-left px-4 py-2 text-xs text-[#1E2320] hover:bg-[#F4F1EA]"
              >
                Edit
              </button>
            )}
            <button
              type="button"
              onClick={closeMenu}
              className="block w-full text-left px-4 py-2 text-xs text-[#1E2320] hover:bg-[#F4F1EA]"
            >
              Close
            </button>
          </div>
        </>
      )}

      {/* Conversation menu: pin / delete / clear chat. All local —
          the server never sees them. Loco gets Pin and Clear only. */}
      {threadMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeThreadMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeThreadMenu();
            }}
          />
          <div
            className="fixed z-50 w-56 bg-white rounded-xl border border-[#E5E1D8] shadow-xl py-1"
            style={{ left: threadMenu.x, top: threadMenu.y }}
          >
            <button
              type="button"
              onClick={() => togglePinThread(threadMenu.key)}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-[#1E2320] hover:bg-[#F4F1EA]"
            >
              <Pin className="w-3.5 h-3.5" />
              {prefs.pinned.includes(threadMenu.key) ? 'Unpin' : 'Pin'}
            </button>
            {threadMenu.key !== AI_THREAD_KEY && (
              <button
                type="button"
                onClick={() => {
                  const t = allThreads.find((x) => x.key === threadMenu.key);
                  askDeleteThread(threadMenu.key, t?.otherName || 'this conversation');
                }}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-red-700 hover:bg-[#F4F1EA]"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const t = allThreads.find((x) => x.key === threadMenu.key);
                askClearThread(threadMenu.key, t?.otherName || 'this conversation');
              }}
              className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-[#1E2320] hover:bg-[#F4F1EA]"
            >
              <Eraser className="w-3.5 h-3.5" />
              Clear chat
            </button>
            <button
              type="button"
              onClick={closeThreadMenu}
              className="block w-full px-4 py-2 text-left text-xs text-[#1E2320] hover:bg-[#F4F1EA]"
            >
              Close
            </button>
          </div>
        </>
      )}

      {/* Delete confirmation: nothing is deleted until you confirm. */}
      <Modal
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete message?"
        description={
          confirmDelete?.scope === 'everyone'
            ? 'This message will be deleted for everyone in this chat.'
            : 'This message will be deleted for you. The other person will still see it.'
        }
        maxWidth="sm"
      >
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => setConfirmDelete(null)}
            className="px-4 py-2 text-xs font-semibold text-[#1E2320] bg-[#F4F1EA] hover:bg-[#EBE7DF] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmDeleteNow}
            className="px-4 py-2 text-xs font-semibold bg-red-700 hover:bg-red-800 text-white rounded-lg transition-colors"
          >
            Delete
          </button>
        </div>
      </Modal>

      {/* Delete conversation: hides the row on this device until a
          new message arrives in that thread. */}
      <Modal
        isOpen={!!confirmThreadDelete}
        onClose={() => setConfirmThreadDelete(null)}
        title="Delete conversation?"
        description={
          confirmThreadDelete
            ? `“${confirmThreadDelete.name}” will be hidden on this device. It comes back if a new message arrives in this chat.`
            : ''
        }
        maxWidth="sm"
      >
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => setConfirmThreadDelete(null)}
            className="px-4 py-2 text-xs font-semibold text-[#1E2320] bg-[#F4F1EA] hover:bg-[#EBE7DF] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmDeleteThreadNow}
            className="px-4 py-2 text-xs font-semibold bg-red-700 hover:bg-red-800 text-white rounded-lg transition-colors"
          >
            Delete
          </button>
        </div>
      </Modal>

      {/* Clear chat: hides every message up to now, on this device
          only. New messages still show. */}
      <Modal
        isOpen={!!confirmThreadClear}
        onClose={() => setConfirmThreadClear(null)}
        title="Clear chat?"
        description={
          confirmThreadClear
            ? `All messages in “${confirmThreadClear.name}” will be hidden on this device. New messages will still show.`
            : ''
        }
        maxWidth="sm"
      >
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={() => setConfirmThreadClear(null)}
            className="px-4 py-2 text-xs font-semibold text-[#1E2320] bg-[#F4F1EA] hover:bg-[#EBE7DF] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmClearThreadNow}
            className="px-4 py-2 text-xs font-semibold bg-[#1E3F35] hover:bg-[#163028] text-white rounded-lg transition-colors"
          >
            Clear
          </button>
        </div>
      </Modal>

      {/* Deleted toast with Undo. Dismissing it (X) only hides the
          toast — the delete still runs when the window expires; only
          Undo cancels it. Kept local to this page so the Undo action
          can never go stale by outliving the chat. */}
      {showDeleteToast && toastDelete && (
        <div className="fixed bottom-4 left-4 right-4 z-50 flex items-center gap-3 p-4 bg-white rounded-xl border border-[#E5E1D8] shadow-lg sm:left-auto sm:right-4 sm:w-96">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#1E2320] leading-tight">Message deleted</p>
            <p className="text-xs text-[#5F635D] mt-0.5">
              {toastDelete.scope === 'everyone' ? 'Deleted for everyone' : 'Deleted for you'}
            </p>
          </div>
          <button
            type="button"
            onClick={undoDelete}
            className="text-xs font-bold text-[#1E3F35] hover:underline shrink-0"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => setToastHiddenId(toastDelete.id)}
            className="text-[#8C887E] hover:text-[#1E2320] p-1 rounded-md shrink-0"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
