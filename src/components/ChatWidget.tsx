import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import {
  sendChatbotMessage,
  CHATBOT_SUGGESTIONS,
  MAX_CHATBOT_SENT_HISTORY,
} from '../services/chatbot-service';
import { authService } from '../services/auth-service';

// Loco — the Locora assistant, floating on every page except the auth
// pages and /messages (the App shell hides it there — Messages already
// has Loco as a conversation). Lazy-loaded from App.tsx so it never
// bloats first paint.
// Chats stay on this device only (localStorage), and the history is
// PERSONAL: the storage key is scoped to the signed-in account, so
// two users on the same browser — attendee, organizer or admin —
// never see each other's chats (owner rule, 2026-11-06). The account
// identity is used only as the local key; nothing about the user is
// ever sent — just the typed message + recent chat history. The
// server answers via Gemini, with Groq as fallback, and stores
// nothing server-side.

type ChatMsg = { role: 'user' | 'assistant'; text: string; ts: number };

const AUTH_PATHS = ['/login', '/signup', '/forgot-password', '/reset-password', '/logout', '/verify-email'];
const STORAGE_KEY = 'locora_chat_history';
const MAX_STORED = 20;

function chatIdentityOf(user: { id?: string; email?: string } | null): string {
  const raw = (user?.id || user?.email || '').trim().toLowerCase();
  return raw ? encodeURIComponent(raw) : 'guest';
}

function storageKeyFor(identity: string): string {
  return `${STORAGE_KEY}:${identity}`;
}

function loadStored(key: string): ChatMsg[] {
  try {
    const raw = window.localStorage.getItem(key);
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
  const [user, setUser] = useState(() => authService.getCurrentUser());
  const identity = chatIdentityOf(user);
  const storageKey = storageKeyFor(identity);
  const firstName = (user?.name || '').trim().split(' ')[0];
  const [messages, setMessages] = useState<ChatMsg[]>(() => loadStored(storageKeyFor(chatIdentityOf(authService.getCurrentUser()))));
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hydratedFor = useRef(storageKey);

  // Auth pages get no widget.
  const isAuthPage = AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Track the signed-in account; drop the old unscoped shared history
  // key once — it belonged to no account in particular.
  useEffect(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage unavailable — nothing to clean up.
    }
    return authService.subscribe(() => setUser(authService.getCurrentUser()));
  }, []);

  // When the account changes, swap in that account's own history.
  // Declared before the persist effect so a switch never writes one
  // account's messages under another account's key.
  useEffect(() => {
    if (hydratedFor.current === storageKey) return;
    hydratedFor.current = storageKey;
    setMessages(loadStored(storageKey));
  }, [storageKey]);

  // Persist — only ever under the current account's own key.
  useEffect(() => {
    if (hydratedFor.current !== storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(messages.slice(-MAX_STORED)));
    } catch {
      // Storage full or unavailable — chat still works for the session.
    }
  }, [messages, storageKey]);

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
    const history = [...messages, userMsg].slice(-MAX_CHATBOT_SENT_HISTORY).map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);
    const reply = await sendChatbotMessage(text, history);
    setMessages((prev) => [...prev, { role: 'assistant', text: reply, ts: Date.now() }]);
    setSending(false);
  };

  return (
    <>
      {/* Floating bubble */}
      <button
        type="button"
        aria-label={open ? 'Close chat with Loco' : 'Chat with Loco, the Locora assistant'}
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-5 right-5 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#1E3F35] text-white shadow-lg shadow-black/20 transition hover:bg-[#163028] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E3F35]"
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
        <span className="absolute right-0.5 top-0.5 h-3 w-3 rounded-full bg-emerald-400 ring-2 ring-white" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Chat with Loco"
          className="fixed bottom-24 right-5 z-50 flex h-[560px] w-[380px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-[#E7E3DB] bg-white shadow-2xl max-sm:inset-x-3 max-sm:bottom-3 max-sm:right-3 max-sm:h-[72vh] max-sm:w-auto"
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-[#E7E3DB] bg-[#FAF8F5] px-4 py-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1E3F35] font-editorial text-lg text-white" aria-hidden="true">
              L
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-editorial text-base leading-tight text-[#1E2320]">Loco</p>
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
              <div className="rounded-2xl border border-[#E7E3DB] bg-white p-5">
                <p className="font-editorial text-base text-[#1E2320]">Hi{firstName ? ` ${firstName}` : ''}, I&apos;m Loco</p>
                <p className="mt-1 text-sm leading-relaxed text-[#5F635D]">
                  Ask me anything about Locora — finding events, creating one, teams, refunds, or your bookings.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {CHATBOT_SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      className="rounded-full border border-[#1E3F35]/25 bg-[#FAF8F5] px-3.5 py-2 text-xs font-medium text-[#1E3F35] transition hover:bg-[#1E3F35] hover:text-white"
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
                      ? 'max-w-[80%] rounded-2xl rounded-br-sm bg-[#1E3F35] px-4 py-2.5 text-sm leading-relaxed text-white'
                      : 'max-w-[80%] rounded-2xl rounded-bl-sm border border-[#E7E3DB] bg-white px-4 py-2.5 text-sm leading-relaxed text-[#1E2320] shadow-xs'
                  }
                >
                  <span className="whitespace-pre-wrap break-words">{m.text}</span>
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-[#E7E3DB] bg-white px-4 py-3" aria-label="Loco is typing">
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
              aria-label="Message Loco"
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
