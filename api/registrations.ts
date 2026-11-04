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

// SECURITY FIX — Phase 1 Finding 1 (and Phase 2 P2-1): registrations are
// now session-only. No valid locora_session JWT -> 401 with no data and
// no parameter listing. With a session: own records only, or organiser/
// admin records for that organiser's own events. Nested event objects
// are always stripped of organiser.email, createdByEmail and upiId.
// Identity comes ONLY from the JWT; body/query userEmail, approverEmail
// and userId are never trusted as identity.
// See SECURITY_FIX_SETUP.md (locora_users, rate_limits, SESSION_SECRET).

// Shared registrations API — Razorpay-only paid registrations.
//
// Manual organizer approval (pay via UPI, submit a UTR, organizer
// approves) was REMOVED in full: paid events are paid only through
// Razorpay Standard Checkout (api/payments.ts), which issues the pass
// automatically once Razorpay confirms a captured payment. There is no
// approval queue, no UTR, and no organizer approve/reject anymore —
// for paid rows, PATCH status changes by an organizer are refused.
//
// GET  /api/registrations?userId=x      -> that user's registrations
// GET  /api/registrations?eventId=x     -> that event's registrations
// GET  /api/registrations?id=x          -> one registration
// GET  /api/registrations?pendingCounts=1 -> { counts: { eventId: n } }
//                                            for pending (unpaid
//                                            Razorpay) registrations
// POST /api/registrations { ...registration }
//      -> stores a registration (status 'pending' for a Razorpay row,
//         'confirmed' for free). A paid row that is NOT a Razorpay row
//         is refused: there is no manual payment path anymore. The
//         ticket code for a pending row is issued by api/payments.ts
//         on verified payment, not here.
// PATCH /api/registrations?id=x { status?, checkedIn? }
//      -> check-in: only the event's owner or an admin (Active
//         management). cancel ('cancelled'): only the registration's
//         own user. Organizer confirm/reject no longer exist.
// Identity comes from the verified session cookie; body/query
// userEmail, approverEmail and userId are never trusted as identity.
//
// This is a Vercel Serverless Function, self-contained (no imports).
//
// Supabase setup (see REGISTRATIONS_SETUP.md):
//   Table: registrations (id text primary key, data jsonb not null,
//                          created_at timestamptz default now())
//   Vercel env vars (Production, Sensitive, already set for events):
//     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// The service-role key is server-only: the frontend never calls Supabase
// directly, it only calls this function, so the key never reaches a browser.
//
// If the env vars are missing, this returns 503 JSON and the frontend
// falls back to per-browser local registrations.
//
// Email notifications (see ORGANIZER_NOTIFICATIONS_SETUP.md):
// when a registration is CONFIRMED with a ticket code (a free instant
// registration, or a Razorpay payment verified by api/payments.ts),
// the attendee gets a confirmation email with that code. Sending is
// best-effort and gated on the Gmail env vars; without them nothing
// is sent and the registration still succeeds. Sends are awaited
// before responding (serverless work after a response is not
// guaranteed to run), but any mail failure is swallowed so it can
// never fail a registration.


async function loadAllRegistrations(): Promise<any[]> {
  // Paginated: PostgREST's default cap is 1,000 rows, so an unpaged
  // read silently dropped older registrations as the table grew.
  const out: any[] = [];
  for (let page = 0; page < 10; page++) {
    const offset = page * 1000;
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/registrations?select=id,data&limit=1000&offset=${offset}`,
      { headers: supabaseHeaders() },
    );
    if (!ok) throw new Error("registrations table read failed");
    const rows = Array.isArray(body) ? body.map((row: any) => row.data) : [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// True when a Telegram-verified row matches this email + phone
// (see api/telegram-verify.ts). Used to stamp phoneVerified on a
// registration server-side; a client-sent value is never trusted.
async function hasVerifiedPhone(email: string, phone: string): Promise<boolean> {
  const digits = (s: string) => (s || "").replace(/\D/g, "");
  const dp = digits(phone || "");
  if (!email || !dp) return false;
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/phone_verifications?select=data`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body)) return false;
  return body.some((row: any) => {
    const d = row.data || {};
    if (d.status !== "verified" || d.email !== email) return false;
    const rdp = digits(d.phone || "");
    if (!rdp) return false;
    if (rdp === dp) return true;
    if (rdp.length >= 10 && dp.length >= 10) return rdp.slice(-10) === dp.slice(-10);
    return false;
  });
}


// Email content for a pending payment. Exported so it can be unit-tested
// without sending. The recipient is the STORED event's organizer email
// (loaded server-side above), never an address the caller supplied, so
// this cannot be used to relay mail to arbitrary addresses.
// Locora email theme: the website's own palette — warm parchment page,
// white card, deep forest headings, terracotta accent, serif wordmark.
// Plain-text versions stay unchanged; only the HTML part is themed.
// All styles are inline (email clients strip <style> blocks). The logo
// loads from the live site; if an inbox blocks images, the "Locora"
// wordmark beside it still reads.
const SITE_URL = "https://locora-hyperlocal.vercel.app";

function emailLayout(title: string, inner: string): string {
  return (
    `<div style="background:#FAF8F5;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">` +
    `<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #E7E3DB;border-radius:16px;overflow:hidden;">` +
    `<div style="height:4px;background:#C25E00;"></div>` +
    `<div style="padding:32px;">` +
    `<div style="margin-bottom:24px;">` +
    `<img src="${SITE_URL}/locora-logo.png" alt="Locora" width="36" height="36" style="vertical-align:middle;border-radius:8px;" />` +
    `<span style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;color:#1E3F35;vertical-align:middle;margin-left:10px;">Locora</span>` +
    `</div>` +
    `<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;color:#1E3F35;margin:0 0 16px;">${title}</h1>` +
    inner +
    `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #E7E3DB;font-size:12px;line-height:1.5;color:#5F635D;">Locora · Hyperlocal Event Discovery &amp; Community Engagement<br />This is an automated email — please don't reply.</div>` +
    `</div></div></div>`
  );
}

function bodyText(s: string): string {
  return `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#1E2320;">${s}</p>`;
}

function detailRow(label: string, value: string): string {
  return `<p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#1E2320;"><span style="color:#5F635D;">${label}:</span> ${value}</p>`;
}

function primaryButton(label: string, href: string): string {
  return `<p style="margin:20px 0 0;"><a href="${href}" style="display:inline-block;background:#1E3F35;color:#ffffff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px;">${label}</a></p>`;
}

function ticketBox(code: string): string {
  return `<div style="background:#FAF8F5;border:1px solid #E7E3DB;border-radius:12px;padding:16px;text-align:center;margin:20px 0;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5F635D;margin-bottom:6px;">Your ticket code</div><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;letter-spacing:2px;font-weight:700;color:#1E3F35;">${code}</div></div>`;
}


// Confirmation email for the attendee. Sent when a registration is
// confirmed with a ticket code: a free instant registration, or a
// Razorpay payment verified by api/payments.ts. Returns null without a recipient
// or without a ticket code, so a confirmation without a pass is never
// mailed. Exported for unit tests.
export function buildAttendeeConfirmationEmail(reg: any, event: any): { to: string; subject: string; text: string; html: string } | null {
  const to = reg?.userEmail || '';
  if (!to || !reg?.ticketCode) return null;
  const title = event?.title || 'the event';
  const venue = [event?.venueName, event?.city, event?.state].filter(Boolean).join(', ');
  let when = '';
  try {
    if (event?.startDate) {
      when = new Date(event.startDate).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    }
  } catch {
    when = '';
  }
  const link = `https://locora-hyperlocal.vercel.app/events/${reg.eventId}`;
  const subject = `You're registered: ${title}`;
  const lines = [
    `You're registered for "${title}".`,
    `Your ticket code: ${reg.ticketCode}`,
    venue ? `Venue: ${venue}` : '',
    when ? `When: ${when}` : '',
    `Show this code at the event. View the event here: ${link}`,
  ].filter(Boolean);
  const text = lines.join('\n\n');
  const html = emailLayout(
    "You're registered",
    bodyText(`You're registered for "${esc(title)}".`) +
      ticketBox(esc(reg.ticketCode)) +
      (venue ? detailRow("Venue", esc(venue)) : '') +
      (when ? detailRow("When", esc(when)) : '') +
      bodyText(`Show this code at the event.`) +
      primaryButton("View event", link),
  );
  return { to, subject, text, html };
}

// (Deleted with the manual-approval flow: the "payment received,
// awaiting approval" email no longer exists. Pending Razorpay rows
// mail nothing; confirmation mails go out on verified payment.)

async function sendMail(mail: { to: string; subject: string; text: string; html: string } | null): Promise<boolean> {
  const user = getEnv('GMAIL_USER');
  const pass = getEnv('GMAIL_APP_PASSWORD');
  if (!user || !pass || !mail) return false;
  try {
    // Dynamic import: nodemailer loads only when an email is actually
    // sent, so plain registration reads never pay its load cost.
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass: pass.replace(/\s+/g, '') },
    });
    await transporter.sendMail({ from: user, ...mail });
    return true;
  } catch (err) {
    console.warn('Email failed (registration still stored):', err);
    return false;
  }
}


async function sendAttendeeConfirmationEmail(reg: any, event: any): Promise<boolean> {
  return sendMail(buildAttendeeConfirmationEmail(reg, event));
}


function stripReg(reg: any, sessionEmail: string, isOrganiser: boolean): any {
  const event = reg.event ? stripEventPublic(reg.event) : undefined;
  // Organiser view keeps attendee fields needed for the roster.
  // Own view keeps the attendee's own fields (including their own ticketCode).
  // In both cases the nested event is stripped. Any other view (which
  // callers must 403 first) is defence-in-depth stripped of phone/UTR:
  // this function used to be a no-op spread, so a future caller passing
  // the flag wrong would have silently leaked attendee phones and UTRs.
  if (isOrganiser) return { ...reg, event };
  if (norm(reg.userEmail) === norm(sessionEmail)) return { ...reg, event };
  const { userPhone: _p, utr: _u, ...rest } = reg;
  return { ...rest, event };
}

// 6 crypto-random characters (no lookalikes), server-generated only.
// The old LOC-<1000..9999>-TK via Math.random had only 9,000 values.
function newTicketCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  try {
    const bytes = new Uint8Array(6);
    (globalThis as any).crypto.getRandomValues(bytes);
    for (const b of bytes) out += chars[b % chars.length];
  } catch {
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  }
  return `LOC-${out}-TK`;
}

// Full refund of a captured Razorpay payment (attendee-cancelled paid
// passes). The organizer's dashboard is the fallback when this fails.
async function refundRazorpayPayment(paymentId: string): Promise<{ ok: boolean; refundId?: string }> {
  try {
    const keyId = getEnv("RAZORPAY_KEY_ID");
    const secret = getEnv("RAZORPAY_KEY_SECRET");
    if (!keyId || !secret) return { ok: false };
    const raw = `${keyId}:${secret}`;
    let auth = "";
    try { auth = `Basic ${(globalThis as any).btoa(raw)}`; } catch {
      const Buf = (globalThis as any).Buffer;
      if (Buf) auth = `Basic ${Buf.from(raw, "utf-8").toString("base64")}`;
    }
    if (!auth) return { ok: false };
    const res = await fetchJson(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok && res.body?.id) return { ok: true, refundId: res.body.id };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// Management (check-in, attendee roster) requires the
// organizer to STILL be approved, not just to have created the event:
// revocation previously left old-event management and attendee phones
// fully open to a removed organizer's still-valid session. Admins pass
// (isApprovedOrganizer already returns true for them).
async function mayManageEventActive(event: any, email: string): Promise<boolean> {
  if (!event || !email) return false;
  if (!mayManageEvent(event, email)) return false;
  return isApprovedOrganizer(email);
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, { message: "Shared registrations database is not configured" });
      return;
    }
    // Finding 1 / P2-1: session first, for every method. No session ->
    // 401, no data, no parameter listing, no hint about the query interface.
    const session = await verifySession(req);
    if (!session) {
      sendJson(res, 401, { message: "Sign in required" });
      return;
    }
    const me = session.email;

    const url = new URL(req.url || "/api/registrations", "http://localhost");
    const q = url.searchParams;

    if (req.method === "GET") {
      // Rate limit (GETs: allow if the rate_limits table is missing,
      // because the session check already protects the data).
      const rl = await checkRateLimit(`reg:get:${getClientIp(req)}:${me}`, 300, 10 * 60 * 1000);
      if (!rl.allowed && !rl.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rl.retryAfter) });
        return;
      }
      const all = await loadAllRegistrations();
      if (q.get("pendingCounts") === "1") {
        // Only counts for events this caller organises (or admins).
        const events = await loadAllEventsForCounts();
        const counts: Record<string, number> = {};
        for (const r of all) {
          if (r && r.status === "pending") {
            const ev = events[r.eventId];
            if (ev && mayManageEvent(ev, me)) counts[r.eventId] = (counts[r.eventId] || 0) + 1;
          }
        }
        sendJson(res, 200, { counts });
        return;
      }
      if (q.get("id")) {
        const reg = all.find((r: any) => r.id === q.get("id"));
        if (!reg) { sendJson(res, 404, { message: "Registration not found" }); return; }
        const event = await loadEvent(reg.eventId);
        // Roster views require STILL-approved management (revocation
        // must also close attendee phone/UTR access, not just the hub).
        const isOrg = await mayManageEventActive(event, me);
        if (norm(reg.userEmail) !== me && !isOrg) { sendJson(res, 403, { message: "Not allowed" }); return; }
        sendJson(res, 200, stripReg(reg, me, isOrg));
        return;
      }
      if (q.get("eventId")) {
        const event = await loadEvent(q.get("eventId") || "");
        if (!event) { sendJson(res, 404, { message: "Event not found" }); return; }
        if (!(await mayManageEventActive(event, me))) { sendJson(res, 403, { message: "Not allowed" }); return; }
        sendJson(res, 200, all.filter((r: any) => r.eventId === q.get("eventId")).map((r: any) => stripReg(r, me, true)));
        return;
      }
      // userId is IGNORED as identity (it was the IDOR vector). Any
      // other GET, including ?userId=someone-else, returns only the
      // caller's own records, by JWT email.
      sendJson(res, 200, all.filter((r: any) => norm(r.userEmail) === me).map((r: any) => stripReg(r, me, false)));
      return;
    }

    if (req.method === "POST") {
      // Rate limit: every pending row emails the organizer, so an
      // unlimited POST was an organizer-inbox spam vector.
      const rlPost = await checkRateLimit(`reg:post:${me}`, 30, 60 * 60 * 1000);
      if (!rlPost.allowed && !rlPost.tableMissing) {
        sendJson(res, 429, { message: "Too many registrations. Try again shortly." }, { "Retry-After": String(rlPost.retryAfter) });
        return;
      }
      const reg = await readBody(req);
      if (!reg || !reg.id || !reg.eventId || !reg.userId) {
        sendJson(res, 400, { message: "Registration needs id, eventId and userId" });
        return;
      }
      // Identity is the JWT email, never the body email.
      if (norm(reg.userEmail) !== me) {
        sendJson(res, 403, { message: "You can only register yourself" });
        return;
      }
      const event = await loadEvent(reg.eventId);
      if (!event) { sendJson(res, 404, { message: "Event not found" }); return; }
      // The event must be open: published and not ended. (Status is
      // enforced only when present, so legacy rows without a status
      // field keep working.)
      if (event.status && event.status !== "published") {
        sendJson(res, 409, { message: "This event is not open for registration" });
        return;
      }
      if (event.endDate && !Number.isNaN(Date.parse(event.endDate)) && new Date(event.endDate).getTime() < Date.now()) {
        sendJson(res, 409, { message: "This event has ended" });
        return;
      }
      // Organizers cannot take a seat at their own event: they would
      // inflate the count, occupy a real attendee's seat, and could
      // approve their own payment. (Admins attending others' events
      // are unaffected — they are not the event owner.)
      if (isEventOwner(event, me)) {
        sendJson(res, 403, { message: "Organizers cannot register for their own event" });
        return;
      }
      const allRegs = await loadAllRegistrations();
      // Server-side dedupe (the client check was local-storage only, so
      // a second device or tab created a second pass and a second
      // count bump). An active row is returned as-is, never duplicated.
      const existingActive = allRegs.find((r: any) => r.eventId === reg.eventId && norm(r.userEmail) === me && (r.status === "pending" || r.status === "confirmed"));
      if (existingActive) {
        sendJson(res, 200, stripReg(existingActive, me, false));
        return;
      }
      // Re-registering after a cancel reactivates the SAME row instead
      // of inserting a second one: the old plain insert conflicted
      // with the cancelled server row while the client still showed a
      // confirmed pass — a phantom pass the organizer never saw.
      const existingCancelled = allRegs.find((r: any) => r.eventId === reg.eventId && norm(r.userEmail) === me && r.status === "cancelled");
      const reactivating = Boolean(existingCancelled);
      if (reactivating) reg.id = existingCancelled.id;
      // Server-side paid rule: a paid event never gets an instant pass,
      // and never gets a manual pending row either. Paid rows exist
      // only as Razorpay rows (paymentMethod 'razorpay', created by
      // the Razorpay checkout flow); anything else for a paid event
      // is refused, because manual UPI/UTR approval no longer exists.
      // Legacy manual pending rows are NOT rejected here — the dedupe
      // above already returned them as-is, so their owners can still
      // convert them via Pay Now (Razorpay create-order).
      if (Number(event.price) > 0 && reg.status === "confirmed") reg.status = "pending";
      if (Number(event.price) > 0 && reg.paymentMethod !== "razorpay" && reg.status === "pending") {
        sendJson(res, 400, { message: "Paid events use Razorpay checkout — manual payments are no longer accepted" });
        return;
      }
      // Server-owned fields are never caller-writable: a crafted row
      // must not smuggle holdsSpot=true (a free seat on approval), a
      // chosen ticket code, or payment markers past the guards. Ticket
      // codes are always generated here, never kept from the client.
      reg.holdsSpot = false;
      reg.userEmail = me;
      if (reg.status === "confirmed") reg.ticketCode = newTicketCode();
      if (reg.status === "pending") reg.ticketCode = "";
      // Capacity is enforced here, not just in the UI: a confirmed row
      // past capacity is refused instead of overbooking the event.
      if (reg.status === "confirmed" && event.capacity && Number(event.registeredCount || 0) >= Number(event.capacity)) {
        sendJson(res, 409, { message: "This event is at full capacity" });
        return;
      }
      // Expected-amount snapshot for the Razorpay order (the amount
      // create-order charges and verify checks against).
      if (Number(event.price) > 0) reg.amountPaise = Math.round(Number(event.price) * 100);
      reg.registeredAt = reg.registeredAt || new Date().toISOString();
      // Do not store a full nested event with organiser email/UPI.
      // Store only the public snapshot the UI needs.
      if (reg.event) reg.event = stripEventPublic(reg.event);
      try {
        reg.phoneVerified = (await hasVerifiedPhone(reg.userEmail, reg.userPhone)) ? true : undefined;
      } catch { reg.phoneVerified = undefined; }
      let stored: any = null;
      if (reactivating) {
        const merged = { ...existingCancelled, ...reg, id: existingCancelled.id };
        const { ok: patchOk, body: patchBody } = await fetchJson(`${supabaseBase()}/rest/v1/registrations?id=eq.${encodeURIComponent(reg.id)}`, {
          method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: merged }),
        });
        if (!patchOk) { sendJson(res, 500, { message: "Failed to store registration" }); return; }
        stored = Array.isArray(patchBody) && patchBody.length > 0 ? patchBody[0].data : merged;
      } else {
        const { ok, body } = await fetchJson(`${supabaseBase()}/rest/v1/registrations`, {
          method: "POST", headers: supabaseHeaders(), body: JSON.stringify({ id: reg.id, data: reg }),
        });
        if (!ok) { sendJson(res, 500, { message: "Failed to store registration" }); return; }
        stored = Array.isArray(body) && body.length > 0 ? body[0].data : reg;
      }
      // Server-side count: a confirmed registration takes a slot now.
      if (stored && stored.status === "confirmed") { try { await bumpEventCount(stored.eventId, 1); } catch {} }
      if (stored) {
        try {
          // Only confirmed rows mail here (free instant passes). A
          // pending Razorpay row mails nothing: its pass confirmation
          // email is sent by api/payments.ts on verified payment.
          // There is no approval email anymore — approval is gone.
          if (stored.status === 'confirmed') await sendAttendeeConfirmationEmail(stored, event);
        } catch {}
      }
      sendJson(res, 200, stripReg(stored, me, false));
      return;
    }

    if (req.method === "PATCH") {
      const id = q.get("id");
      if (!id) { sendJson(res, 400, { message: "Pass id" }); return; }
      const updates = await readBody(req);
      const all = await loadAllRegistrations();
      const existing = all.find((r: any) => r.id === id);
      if (!existing) { sendJson(res, 404, { message: "Registration not found" }); return; }
      const nextStatus = updates.status;
      const event = await loadEvent(existing.eventId);
      const isOrg = mayManageEvent(event, me);
      // Organizer actions require STILL-approved management (see
      // mayManageEventActive): a revoked organizer's session no longer
      // approves, rejects, checks in, or reads this roster.
      const isOrgActive = isOrg ? await mayManageEventActive(event, me) : false;
      const isOwner = norm(existing.userEmail) === me;
      // Organizer approval is GONE: there is no confirm/reject anymore.
      // Paid passes are issued only by api/payments.ts on a verified
      // captured payment, so any organizer status change is refused
      // outright (with a clear message, not a silent 400) — including
      // for legacy manual pending rows, which can only convert to
      // Razorpay via Pay Now or be withdrawn by their owner.
      if (nextStatus === "confirmed" || nextStatus === "rejected") {
        sendJson(res, 403, { message: "Organizer approval has been removed — passes are issued automatically by Razorpay" });
        return;
      }
      if (updates.checkedIn !== undefined) {
        if (!isOrgActive) { sendJson(res, 403, { message: "Only the event owner or an admin can do this" }); return; }
        // Check-in only makes sense on a confirmed pass.
        if (existing.status !== "confirmed") {
          sendJson(res, 400, { message: "Only confirmed registrations can be checked in" });
          return;
        }
      } else if (nextStatus === "cancelled") {
        if (!isOwner) { sendJson(res, 403, { message: "Only the registration owner can cancel it" }); return; }
      } else {
        if (!isOwner && !isOrgActive) { sendJson(res, 403, { message: "Not allowed" }); return; }
      }
      // Field allowlist by role: attendees may only cancel their own
      // row; organizers/admins may only toggle checkedIn. There is no
      // organizer status change anymore (see the gate above). Ticket
      // codes, holdsSpot, and every payment field are server-only,
      // always.
      let allowedUpdates: any = null;
      if (nextStatus === "cancelled" && isOwner) {
        allowedUpdates = { status: "cancelled" };
      } else if (isOrgActive && updates.checkedIn !== undefined && nextStatus === undefined) {
        allowedUpdates = { checkedIn: Boolean(updates.checkedIn) };
      }
      if (!allowedUpdates) {
        sendJson(res, 400, { message: "This update is not allowed" });
        return;
      }
      const merged: any = { ...existing, ...allowedUpdates, id: existing.id, userEmail: existing.userEmail, userId: existing.userId, eventId: existing.eventId, utr: existing.utr };
      if (merged.event) merged.event = stripEventPublic(merged.event);
      // Cancelling a confirmed Razorpay pass refunds it automatically:
      // previously the pass vanished but the money stayed with the
      // organizer and nothing recorded that a refund was owed. If the
      // refund call fails, the cancel still proceeds (the attendee
      // asked to leave) but refundStatus "failed" stays on the row for
      // the organizer to resolve in the Razorpay dashboard.
      if (merged.status === 'cancelled' && existing.status === 'confirmed' && existing.paymentMethod === 'razorpay' && existing.razorpayPaymentId && !existing.refundId) {
        const rf = await refundRazorpayPayment(existing.razorpayPaymentId);
        merged.refundStatus = rf.ok ? "initiated" : "failed";
        if (rf.refundId) merged.refundId = rf.refundId;
      }
      const { ok } = await fetchJson(
        `${supabaseBase()}/rest/v1/registrations?id=eq.${encodeURIComponent(id)}`,
        { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: merged }) },
      );
      if (!ok) { sendJson(res, 500, { message: "Failed to update registration" }); return; }
      // Server-side counts: cancelling a held slot releases one
      // (confirmed passes, and legacy pending rows that predate the
      // holdsSpot flag). Nothing else changes counts here anymore —
      // Razorpay confirms bump their own count in api/payments.ts.
      try {
        if (merged.status === 'cancelled' && (existing.status === 'confirmed' || (existing.status === 'pending' && existing.holdsSpot !== false))) await bumpEventCount(merged.eventId, -1);
      } catch {}
      sendJson(res, 200, stripReg(merged, me, isOrgActive));
      return;
    }

    sendJson(res, 405, { message: "Method not allowed" });
  } catch (err) {
    // Generic message to the client; the detail stays in server logs
    // (previously Supabase internals leaked through error text).
    try { console.error("Registration API failed:", err instanceof Error ? err.message : err); } catch {}
    sendJson(res, 500, { message: "Registration API failed" });
  }
}

async function loadAllEventsForCounts(): Promise<Record<string, any>> {
  const { ok, body } = await fetchJson(`${supabaseBase()}/rest/v1/events?select=data&limit=1000`, { headers: supabaseHeaders() });
  const out: Record<string, any> = {};
  if (ok && Array.isArray(body)) for (const row of body) if (row.data?.id) out[row.data.id] = row.data;
  return out;
}

async function bumpEventCount(eventId: string, delta: number): Promise<void> {
  // Atomic RPC first (see SUPABASE_RPC_SETUP.md): increments only when
  // a seat is free, never past capacity, in one statement. Until that
  // function exists in Supabase, fall back to a capped read-modify-write.
  try {
    const rpc = await fetchJson(`${supabaseBase()}/rest/v1/rpc/adjust_event_count`, {
      method: "POST", headers: supabaseHeaders(),
      body: JSON.stringify({ p_event_id: eventId, p_delta: delta }),
    });
    if (rpc.ok) return;
  } catch { /* fall through to capped bump */ }
  const event = await loadEvent(eventId);
  if (!event) return;
  const capacity = Number(event.capacity || 0);
  const cap = capacity > 0 ? capacity : Number.MAX_SAFE_INTEGER;
  const next = Math.min(cap, Math.max(0, Number(event.registeredCount || 0) + delta));
  if (next === Number(event.registeredCount || 0)) return;
  await fetchJson(`${supabaseBase()}/rest/v1/events?id=eq.${encodeURIComponent(eventId)}`, {
    method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: { ...event, registeredCount: next } }),
  });
}
