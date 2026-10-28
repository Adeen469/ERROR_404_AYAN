import { createHmac, timingSafeEqual, scryptSync, randomBytes, createHash } from "crypto";
// Shared server helpers for Locora security fix (Phase 1 Finding 1+).
// Used by api/registrations.ts, api/events.ts, api/messages.ts,
// api/auth/* and api/me.ts. No secrets are hardcoded here: SESSION_SECRET,
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come only from Vercel env vars.
// If SESSION_SECRET is missing, session verification fails closed (null)
// and login/signup/Google callback must refuse to issue a session.

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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || "");
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
  const fwd = req.headers?.["x-forwarded-for"] || "";
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.headers?.["x-real-ip"] || "unknown";
}

function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
function b64urlDecode(text: string): string {
  return Buffer.from(text, "base64url").toString("utf8");
}

export interface SessionUser { email: string; role: string; authProvider: string; sessionVersion?: number; }

export function signSession(email: string, role: string, authProvider: string, sessionVersion = 0): string {
  const secret = getEnv("SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(JSON.stringify({
    email: norm(email), role: role || "attendee", authProvider: authProvider || "local",
    v: sessionVersion || 0,
    iat: now, exp: now + 7 * 24 * 3600,
  }));
  const sig = createHmac("sha256", secret).update(header + "." + payload).digest("base64url");
  return header + "." + payload + "." + sig;
}

export function sessionToken(req: any): string | null {
  try { return parseCookies(req).locora_session || null; } catch { return null; }
}

// Async verifySession (revocation pass): signature + expiry, then
// (a) revoked_tokens — a row for this token's SHA-256 hash, not yet
// expired, rejects the token. If the table is missing/unreadable the
// check is SKIPPED (allow), so a missing table can never lock everyone
// out; logout revocation simply does not persist until the table
// exists (see SECURITY_FIX_SETUP.md). This is honest fail-open for
// revocation only — a missing SESSION_SECRET still fails closed.
// (b) session version — if a locora_users row exists with a numeric
// sessionVersion, the token's v must match it. A token with no v is
// rejected only when the stored version is > 0 (so pre-version tokens
// keep working until a password reset bumps the version). If no user
// row exists (e.g. locora_users missing, Google sign-in recorded
// best-effort), the version check is skipped, not failed.
export async function verifySession(req: any): Promise<SessionUser | null> {
  try {
    const secret = getEnv("SESSION_SECRET");
    if (!secret) return null;
    const token = sessionToken(req);
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const expected = createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest("base64url");
    const a = Buffer.from(expected);
    const b = Buffer.from(parts[2]);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (!payload.email || !isEmail(payload.email) || !payload.exp || payload.exp * 1000 < Date.now()) return null;
    const email = norm(payload.email);
    // (a) revocation check (best-effort, fail-open only on table errors).
    try {
      if (supabaseBase() && getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
        const tokenHash = hashToken(token);
        const { ok, body } = await fetchJson(
          `${supabaseBase()}/rest/v1/revoked_tokens?id=eq.${encodeURIComponent(tokenHash)}&select=data`,
          { headers: supabaseHeaders() },
        );
        if (ok && Array.isArray(body) && body.length > 0) {
          const d = body[0].data || {};
          if (!d.expiresAt || Date.parse(d.expiresAt) >= Date.now()) return null;
        }
      }
    } catch {}
    // (b) session-version check (skipped when no user row is found).
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

// Insert the caller's current token into revoked_tokens (best-effort).
// Returns true only if the row was written; a missing table / error
// returns false and must never fail logout (the cookie is still cleared).
export async function revokeSessionToken(req: any): Promise<boolean> {
  try {
    const token = sessionToken(req);
    if (!token || !supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) return false;
    const parts = token.split(".");
    let expMs = Date.now() + 7 * 24 * 3600 * 1000;
    let email = "";
    try {
      const payload = JSON.parse(b64urlDecode(parts[1]));
      if (payload.exp) expMs = payload.exp * 1000;
      if (payload.email) email = norm(payload.email);
    } catch {}
    const tokenHash = hashToken(token);
    const { ok } = await fetchJson(`${supabaseBase()}/rest/v1/revoked_tokens`, {
      method: "POST", headers: supabaseHeaders(),
      body: JSON.stringify({ id: tokenHash, data: { tokenHash, email, expiresAt: new Date(expMs).toISOString() } }),
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

// ---- Passwords (scrypt, per-user salt, timing-safe compare) ----
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = (stored || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const hash = scryptSync(password, parts[1], 64);
    const expected = Buffer.from(parts[2], "hex");
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch { return false; }
}
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
export function randomTokenHex(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

// ---- Rate limiting (Supabase-backed counter, table rate_limits) ----
// Returns { allowed, retryAfter, tableMissing }.
// Auth callers must fail closed (503) when tableMissing is true.
// Read (GET) callers may allow when tableMissing is true, because the
// data itself is already protected by the session check; the table
// must still be created (see SECURITY_FIX_SETUP.md).
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
// Authorization (same honesty note as registrations): there is no
// session auth, so senderEmail / recipientEmail are caller-sent and
// trusted the way the app's own UI sends them. The rules below still
// stop misuse through the API itself:
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

const ADMIN_EMAILS = ["mr.adeen946@gmail.com", "ayan.work937@gmail.com"];
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
    `${supabaseBase()}/rest/v1/messages?select=id,data`,
    { headers: supabaseHeaders() },
  );
  if (!ok) throw new Error("messages table read failed");
  return Array.isArray(body) ? body.map((row: any) => row.data) : [];
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
function authorizeContact(
  event: any,
  sender: string,
  recipient: string,
  existing: any[],
): string | null {
  const organizerEmail = organizerEmailOf(event);
  if (!organizerEmail) return "This event has no organizer contact";
  if (sender === recipient) return "You cannot message yourself";
  if (recipient === organizerEmail) return null;
  if (!isOrganizerOrAdmin(sender, organizerEmail)) {
    return "You can only message this event's organizer";
  }
  // Organizers reply; they never cold-message. A thread exists when
  // either side has already written to the other about this event.
  const threadExists = existing.some(
    (m: any) =>
      m.eventId === event.id &&
      ((m.senderEmail === sender && m.recipientEmail === recipient) ||
        (m.senderEmail === recipient && m.recipientEmail === sender)),
  );
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
        all = await loadAllMessages();
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // "Delete for me" hides via hiddenFor; old rows predate the field
      // and are treated as hidden for nobody.
      const mine = all.filter(
        (m: any) =>
          (m.senderEmail === userEmail || m.recipientEmail === userEmail) &&
          !((m.hiddenFor || []) as string[]).includes(userEmail),
      );
      if (req.query?.unreadCount === "1") {
        sendJson(res, 200, {
          count: mine.filter((m: any) => m.recipientEmail === userEmail && !m.read)
            .length,
        });
        return;
      }
      mine.sort((a: any, b: any) =>
        (a.createdAt || "").localeCompare(b.createdAt || ""),
      );
      sendJson(res, 200, { messages: mine });
      return;
    }

    const body = await readBody(req);

    // ---- DELETE: delete for everyone (sender only) ----
    if (req.method === "DELETE") {
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
      const { ok } = await fetchJson(
        `${supabaseBase()}/rest/v1/messages?id=eq.${encodeURIComponent(id)}`,
        { method: "DELETE", headers: supabaseHeaders() },
      );
      if (!ok) {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // Best-effort: remove the attachment object too, so a deleted
      // file does not linger in Storage under a guessable path.
      if (msg.attachment?.path) {
        try {
          await fetchJson(
            `${supabaseBase()}/storage/v1/object/${BUCKET}/${msg.attachment.path}`,
            { method: "DELETE", headers: supabaseHeaders() },
          );
        } catch {
          // Row is already gone; a leftover object is harmless clutter.
        }
      }
      sendJson(res, 200, { deleted: true });
      return;
    }

    // ---- POST: "Delete for me" (hide for one user) ----
    if (req.method === "POST" && body.action === "hide") {
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

    // ---- POST: signed upload URL ----
    if (req.method === "POST" && body.action === "upload-url") {
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
      try {
        existing = await loadAllMessages();
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      const denied = authorizeContact(event, sender, recipient, existing);
      if (denied) {
        sendJson(res, 403, { message: denied });
        return;
      }
      const path = `${sanitizePathSegment(eventId)}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
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
      const eventId = String(body.eventId || "");
      const sender = me;
      const senderName = String(body.senderName || "");
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
      try {
        existing = await loadAllMessages();
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      const denied = authorizeContact(event, sender, recipient, existing);
      if (denied) {
        sendJson(res, 403, { message: denied });
        return;
      }
      const msg: any = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        eventId,
        eventTitle: event.title || "",
        senderEmail: sender,
        senderName: senderName || sender,
        recipientEmail: recipient,
        text: text || "",
        attachment: cleanAttachment,
        read: false,
        hiddenFor: [],
        createdAt: new Date().toISOString(),
      };
      try {
        await storeMessage(msg);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // Best-effort alert; a mail failure must never unsend the message.
      const mailed = await sendMail(buildMessageEmail(msg, event));
      sendJson(res, 200, { message: msg, mailed });
      return;
    }

    // ---- PATCH: edit text (own message, within 1 hour) / mark read ----
    if (req.method === "PATCH") {
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
        const ageMs = Date.now() - Date.parse(msg.createdAt || "");
        if (!Number.isFinite(ageMs) || ageMs > 60 * 60 * 1000) {
          sendJson(res, 403, { message: "Messages can only be edited within 1 hour of sending" });
          return;
        }
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
