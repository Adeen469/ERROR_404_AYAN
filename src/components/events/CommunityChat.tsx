// Community chat — one group chat per event.
//
// Who can see/post: signed-in users with a CONFIRMED registration
// for this event, plus the event organizer and admins. Guests and
// signed-in non-registered users see only a locked placeholder —
// the server enforces this on every call (403 with member:false),
// so the placeholder here is display only, never the access check.
//
// Privacy: only sender NAMES are shown, never emails or phones.
// The server strips hiddenFor/idempotencyKey/editHistory from
// returned rows (same stripMessageForViewer as private messages).
//
// Delivery: 3s polling while open, 30s safety net when the
// per-event Realtime ping channel is live. Pings are content-free
// (id only, see realtime-service.ts) on channel `community:<eventId>`.
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
} from '../../services/messages-service';
import { broadcastToCommunity, subscribeToCommunity } from '../../services/realtime-service';
import { ApiError } from '../../services/api-client';

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

function quoteText(m: EventMessage): string {
  if (m.deletedForEveryone) return 'This message was deleted';
  if (m.text && m.text.trim()) return m.text.trim();
  if (m.attachment) return `Sent an attachment: ${m.attachment.name}`;
  return 'Message';
}

// WhatsApp-style quote above a reply's text, rendered from the
// frozen server snapshot (never by re-reading the original).
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
        <span className="text-[11px] opacity-80 underline">
          {a.name} · {formatFileSize(a.size)}
        </span>
      </a>
    );
  }
  if (a.type.startsWith('video/')) {
    return (
      <span className="block">
        <video src={a.url} controls preload="metadata" className="max-h-64 max-w-full rounded-lg bg-black" />
        <span className="text-[11px] opacity-80">
          {a.name} · {formatFileSize(a.size)}
        </span>
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

type ChatMessage = EventMessage & { pending?: boolean };

export function CommunityChat({
  eventId,
  eventTitle,
  isRegistered,
  isOwner,
}: {
  eventId: string;
  eventTitle: string;
  isRegistered: boolean;
  isOwner: boolean;
}) {
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
  const [realtimeLive, setRealtimeLive] = useState(false);
  const pollInFlight = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const highlightTimer = useRef<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const meEmail = (currentUser?.email || '').toLowerCase();

  const load = useCallback(
    async (silent = false) => {
      if (!currentUser?.email) {
        setStatus('locked');
        return;
      }
      try {
        const data = await messagesService.getCommunityMessages(eventId);
        setMessages(data.messages);
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
    [currentUser?.email, eventId],
  );

  useEffect(() => {
    load();
    const intervalMs = realtimeLive ? 30000 : 3000;
    const timer = setInterval(() => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      load(true).finally(() => {
        pollInFlight.current = false;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [load, realtimeLive]);

  // Community pings (content-free, see realtime-service.ts): a ping
  // means "something changed in this event's chat" — refetch via the
  // session-authenticated, membership-gated API. Never trust a ping
  // as data. Without VITE_SUPABASE_* this is a silent no-op and
  // polling above stays at 3s.
  useEffect(() => {
    if (!eventId || status !== 'member') return;
    const unsubscribe = subscribeToCommunity(
      eventId,
      () => {
        load(true);
      },
      (s) => setRealtimeLive(s === 'SUBSCRIBED'),
    );
    return unsubscribe;
  }, [eventId, status, load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  function startReply(m: EventMessage) {
    if (m.deletedForEveryone) return;
    setReplyTo(m);
    composerRef.current?.focus();
  }

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
    load(true).finally(() => {
      window.setTimeout(() => {
        highlight(messageRefs.current.get(id));
      }, 300);
    });
  }

  function canEdit(m: EventMessage): boolean {
    if (m.senderEmail.toLowerCase() !== meEmail) return false;
    if (m.deletedForEveryone) return false;
    const ageMs = Date.now() - Date.parse(m.createdAt || '');
    return Number.isFinite(ageMs) && ageMs <= 60 * 60 * 1000;
  }

  function canDelete(m: EventMessage): boolean {
    if (m.deletedForEveryone) return false;
    return m.senderEmail.toLowerCase() === meEmail || isOrganizer;
  }

  async function handleSend() {
    if (!currentUser?.email) return;
    const text = draft.trim();
    if (!text && !file) return;
    const sendingFile = file;
    const replyingTo = replyTo;
    const temp: ChatMessage = {
      id: `temp-${Date.now()}`,
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
    setSendError('');
    try {
      let attachmentMeta: { name: string; size: number; type: string; path: string } | undefined;
      if (sendingFile) {
        const validationError = validateAttachment(sendingFile);
        if (validationError) throw new Error(validationError);
        const { uploadUrl, path } = await messagesService.requestCommunityUploadUrl({
          eventId,
          fileName: sendingFile.name,
          fileSize: sendingFile.size,
          fileType: sendingFile.type,
        });
        try {
          await messagesService.uploadFile(uploadUrl, sendingFile);
        } catch (err) {
          throw err;
        }
        attachmentMeta = { name: sendingFile.name, size: sendingFile.size, type: sendingFile.type, path };
      }
      let created: EventMessage;
      try {
        created = await messagesService.sendCommunityMessage({
          eventId,
          text,
          attachment: attachmentMeta,
          idempotencyKey: `community-${eventId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
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
      setDraft('');
      setFile(null);
      setReplyTo(null);
      // Realtime ping (id only) so every member refetches at once;
      // polling is the fallback if this is missed.
      broadcastToCommunity(eventId, { type: 'message', id: created.id }).catch(() => {});
      await load(true);
    } catch (err: any) {
      setPending((prev) => prev.filter((p) => p.id !== temp.id));
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
      broadcastToCommunity(eventId, { type: 'edited', id: m.id }).catch(() => {});
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
      broadcastToCommunity(eventId, { type: 'deleted', id: target.id }).catch(() => {});
      await load(true);
    } catch (err: any) {
      setSendError(err?.message || 'Could not delete message.');
    }
  }

  const visible = [...messages, ...pending].sort(
    (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || (a.id || '').localeCompare(b.id || ''),
  );

  return (
    <div className="p-6 bg-white rounded-xl border border-[#E5E1D8] space-y-4">
      <div className="flex items-center gap-2">
        <Users className="w-5 h-5 text-[#1E3F35]" />
        <h2 className="font-editorial text-xl font-bold text-[#1E2320]">Community Chat</h2>
      </div>
      <p className="text-xs text-[#5F635D] -mt-2">
        Chat with everyone attending {eventTitle}. Only confirmed attendees, the organizer and admins can
        see or post here — no email alerts are sent for community messages.
      </p>

      {status === 'loading' && (
        <p className="text-sm text-[#5F635D]">Loading the community chat…</p>
      )}

      {status === 'locked' && (
        <div className="p-4 bg-[#F4F1EA] border border-[#E2DFD8] rounded-lg space-y-2">
          <p className="text-sm font-semibold text-[#1E2320] flex items-center gap-2">
            <MessageCircle className="w-4 h-4" />
            Join this event to chat with attendees
          </p>
          <p className="text-xs text-[#5F635D] leading-relaxed">
            {meEmail
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
          ) : !isRegistered && !isOwner ? (
            <p className="text-[11px] text-[#8C887E]">
              Use the Register button on this page to get your pass, then come back here to chat.
            </p>
          ) : null}
        </div>
      )}

      {status === 'member' && (
        <>
          {loadError && <p className="text-xs text-rose-600">{loadError}</p>}
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {visible.length === 0 && (
              <p className="text-sm text-[#5F635D]">
                No messages yet — say hello to your fellow attendees.
              </p>
            )}
            {visible.map((m) => {
              const mine = m.senderEmail.toLowerCase() === meEmail;
              const deleted = m.deletedForEveryone === true;
              return (
                <div
                  key={m.id}
                  ref={(el) => {
                    if (el) messageRefs.current.set(m.id, el);
                    else messageRefs.current.delete(m.id);
                  }}
                  onDoubleClick={() => startReply(m)}
                  className={`flex gap-2.5 ${highlightId === m.id ? 'bg-amber-50 rounded-lg p-1 -m-1' : ''} ${
                    (m as ChatMessage).pending ? 'opacity-70' : ''
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
                      <span className="text-[11px] text-[#8C887E]">{fmtTime(m.createdAt)}</span>
                      {m.edited && !deleted && (
                        <span className="text-[11px] text-[#8C887E]">edited</span>
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
                    {!deleted && <AttachmentView m={m} />}
                    {!deleted && (
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
              );
            })}
            <div ref={bottomRef} />
          </div>

          <div className="border-t border-[#E5E1D8] pt-3 space-y-2">
            {replyTo && (
              <div className="flex items-start justify-between gap-2 bg-[#F4F1EA] border border-[#E2DFD8] rounded-lg px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold text-[#C25E00]">
                    Replying to{' '}
                    {replyTo.senderEmail.toLowerCase() === meEmail
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
            <div className="flex items-end gap-2">
              <label className="shrink-0 p-2 text-[#1E3F35] hover:bg-[#F4F1EA] rounded-lg cursor-pointer transition-colors">
                <Paperclip className="w-4 h-4" />
                <span className="sr-only">Attach a file</span>
                <input
                  type="file"
                  className="hidden"
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
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                rows={2}
                maxLength={2000}
                placeholder="Message the community…"
                className="flex-1 text-sm border border-[#D0E2D9] rounded-lg p-2.5 focus:outline-hidden focus:ring-1 focus:ring-[#1E3F35] resize-none"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!draft.trim() && !file}
                className="shrink-0 p-2.5 text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors disabled:opacity-40"
                aria-label="Send community message"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            {sendError && <p className="text-[11px] text-rose-600">{sendError}</p>}
            <p className="text-[11px] text-[#8C887E]">
              Only confirmed attendees can see these messages. Be kind — the organizer can remove
              messages.
            </p>
          </div>
        </>
      )}

      <ConfirmDialog
        isOpen={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDeleteConfirm}
        isDestructive
        title="Delete message?"
        message={
          confirmDelete && confirmDelete.senderEmail.toLowerCase() !== meEmail
            ? 'Delete this attendee’s message from the community chat? Everyone will see "This message was deleted".'
            : 'Delete your message from the community chat? Everyone will see "This message was deleted".'
        }
        confirmLabel="Delete"
      />
    </div>
  );
}
