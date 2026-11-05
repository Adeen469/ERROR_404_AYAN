import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  FileText,
  MessageCircle,
  Paperclip,
  Reply,
  Send,
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
  validateAttachment,
  formatFileSize,
} from '../services/messages-service';
import { subscribeToInbox, broadcastToInbox } from '../services/realtime-service';

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

function AttachmentView({ m }: { m: EventMessage }) {
  const a = m.attachment;
  if (!a) return null;
  if (a.type.startsWith('image/')) {
    return (
      <a href={a.url} target="_blank" rel="noreferrer" className="block">
        <img
          src={a.url}
          alt={a.name}
          className="max-h-64 max-w-full rounded-lg object-contain bg-[#F4F1EA]"
        />
        <span className="text-[11px] opacity-80 underline">{a.name} · {formatFileSize(a.size)}</span>
      </a>
    );
  }
  if (a.type.startsWith('video/')) {
    return (
      <span className="block">
        <video src={a.url} controls preload="metadata" className="max-h-64 max-w-full rounded-lg bg-black" />
        <span className="text-[11px] opacity-80">{a.name} · {formatFileSize(a.size)}</span>
      </span>
    );
  }
  return (
    <a
      href={a.url}
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
}

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
function QuoteView({
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
}

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
  const pollInFlight = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Reply state: the message being quoted in the composer. The quote
  // bar above the composer shows it; handleSend clears it on success.
  const [replyTo, setReplyTo] = useState<EventMessage | null>(null);
  // Quote jump: the message id to highlight after jumpToQuoted.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Realtime: true once the ping channel is SUBSCRIBED — polling then
  // drops to a 30s safety net (see the polling effect below).
  const [realtimeLive, setRealtimeLive] = useState(false);
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

  const loadMessages = useCallback(
    async (silent = false) => {
      if (!currentUser?.email) return;
      if (!silent) setLoading(true);
      try {
        const list = await messagesService.getMessages(currentUser.email);
        setMessages(list);
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
    [currentUser?.email],
  );

  useEffect(() => {
    loadMessages();
    // Poll interval depends on Realtime: 3s while polling is the only
    // delivery path, 30s safety net once the ping channel is live
    // (pings trigger an immediate silent reload — see the subscribe
    // effect below). Each poll costs one ~2s server call, so polling
    // faster than this would mostly overlap requests without fresher
    // data — the in-flight guard skips a tick when the previous poll
    // is still running.
    const intervalMs = realtimeLive ? 30000 : 3000;
    const timer = setInterval(() => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      loadMessages(true).finally(() => {
        pollInFlight.current = false;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [loadMessages, realtimeLive]);

  // Realtime pings (content-free, see realtime-service.ts): a ping
  // means "something changed for this inbox" — refetch via the
  // session-authenticated API. Never trust a ping as data. When the
  // client is null (VITE_SUPABASE_* not set) subscribeToInbox is a
  // silent no-op and polling above stays at 3s.
  useEffect(() => {
    if (!meEmail) return;
    const unsubscribe = subscribeToInbox(
      meEmail,
      () => {
        loadMessages(true);
      },
      (status) => setRealtimeLive(status === 'SUBSCRIBED'),
    );
    return unsubscribe;
  }, [meEmail, loadMessages]);

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
  const threads = groupThreads(visibleServerMessages, meEmail);
  const allThreads: MessageThread[] = pendingThread
    ? threads.some((t) => t.key === pendingThread.key)
      ? threads
      : [pendingThread, ...threads]
    : threads;
  const selected = allThreads.find((t) => t.key === selectedKey) || null;

  // Server messages plus in-flight ones for this thread, oldest
  // first. A pending bubble is dropped once its server copy shows up
  // (the 3s poll can beat the post's own response by a hair); the
  // createdAt guard keeps a genuinely repeated message ("Hi", "Hi")
  // from collapsing into the first copy.
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
                Date.parse(s.createdAt) - Date.parse(p.createdAt) < 30000,
            ),
        ),
      ].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
    : [];

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

  // Opening a thread marks its unread messages (addressed to me) read.
  useEffect(() => {
    if (!selected || !currentUser?.email) return;
    const unread = selected.messages.filter(
      (m) => m.recipientEmail.toLowerCase() === meEmail && !m.read,
    );
    if (unread.length === 0) return;
    Promise.all(unread.map((m) => messagesService.markAsRead(m.id, currentUser.email))).then(
      () => loadMessages(true),
    );
  }, [selectedKey, messages, currentUser?.email, meEmail, loadMessages]);

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [visibleMessages.length, selectedKey]);

  function selectThread(key: string) {
    setSelectedKey(key);
    setMobileView('chat');
    setSendError('');
  }

  // ---- Replies ----
  // The other participant of a message, for Realtime pings after a
  // send/edit/delete. A ping carries only the message id (see
  // realtime-service.ts) — the recipient refetches the real message
  // through the session-authenticated API.
  function otherEmailFor(m: EventMessage): string {
    return m.senderEmail.toLowerCase() === meEmail ? m.recipientEmail : m.senderEmail;
  }

  function notifyOther(m: EventMessage, type: 'message' | 'edited' | 'deleted'): void {
    const other = otherEmailFor(m);
    if (!other) return;
    broadcastToInbox(other, { type, id: m.id }).catch(() => {});
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
  // still missing (deleted, or not in this thread) do nothing — the
  // quote itself already says "This message was deleted" when the
  // server scrubbed its snapshot.
  function jumpToQuoted(id: string) {
    const highlight = (el: HTMLDivElement | null | undefined) => {
      if (!el) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightId(id);
      if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => setHighlightId(null), 2000);
      return true;
    };
    if (highlight(messageRefs.current.get(id))) return;
    loadMessages(true).finally(() => {
      window.setTimeout(() => {
        highlight(messageRefs.current.get(id));
      }, 300);
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
        await messagesService.uploadFile(uploadUrl, input.file);
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
      id: `temp-${Date.now()}`,
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
    // The draft is cleared only on success now: clearing it before the
    // send completed meant a failed send lost the text, and a retry
    // could duplicate it. The idempotency key covers the retry.
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
      });
      setPending((prev) => prev.filter((p) => p.id !== temp.id));
      // Dedupe by id: the 3s poll can already have fetched this very
      // message before the post's own response arrived — appending
      // blindly showed it twice until the next poll.
      setMessages((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
      setPendingThread(null);
      setDraft('');
      setFile(null);
      setReplyTo(null);
      // Realtime ping (id only) so the recipient's inbox refetches
      // immediately; polling is the fallback if this is missed.
      notifyOther(created, 'message');
      // Switch to the real thread key at once (the deep-link effect
      // also does this on the next poll, but waiting for it left the
      // pane blank after the first send).
      setSelectedKey(threadKey(created.eventId, created.senderEmail, created.recipientEmail));
      await loadMessages(true);
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
    setSendError('');
    try {
      const created = await deliver({
        eventId: temp.eventId,
        recipientEmail: temp.recipientEmail,
        text: temp.text || '',
        file: temp.localFile || null,
        idempotencyKey: temp.idempotencyKey,
        replyToId: temp.replyToId,
      });
      setPending((prev) => prev.filter((p) => p.id !== temp.id));
      setMessages((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
      setDraft('');
      setFile(null);
      setReplyTo(null);
      notifyOther(created, 'message');
      setSelectedKey(threadKey(created.eventId, created.senderEmail, created.recipientEmail));
      await loadMessages(true);
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
        // Remove locally at once; the reload below is just consistency.
        setMessages((prev) => prev.filter((m) => m.id !== message.id));
        // Delete-for-everyone also tombstones the other side's copy:
        // ping them (id only) so their inbox refetches at once.
        // Delete-for-me is local only and needs no ping.
        if (scope === 'everyone') notifyOther(message, 'deleted');
        await loadMessages(true);
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
      if (original) notifyOther(original, 'edited');
      await loadMessages(true);
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
        <div className="max-w-md mx-auto bg-white rounded-2xl border border-[#E5E1D8] p-8 text-center space-y-3">
          <MessageCircle className="w-10 h-10 mx-auto text-[#1E3F35]" />
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
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center gap-2 mb-4">
        <MessageCircle className="w-5 h-5 text-[#1E3F35]" />
        <h1 className="font-editorial text-2xl font-bold text-[#1E2320]">Messages</h1>
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

      <div className="flex gap-4 items-start">
        {/* Thread list */}
        <div
          className={`w-full md:w-1/3 bg-white rounded-2xl border border-[#E5E1D8] overflow-hidden shrink-0 ${
            mobileView === 'chat' ? 'hidden md:block' : 'block'
          }`}
        >
          {loading ? (
            <p className="p-6 text-xs text-[#5F635D]">Loading conversations…</p>
          ) : allThreads.length === 0 ? (
            <div className="p-6 text-center space-y-2">
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
            </div>
          ) : (
            <ul className="divide-y divide-[#EBE7DF]">
              {allThreads.map((t) => (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => selectThread(t.key)}
                    className={`w-full text-left px-4 py-3 hover:bg-[#FAF8F5] transition-colors ${
                      t.key === selectedKey ? 'bg-[#F4F1EA]' : ''
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[#1E2320] truncate">{t.eventTitle}</span>
                      {t.unread > 0 && (
                        <span className="shrink-0 min-w-5 h-5 px-1 rounded-full bg-[#1E3F35] text-white text-[10px] font-bold flex items-center justify-center">
                          {t.unread > 99 ? '99+' : t.unread}
                        </span>
                      )}
                    </span>
                    <span className="block text-[11px] text-[#5F635D] truncate mt-0.5">
                      {t.otherName}
                      {t.messages.length > 0 && ` · ${snippetOf(t.messages[t.messages.length - 1])}`}
                    </span>
                    {t.lastAt && (
                      <span className="block text-[10px] text-[#8C887E] mt-0.5">{fmtTime(t.lastAt)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Chat pane */}
        <div
          className={`w-full md:flex-1 bg-white rounded-2xl border border-[#E5E1D8] overflow-hidden flex flex-col ${
            mobileView === 'chat' ? 'block' : 'hidden md:flex'
          }`}
        >
          {!selected ? (
            <div className="p-12 text-center space-y-2">
              <MessageCircle className="w-10 h-10 mx-auto text-[#1E3F35]" />
              <p className="text-xs font-semibold text-[#1E2320]">Select a conversation</p>
              <p className="text-[11px] text-[#5F635D]">Or start one from an event page.</p>
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-[#EBE7DF] flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setMobileView('list')}
                  className="md:hidden p-1.5 -ml-1 rounded-lg hover:bg-[#F4F1EA] text-[#5F635D]"
                  aria-label="Back to conversations"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[#1E2320] truncate">{selected.eventTitle}</p>
                  <p className="text-[11px] text-[#5F635D] truncate">With {selected.otherName}</p>
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

              <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[300px] max-h-[60vh]">
                {visibleMessages.length === 0 ? (
                  <p className="text-xs text-[#5F635D] text-center pt-8">
                    No messages yet. Say hello — the organizer will get an email alert.
                  </p>
                ) : (
                  visibleMessages.map((m) => {
                    const mine = m.senderEmail.toLowerCase() === meEmail;
                    const isEditing = editingId === m.id;
                    return (
                      <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          ref={(el) => {
                            if (el) messageRefs.current.set(m.id, el);
                            else messageRefs.current.delete(m.id);
                          }}
                          className={`max-w-[85%] rounded-2xl px-3 py-2 space-y-1 select-none ${
                            mine
                              ? 'bg-[#1E3F35] text-white rounded-br-md'
                              : 'bg-[#F4F1EA] text-[#1E2320] rounded-bl-md'
                          }${highlightId === m.id ? ' ring-2 ring-[#C25E00]' : ''}`}
                          style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
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
                              <p className={`text-[10px] ${mine ? 'text-white/70' : 'text-[#8C887E]'}`}>
                                {fmtTime(m.createdAt)}
                                {m.edited ? ' · edited' : ''}
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
                    );
                  })
                )}
                <div ref={bottomRef} />
              </div>

              <div className="p-3 border-t border-[#EBE7DF] space-y-2">
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
                    className="p-2.5 rounded-lg border border-[#E2DFD8] bg-white hover:bg-[#F4F1EA] text-[#5F635D] cursor-pointer shrink-0"
                    title="Attach a file (video, image, PDF, Word, spreadsheet — max 20MB)"
                  >
                    <Paperclip className="w-4 h-4" />
                    <input
                      type="file"
                      className="hidden"
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
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder="Write a message…"
                    rows={1}
                    className="flex-1 min-w-0 text-xs bg-white border border-[#E2DFD8] rounded-lg p-2.5 text-[#1E2320] focus:border-[#1E3F35] resize-none"
                  />
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!draft.trim() && !file}
                    className="p-2.5 rounded-lg border border-[#1E3F35] bg-[#1E3F35] hover:bg-[#163028] text-white disabled:opacity-60 transition-colors shrink-0"
                    aria-label="Send message"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-[10px] text-[#8C887E]">
                  Attachments: video, image, PDF, Word or spreadsheet, max 20MB each.
                </p>
              </div>
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
