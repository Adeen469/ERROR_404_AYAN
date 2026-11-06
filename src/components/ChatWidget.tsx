import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';

// Loci — the Locora assistant, floating on every page except the auth
// pages. Lazy-loaded from App.tsx so it never bloats first paint.
// Chats stay on this device only (localStorage); nothing about the
// signed-in user is ever sent — just the typed message + recent chat
// history. The server answers via Gemini, with Groq as fallback.

type ChatMsg = { role: 'user' | 'assistant'; text: string; ts: number };

const AUTH_PATHS = ['/login', '/signup', '/forgot-password', '/reset-password', '/logout', '/verify-email'];
const STORAGE_KEY = 'locora_chat_history';
const SUGGESTIONS = ['How do I create an event?', 'How do refunds work?', 'How do teams work?'];
const MAX_STORED = 20;
const MAX_SENT_HISTORY = 8;
const FALLBACK_TEXT = "I'm having trouble right now — please try again in a moment.";

function loadStored(): ChatMsg[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .slice(-MAX_STORED);
  } catch {
    return [];
  }
}

export function ChatWidget() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>(() => loadStored());
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auth pages get no widget.
  const isAuthPage = AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_STORED)));
    } catch {
      // Storage full or unavailable — chat still works for the session.
    }
  }, [messages]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open ]);

  if (isAuthPage) return null;

  const send = async (rawText?: string) => {
    const text = (rawText ?? input).trim();
    if (!text || sending) return;
    const userMsg: ChatMsg = { role: 'user', text, ts: Date.now() };
    const history = [...messages, userMsg].slice(-MAX_SENT_HISTORY).map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);
    try {
      const res = await fetch('/api/chatbot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      });
      let reply = FALLBACK_TEXT;
      try {
        const data = await res.json();
        if (data && typeof data.reply === 'string' && data.reply.trim()) reply = data.reply.trim();
      } catch {
        // Non-JSON response — keep the friendly fallback.
      }
      setMessages((prev) => [...prev, { role: 'assistant', text: reply, ts: Date.now() }]);
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', text: FALLBACK_TEXT, ts: Date.now() }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* Floating bubble */}
      <button
        type="button"
        aria-label={open ? 'Close chat with Loci' : 'Chat with Loci, the Locora assistant'}
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#1E3F35] text-white shadow-lg shadow-black/20 transition hover:bg-[#163028] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E3F35]"
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
        <span className="absolute right-0.5 top-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-white" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Chat with Loci"
          className="fixed bottom-24 right-5 z-50 flex h-[560px] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-[#E7E3DB] bg-white shadow-2xl max-sm:inset-x-3 max-sm:bottom-3 max-sm:right-3 max-sm:h-[72vh] max-sm:w-auto"
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-[#E7E3DB] bg-[#FAF8F5] px-4 py-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1E3F35] font-editorial text-lg text-white" aria-hidden="true">
              L
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-editorial text-base leading-tight text-[#1E2320]">Loci</p>
              <p className="flex items-center gap-1.5 text-xs text-[#5F635D]">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                Locora assistant · Online
              </p>
            </div>
            <button
              type="button"
              aria-label="Close chat"
              onClick={() => setOpen(false)}
              className="rounded-full p-2 text-[#5F635D] transition hover:bg-[#E7E3DB] hover:text-[#1E2320]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Messages */}
          <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto bg-[#FAF8F5] p-3">
            {messages.length === 0 && (
              <div className="rounded-2xl border border-[#E7E3DB] bg-white p-4">
                <p className="font-editorial text-base text-[#1E2320]">Hi, I&apos;m Loci 👋</p>
                <p className="mt-1 text-sm leading-relaxed text-[#5F635D]">
                  Ask me anything about Locora — finding events, creating one, teams, refunds, or your bookings.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      className="rounded-full border border-[#1E3F35]/30 bg-[#FAF8F5] px-3 py-1.5 text-xs font-medium text-[#1E3F35] transition hover:bg-[#1E3F35] hover:text-white"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={`${m.ts}-${i}`} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={
                    m.role === 'user'
                      ? 'max-w-[80%] rounded-2xl rounded-br-sm bg-[#1E3F35] px-3 py-2 text-sm leading-relaxed text-white'
                      : 'max-w-[80%] rounded-2xl rounded-bl-sm border border-[#E7E3DB] bg-white px-3 py-2 text-sm leading-relaxed text-[#1E2320]'
                  }
                >
                  <span className="whitespace-pre-wrap break-words">{m.text}</span>
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-[#E7E3DB] bg-white px-3 py-2.5" aria-label="Loci is typing">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-[#5F635D]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-[#5F635D] [animation-delay:150ms]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-[#5F635D] [animation-delay:300ms]" />
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <form
            className="flex items-center gap-2 border-t border-[#E7E3DB] bg-white p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about Locora…"
              aria-label="Message Loci"
              maxLength={2000}
              disabled={sending}
              className="min-w-0 flex-1 rounded-full border border-[#E7E3DB] bg-[#FAF8F5] px-4 py-2.5 text-sm text-[#1E2320] placeholder:text-[#5F635D] focus:border-[#1E3F35] focus:outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              aria-label="Send message"
              disabled={!input.trim() || sending}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1E3F35] text-white transition hover:bg-[#163028] disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}
