// Loco — the Locora assistant: one shared client for the floating
// ChatWidget and the AI chat inside Messages. The server answers via
// Gemini, with Groq as fallback; a failure is always the friendly
// fallback text, never a raw error. Nothing about the signed-in user
// is ever sent — just the typed message + recent chat history.

export interface ChatbotMessage {
  role: 'user' | 'assistant';
  text: string;
}

export const CHATBOT_SUGGESTIONS = [
  'How do I create an event?',
  'How do refunds work?',
  'How do teams work?',
];

export const CHATBOT_FALLBACK_TEXT =
  "I'm having trouble right now — please try again in a moment.";

export const MAX_CHATBOT_SENT_HISTORY = 8;

export async function sendChatbotMessage(
  message: string,
  history: ChatbotMessage[],
): Promise<string> {
  try {
    const res = await fetch('/api/chatbot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
    });
    let reply = CHATBOT_FALLBACK_TEXT;
    try {
      const data = await res.json();
      if (data && typeof data.reply === 'string' && data.reply.trim()) {
        reply = data.reply.trim();
      }
    } catch {
      // Non-JSON response — keep the friendly fallback.
    }
    return reply;
  } catch {
    // Network failure — keep the friendly fallback.
    return CHATBOT_FALLBACK_TEXT;
  }
}
