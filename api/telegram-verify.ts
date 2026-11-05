// Telegram phone verification — free, no SMS.
//
// Flow:
//   1. The Locora profile page calls POST { action: "start", email, phone }.
//      A one-time token is stored (Supabase phone_verifications table)
//      and the caller gets a https://t.me/<bot>?start=<token> link.
//   2. The user opens the link in Telegram. The bot replies with a
//      "Share my phone number" button (request_contact).
//   3. The user taps it. Telegram sends the contact (a number Telegram
//      itself verified at signup) to this same endpoint as a webhook
//      update. If its digits match the profile number, the row becomes
//      "verified" and the profile page's status poll sees it.
//   4. The profile page then marks the profile phoneVerified.
//
// Security notes:
//   - The webhook is a public URL, so Telegram updates are authenticated
//     with the secret_token set via setWebhook: every update must carry
//     the X-Telegram-Bot-Api-Secret-Token header matching
//     TELEGRAM_WEBHOOK_SECRET. Without that secret configured, updates
//     are ignored (fail closed) — see TELEGRAM_VERIFICATION_SETUP.md.
//   - A token alone proves nothing: verification requires a Telegram
//     contact whose digits match the profile number. A token created
//     for someone else's email/phone cannot be completed with the
//     attacker's own Telegram number (digit mismatch).
//   - Tokens live 15 minutes. Verified rows are kept as the attestation
//     record (see api/registrations.ts, which server-checks them before
//     stamping a registration's phoneVerified badge).
//
// Env (Vercel Production): TELEGRAM_BOT_TOKEN (Sensitive),
// TELEGRAM_BOT_USERNAME (public), TELEGRAM_WEBHOOK_SECRET (Sensitive).
// Table: phone_verifications (token text pk, data jsonb, created_at).

function getEnv(name: string): string {
  try {
    const v = (process as any)?.env?.[name];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

function sendJson(res: any, status: number, obj: any, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { "Content-Type": "application/json", ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const b = (req as any).body;
      if (b && typeof b === "object") return resolve(b);
      if (typeof b === "string" && b.length > 0) {
        try {
          return resolve(JSON.parse(b));
        } catch {
          return resolve({});
        }
      }
      let data = "";
      const timer = setTimeout(() => resolve({}), 3000);
      req.on("data", (chunk: any) => {
        data += chunk;
      });
      req.on("end", () => {
        clearTimeout(timer);
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
      req.on("error", () => {
        clearTimeout(timer);
        resolve({});
      });
    } catch {
      resolve({});
    }
  });
}

function supabaseBase(): string {
  return (getEnv("SUPABASE_URL") || "").replace(/\/$/, "");
}

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY") || "";
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function fetchJson(
  url: string,
  init?: any,
): Promise<{ ok: boolean; status: number; body: any }> {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

const TABLE = "phone_verifications";
const TOKEN_TTL_MS = 15 * 60 * 1000;

// ---- Session verification (audit fix) ----
// The start action used to take any email/phone from the body with no
// session check, so anyone could mint tokens for any address and —
// because start deletes the victim's pending rows first — repeatedly
// invalidate a victim's in-progress verification. Now start requires a
// session whose email matches the body email, plus a per-email rate
// limit. The Telegram webhook branch below stays session-free (Telegram
// calls it, authenticated by the secret header instead).
function norm(email: string): string {
  return (email || "").trim().toLowerCase();
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || "");
}

function parseCookies(req: any): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers?.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Last x-forwarded-for entry (Vercel appends the real IP last; the
// first entry is client-spoofable).
function getClientIp(req: any): string {
  const fwd = req.headers?.["x-forwarded-for"] || "";
  if (typeof fwd === "string" && fwd.trim()) {
    const parts = fwd.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers?.["x-real-ip"] || "unknown";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlDecode(text: string): string {
  return new TextDecoder().decode(b64urlToBytes(text));
}
async function sha256Hex(text: string): Promise<string> {
  const digest = await (globalThis as any).crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}
async function hmacB64url(secret: string, data: string): Promise<string> {
  const key = await (globalThis as any).crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await (globalThis as any).crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function loadUserByEmail(email: string): Promise<{ id: string; data: any } | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/locora_users?select=id,data&data->>email=eq.${encodeURIComponent(norm(email))}`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0];
}

async function verifySession(req: any): Promise<{ email: string } | null> {
  try {
    const secret = getEnv("SESSION_SECRET");
    if (!secret || secret.length < 32) return null;
    const token = parseCookies(req).locora_session;
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const expected = await hmacB64url(secret, parts[0] + "." + parts[1]);
    if (!ctEqual(expected, parts[2])) return null;
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (!payload.email || !isEmail(payload.email) || !payload.exp || payload.exp * 1000 < Date.now()) return null;
    const email = norm(payload.email);
    try {
      const tokenHash = await sha256Hex(token);
      const rev = await fetchJson(`${supabaseBase()}/rest/v1/revoked_tokens?id=eq.${encodeURIComponent(tokenHash)}&select=data`, { headers: supabaseHeaders() });
      if (rev.ok && Array.isArray(rev.body) && rev.body.length > 0) {
        const exp = rev.body[0].data?.expiresAt;
        if (!exp || new Date(exp).getTime() > Date.now()) return null;
      }
    } catch {
      // Fail CLOSED: a Supabase error must not silently skip the
      // revocation check (sign-out-everywhere would stop working).
      return null;
    }
    try {
      const userRow = await loadUserByEmail(email);
      if (userRow && userRow.data && typeof userRow.data.sessionVersion === "number") {
        const stored = userRow.data.sessionVersion;
        if (payload.v === undefined) {
          if (stored > 0) return null;
        } else if (payload.v !== stored) {
          return null;
        }
      }
    } catch {
      // Fail CLOSED: a Supabase error must not silently skip the
      // session-version check (sign-out-everywhere would stop working).
      return null;
    }
    return { email };
  } catch {
    return null;
  }
}

// Fail-CLOSED rate-limit helper for mutations (see api/auth.ts).
function limited(res: any, rl: { allowed: boolean; retryAfter: number; tableMissing: boolean }, message: string): boolean {
  if (rl.tableMissing) {
    sendJson(res, 503, { message: "Rate limiting is not configured. Please ask the admin to run the rate_limits setup SQL." });
    return true;
  }
  if (!rl.allowed) {
    sendJson(res, 429, { message }, { "Retry-After": String(rl.retryAfter) });
    return true;
  }
  return false;
}

async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfter: number; tableMissing: boolean }> {
  try {
    // Bound the key: it embeds unauthenticated emails/IPs, so an
    // unbounded key is unbounded row size (distinct keys are still
    // pruned by the retention SQL in supabase-setup.sql §6).
    key = String(key || "").slice(0, 512);
    if (!supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) return { allowed: false, retryAfter: 0, tableMissing: true };
    // Atomic path first: the rate_limit_hit RPC (see
    // SUPABASE_RPC_SETUP.md) increments and checks in one Postgres
    // call. Falls back to the read-modify-write path below when the
    // RPC has not been created yet.
    try {
      const rpc = await fetchJson(`${supabaseBase()}/rest/v1/rpc/rate_limit_hit`, {
        method: "POST",
        headers: supabaseHeaders(),
        body: JSON.stringify({ p_key: key, p_limit: limit, p_window_ms: windowMs }),
      });
      if (rpc.ok) {
        const r = rpc.body;
        if (typeof r === "boolean") return { allowed: r, retryAfter: 0, tableMissing: false };
        if (r && typeof r === "object") return { allowed: r.allowed !== false, retryAfter: Number(r.retry_after || 0), tableMissing: false };
      }
    } catch { /* fall through to the legacy path */ }
    const url = `${supabaseBase()}/rest/v1/rate_limits?id=eq.${encodeURIComponent(key)}&select=data`;
    const { ok, status, body } = await fetchJson(url, { headers: supabaseHeaders() });
    if (!ok) {
      if (status === 404 || status === 400) return { allowed: false, retryAfter: 0, tableMissing: true };
      return { allowed: true, retryAfter: 0, tableMissing: false };
    }
    const now = Date.now();
    const row = Array.isArray(body) && body.length > 0 ? body[0].data : null;
    const windowStart = row && typeof row.windowStart === "number" ? row.windowStart : 0;
    const count = row && typeof row.count === "number" ? row.count : 0;
    if (windowStart && now - windowStart < windowMs && count >= limit) {
      return { allowed: false, retryAfter: Math.ceil((windowStart + windowMs - now) / 1000), tableMissing: false };
    }
    const fresh = !windowStart || now - windowStart >= windowMs;
    const next = { count: fresh ? 1 : count + 1, windowStart: fresh ? now : windowStart };
    await fetchJson(`${supabaseBase()}/rest/v1/rate_limits`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "resolution=merge-duplicates,return=representation", "Content-Type": "application/json" },
      body: JSON.stringify({ id: key, data: next }),
    });
    return { allowed: true, retryAfter: 0, tableMissing: false };
  } catch {
    return { allowed: true, retryAfter: 0, tableMissing: false };
  }
}

async function loadRows(): Promise<any[]> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/${TABLE}?select=token,data`,
    { headers: supabaseHeaders() },
  );
  if (!ok) throw new Error("phone_verifications table read failed");
  if (!Array.isArray(body)) return [];
  return body.map((row: any) => ({ token: row.token, ...(row.data || {}) }));
}

// Targeted single-row fetch by the token column: the status poll and
// the /start handler used to load the WHOLE phone_verifications table
// on every call. Throws when the table cannot be read, so callers can
// tell "table missing" apart from "no such token".
async function loadRowByToken(token: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/${TABLE}?select=token,data&token=eq.${encodeURIComponent(token)}`,
    { headers: supabaseHeaders() },
  );
  if (!ok) throw new Error("phone_verifications table read failed");
  if (!Array.isArray(body) || body.length === 0) return null;
  return { token: body[0].token, ...(body[0].data || {}) };
}

// Targeted fetch of one email's rows (the start action used to load
// the whole table just to drop that email's stale pending tokens).
async function loadRowsByEmail(email: string): Promise<any[]> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/${TABLE}?select=token,data&data->>email=eq.${encodeURIComponent(email)}&limit=100`,
    { headers: supabaseHeaders() },
  );
  if (!ok) throw new Error("phone_verifications table read failed");
  if (!Array.isArray(body)) return [];
  return body.map((row: any) => ({ token: row.token, ...(row.data || {}) }));
}

async function insertRow(token: string, data: any): Promise<void> {
  const { ok } = await fetchJson(`${supabaseBase()}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({ token, data }),
  });
  if (!ok) throw new Error("phone_verifications insert failed");
}

async function updateRow(token: string, data: any): Promise<void> {
  await fetchJson(
    `${supabaseBase()}/rest/v1/${TABLE}?token=eq.${encodeURIComponent(token)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({ data }),
    },
  );
}

async function deleteRow(token: string): Promise<void> {
  await fetchJson(
    `${supabaseBase()}/rest/v1/${TABLE}?token=eq.${encodeURIComponent(token)}`,
    { method: "DELETE", headers: supabaseHeaders() },
  );
}

function digits(s: string): string {
  return (s || "").replace(/\D/g, "");
}

function numbersMatch(a: string, b: string): boolean {
  const da = digits(a);
  const db = digits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  // Split each number into a country code (the digits before the last
  // 10, when there are any) and the 10-digit national part. The old
  // rule matched on the last 10 digits alone, so a foreign virtual
  // number sharing the same 10 digits verified someone else's number.
  // Now the national parts must match AND the country codes must
  // agree whenever both sides carry one. A bare 10-digit profile
  // number (no code stored) still matches a coded Telegram number —
  // that is the existing legit flow, since profiles store the number
  // as typed; the residual (same 10 digits, different country, no
  // code on file) is documented in the audit report, and the verified
  // flag gates nothing by itself.
  const split = (d: string) =>
    d.length > 10 ? { code: d.slice(0, d.length - 10), national: d.slice(-10) } : { code: "", national: d };
  const sa = split(da);
  const sb = split(db);
  if (sa.national !== sb.national) return false;
  if (sa.code && sb.code && sa.code !== sb.code) return false;
  return true;
}

function isExpired(row: any): boolean {
  const t = Date.parse(row.createdAt || "");
  if (Number.isNaN(t)) return true;
  return Date.now() - t > TOKEN_TTL_MS;
}

async function telegramSend(
  chatId: number | string,
  text: string,
  replyMarkup?: any,
): Promise<void> {
  const token = getEnv("TELEGRAM_BOT_TOKEN");
  if (!token) return;
  try {
    await fetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
  } catch {
    // Webhook replies are best-effort; the row state is the truth.
  }
}

const SHARE_KEYBOARD = {
  keyboard: [[{ text: "Share my phone number", request_contact: true }]],
  one_time_keyboard: true,
  resize_keyboard: true,
};

async function handleTelegramUpdate(
  body: any,
  secretHeader: string,
): Promise<{ ok: boolean; reason?: string }> {
  const secret = getEnv("TELEGRAM_WEBHOOK_SECRET");
  if (!secret || !ctEqual(secretHeader, secret)) {
    return { ok: false, reason: "webhook secret missing or mismatch" };
  }
  const msg = body.message;
  if (!msg || !msg.chat || msg.chat.id === undefined) return { ok: true };
  const chatId = msg.chat.id;

  // Contact shared: the verification moment.
  if (msg.contact && msg.contact.phone_number) {
    let row: any = null;
    try {
      const { ok, body } = await fetchJson(
        `${supabaseBase()}/rest/v1/${TABLE}?select=token,data&data->>chatId=eq.${encodeURIComponent(String(chatId))}&limit=10`,
        { headers: supabaseHeaders() },
      );
      if (ok && Array.isArray(body)) {
        row = body.map((r: any) => ({ token: r.token, ...(r.data || {}) })).find(
          (r: any) =>
            (r.status === "pending" || r.status === "awaiting_contact") &&
            String(r.chatId) === String(chatId) &&
            !isExpired(r),
        ) || null;
      } else {
        throw new Error("targeted chat lookup failed");
      }
    } catch {
      // Fall back to the full scan rather than dropping a real
      // verification when the targeted query fails.
      try {
        const rows = await loadRows();
        row = rows.find(
          (r: any) =>
            (r.status === "pending" || r.status === "awaiting_contact") &&
            String(r.chatId) === String(chatId) &&
            !isExpired(r),
        ) || null;
      } catch {
        return { ok: true };
      }
    }
    if (!row) {
      await telegramSend(
        chatId,
        "I don't have a pending verification for this chat. Open Locora → Profile → Verify via Telegram to get your personal link first.",
      );
      return { ok: true };
    }
    if (numbersMatch(msg.contact.phone_number, row.phone)) {
      await updateRow(row.token, {
        ...row,
        status: "verified",
        verifiedAt: new Date().toISOString(),
      });
      await telegramSend(
        chatId,
        "Verified! Your Locora mobile number is confirmed. You can go back to Locora — your profile now shows it as verified.",
      );
    } else {
      await telegramSend(
        chatId,
        `That number (+${digits(msg.contact.phone_number)}) doesn't match the number on your Locora profile (+${digits(row.phone)}). Please share the number you registered with, or update it on Locora and get a fresh link.`,
      );
    }
    return { ok: true };
  }

  const text = typeof msg.text === "string" ? msg.text : "";
  if (text.startsWith("/start")) {
    const token = (text.split(/\s+/)[1] || "").trim();
    if (!token) {
      await telegramSend(
        chatId,
        "Open Locora → Profile → Verify via Telegram to get your personal verification link, then tap it to come back here.",
      );
      return { ok: true };
    }
    let row: any = null;
    try {
      row = await loadRowByToken(token);
    } catch {
      return { ok: true };
    }
    if (!row || row.status === "verified") {
      await telegramSend(
        chatId,
        "This link is no longer valid. Get a fresh link from your Locora profile (Profile → Verify via Telegram).",
      );
      return { ok: true };
    }
    if (row.status !== "pending" && row.status !== "awaiting_contact") {
      await telegramSend(
        chatId,
        "This link is no longer valid. Get a fresh link from your Locora profile (Profile → Verify via Telegram).",
      );
      return { ok: true };
    }
    if (isExpired(row)) {
      await updateRow(row.token, { ...row, status: "expired" });
      await telegramSend(
        chatId,
        "This link expired (links last 15 minutes). Get a fresh link from your Locora profile.",
      );
      return { ok: true };
    }
    await updateRow(row.token, { ...row, chatId, status: "awaiting_contact" });
    await telegramSend(
      chatId,
      `Tap "Share my phone number" below to verify ${row.phone} on Locora. Telegram shares the number it verified when you signed up — nothing else is shared.`,
      SHARE_KEYBOARD,
    );
    return { ok: true };
  }

  if (text) {
    await telegramSend(
      chatId,
      "Open Locora → Profile → Verify via Telegram to get your personal verification link, then tap it to come back here.",
    );
  }
  return { ok: true };
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "Method not allowed" });
      return;
    }
    const body = await readBody(req);

    // Telegram webhook update (no action field, has message). The
    // secret header is read here: Vercel lowercases header names.
    if (body && body.message) {
      const secretHeader =
        req.headers?.["x-telegram-bot-api-secret-token"] || "";
      const result = await handleTelegramUpdate(body, secretHeader);
      // Always 200 for Telegram so it does not retry a handled update.
      sendJson(res, 200, result);
      return;
    }

    if (!supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, { message: "Verification is not set up yet (Supabase env missing)" });
      return;
    }

    if (body.action === "start") {
      const session = await verifySession(req);
      if (!session) {
        sendJson(res, 401, { message: "Sign in required" });
        return;
      }
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(res, 400, { message: "A valid email is required" });
        return;
      }
      if (norm(email) !== session.email) {
        sendJson(res, 403, { message: "You can only verify your own email" });
        return;
      }
      const rl = await checkRateLimit(`telegram:start:${session.email}`, 5, 60 * 60 * 1000);
      if (limited(res, rl, "Too many verification attempts. Try again later.")) return;
      const d = digits(phone);
      if (d.length < 7 || d.length > 15) {
        sendJson(res, 400, { message: "A valid mobile number is required" });
        return;
      }
      const username = getEnv("TELEGRAM_BOT_USERNAME");
      if (!username) {
        sendJson(res, 503, { message: "Telegram verification is not set up yet (bot username missing)" });
        return;
      }
      let rows: any[];
      try {
        rows = await loadRowsByEmail(email);
      } catch {
        sendJson(res, 503, {
          message: "Verification table is not set up yet (see TELEGRAM_VERIFICATION_SETUP.md)",
        });
        return;
      }
      // One pending token per email: drop stale ones first.
      for (const r of rows) {
        if (r.status === "pending" || r.status === "awaiting_contact") {
          try {
            await deleteRow(r.token);
          } catch {
            // Best-effort; the new token still works.
          }
        }
      }
      // Fail CLOSED when Web Crypto is unavailable: the old fallback
      // (Date.now + Math.random) produced guessable verification
      // tokens.
      const cryptoObj = (globalThis as any).crypto;
      if (!cryptoObj || typeof cryptoObj.randomUUID !== "function") {
        sendJson(res, 503, { message: "Verification is not available in this runtime" });
        return;
      }
      const token = cryptoObj.randomUUID().replace(/-/g, "");
      try {
        await insertRow(token, {
          email,
          phone,
          status: "pending",
          createdAt: new Date().toISOString(),
        });
      } catch {
        sendJson(res, 503, {
          message: "Verification table is not set up yet (see TELEGRAM_VERIFICATION_SETUP.md)",
        });
        return;
      }
      sendJson(res, 200, {
        link: `https://t.me/${username}?start=${token}`,
        token,
        expiresInSec: Math.floor(TOKEN_TTL_MS / 1000),
      });
      return;
    }

    if (body.action === "status") {
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) {
        sendJson(res, 400, { message: "Token required" });
        return;
      }
      // The client polls this every 3s while waiting, so the limit is
      // generous (3000/hr per IP covers several concurrent pollers);
      // it still stops a flood, and the token itself is unguessable.
      const rlStatus = await checkRateLimit(`telegram:status:${getClientIp(req)}`, 3000, 60 * 60 * 1000);
      if (limited(res, rlStatus, "Too many status checks. Try again shortly.")) return;
      let row: any = null;
      try {
        row = await loadRowByToken(token);
      } catch {
        sendJson(res, 503, {
          message: "Verification table is not set up yet (see TELEGRAM_VERIFICATION_SETUP.md)",
        });
        return;
      }
      if (!row) {
        sendJson(res, 200, { status: "not_found" });
        return;
      }
      if (row.status === "verified") {
        // Verified rows were kept forever. A row verified more than
        // 24h ago is deleted on read (the client stops polling the
        // moment it sees "verified", so nothing still needs it).
        const doneAt = Date.parse(row.verifiedAt || row.createdAt || "");
        if (!Number.isNaN(doneAt) && Date.now() - doneAt > 24 * 60 * 60 * 1000) {
          try { await deleteRow(row.token); } catch { /* best-effort */ }
          sendJson(res, 200, { status: "not_found" });
          return;
        }
        sendJson(res, 200, { status: "verified" });
        return;
      }
      if (isExpired(row)) {
        try {
          await updateRow(row.token, { ...row, status: "expired" });
        } catch {
          // Best-effort.
        }
        sendJson(res, 200, { status: "expired" });
        return;
      }
      sendJson(res, 200, { status: row.status });
      return;
    }

    sendJson(res, 400, { message: "Unknown request" });
  } catch (err) {
    try { console.error("Telegram verify failed:", err instanceof Error ? err.message : err); } catch {}
    sendJson(res, 500, { message: "Verification failed" });
  }
}
