// Shared server helpers for Locora security fix — NO IMPORTS, NO node:crypto.
// This file is inlined into each api/*.ts function because this project's
// Vercel functions have historically been self-contained (no static imports:
// the previous _lib import and the node:crypto import both failed live with
// FUNCTION_INVOCATION_FAILED, while the import-free api/auth/google.ts worked).
// Crypto uses only WebCrypto (globalThis.crypto.subtle) + btoa/atob, which
// work in Node and Edge runtimes without any import. No secrets are hardcoded:
// SESSION_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come only from
// Vercel env vars. If SESSION_SECRET is missing, session verification fails
// closed (null) and login/signup/Google callback must refuse to issue a session.
export const ADMIN_EMAILS = ["mr.adeen946@gmail.com", "ayan.work937@gmail.com"];

export function getEnv(name: string): string {
  try {
    const env = (globalThis as any).process?.env;
    return (env && env[name]) || "";
  } catch {
    return "";
  }
}

export function norm(email: string): string {
  return (email || "").trim().toLowerCase();
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^@\s@]+$/.test(s || "");
}

export function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.indexOf(norm(email)) !== -1;
}

export function sendJson(res: any, status: number, obj: any, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": "no-store",
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(obj));
}

export function parseCookies(req: any): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers?.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function getClientIp(req: any): string {
  // Last entry, not first: the first x-forwarded-for entry is
  // client-controlled and trivially spoofed to dodge per-IP limits;
  // Vercel appends the real connecting IP last.
  const fwd = req.headers?.["x-forwarded-for"] || "";
  if (typeof fwd === "string" && fwd.trim()) {
    const parts = fwd.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers?.["x-real-ip"] || "unknown";
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
function b64urlEncode(text: string): string {
  return bytesToB64url(new TextEncoder().encode(text));
}
function b64urlDecode(text: string): string {
  return new TextDecoder().decode(b64urlToBytes(text));
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  (globalThis as any).crypto.getRandomValues(out);
  return out;
}
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

export interface SessionUser { email: string; role: string; authProvider: string; sessionVersion?: number; }

export async function signSession(email: string, role: string, authProvider: string, sessionVersion = 0): Promise<string> {
  const secret = getEnv("SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(JSON.stringify({
    email: norm(email), role: role || "attendee", authProvider: authProvider || "local",
    v: sessionVersion || 0, iat: now, exp: now + 7 * 24 * 3600,
  }));
  const sig = await hmacB64url(secret, header + "." + payload);
  return header + "." + payload + "." + sig;
}

export async function verifySession(req: any): Promise<SessionUser | null> {
  try {
    const secret = getEnv("SESSION_SECRET");
    if (!secret) return null;
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
    } catch {}
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
    } catch {}
    return { email, role: payload.role || "attendee", authProvider: payload.authProvider || "local", sessionVersion: typeof payload.v === "number" ? payload.v : undefined };
  } catch {
    return null;
  }
}

export async function revokeSessionToken(req: any): Promise<boolean> {
  try {
    const token = parseCookies(req).locora_session;
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    let expIso = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    try { expIso = new Date(JSON.parse(b64urlDecode(parts[1])).exp * 1000).toISOString(); } catch {}
    const tokenHash = await sha256Hex(token);
    const { ok } = await fetchJson(`${supabaseBase()}/rest/v1/revoked_tokens`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ id: tokenHash, data: { tokenHash, email: norm(JSON.parse(b64urlDecode(parts[1])).email || ""), expiresAt: expIso } }),
    });
    return ok;
  } catch { return false; }
}

function isSecureReq(req: any): boolean {
  const proto = req.headers?.["x-forwarded-proto"];
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "";
  return proto === "https" || (host !== "" && !host.includes("localhost") && !host.startsWith("127."));
}

export function sessionCookie(jwt: string, req: any): string {
  return `locora_session=${jwt}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${isSecureReq(req) ? "; Secure" : ""}`;
}
export function clearSessionCookie(req: any): string {
  return `locora_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecureReq(req) ? "; Secure" : ""}`;
}

// ---- Supabase ----
export function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" };
}
export function supabaseBase(): string {
  return getEnv("SUPABASE_URL").replace(/\/$/, "");
}
export async function fetchJson(url: string, init?: any): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}
export function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const b = (req as any).body;
      if (b && typeof b === "object") return resolve(b);
      if (typeof b === "string" && b.length > 0) {
        try { return resolve(JSON.parse(b)); } catch { return resolve({}); }
      }
      let data = "";
      const timer = setTimeout(() => resolve({}), 3000);
      req.on("data", (chunk: any) => { data += chunk; });
      req.on("end", () => { clearTimeout(timer); try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
      req.on("error", () => { clearTimeout(timer); resolve({}); });
    } catch { resolve({}); }
  });
}

// ---- Passwords (PBKDF2-SHA256 via WebCrypto, per-user salt, constant-time compare) ----
// Format: pbkdf2$<saltHex>$<hashHex>$100000. No live passwords exist yet
// (locora_users table is new in this fix), so no scrypt migration is needed.
export async function hashPassword(password: string): Promise<string> {
  const salt = bytesToHex(randomBytes(16));
  const key = await (globalThis as any).crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await (globalThis as any).crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBytes(salt), iterations: 100000, hash: "SHA-256" }, key, 256);
  return `pbkdf2$${salt}$${bytesToHex(new Uint8Array(bits))}$100000`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = (stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const key = await (globalThis as any).crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await (globalThis as any).crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBytes(parts[1]), iterations: parseInt(parts[3], 10) || 100000, hash: "SHA-256" }, key, 256);
    return ctEqual(bytesToHex(new Uint8Array(bits)), parts[2]);
  } catch { return false; }
}
export async function hashToken(raw: string): Promise<string> {
  return sha256Hex(raw);
}
export function randomTokenHex(bytes = 32): string {
  return bytesToHex(randomBytes(bytes));
}

// ---- Rate limiting (Supabase-backed counter, table rate_limits) ----
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfter: number; tableMissing: boolean }> {
  try {
    if (!supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) return { allowed: false, retryAfter: 0, tableMissing: true };
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
    const up = await fetchJson(`${supabaseBase()}/rest/v1/rate_limits`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ id: key, data: next }),
    });
    if (!up.ok && (up.status === 404 || up.status === 400)) return { allowed: false, retryAfter: 0, tableMissing: true };
    return { allowed: true, retryAfter: 0, tableMissing: false };
  } catch {
    return { allowed: true, retryAfter: 0, tableMissing: false };
  }
}

// Fail closed on mutations when the limiter is unavailable: a missing
// rate_limits table must never silently disable abuse protection on
// writes (login spam, message spam, order spam). Reads keep the old
// fail-open behaviour — a missing table must not take the inbox offline.
// Returns true when a response was already sent.
function limited(res: any, rl: { allowed: boolean; retryAfter: number; tableMissing: boolean }, message: string): boolean {
  if (rl.allowed) return false;
  if (rl.tableMissing) {
    sendJson(res, 503, { message: "Rate limiting is not configured. Please ask the admin to run the rate_limits setup SQL." });
  } else {
    sendJson(res, 429, { message }, { "Retry-After": String(rl.retryAfter) });
  }
  return true;
}

// ---- Events / organiser helpers ----
export function organizerEmailOf(event: any): string {
  return norm(event?.createdByEmail || event?.organizer?.email || "");
}
export function isEventOwner(event: any, email: string): boolean {
  if (!event || !email) return false;
  const e = norm(email);
  if (event.createdByEmail) return norm(event.createdByEmail) === e;
  return (event.organizer?.email || "") !== "" && norm(event.organizer.email) === e;
}
export function mayManageEvent(event: any, email: string): boolean {
  if (!event || !email) return false;
  if (isAdmin(email)) return true;
  return isEventOwner(event, email);
}
export function stripEventPublic(event: any): any {
  if (!event) return event;
  const { createdByEmail: _c, upiId: _u, organizer, ...rest } = event;
  let org = organizer;
  if (organizer && typeof organizer === "object") {
    const { email: _e, ...orgRest } = organizer;
    org = orgRest;
  }
  return { ...rest, organizer: org };
}
export async function loadEvent(eventId: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/events?id=eq.${encodeURIComponent(eventId)}&select=data`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data;
}
export async function loadAllEvents(): Promise<any[]> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/events?select=data&order=created_at.desc&limit=1000`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body)) return [];
  return body.map((r: any) => r.data).filter(Boolean);
}
export async function isApprovedOrganizer(email: string): Promise<boolean> {
  if (isAdmin(email)) return true;
  try {
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/organizer_access?email=eq.${encodeURIComponent(norm(email))}&select=data`,
      { headers: supabaseHeaders() },
    );
    if (!ok || !Array.isArray(body) || body.length === 0) return false;
    return body[0].data?.status === "approved";
  } catch { return false; }
}
export async function loadUserByEmail(email: string): Promise<{ id: string; data: any } | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/locora_users?select=id,data&data->>email=eq.${encodeURIComponent(norm(email))}`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0];
}
export function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// SECURITY FIX — Phase 2 P2-3 (and P2-4, see below): every method now
// requires a valid locora_session JWT. Identity comes ONLY from the JWT
// email; userEmail / senderEmail / editorEmail / recipientEmail in the
// query or body are never trusted as identity. GET ignores ?userEmail=
// entirely and returns only the session user's messages. POST sender
// must equal the session email. PATCH editor/recipient must equal the
// session email. DELETE/hide use the session email as the actor.
// Recipient resolution for a first message to an organiser is in P2-4
// (organizerId -> stored event's organiser email).

// Private attendee <-> organizer messages for an event.
//
// One thread per (event, attendee, organizer). The attendee starts it
// from the event page's "Message organizer" button; both sides then talk
// in the Messages inbox. No phone numbers or email addresses are ever
// shown to the other side inside the app — each side only sees the
// other's display name.
//
// GET  /api/messages?userEmail=x
//      -> { messages: [...] } every message where x is sender or
//         recipient, oldest first. The frontend groups them into threads.
// GET  /api/messages?userEmail=x&unreadCount=1 -> { count } unread
//      messages addressed to x (the Navbar badge).
// POST /api/messages { eventId, senderEmail, senderName?, recipientEmail,
//                      text?, attachment? }
//      -> stores one message and emails the recipient (best-effort).
//         text max 2000 chars; at least one of text / attachment.
//         attachment is { name, size, type, path } — the public URL is
//         rebuilt here from path, never trusted from the caller.
// POST /api/messages { action: "upload-url", eventId, senderEmail,
//                      recipientEmail, fileName, fileSize, fileType }
//      -> { uploadUrl, publicUrl, path } for a direct browser -> Supabase
//         Storage upload. Files NEVER travel through this function:
//         Vercel serverless payloads cap around 4.5MB, far below the
//         20MB attachment limit, so the browser PUTs the file straight
//         to Storage with the signed URL and only the metadata comes here.
// PATCH /api/messages?id=x { recipientEmail }
//      -> marks that message read; only its recipient may do this.
// PATCH /api/messages?id=x { editorEmail, text }
//      -> edits the text of your OWN message within 1 hour of sending
//         (sets edited: true + editedAt). Later edits, and edits by
//         anyone else, are refused. The attachment is untouched.
// POST /api/messages { action: "hide", id, userEmail }
//      -> "Delete for me": hides that message for that user only, any
//         time. The other side still sees it. Implemented as a hiddenFor
//         list on the row; GET filters it out for the hider.
// DELETE /api/messages?id=x&userEmail=y
//      -> "Delete for everyone": permanently removes the row (and, best
//         effort, its Storage object). Only the SENDER may do this, any
//         time. A recipient who wants it gone uses "Delete for me".
//
// Authorization: every method requires a valid locora_session JWT
// (P2-3) and identity comes only from it; senderEmail / recipientEmail
// in the body are never trusted as identity. The rules below stop
// misuse through the API itself:
//   - an attendee may only message the event's organizer (taken from
//     the STORED event row, never the caller's claim);
//   - an organizer (or admin) may only reply inside a thread the
//     attendee already started — they cannot cold-message anyone;
//   - nobody may message themselves.
// A fake "sent" message would be worse than an error, so unlike other
// services this one has NO localStorage fallback: if the table is
// missing the endpoint fails closed (503) and the UI says so.
//
// Attachments: video, images, PDF, Word (.doc/.docx) and spreadsheets
// (.xls/.xlsx/.xlsm), each at most 20MB. The Storage bucket is
// "message-attachments" (public reads, uploads only via the signed URLs
// issued here). See MESSAGES_SETUP.md.
//
// This is a Vercel Serverless Function, self-contained (no imports).
// Supabase setup: table messages (id text primary key, data jsonb not
// null, created_at timestamptz default now()); env vars SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY (already set); GMAIL_USER / GMAIL_APP_PASSWORD
// for the new-message email (already set; best-effort, never blocks send).

const SITE_URL = "https://locora-hyperlocal.vercel.app";
const BUCKET = "message-attachments";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 2000;

// Extension -> expected MIME family. The server checks the extension
// (the client also checks File.type); a mismatch is rejected.
const ALLOWED_EXTENSIONS: Record<string, string[]> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  mp4: ["video/mp4"],
  webm: ["video/webm"],
  mov: ["video/quicktime"],
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  xls: ["application/vnd.ms-excel"],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  xlsm: ["application/vnd.ms-excel.sheet.macroEnabled.12"],
};



async function loadAllMessages(): Promise<any[]> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages?select=id,data&limit=1000`,
    { headers: supabaseHeaders() },
  );
  if (!ok) throw new Error("messages table read failed");
  return Array.isArray(body) ? body.map((row: any) => row.data) : [];
}

// Per-user read: only rows where the caller is sender or recipient,
// server-side filtered (the old code fetched the WHOLE table every 3
// seconds per polling tab and relied on PostgREST's 1,000-row default
// cap, so old conversations silently vanished past 1,000 rows site-wide
// and server cost grew with total usage). Falls back to the full read
// (callers filter by participant) if the jsonb filter is ever rejected.
async function loadMessagesFor(email: string): Promise<any[]> {
  const out = new Map<string, any>();
  try {
    for (const field of ["senderEmail", "recipientEmail"]) {
      const { ok, body } = await fetchJson(
        `${supabaseBase()}/rest/v1/messages?select=id,data&data->>${field}=eq.${encodeURIComponent(norm(email))}&limit=1000`,
        { headers: supabaseHeaders() },
      );
      if (!ok) throw new Error("filtered messages read failed");
      if (Array.isArray(body)) for (const row of body) if (row.data?.id) out.set(row.data.id, row.data);
    }
    return [...out.values()];
  } catch {
    return loadAllMessages();
  }
}

// Block rows are stored as { type: "block", blockerEmail, blockedEmail }
// — they carry neither senderEmail nor recipientEmail, so the per-user
// filtered read in loadMessagesFor() can never return them. Every block
// check must use this loader instead (previously findBlock() always saw
// an empty set, so blocks were silently non-functional).
async function loadBlocksFor(email: string): Promise<any[]> {
  const out = new Map<string, any>();
  try {
    for (const field of ["blockerEmail", "blockedEmail"]) {
      const { ok, body } = await fetchJson(
        `${supabaseBase()}/rest/v1/messages?select=id,data&data->>${field}=eq.${encodeURIComponent(norm(email))}&limit=1000`,
        { headers: supabaseHeaders() },
      );
      if (!ok) throw new Error("filtered blocks read failed");
      if (Array.isArray(body)) for (const row of body) if (row.data?.id) out.set(row.data.id, row.data);
    }
    return [...out.values()].filter((m: any) => m.type === "block");
  } catch {
    // Same fallback as loadMessagesFor: a rejected jsonb filter must not
    // silently drop blocks (fail closed at the call site on throw).
    const all = await loadAllMessages();
    return all.filter((m: any) => m.type === "block" && (norm(m.blockerEmail) === norm(email) || norm(m.blockedEmail) === norm(email)));
  }
}

// Targeted idempotency lookup: the old in-memory scan over the
// 1,000-row-capped loadMessagesFor() set was racy and window-limited —
// two concurrent retries with the same key could both pass it.
async function loadMessageByIdempotencyKey(key: string, sender: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages?select=id,data&data->>idempotencyKey=eq.${encodeURIComponent(key)}&data->>senderEmail=eq.${encodeURIComponent(norm(sender))}&limit=1`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data;
}

// Per-recipient throttle for new-message email alerts (email_log,
// kind "message"): without it one sender can fire 60 alert emails/hour
// at any organizer. The message itself is always stored; only the mail
// is skipped when the cap is hit.
async function countRecentMessageMails(email: string): Promise<number | null> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const url =
    `${supabaseBase()}/rest/v1/email_log?select=created_at` +
    `&email=eq.${encodeURIComponent(norm(email))}&kind=eq.message&created_at=gte.${encodeURIComponent(since)}`;
  const { ok, body } = await fetchJson(url, { headers: supabaseHeaders() });
  if (!ok || !Array.isArray(body)) return null;
  return body.length;
}

async function logMessageMail(email: string): Promise<void> {
  try {
    await fetchJson(`${supabaseBase()}/rest/v1/email_log`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ email: norm(email), kind: "message" }),
    });
  } catch { /* a missed log row only risks a duplicate mail later */ }
}

async function deleteAttachmentObject(path: string): Promise<void> {
  try {
    await fetchJson(
      `${supabaseBase()}/storage/v1/object/${BUCKET}/${path}`,
      { method: "DELETE", headers: supabaseHeaders() },
    );
  } catch { /* best-effort */ }
}

// Verify an uploaded attachment against its REAL bytes, not the
// metadata the uploader declared: upload-url and send used to trust
// declared size/type/extension, while the browser PUTs straight to
// Storage — so the 20MB/type limits were bypassable via direct API.
// This fetches only the first bytes (Range request, reader cancelled
// after the first chunk — never a 20MB download) and checks the magic
// bytes against the extension, plus the stored total size. Returns an
// error string, or null when the attachment checks out. A mismatched
// object is deleted so it does not linger publicly.
async function verifyAttachment(path: string, ext: string): Promise<string | null> {
  const url = `${supabaseBase()}/storage/v1/object/public/${BUCKET}/${path}`;
  let res: any;
  try {
    res = await fetch(url, { headers: { Range: "bytes=0-15" } });
  } catch {
    return "Could not verify the attachment — please try again";
  }
  if (res.status === 404) return "Attachment was not uploaded — please upload it again";
  if (!res.ok && res.status !== 206) return "Could not verify the attachment — please try again";
  // Total size: prefer the Content-Range total; a 200 (non-range)
  // response carries it in Content-Length instead. If neither is
  // present, HEAD the object — an unverifiable size fails closed.
  let total = NaN;
  const range = res.headers.get("content-range") || "";
  const totalMatch = range.match(/\/(\d+)\s*$/);
  if (totalMatch) total = Number(totalMatch[1]);
  if (!Number.isFinite(total) && res.status === 200) total = Number(res.headers.get("content-length") || "");
  if (!Number.isFinite(total)) {
    try {
      const headRes = await fetch(url, { method: "HEAD" });
      if (headRes.ok) total = Number(headRes.headers.get("content-length") || "");
    } catch { /* fall through to the fail-closed check below */ }
  }
  if (!Number.isFinite(total) || total <= 0) {
    return "Could not verify the attachment — please try again";
  }
  if (total > MAX_ATTACHMENT_BYTES) {
    await deleteAttachmentObject(path);
    return "Attachment exceeds the 20MB limit";
  }
  let head = new Uint8Array(0);
  try {
    const reader = (res.body as any)?.getReader?.();
    if (reader) {
      const { value } = await reader.read();
      try { await reader.cancel(); } catch {}
      head = value || new Uint8Array(0);
    } else {
      const buf = await res.arrayBuffer();
      head = new Uint8Array(buf).slice(0, 16);
    }
  } catch {
    return "Could not verify the attachment — please try again";
  }
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  const at = (off: number, ...bytes: number[]) => bytes.every((b, i) => head[off + i] === b);
  // Magic bytes first (as before), then the STORED Content-Type for
  // every extension: the upload PUT's Content-Type is caller-controlled
  // and Supabase serves it verbatim, so a PNG-magic file stored as
  // text/html used to pass the sniff and render as a page from the
  // public bucket. An absent/generic type is tolerated (some browsers
  // PUT without one); any other mismatch is rejected and deleted.
  let ok = true;
  if (ext === "png") ok = starts(0x89, 0x50, 0x4e, 0x47);
  else if (ext === "jpg" || ext === "jpeg") ok = starts(0xff, 0xd8, 0xff);
  else if (ext === "gif") ok = starts(0x47, 0x49, 0x46, 0x38);
  else if (ext === "webp") ok = starts(0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
  else if (ext === "pdf") ok = starts(0x25, 0x50, 0x44, 0x46);
  else if (ext === "docx" || ext === "xlsx" || ext === "xlsm") ok = starts(0x50, 0x4b, 0x03, 0x04);
  else if (ext === "doc" || ext === "xls") ok = starts(0xd0, 0xcf, 0x11, 0xe0);
  else if (ext === "mp4" || ext === "mov") ok = at(4, 0x66, 0x74, 0x79, 0x70);
  else if (ext === "webm") ok = starts(0x1a, 0x45, 0xdf, 0xa3);
  else ok = false;
  if (ok) {
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const allowedCts = ALLOWED_EXTENSIONS[ext] || [];
    if (ct && ct !== "application/octet-stream" && !allowedCts.includes(ct)) ok = false;
  }
  if (!ok) {
    await deleteAttachmentObject(path);
    return "Attachment contents do not match its file type";
  }
  return null;
}

async function loadMessage(id: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages?id=eq.${encodeURIComponent(id)}&select=data`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data;
}

async function storeMessage(msg: any): Promise<void> {
  const { ok } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages`,
    {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ id: msg.id, data: msg }),
    },
  );
  if (!ok) throw new Error("messages table write failed");
}

async function updateMessageData(msg: any): Promise<void> {
  const { ok } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages?id=eq.${encodeURIComponent(msg.id)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({ data: msg }),
    },
  );
  if (!ok) throw new Error("messages table update failed");
}

// The organizer's email comes from the STORED event row only.
function isOrganizerOrAdmin(sender: string, organizerEmail: string): boolean {
  return sender === organizerEmail || ADMIN_EMAILS.includes(sender);
}

// Shared rule for sending a message AND for issuing an upload URL:
// returns an error string, or null when the sender may contact the
// recipient about this event.
//
// The check keys on the RECIPIENT, not on the sender's role — the
// earlier version keyed on the sender and broke a real case: an admin
// writing to an organizer for the first time was treated as "an
// organizer cold-messaging" and blocked, when they were simply an
// attendee starting a conversation. Now:
//   - anyone may write TO the event's organizer (starting or continuing);
//   - anyone else may only be written to by the organizer/admin, and
//     only inside a thread the attendee already started.
function threadPairExists(existing: any[], eventId: string, a: string, b: string): boolean {
  return existing.some(
    (m: any) =>
      m.eventId === eventId &&
      m.type !== "block" &&
      ((m.senderEmail === a && m.recipientEmail === b) ||
        (m.senderEmail === b && m.recipientEmail === a)) &&
      // A thread both sides deleted for themselves is dead: replies
      // into it would resurrect a conversation both people removed.
      !(((m.hiddenFor || []) as string[]).includes(a) && ((m.hiddenFor || []) as string[]).includes(b)),
  );
}

function findBlock(existing: any[], eventId: string, a: string, b: string): any | null {
  return existing.find(
    (m: any) =>
      m.type === "block" &&
      m.eventId === eventId &&
      ((m.blockerEmail === a && m.blockedEmail === b) ||
        (m.blockerEmail === b && m.blockedEmail === a)),
  ) || null;
}

function authorizeContact(
  event: any,
  sender: string,
  recipient: string,
  existing: any[],
  blocks: any[] = [],
): string | null {
  const organizerEmail = organizerEmailOf(event);
  if (!organizerEmail) return "This event has no organizer contact";
  if (sender === recipient) return "You cannot message yourself";
  if (findBlock(blocks, event.id, sender, recipient)) return "This conversation is blocked";
  if (recipient === organizerEmail) return null;
  if (!isOrganizerOrAdmin(sender, organizerEmail)) {
    return "You can only message this event's organizer";
  }
  // Organizers reply; they never cold-message. A thread exists when
  // either side has already written to the other about this event.
  const threadExists = threadPairExists(existing, event.id, sender, recipient);
  return threadExists
    ? null
    : "Reply inside a conversation the attendee started";
}

function extensionOf(fileName: string): string {
  const parts = (fileName || "").split(".");
  if (parts.length < 2) return "";
  return (parts.pop() || "").toLowerCase();
}

function sanitizePathSegment(s: string): string {
  return (s || "").replace(/[^A-Za-z0-9_-]/g, "");
}

// --- New-message email (best-effort, never blocks the send) ---

function buildMessageEmail(
  msg: any,
  event: any,
): { to: string; subject: string; text: string; html: string } | null {
  const to = msg.recipientEmail;
  if (!to) return null;
  const title = event?.title || "an event";
  const senderName = msg.senderName || msg.senderEmail;
  const snippet =
    msg.text && msg.text.trim()
      ? msg.text.trim().slice(0, 200)
      : msg.attachment
        ? `Sent an attachment: ${msg.attachment.name}`
        : "Sent you a message";
  const subject = `New message about "${title}"`;
  // P2-4: the email alert link carries only the eventId, never
  // an email address, so no organiser/attendee email leaks via URL.
  const link = `${SITE_URL}/messages?eventId=${encodeURIComponent(msg.eventId)}`;
  const text =
    `${senderName} sent you a message about "${title}":\n\n${snippet}\n\n` +
    `Reply in Locora: ${link}`;
  const html =
    `<div style="background:#FAF8F5;padding:24px;font-family:Georgia,serif;color:#1E2320;">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #E7E3DB;border-radius:16px;overflow:hidden;">` +
    `<div style="height:4px;background:#C25E00;"></div>` +
    `<div style="padding:24px;">` +
    `<div style="font-size:22px;font-weight:bold;color:#1E3F35;">Locora</div>` +
    `<h2 style="font-size:18px;color:#1E3F35;">New message about "${esc(title)}"</h2>` +
    `<p><strong>${esc(senderName)}</strong> wrote:</p>` +
    `<p style="background:#FAF8F5;border:1px solid #E7E3DB;border-radius:12px;padding:12px 16px;">${esc(snippet)}</p>` +
    `<a href="${link}" style="display:inline-block;background:#1E3F35;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:999px;font-size:14px;">Reply in Locora</a>` +
    `</div></div></div>`;
  return { to, subject, text, html };
}

async function sendMail(
  mail: { to: string; subject: string; text: string; html: string } | null,
): Promise<boolean> {
  const user = getEnv("GMAIL_USER");
  const pass = getEnv("GMAIL_APP_PASSWORD");
  if (!user || !pass || !mail) return false;
  try {
    // Dynamic import: nodemailer loads only when an email is actually
    // sent, so plain message reads never pay its load cost.
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: pass.replace(/\s+/g, "") },
    });
    await transporter.sendMail({ from: user, ...mail });
    return true;
  } catch (err) {
    console.warn("Message email failed (message still stored):", err);
    return false;
  }
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (
      req.method !== "GET" &&
      req.method !== "POST" &&
      req.method !== "PATCH" &&
      req.method !== "DELETE"
    ) {
      sendJson(res, 405, { message: "Method not allowed" });
      return;
    }
    if (!supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, { message: "Messages are not set up yet" });
      return;
    }
    // P2-3: session first, for every method. No session -> 401, no data.
    const session = await verifySession(req);
    if (!session) {
      sendJson(res, 401, { message: "Sign in required" });
      return;
    }
    const me = session.email;

    // ---- GET: list / unread count ----
    if (req.method === "GET") {
      // userEmail query param is IGNORED (it was the P2-3 trust vector).
      const userEmail = me;
      const rl = await checkRateLimit(`msg:get:${getClientIp(req)}:${me}`, 300, 10 * 60 * 1000);
      if (!rl.allowed && !rl.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rl.retryAfter) });
        return;
      }
      let all: any[];
      try {
        all = await loadMessagesFor(userEmail);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // "Delete for me" hides via hiddenFor; old rows predate the field
      // and are treated as hidden for nobody. Block rows are internal
      // state and never listed as messages.
      const mine = all
        .filter(
          (m: any) =>
            m.type !== "block" &&
            (m.senderEmail === userEmail || m.recipientEmail === userEmail) &&
            !((m.hiddenFor || []) as string[]).includes(userEmail),
        )
        // Server-internal fields must not leak to the counterparty:
        // hiddenFor would tell B that A deleted the message for
        // themselves, idempotencyKey is a bearer-ish token, and
        // editHistory keeps edited-away text readable after an edit.
        .map((m: any) => {
          const out: any = { ...m };
          delete out.hiddenFor;
          delete out.idempotencyKey;
          if (m.senderEmail !== userEmail) delete out.editHistory;
          return out;
        });
      if (req.query?.unreadCount === "1") {
        sendJson(res, 200, {
          count: mine.filter((m: any) => m.recipientEmail === userEmail && !m.read)
            .length,
        });
        return;
      }
      // Same-millisecond messages used to flip order (createdAt-only
      // sort); id breaks ties deterministically.
      mine.sort((a: any, b: any) =>
        (a.createdAt || "").localeCompare(b.createdAt || "") ||
        (a.id || "").localeCompare(b.id || ""),
      );
      sendJson(res, 200, { messages: mine });
      return;
    }

    const body = await readBody(req);

    // ---- DELETE: delete for everyone (sender only) ----
    if (req.method === "DELETE") {
      const rlDel = await checkRateLimit(`msg:delete:${me}`, 60, 10 * 60 * 1000);
      if (limited(res, rlDel, "Too many requests. Try again shortly.")) return;
      const id = String(req.query?.id || "");
      const userEmail = me;
      if (!id) {
        sendJson(res, 400, { message: "id is required" });
        return;
      }
      const msg = await loadMessage(id);
      if (!msg) {
        sendJson(res, 404, { message: "Message not found" });
        return;
      }
      if (msg.senderEmail !== userEmail) {
        sendJson(res, 403, { message: "Only the sender can delete for everyone" });
        return;
      }
      // A delete-for-everyone window: after 24 hours the message is
      // part of the other side's history and only "delete for me"
      // remains. (Previously there was no window at all, and no
      // tombstone — the other side's conversation just lost messages
      // without explanation.)
      const ageMs = Date.now() - Date.parse(msg.createdAt || "");
      if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) {
        sendJson(res, 403, { message: "Messages can only be deleted for everyone within 24 hours of sending" });
        return;
      }
      // Storage first: if the attachment cannot be removed, the row
      // stays — previously the row was deleted and the public URL kept
      // serving the file, which is the opposite of a deletion.
      if (msg.attachment?.path) {
        try {
          await fetchJson(
            `${supabaseBase()}/storage/v1/object/${BUCKET}/${msg.attachment.path}`,
            { method: "DELETE", headers: supabaseHeaders() },
          );
        } catch { /* fall through: row is still intact below */ }
        // Verify the object is actually gone before tombstoning.
        try {
          const check = await fetch(`${supabaseBase()}/storage/v1/object/public/${BUCKET}/${msg.attachment.path}`, { method: "HEAD" });
          if (check.ok || check.status === 200) {
            sendJson(res, 502, { message: "Could not delete the attachment. Nothing was deleted." });
            return;
          }
        } catch { /* HEAD failure is not proof the object survived; continue */ }
      }
      // Tombstone, not row deletion: the other side sees "This message
      // was deleted" instead of a silently shifting conversation, and
      // thread grouping (which keys on message rows) stays stable.
      const tombstoned: any = {
        ...msg,
        text: "",
        attachment: null,
        // editHistory kept up to 5 prior versions: deleting for everyone
        // must not leave edited-away text readable via the API.
        editHistory: [],
        deletedForEveryone: true,
        deletedAt: new Date().toISOString(),
      };
      try {
        await updateMessageData(tombstoned);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // Scrub quotes of this message in the same threads (the reply
      // feature freezes a quote snapshot at send time; a deleted
      // message must not survive inside someone else's quote).
      try {
        const mine = await loadMessagesFor(userEmail);
        for (const m of mine) {
          if (m.replyToId === id && m.replySnapshot) {
            m.replySnapshot = { ...m.replySnapshot, text: "", deleted: true };
            try { await updateMessageData(m); } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }
      sendJson(res, 200, { deleted: true, message: tombstoned });
      return;
    }

    // ---- POST: "Delete for me" (hide for one user) ----
    if (req.method === "POST" && body.action === "hide") {
      const rlHide = await checkRateLimit(`msg:hide:${me}`, 60, 10 * 60 * 1000);
      if (limited(res, rlHide, "Too many requests. Try again shortly.")) return;
      const id = String(body.id || "");
      const userEmail = me;
      if (!id) {
        sendJson(res, 400, { message: "id is required" });
        return;
      }
      const msg = await loadMessage(id);
      if (!msg) {
        sendJson(res, 404, { message: "Message not found" });
        return;
      }
      if (msg.senderEmail !== userEmail && msg.recipientEmail !== userEmail) {
        sendJson(res, 403, { message: "You are not part of this conversation" });
        return;
      }
      const hiddenFor: string[] = Array.isArray(msg.hiddenFor) ? msg.hiddenFor : [];
      if (!hiddenFor.includes(userEmail)) hiddenFor.push(userEmail);
      msg.hiddenFor = hiddenFor;
      try {
        await updateMessageData(msg);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      sendJson(res, 200, { message: msg });
      return;
    }

    // ---- POST: block / unblock a conversation ----
    // Blocks live as rows in the messages table (no new table needed):
    // { type: "block", eventId, blockerEmail, blockedEmail }. GET
    // never lists them; authorizeContact refuses both directions while
    // one exists. Only someone with an actual thread with the target
    // may block them; only the blocker may lift their own block.
    if (req.method === "POST" && (body.action === "block" || body.action === "unblock")) {
      const rlBlock = await checkRateLimit(`msg:block:${me}`, 20, 10 * 60 * 1000);
      if (limited(res, rlBlock, "Too many requests. Try again shortly.")) return;
      const eventId = String(body.eventId || "");
      const target = norm(body.blockedEmail || body.recipientEmail || "");
      if (!eventId || !isEmail(target)) {
        sendJson(res, 400, { message: "eventId and a valid blockedEmail are required" });
        return;
      }
      if (target === me) {
        sendJson(res, 400, { message: "You cannot block yourself" });
        return;
      }
      const event = await loadEvent(eventId);
      if (!event) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      let existing: any[] = [];
      let blocks: any[] = [];
      try {
        existing = await loadMessagesFor(me);
        blocks = await loadBlocksFor(me);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      if (body.action === "block") {
        if (!threadPairExists(existing, eventId, me, target)) {
          sendJson(res, 403, { message: "You can only block someone you have a conversation with" });
          return;
        }
        if (!findBlock(blocks, eventId, me, target)) {
          try {
            await storeMessage({
              id: `block-${Date.now()}-${randomTokenHex(4)}`,
              type: "block",
              eventId,
              blockerEmail: me,
              blockedEmail: target,
              createdAt: new Date().toISOString(),
            });
          } catch {
            sendJson(res, 503, { message: "Messages are not set up yet" });
            return;
          }
        }
        sendJson(res, 200, { blocked: true });
        return;
      }
      const mine = blocks.filter((m: any) => m.eventId === eventId && m.blockerEmail === me && m.blockedEmail === target);
      for (const row of mine) {
        try {
          await fetchJson(
            `${supabaseBase()}/rest/v1/messages?id=eq.${encodeURIComponent(row.id)}`,
            { method: "DELETE", headers: supabaseHeaders() },
          );
        } catch { /* best-effort */ }
      }
      sendJson(res, 200, { blocked: false });
      return;
    }

    // ---- POST: delete an orphaned upload (send failed after upload) ----
    // Uploads happen before the send, so a failed send (or a retry that
    // uploads again) used to leave unreferenced public objects in the
    // bucket forever. The client calls this best-effort on send failure.
    // The path pattern is the same one send() enforces, and the random
    // suffix makes other users' paths unguessable.
    if (req.method === "POST" && body.action === "delete-upload") {
      const rlDelUp = await checkRateLimit(`msg:delete-upload:${me}`, 20, 10 * 60 * 1000);
      if (limited(res, rlDelUp, "Too many requests. Try again shortly.")) return;
      const path = String(body.path || "");
      const pathOk = /^[A-Za-z0-9_-]+\/[0-9]+-[a-z0-9]+\.[A-Za-z0-9]+$/.test(path);
      if (!pathOk) {
        sendJson(res, 400, { message: "Invalid attachment path" });
        return;
      }
      // Authorization: the path's first segment is the event folder.
      // The caller must be a participant in a thread for that event,
      // and the path must not be referenced by any stored message for
      // the event — referenced attachments go through the message
      // DELETE flow (which verifies Storage deletion before tombstoning).
      // This endpoint exists only to clean up orphaned uploads from
      // failed sends.
      const eventId = path.split("/")[0];
      const event = await loadEvent(eventId);
      if (!event) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      let existing: any[] = [];
      try {
        existing = await loadMessagesFor(me);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      const organizerEmail = organizerEmailOf(event);
      const isParticipant =
        me === organizerEmail ||
        threadPairExists(existing, eventId, me, organizerEmail) ||
        existing.some((m: any) => m.eventId === eventId && (m.senderEmail === me || m.recipientEmail === me));
      if (!isParticipant) {
        sendJson(res, 403, { message: "You are not part of this conversation" });
        return;
      }
      // Referenced anywhere for this event? Refuse — delete the message.
      let referenced = false;
      try {
        const { ok, body: rows } = await fetchJson(
          `${supabaseBase()}/rest/v1/messages?select=data&data->>eventId=eq.${encodeURIComponent(eventId)}&limit=1000`,
          { headers: supabaseHeaders() },
        );
        if (ok && Array.isArray(rows)) {
          referenced = rows.some((row: any) => row.data?.attachment?.path === path);
        }
      } catch { /* on read failure, fall through to the participant-only check */ }
      if (referenced) {
        sendJson(res, 409, { message: "This attachment belongs to a sent message — delete the message instead" });
        return;
      }
      await deleteAttachmentObject(path);
      sendJson(res, 200, { deleted: true });
      return;
    }

    // ---- POST: signed upload URL ----
    if (req.method === "POST" && body.action === "upload-url") {
      const rlUpload = await checkRateLimit(`msg:upload:${me}`, 20, 10 * 60 * 1000);
      if (limited(res, rlUpload, "Too many requests. Try again shortly.")) return;
      const eventId = String(body.eventId || "");
      const sender = me;
      const fileName = String(body.fileName || "");
      const fileSize = Number(body.fileSize || 0);
      const fileType = String(body.fileType || "");
      if (!eventId || !fileName) {
        sendJson(res, 400, { message: "eventId and fileName are required" });
        return;
      }
      // Recipient: if organizerId is given, resolve it from the stored
      // event (P2-4); otherwise fall back to a caller recipient that
      // authorizeContact() still validates against the stored event.
      const eventForRecipient = await loadEvent(eventId);
      let recipient = norm(body.recipientEmail || "");
      if (body.organizerId && eventForRecipient) {
        const orgEmail = organizerEmailOf(eventForRecipient);
        if (orgEmail) recipient = orgEmail;
      }
      if (!isEmail(recipient)) {
        sendJson(res, 400, { message: "A valid recipient is required" });
        return;
      }
      if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_ATTACHMENT_BYTES) {
        sendJson(res, 400, { message: "File must be larger than 0 and no bigger than 20MB" });
        return;
      }
      const ext = extensionOf(fileName);
      const allowed = ALLOWED_EXTENSIONS[ext];
      if (!allowed || (fileType && !allowed.includes(fileType))) {
        sendJson(res, 400, {
          message: "File type not allowed — video, image, PDF, Word or spreadsheet only",
        });
        return;
      }
      const event = await loadEvent(eventId);
      if (!event) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      let existing: any[] = [];
      let blocks: any[] = [];
      try {
        existing = await loadMessagesFor(sender);
        blocks = await loadBlocksFor(sender);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      const denied = authorizeContact(event, sender, recipient, existing, blocks);
      if (denied) {
        sendJson(res, 403, { message: denied });
        return;
      }
      // First messages need a published event; replies in an existing
      // thread keep working even if the event is later cancelled, so a
      // conversation is not cut off mid-discussion.
      if (event.status && event.status !== "published" && !threadPairExists(existing, eventId, sender, recipient)) {
        sendJson(res, 409, { message: "This event is not open for new messages" });
        return;
      }
      const path = `${sanitizePathSegment(eventId)}/${Date.now()}-${randomTokenHex(6)}.${ext}`;
      // Upload signed URLs are a DIFFERENT endpoint from download
      // signed URLs, and mixing them up fails in confusing ways:
      //   - POST /object/sign/... signs a DOWNLOAD link, so it 404s
      //     "Object not found" for a path that does not exist yet;
      //   - POST /object/upload/sign/... signs an UPLOAD link for a
      //     new object, which is what this is. It returns a token; the
      //     browser PUTs the file to .../object/upload/sign/...?token=.
      // expiresIn (seconds) is REQUIRED — without it Storage answers
      // 400 "body must have required property 'expiresIn'". One hour
      // is plenty for picking and uploading a file.
      const { ok, status, body: signBody } = await fetchJson(
        `${supabaseBase()}/storage/v1/object/upload/sign/${BUCKET}/${path}`,
        {
          method: "POST",
          headers: supabaseHeaders(),
          body: JSON.stringify({ expiresIn: 3600 }),
        },
      );
      let uploadUrl = "";
      if (signBody?.token) {
        uploadUrl = `${supabaseBase()}/storage/v1/object/upload/sign/${BUCKET}/${path}?token=${signBody.token}`;
      } else if (signBody?.url) {
        uploadUrl = signBody.url.startsWith("http")
          ? signBody.url
          : `${supabaseBase()}/storage/v1${signBody.url}`;
      }
      if (!ok || !uploadUrl) {
        // Surface Storage's own reason instead of a generic guess: a
        // 404 here means the bucket is not in this project, a 401/403
        // means the key, and so on. No secret ever appears in these.
        const detail =
          signBody?.message || signBody?.error || `storage sign failed (${status})`;
        sendJson(res, 502, {
          message: `Message attachments are not set up yet (${detail})`,
        });
        return;
      }
      sendJson(res, 200, {
        uploadUrl,
        publicUrl: `${supabaseBase()}/storage/v1/object/public/${BUCKET}/${path}`,
        path,
      });
      return;
    }

    // ---- POST: send a message ----
    if (req.method === "POST") {
      const rlSend = await checkRateLimit(`msg:send:${me}`, 60, 60 * 60 * 1000);
      if (limited(res, rlSend, "Too many messages. Try again shortly.")) return;
      const eventId = String(body.eventId || "");
      const sender = me;
      // Display names are server-derived, never caller-supplied: the
      // old code stored body.senderName verbatim (spoofable, and the
      // same spoofed name went out in the email alert).
      let senderName = sender;
      try {
        const profile = await loadUserByEmail(sender);
        if (profile && typeof profile.data?.name === "string" && profile.data.name.trim()) {
          senderName = profile.data.name.trim().slice(0, 80);
        }
      } catch { /* fall back to the email address */ }
      const text = String(body.text || "").trim().slice(0, MAX_TEXT_CHARS);
      const attachment = body.attachment || null;
      if (!eventId) {
        sendJson(res, 400, { message: "eventId is required" });
        return;
      }
      // Recipient resolution (P2-4): organizerId -> stored event's
      // organiser email. A caller-supplied recipientEmail is only used
      // when no organizerId is given, and authorizeContact() below
      // still validates it against the stored event.
      const eventForRecipient = await loadEvent(eventId);
      if (!eventForRecipient) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      let recipient = norm(body.recipientEmail || "");
      if (body.organizerId) {
        const orgEmail = organizerEmailOf(eventForRecipient);
        if (orgEmail) recipient = orgEmail;
      }
      if (!isEmail(recipient)) {
        sendJson(res, 400, { message: "A valid recipient is required" });
        return;
      }
      if (!text && !attachment) {
        sendJson(res, 400, { message: "Write a message or attach a file" });
        return;
      }
      let cleanAttachment: any = null;
      if (attachment) {
        const name = String(attachment.name || "");
        const size = Number(attachment.size || 0);
        const type = String(attachment.type || "");
        const path = String(attachment.path || "");
        const ext = extensionOf(name);
        const allowed = ALLOWED_EXTENSIONS[ext];
        // The path must be one this endpoint could have issued for this
        // event; the public URL is rebuilt from it, never trusted.
        const pathOk =
          path.startsWith(`${sanitizePathSegment(eventId)}/`) &&
          /^[A-Za-z0-9_-]+\/[0-9]+-[a-z0-9]+\.[A-Za-z0-9]+$/.test(path) &&
          path.endsWith(`.${ext}`);
        if (
          !name || name.length > 200 || !Number.isFinite(size) ||
          size <= 0 || size > MAX_ATTACHMENT_BYTES ||
          !allowed || (type && !allowed.includes(type)) || !pathOk
        ) {
          sendJson(res, 400, {
            message: "Attachment not allowed — video, image, PDF, Word or spreadsheet, max 20MB",
          });
          return;
        }
        cleanAttachment = {
          name,
          size,
          type,
          path,
          url: `${supabaseBase()}/storage/v1/object/public/${BUCKET}/${path}`,
        };
      }
      const event = await loadEvent(eventId);
      if (!event) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      let existing: any[] = [];
      let blocks: any[] = [];
      try {
        existing = await loadMessagesFor(sender);
        blocks = await loadBlocksFor(sender);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      const denied = authorizeContact(event, sender, recipient, existing, blocks);
      if (denied) {
        sendJson(res, 403, { message: denied });
        return;
      }
      // First messages need a published event (replies keep working
      // after a later cancellation — see upload-url for the same rule).
      if (event.status && event.status !== "published" && !threadPairExists(existing, eventId, sender, recipient)) {
        sendJson(res, 409, { message: "This event is not open for new messages" });
        return;
      }
      // Send idempotency: a lost response + Retry used to create a
      // duplicate message (the client cleared the draft before the send
      // completed). A retry carrying the same key returns the original
      // row instead of storing a second one.
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.slice(0, 100) : "";
      if (idempotencyKey) {
        const prior = await loadMessageByIdempotencyKey(idempotencyKey, sender).catch(() => null);
        if (prior) {
          sendJson(res, 200, { message: prior, mailed: false, idempotent: true });
          return;
        }
      }
      // Attachments are verified against their real bytes here (see
      // verifyAttachment): declared size/type/extension alone were
      // bypassable, because the browser uploads straight to Storage.
      if (cleanAttachment) {
        const sniffError = await verifyAttachment(cleanAttachment.path, extensionOf(cleanAttachment.name));
        if (sniffError) {
          sendJson(res, 400, { message: sniffError });
          return;
        }
      }
      // Recipient display name (the old thread list showed the viewer's
      // OWN name for sender-side threads, because no recipient name was
      // ever stored): the organizer's name from the stored event, or
      // the attendee's profile name.
      let recipientName = recipient;
      try {
        if (recipient === organizerEmailOf(event)) {
          if (event.organizer && typeof event.organizer.name === "string" && event.organizer.name.trim()) {
            recipientName = event.organizer.name.trim().slice(0, 80);
          }
        } else {
          const profile = await loadUserByEmail(recipient);
          if (profile && typeof profile.data?.name === "string" && profile.data.name.trim()) {
            recipientName = profile.data.name.trim().slice(0, 80);
          }
        }
      } catch { /* fall back to the email address */ }
      const msg: any = {
        id: `msg-${Date.now()}-${randomTokenHex(4)}`,
        eventId,
        eventTitle: event.title || "",
        senderEmail: sender,
        senderName,
        recipientEmail: recipient,
        recipientName,
        text: text || "",
        attachment: cleanAttachment,
        read: false,
        hiddenFor: [],
        createdAt: new Date().toISOString(),
      };
      if (idempotencyKey) msg.idempotencyKey = idempotencyKey;
      try {
        await storeMessage(msg);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // Best-effort alert; a mail failure must never unsend the message.
      // Per-recipient throttle (10/hour): without it one sender can fire
      // 60 alert emails/hour at any organizer.
      let mailed = false;
      const recentMails = await countRecentMessageMails(recipient).catch(() => null);
      if (recentMails === null || recentMails < 10) {
        mailed = await sendMail(buildMessageEmail(msg, event));
        if (mailed) await logMessageMail(recipient);
      }
      sendJson(res, 200, { message: msg, mailed });
      return;
    }

    // ---- PATCH: edit text (own message, within 1 hour) / mark read ----
    if (req.method === "PATCH") {
      const rlPatch = await checkRateLimit(`msg:patch:${me}`, 60, 10 * 60 * 1000);
      if (limited(res, rlPatch, "Too many requests. Try again shortly.")) return;
      const id = String(req.query?.id || "");
      if (body.text !== undefined) {
        const editor = me;
        const text = String(body.text || "").trim().slice(0, MAX_TEXT_CHARS);
        if (!id || !text) {
          sendJson(res, 400, { message: "id and non-empty text are required" });
          return;
        }
        const msg = await loadMessage(id);
        if (!msg) {
          sendJson(res, 404, { message: "Message not found" });
          return;
        }
        if (msg.senderEmail !== editor) {
          sendJson(res, 403, { message: "You can only edit your own messages" });
          return;
        }
        if (msg.deletedForEveryone) {
          sendJson(res, 403, { message: "A deleted message cannot be edited" });
          return;
        }
        const ageMs = Date.now() - Date.parse(msg.createdAt || "");
        if (!Number.isFinite(ageMs) || ageMs > 60 * 60 * 1000) {
          sendJson(res, 403, { message: "Messages can only be edited within 1 hour of sending" });
          return;
        }
        // Edits used to leave no history: the previous text vanished.
        // Keep the last few versions on the row (cap 5).
        const history: any[] = Array.isArray(msg.editHistory) ? msg.editHistory : [];
        history.push({ text: msg.text || "", at: msg.editedAt || msg.createdAt || null });
        msg.editHistory = history.slice(-5);
        msg.text = text;
        msg.edited = true;
        msg.editedAt = new Date().toISOString();
        try {
          await updateMessageData(msg);
        } catch {
          sendJson(res, 503, { message: "Messages are not set up yet" });
          return;
        }
        sendJson(res, 200, { message: msg });
        return;
      }
      const recipient = me;
      if (!id) {
        sendJson(res, 400, { message: "id is required" });
        return;
      }
      const msg = await loadMessage(id);
      if (!msg) {
        sendJson(res, 404, { message: "Message not found" });
        return;
      }
      if (msg.recipientEmail !== recipient) {
        sendJson(res, 403, { message: "Only the recipient can mark this read" });
        return;
      }
      msg.read = true;
      try {
        await updateMessageData(msg);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      sendJson(res, 200, { message: msg });
      return;
    }

    sendJson(res, 405, { message: "Method not allowed" });
  } catch (err) {
    console.warn("messages handler failed:", err);
    sendJson(res, 500, { message: "Something went wrong" });
  }
}
