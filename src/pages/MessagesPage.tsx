import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  FileText,
  MessageCircle,
  Paperclip,
  Send,
} from 'lucide-react';
import { authService } from '../services/auth-service';
import { eventsService } from '../services/events-service';
import {
  EventMessage,
  MessageThread,
  messagesService,
  groupThreads,
  validateAttachment,
  formatFileSize,
} from '../services/messages-service';

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
  if (m.text && m.text.trim()) return m.text.trim();
  if (m.attachment) return `Sent an attachment: ${m.attachment.name}`;
  return 'Message';
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

export function MessagesPage() {
  const [searchParams] = useSearchParams();
  const [currentUser] = useState(() => authService.getCurrentUser());
  const [messages, setMessages] = useState<EventMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list');
  const [draft, setDraft] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [pendingThread, setPendingThread] = useState<MessageThread | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const meEmail = (currentUser?.email || '').toLowerCase();
  const queryEventId = searchParams.get('eventId') || '';
  const queryWith = searchParams.get('with') || '';

  const loadMessages = useCallback(
    async (silent = false) => {
      if (!currentUser?.email) return;
      if (!silent) setLoading(true);
      try {
        const list = await messagesService.getMessages(currentUser.email);
        setMessages(list);
        setLoadError('');
      } catch (err: any) {
        setLoadError(err?.message || 'Could not load messages.');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [currentUser?.email],
  );

  useEffect(() => {
    loadMessages();
    const timer = setInterval(() => loadMessages(true), 30000);
    return () => clearInterval(timer);
  }, [loadMessages]);

  // Deep link from an event page: /messages?eventId=x&with=organizer@…
  // selects that thread, or prepares a fresh composer when no message
  // exists yet (the first send creates the thread server-side).
  useEffect(() => {
    if (!queryEventId || !queryWith || !currentUser?.email) return;
    const key = `${queryEventId}|${[currentUser.email.toLowerCase(), queryWith.toLowerCase()].sort().join('|')}`;
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
                otherEmail: queryWith,
                otherName: event?.organizer?.name || queryWith,
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
          otherEmail: queryWith,
          otherName: queryWith,
          messages: [],
          lastAt: '',
          unread: 0,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [queryEventId, queryWith, currentUser?.email]);

  const threads = groupThreads(messages, meEmail);
  const allThreads: MessageThread[] = pendingThread
    ? threads.some((t) => t.key === pendingThread.key)
      ? threads
      : [pendingThread, ...threads]
    : threads;
  const selected = allThreads.find((t) => t.key === selectedKey) || null;

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [selected?.messages.length, selectedKey]);

  function selectThread(key: string) {
    setSelectedKey(key);
    setMobileView('chat');
    setSendError('');
  }

  async function handleSend() {
    if (!currentUser?.email || !selected) return;
    const text = draft.trim();
    if (!text && !file) return;
    setSending(true);
    setSendError('');
    try {
      let attachmentMeta: { name: string; size: number; type: string; path: string } | undefined;
      if (file) {
        const validationError = validateAttachment(file);
        if (validationError) throw new Error(validationError);
        const { uploadUrl, path } = await messagesService.requestUploadUrl({
          eventId: selected.eventId,
          senderEmail: currentUser.email,
          recipientEmail: selected.otherEmail,
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type,
        });
        await messagesService.uploadFile(uploadUrl, file);
        attachmentMeta = { name: file.name, size: file.size, type: file.type, path };
      }
      await messagesService.sendMessage({
        eventId: selected.eventId,
        senderEmail: currentUser.email,
        senderName: currentUser.name,
        recipientEmail: selected.otherEmail,
        text,
        attachment: attachmentMeta,
      });
      setDraft('');
      setFile(null);
      setPendingThread(null);
      await loadMessages(true);
    } catch (err: any) {
      setSendError(err?.message || 'Could not send the message. Please try again.');
    } finally {
      setSending(false);
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
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[300px] max-h-[60vh]">
                {selected.messages.length === 0 ? (
                  <p className="text-xs text-[#5F635D] text-center pt-8">
                    No messages yet. Say hello — the organizer will get an email alert.
                  </p>
                ) : (
                  selected.messages.map((m) => {
                    const mine = m.senderEmail.toLowerCase() === meEmail;
                    return (
                      <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[85%] rounded-2xl px-3 py-2 space-y-1 ${
                            mine
                              ? 'bg-[#1E3F35] text-white rounded-br-md'
                              : 'bg-[#F4F1EA] text-[#1E2320] rounded-bl-md'
                          }`}
                        >
                          {m.text && <p className="text-xs leading-relaxed whitespace-pre-wrap break-words">{m.text}</p>}
                          <AttachmentView m={m} />
                          <p className={`text-[10px] ${mine ? 'text-white/70' : 'text-[#8C887E]'}`}>
                            {fmtTime(m.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={bottomRef} />
              </div>

              <div className="p-3 border-t border-[#EBE7DF] space-y-2">
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
                    disabled={sending || (!draft.trim() && !file)}
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
    </div>
  );
}
