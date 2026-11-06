// Local-only conversation preferences for Messages: pin, delete
// (hide), clear chat. All localStorage-backed — the server never
// sees them, so they apply on this device only.

export const CONVERSATION_PREFS_KEY = 'locora_message_prefs';

export interface ThreadPrefs {
  pinned: string[];
  // key -> ms epoch when the conversation was hidden. A hidden thread
  // reappears the moment a message newer than the hide arrives.
  hidden: Record<string, number>;
  // key -> ms epoch when the chat was cleared. Messages at or before
  // that moment stay hidden; anything after still shows.
  clearedAt: Record<string, number>;
}

export function emptyPrefs(): ThreadPrefs {
  return { pinned: [], hidden: {}, clearedAt: {} };
}

type MiniStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function getStorage(): MiniStorage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* ignore */
  }
  try {
    const g = globalThis as unknown as { localStorage?: MiniStorage };
    if (g.localStorage) return g.localStorage;
  } catch {
    /* ignore */
  }
  return null;
}

function sanitizeRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function loadPrefs(): ThreadPrefs {
  try {
    const storage = getStorage();
    if (!storage) return emptyPrefs();
    const raw = storage.getItem(CONVERSATION_PREFS_KEY);
    if (!raw) return emptyPrefs();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyPrefs();
    return {
      pinned: Array.isArray(parsed.pinned)
        ? parsed.pinned.filter((k: unknown) => typeof k === 'string')
        : [],
      hidden: sanitizeRecord(parsed.hidden),
      clearedAt: sanitizeRecord(parsed.clearedAt),
    };
  } catch {
    return emptyPrefs();
  }
}

export function savePrefs(prefs: ThreadPrefs): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(CONVERSATION_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or unavailable — prefs just don't persist */
  }
}

// Pinned first, each group keeping its current order.
export function sortThreadsByPin<T extends { key: string }>(threads: T[], pinned: string[]): T[] {
  const pinSet = new Set(pinned);
  const pinnedFirst = threads.filter((t) => pinSet.has(t.key));
  const rest = threads.filter((t) => !pinSet.has(t.key));
  return [...pinnedFirst, ...rest];
}

// Hidden until a message newer than the hide moment arrives.
export function isThreadHidden(
  key: string,
  lastAt: string,
  hidden: Record<string, number>,
): boolean {
  const at = hidden[key];
  if (at === undefined) return false;
  if (!lastAt) return true;
  const last = Date.parse(lastAt);
  if (Number.isNaN(last)) return true;
  return last <= at;
}

// True when this message was sent at or before the clear moment.
export function isMessageCleared(createdAt: string, clearedAt: number | undefined): boolean {
  if (clearedAt === undefined) return false;
  const ts = Date.parse(createdAt || '');
  if (Number.isNaN(ts)) return false;
  return ts <= clearedAt;
}
