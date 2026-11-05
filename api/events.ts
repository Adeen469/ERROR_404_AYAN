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
// Management requires the organizer to STILL be approved: revocation
// must also close edits, status changes, and deletes of old events,
// not just new posts (see api/registrations.ts).
async function mayManageEventActive(event: any, email: string): Promise<boolean> {
  if (!event || !email) return false;
  if (!mayManageEvent(event, email)) return false;
  return isApprovedOrganizer(email);
}

// Full refund of a captured Razorpay payment (used by DELETE for
// confirmed paid passes). Mirrors api/payments.ts (import-free files
// cannot share code).
async function refundRazorpayPayment(paymentId: string): Promise<{ ok: boolean; refundId?: string }> {
  try {
    const keyId = getEnv("RAZORPAY_KEY_ID");
    const secret = getEnv("RAZORPAY_KEY_SECRET");
    if (!keyId || !secret) return { ok: false };
    const raw = `${keyId}:${secret}`;
    let auth = "";
    try { auth = `Basic ${btoa(raw)}`; } catch {
      const Buf = (globalThis as any).Buffer;
      if (Buf) auth = `Basic ${Buf.from(raw, "utf-8").toString("base64")}`;
    }
    if (!auth) return { ok: false };
    const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.id) return { ok: true, refundId: body.id };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

const SITE_URL = "https://locora-hyperlocal.vercel.app";

// Recommendation emails (new event created): every user whose saved
// profile interests include this event's category gets one mail
// inviting them to it. Interests already live server-side in
// locora_users (Profile saves sync via /api/auth?endpoint=me), so no
// new table is needed. Best-effort and capped: at most 10 recipients
// per event, sent in parallel with a 10s overall cap so a slow mail
// server cannot stall event creation; the organizer is excluded, and
// any failure is swallowed — the event is created regardless. A
// retry/replay of the same create (same client id) returns the stored
// event before this runs, so nobody is mailed twice for one event.
async function sendEventRecommendationEmails(event: any, organizerEmail: string): Promise<void> {
  try {
    const user = getEnv("GMAIL_USER");
    const pass = getEnv("GMAIL_APP_PASSWORD");
    if (!user || !pass) return;
    const cat = String(event?.category || "").trim().toLowerCase();
    if (!cat) return;
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/locora_users?select=data&limit=1000`,
      { headers: supabaseHeaders() },
    );
    if (!ok || !Array.isArray(body)) return;
    const orgEmail = String(organizerEmail || "").toLowerCase();
    const recipients: string[] = [];
    for (const row of body) {
      const d = row?.data || {};
      const email = typeof d.email === "string" ? d.email.trim().toLowerCase() : "";
      if (!email || email === orgEmail) continue;
      const interests = Array.isArray(d.profile?.interests)
        ? d.profile.interests
        : (Array.isArray(d.interests) ? d.interests : []);
      if (interests.some((i: any) => typeof i === "string" && i.trim().toLowerCase() === cat)) {
        recipients.push(email);
      }
      if (recipients.length >= 10) break;
    }
    if (recipients.length === 0) return;
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: pass.replace(/\s+/g, "") },
    });
    const title = event?.title || "a new event";
    const when = event?.startDate ? new Date(event.startDate).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "";
    const where = [event?.venueName, event?.city].filter(Boolean).join(", ");
    const price = typeof event?.price === "number" && event.price > 0 ? `₹${event.price}` : "Free";
    const link = `${SITE_URL}/events/${event?.id}`;
    const sends = recipients.map((to) =>
      transporter.sendMail({
        from: `"Locora" <${user}>`,
        to,
        subject: `New event for you: ${title}`,
        text: `A new event matching your interest in ${event.category} was just added on Locora: "${title}"${when ? ` on ${when}` : ""}${where ? ` at ${where}` : ""} (${price}). See it here: ${link}`,
        html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;background:#FAF8F5;padding:24px;"><div style="background:#fff;border:1px solid #E7E3DB;border-radius:16px;padding:24px;"><h2 style="color:#1E3F35;">New event for you: ${esc(title)}</h2><p style="color:#1E2320;">A new event matching your interest in <strong>${esc(String(event.category))}</strong> was just added on Locora.</p><p style="color:#5F635D;">${when ? `${esc(when)} · ` : ""}${esc(where)} · ${esc(price)}</p><p><a href="${link}" style="display:inline-block;background:#1E3F35;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">View event &amp; RSVP</a></p><p style="color:#5F635D;font-size:12px;">You get this because “${esc(String(event.category))}” is one of your saved interests on Locora. Update your interests any time on your Profile page.</p></div></div>`,
      }).then(() => true).catch(() => false),
    );
    await Promise.race([
      Promise.allSettled(sends),
      new Promise((resolve) => setTimeout(resolve, 10000)),
    ]);
  } catch {
    // Recommendation mail must never fail event creation.
  }
}

// Best-effort cancellation email (event deleted). Email must never
// fail the delete itself: every failure returns false and is swallowed.
async function sendEventCancelledEmail(to: string, event: any, refunded: boolean): Promise<boolean> {
  try {
    const user = getEnv("GMAIL_USER");
    const pass = getEnv("GMAIL_APP_PASSWORD");
    if (!user || !pass || !to) return false;
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: pass.replace(/\s+/g, "") },
    });
    const title = event?.title || "your event";
    const when = event?.startDate ? new Date(event.startDate).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "";
    await transporter.sendMail({
      from: `"Locora" <${user}>`,
      to,
      subject: `Event cancelled: ${title}`,
      text: `The event "${title}"${when ? ` scheduled for ${when}` : ""} has been cancelled by the organizer.${refunded ? " If you paid via Razorpay, your refund has been initiated." : ""} We are sorry for the inconvenience.`,
      html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;background:#FAF8F5;padding:24px;"><div style="background:#fff;border:1px solid #E7E3DB;border-radius:16px;padding:24px;"><h2 style="color:#1E3F35;">Event cancelled: ${esc(title)}</h2><p style="color:#1E2320;">The organizer has cancelled this event${when ? `, which was scheduled for ${esc(when)}` : ""}.${refunded ? " If you paid via Razorpay, your refund has been initiated." : ""}</p><p style="color:#5F635D;">We are sorry for the inconvenience.</p></div></div>`,
    });
    return true;
  } catch {
    return false;
  }
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

// SECURITY FIX — Phase 1 Finding 2: /api/events responses never include
// organiser.email, createdByEmail or upiId for viewers who are NOT the
// event's owner or an admin (list or single). The owner/admin exception
// exists because the organizer hub and the edit page filter by exactly
// those fields: stripping them for the owner too made every non-admin
// organizer's hub come back empty after a fresh fetch (e.g. logout ->
// login) while Discover still showed the events. (UPI IDs are legacy
// only now: the manual payment flow is gone, new events store none,
// and the ?payment=1 endpoint that used to hand them out is removed.)
// Writes require a session and server-side ownership
// (POST: approved organiser/admin; PATCH details: owner only; PATCH
// status / DELETE: owner or admin).

// GET /api/events — shared event list (all users, all devices).
// POST /api/events — create a shared event.
//
// This is a Vercel Serverless Function, self-contained (no imports).
// Events live in Supabase, not in any one browser's localStorage, so an
// event posted by User A is visible to User B on another device.
//
// Supabase setup (see SHARED_EVENTS_SETUP.md):
//   Table: events (id text primary key, data jsonb not null,
//                  created_at timestamptz default now())
//   Vercel env vars (Production, Sensitive):
//     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// The service-role key is server-only: the frontend never calls Supabase
// directly, it only calls this function, so the key never reaches a browser.
//
// If the env vars are missing, this returns 503 JSON. The frontend's
// events-service treats any API failure as "fall back to local storage",
// so the site keeps working locally until setup is finished — it just
// isn't shared yet.

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

// Single-event operations use ?id= on this same endpoint instead of
// /api/events/:id. The dynamic api/events/[id].ts route was never reached
// on Vercel: requests to /api/events/<id> came back as the SPA's HTML
// 404 page (the catch-all vercel.json rewrite), while /api/events itself
// worked fine. So GET/PATCH/DELETE for one event go through here, where
// the id arrives as a query parameter and the route is proven to deploy.
function firstQuery(query: any, name: string): string {
  const v = query ? query[name] : undefined;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return typeof v === "string" ? v : "";
}

async function fetchEvent(id: string): Promise<any | null> {
  const res = await fetch(
    supabaseBase() + "/rest/v1/events?select=data&id=eq." + encodeURIComponent(id),
    { headers: supabaseHeaders() },
  );
  const rows = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(rows)) return null;
  return rows.length > 0 ? rows[0].data : null;
}

async function fetchAllEvents(): Promise<any[]> {
  const res = await fetch(
    supabaseBase() + "/rest/v1/events?select=data&order=created_at.desc&limit=1000",
    { headers: supabaseHeaders() },
  );
  const rows = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(rows)) {
    const detail = rows && rows.message ? rows.message : "Supabase query failed";
    throw new Error(detail);
  }
  return rows.map((r: any) => r.data).filter(Boolean);
}

function applyFilters(events: any[], query: any): any[] {
  let out = events.slice();
  const q = typeof query.query === "string" ? query.query.trim().toLowerCase() : "";
  if (q) {
    out = out.filter((e: any) => {
      const hay = [
        e.title || "",
        e.summary || "",
        e.description || "",
        e.venueName || "",
        ((e.tags || []) as string[]).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }
  if (query.category && query.category !== "All" && query.category !== "All Categories") {
    out = out.filter((e: any) => e.category === query.category);
  }
  // Worldwide location filter (Country -> State -> City). Same rule as the
  // frontend's local filter: a set filter matches only events that actually
  // carry that value, case-insensitively.
  const locEq = (eventValue: any, filterValue: any) =>
    typeof filterValue === "string" &&
    filterValue.trim() !== "" &&
    typeof eventValue === "string" &&
    eventValue.trim().toLowerCase() === filterValue.trim().toLowerCase();
  if (typeof query.country === "string" && query.country.trim() !== "") {
    out = out.filter((e: any) => locEq(e.country, query.country));
  }
  if (typeof query.state === "string" && query.state.trim() !== "") {
    out = out.filter((e: any) => locEq(e.state, query.state));
  }
  if (typeof query.city === "string" && query.city.trim() !== "") {
    out = out.filter((e: any) => locEq(e.city, query.city));
  }
  if (query.priceType === "free") {
    out = out.filter((e: any) => Number(e.price) === 0);
  } else if (query.priceType === "paid") {
    out = out.filter((e: any) => Number(e.price) > 0);
  }
  if (query.dateRange && query.dateRange !== "all") {
    const now = new Date();
    out = out.filter((e: any) => {
      const d = new Date(e.startDate);
      if (query.dateRange === "today") {
        return (
          d.getDate() === now.getDate() &&
          d.getMonth() === now.getMonth() &&
          d.getFullYear() === now.getFullYear()
        );
      }
      if (query.dateRange === "this_weekend") {
        const day = d.getDay();
        return day === 0 || day === 6;
      }
      if (query.dateRange === "this_month") {
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      }
      if (query.dateRange === "custom") {
        // Calendar range from the Discover picker (YYYY-MM-DD, local
        // days, same "viewer day" as the presets above). An incomplete
        // range filters nothing rather than hiding everything.
        if (!query.startDate || !query.endDate) return true;
        const pad = (n: number) => String(n).padStart(2, "0");
        const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        return day >= query.startDate && day <= query.endDate;
      }
      return true;
    });
  }
  if (query.sortBy === "soonest") {
    out.sort((a: any, b: any) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  } else if (query.sortBy === "capacity") {
    out.sort(
      (a: any, b: any) =>
        (Number(b.capacity) - Number(b.registeredCount)) - (Number(a.capacity) - Number(a.registeredCount)),
    );
  } else {
    out.sort((a: any, b: any) => {
      if (a.isFeatured && !b.isFeatured) return -1;
      if (!a.isFeatured && b.isFeatured) return 1;
      return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
    });
  }
  return out;
}

export default async function handler(req: any, res: any) {
  if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return sendJson(res, 503, {
      message: "Shared events database is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel (Production) and redeploy. See SHARED_EVENTS_SETUP.md.",
    });
  }

  if (req.method === "GET") {
    try {
      // Finding 3: per-IP rate limit on the public list/single reads.
      // If the rate_limits table is missing, allow (public data is
      // already stripped) rather than breaking Discover; the limit
      // takes effect once the table exists (see SECURITY_FIX_SETUP.md).
      // Latency: the rate-limit check, the session lookup and the
      // event fetch are independent, so they run concurrently.
      // Measured live 2026-11-05: each Supabase round-trip from the
      // function costs ~1s, and running them one after another made
      // every list/detail read take ~3.5s before the first byte.
      // (fetchAllEvents still throws on a Supabase failure, exactly
      // as before — the outer try/catch turns it into a 502.)
      const rlPromise = checkRateLimit(`events:get:${getClientIp(req)}`, 600, 10 * 60 * 1000);
      const viewerPromise = verifySession(req);
      const singleId = firstQuery(req.query, "id");
      // The ?payment=1 UPI endpoint was REMOVED with the manual
      // payment flow: there is no UPI ID to hand out anymore, and
      // the endpoint had let any signed-in user harvest organizer
      // UPI IDs. A stale client asking for it gets a plain 404
      // (the single-event branch below would 404 the same way for
      // an unknown id, so this keeps the shape explicit).
      if (singleId && firstQuery(req.query, "payment") === "1") {
        return sendJson(res, 404, { message: "Manual payments are no longer supported" });
      }
      const fetchPromise = singleId ? fetchEvent(singleId) : fetchAllEvents();
      const [rl, viewer, fetched] = await Promise.all([rlPromise, viewerPromise, fetchPromise]);
      if (!rl.allowed && !rl.tableMissing) {
        return sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rl.retryAfter) });
      }
      // Ownership-aware reads: resolve the viewer from the session
      // cookie (null for guests; verifySession never throws). The
      // event's owner or an admin receives the unstripped record so
      // the hub/edit owner filter can match; every other viewer still
      // gets the stripped public shape, so no organiser email leaks to
      // other users. Guests see exactly what they saw before.
      const viewerEmail = viewer ? viewer.email : null;
      const viewEvent = (e: any) =>
        viewerEmail && mayManageEvent(e, viewerEmail) ? e : stripEventPublic(e);
      if (singleId) {
        const event = fetched;
        if (!event) return sendJson(res, 404, { message: "Event not found" });
        return sendJson(res, 200, viewEvent(event));
      }
      const filtered = applyFilters(fetched, req.query || {});
      const page = Math.max(1, parseInt(String(req.query?.page || "1"), 10) || 1);
      // pageSize was uncapped: ?pageSize=100000 returned up to the
      // 1,000-row fetch cap in one response.
      const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query?.pageSize || "12"), 10) || 12));
      const total = filtered.length;
      const totalPages = Math.ceil(total / pageSize) || 1;
      const offset = (page - 1) * pageSize;
      const pageItems = filtered.slice(offset, offset + pageSize).map((e: any) => viewEvent(e));
      // Slim list mode (?slim=1): card fields only. The full list
      // response was measured at ~374KB for 100 events (descriptions,
      // organizer blobs, tags) — far more than any card grid renders.
      // Slim cuts the payload to roughly a quarter, which is faster
      // to transfer AND to parse on low-end phones. Card consumers
      // (Discover, Home, related, landing stats) need nothing else;
      // detail/organizer/registration reads keep the full shape.
      // The organizer object is reduced to id+name here, so slim can
      // never leak an organizer email to any viewer.
      const slim = firstQuery(req.query, "slim") === "1";
      const data = slim ? pageItems.map((e: any) => ({
        id: e.id, slug: e.slug, title: e.title, summary: e.summary,
        coverImage: e.coverImage, category: e.category,
        startDate: e.startDate, endDate: e.endDate,
        city: e.city, state: e.state, country: e.country,
        neighborhood: e.neighborhood, venueName: e.venueName,
        price: e.price, capacity: e.capacity,
        registeredCount: e.registeredCount, status: e.status,
        isFeatured: e.isFeatured,
        organizer: e.organizer ? { id: e.organizer.id, name: e.organizer.name } : undefined,
      })) : pageItems;
      return sendJson(res, 200, {
        data,
        total, page, pageSize, totalPages,
      });
    } catch (err: any) {
      // Generic message; Supabase internals previously leaked here.
      try { console.error("Events GET failed:", err?.message || err); } catch {}
      return sendJson(res, 502, { message: "Could not load shared events" });
    }
  }

  if (req.method === "POST") {
    try {
      const session = await verifySession(req);
      if (!session) return sendJson(res, 401, { message: "Sign in required" });
      if (!(await isApprovedOrganizer(session.email))) {
        return sendJson(res, 403, { message: "Only approved organizers and admins can post events." });
      }
      const rlPost = await checkRateLimit(`events:post:${session.email}`, 20, 60 * 60 * 1000);
      if (!rlPost.allowed && !rlPost.tableMissing) {
        return sendJson(res, 429, { message: "Too many events created. Try again shortly." }, { "Retry-After": String(rlPost.retryAfter) });
      }
      const p = await readBody(req);
      const id = typeof p.id === "string" && p.id ? p.id : "evt-" + Date.now();
      // Idempotency: a retry/replay carrying the same client id returns
      // the existing event instead of creating a duplicate listing.
      // (The frontend now sends a client-generated id on every create.)
      if (typeof p.id === "string" && p.id) {
        const dupe = await fetchEvent(p.id);
        if (dupe) {
          if (norm(dupe.createdByEmail) === session.email || isAdmin(session.email)) {
            return sendJson(res, 200, stripEventPublic(dupe));
          }
          return sendJson(res, 409, { message: "An event with this id already exists" });
        }
      }
      // Server-side validation (previously almost none: negative
      // prices were stored and then treated as "free" instant passes,
      // negative capacities stored as instantly-full events, past and
      // end-before-start dates accepted verbatim, unbounded text).
      const title = typeof p.title === "string" ? p.title.trim() : "";
      if (!title) return sendJson(res, 400, { message: "Title is required" });
      if (title.length > 150) return sendJson(res, 400, { message: "Title must be 150 characters or fewer" });
      const description = typeof p.description === "string" ? p.description : "";
      if (description.length > 5000) return sendJson(res, 400, { message: "Description must be 5000 characters or fewer" });
      const venueName = typeof p.venueName === "string" ? p.venueName : "Community Hall";
      if (venueName.length > 200) return sendJson(res, 400, { message: "Venue name must be 200 characters or fewer" });
      // Optional exact map link: must be an http(s) URL when given.
      const mapUrl = typeof p.mapUrl === "string" ? p.mapUrl.trim() : "";
      if (mapUrl) {
        let okUrl = false;
        try {
          const u = new URL(mapUrl);
          okUrl = (u.protocol === "http:" || u.protocol === "https:") && mapUrl.length <= 500;
        } catch { okUrl = false; }
        if (!okUrl) return sendJson(res, 400, { message: "Map link must be a valid http(s) URL" });
      }
      // Team participation (Technology & Hackathons only, f-1 + f-2):
      // the organizer picks Individual only / Team only / Individual
      // or Team, plus the min/max team size (2..10, min <= max). Any
      // other category stores no participation config at all — the
      // config is stripped below, never trusted from the body.
      let participation: any = undefined;
      if (p.category === "Technology & Hackathons" && p.participation && typeof p.participation === "object") {
        const mode = p.participation.mode;
        if (mode !== undefined && mode !== "individual" && mode !== "team" && mode !== "both") {
          return sendJson(res, 400, { message: "Participation mode must be individual, team or both" });
        }
        const minTeamSize = p.participation.minTeamSize === undefined ? 2 : Number(p.participation.minTeamSize);
        const maxTeamSize = p.participation.maxTeamSize === undefined ? 4 : Number(p.participation.maxTeamSize);
        if (!Number.isInteger(minTeamSize) || minTeamSize < 2 || minTeamSize > 10) return sendJson(res, 400, { message: "Minimum team size must be between 2 and 10" });
        if (!Number.isInteger(maxTeamSize) || maxTeamSize < 2 || maxTeamSize > 10) return sendJson(res, 400, { message: "Maximum team size must be between 2 and 10" });
        if (minTeamSize > maxTeamSize) return sendJson(res, 400, { message: "Minimum team size cannot exceed the maximum" });
        participation = { mode: mode || "individual", minTeamSize, maxTeamSize };
      }
      const price = p.price === undefined || p.price === null || p.price === "" ? 0 : Number(p.price);
      if (!Number.isFinite(price) || price < 0) return sendJson(res, 400, { message: "Price must be zero or more" });
      const capacity = p.capacity === undefined || p.capacity === null || p.capacity === "" ? 50 : Number(p.capacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) return sendJson(res, 400, { message: "Capacity must be between 1 and 10000" });
      const startRaw = p.startDate || new Date(Date.now() + 86400000 * 7).toISOString();
      const endRaw = p.endDate || new Date(Date.now() + 86400000 * 7 + 7200000).toISOString();
      const startMs = Date.parse(startRaw);
      const endMs = Date.parse(endRaw);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) return sendJson(res, 400, { message: "Start and end dates must be valid dates" });
      if (endMs < startMs) return sendJson(res, 400, { message: "End date must be after the start date" });
      if (startMs < Date.now() - 5 * 60 * 1000) return sendJson(res, 400, { message: "Start date cannot be in the past" });
      // Organizer display name comes from the account profile, not the
      // request body — previously any approved organizer could post an
      // event displaying as "Posted by" another organizer or brand.
      let organizerName = "Community Organizer";
      try {
        const profile = await loadUserByEmail(session.email);
        if (profile && typeof profile.data?.name === "string" && profile.data.name.trim()) {
          organizerName = profile.data.name.trim().slice(0, 80);
        } else if (p.organizer && typeof p.organizer.name === "string" && p.organizer.name.trim()) {
          organizerName = p.organizer.name.trim().slice(0, 80);
        }
      } catch { /* profile lookup failure falls back to the body name */ }
      const event = {
        id, title, slug: p.slug || slugify(title),
        summary: p.summary || (description ? description.slice(0, 140) : "Local community gathering."),
        description, category: p.category || "Food & Community",
        coverImage: p.coverImage || "", startDate: startRaw,
        endDate: endRaw,
        venueName, address: typeof p.address === "string" ? p.address.slice(0, 300) : "100 Main Street",
        mapUrl: mapUrl || undefined,
        neighborhood: p.state ? (p.city || "") : "", city: p.city || "Metro City",
        state: p.state || undefined, country: p.country || undefined,
        // Ownership is forced from the session, never from the body.
        createdByEmail: session.email,
        price,
        // No upiId on new events: the manual UPI flow is gone, so
        // there is nothing to collect one for. (Legacy rows keep
        // theirs stored, still stripped for non-owners above.)
        requireAttendeeDetails: p.requireAttendeeDetails ?? true,
        // Team participation (validated above; undefined for every
        // other category, so nothing is stored there).
        participation,
        capacity, registeredCount: 0, status: "published",
        organizer: {
          ...(p.organizer || { id: "org-community", name: organizerName, slug: "community-organizer", avatar: "", bio: "Community organizer.", location: "Metro City", eventsCount: 0, totalAttendeesServed: 0 }),
          name: organizerName,
          email: session.email,
        },
        tags: Array.isArray(p.tags) && p.tags.length > 0 ? p.tags.slice(0, 10).map((t: any) => String(t).slice(0, 40)) : ["Local", "Community"],
        isFeatured: false,
      };
      const supa = await fetch(supabaseBase() + "/rest/v1/events", {
        method: "POST", headers: supabaseHeaders(), body: JSON.stringify([{ id, data: event }]),
      });
      if (!supa.ok) {
        try { console.error("Events POST failed:", supa.status); } catch {}
        return sendJson(res, 502, { message: "Could not save shared event" });
      }
      // Recommendation emails for matching saved interests
      // (best-effort, capped — see sendEventRecommendationEmails).
      await sendEventRecommendationEmails(event, session.email);
      return sendJson(res, 201, stripEventPublic(event));
    } catch (err: any) {
      try { console.error("Events POST failed:", err?.message || err); } catch {}
      return sendJson(res, 502, { message: "Could not save shared event" });
    }
  }

  if (req.method === "PATCH") {
    try {
      const session = await verifySession(req);
      if (!session) return sendJson(res, 401, { message: "Sign in required" });
      const rlPatch = await checkRateLimit(`events:patch:${session.email}`, 60, 60 * 60 * 1000);
      if (!rlPatch.allowed && !rlPatch.tableMissing) {
        return sendJson(res, 429, { message: "Too many event updates. Try again shortly." }, { "Retry-After": String(rlPatch.retryAfter) });
      }
      const singleId = firstQuery(req.query, "id");
      if (!singleId) return sendJson(res, 400, { message: "Missing event id" });
      const existing = await fetchEvent(singleId);
      if (!existing) return sendJson(res, 404, { message: "Event not found" });
      const updates = await readBody(req);
      const keys = Object.keys(updates || {});
      // Counts are now owned by the registrations server (see
      // api/registrations.ts bumpEventCount). A direct count PATCH from
      // any caller, even an owner, is refused so counts cannot be forged.
      if (keys.length > 0 && keys.every((k) => k === "registeredCount")) {
        return sendJson(res, 403, { message: "Event counts are updated by the server, not by direct edits." });
      }
      const statusOnly = keys.length > 0 && keys.every((k) => k === "status");
      if (statusOnly) {
        // Status changes also require STILL-approved management.
        if (!(await mayManageEventActive(existing, session.email))) return sendJson(res, 403, { message: "Only the event owner or an admin can change status." });
      } else {
        // Detail edits: owner only (admins explicitly cannot edit
        // another organiser's details, per the original matrix), and
        // the owner must still be approved.
        if (!isEventOwner(existing, session.email) || !(await isApprovedOrganizer(session.email))) return sendJson(res, 403, { message: "You can only edit your own events." });
      }
      // Validate edits (previously any capacity/price/date passed):
      // capacity can never drop below the confirmed count, prices can
      // never go negative, and dates must stay valid and ordered. A
      // future event cannot be moved into the past; an already-past
      // event can still have its other details fixed.
      if (updates.title !== undefined) {
        if (typeof updates.title !== "string" || !updates.title.trim()) return sendJson(res, 400, { message: "Title is required" });
        if (updates.title.trim().length > 150) return sendJson(res, 400, { message: "Title must be 150 characters or fewer" });
      }
      if (updates.description !== undefined && typeof updates.description === "string" && updates.description.length > 5000) return sendJson(res, 400, { message: "Description must be 5000 characters or fewer" });
      if (updates.venueName !== undefined && typeof updates.venueName === "string" && updates.venueName.length > 200) return sendJson(res, 400, { message: "Venue name must be 200 characters or fewer" });
      if (updates.mapUrl !== undefined) {
        if (typeof updates.mapUrl !== "string") return sendJson(res, 400, { message: "Map link must be a valid http(s) URL" });
        const m = updates.mapUrl.trim();
        if (m) {
          let okUrl = false;
          try {
            const u = new URL(m);
            okUrl = (u.protocol === "http:" || u.protocol === "https:") && m.length <= 500;
          } catch { okUrl = false; }
          if (!okUrl) return sendJson(res, 400, { message: "Map link must be a valid http(s) URL" });
          updates.mapUrl = m;
        }
      }
      // Team participation edit (same rules as POST): an object with
      // mode + min/max team size, or null to clear it. A non-object
      // value is refused; the merged-category check below strips the
      // config whenever the event is not a hackathon.
      if (updates.participation !== undefined && updates.participation !== null) {
        if (typeof updates.participation !== "object" || Array.isArray(updates.participation)) {
          return sendJson(res, 400, { message: "Participation must be an object" });
        }
        const mode = updates.participation.mode;
        if (mode !== undefined && mode !== "individual" && mode !== "team" && mode !== "both") {
          return sendJson(res, 400, { message: "Participation mode must be individual, team or both" });
        }
        const minTeamSize = updates.participation.minTeamSize === undefined ? 2 : Number(updates.participation.minTeamSize);
        const maxTeamSize = updates.participation.maxTeamSize === undefined ? 4 : Number(updates.participation.maxTeamSize);
        if (!Number.isInteger(minTeamSize) || minTeamSize < 2 || minTeamSize > 10) return sendJson(res, 400, { message: "Minimum team size must be between 2 and 10" });
        if (!Number.isInteger(maxTeamSize) || maxTeamSize < 2 || maxTeamSize > 10) return sendJson(res, 400, { message: "Maximum team size must be between 2 and 10" });
        if (minTeamSize > maxTeamSize) return sendJson(res, 400, { message: "Minimum team size cannot exceed the maximum" });
        updates.participation = { mode: mode || "individual", minTeamSize, maxTeamSize };
      }
      if (updates.price !== undefined) {
        const pr = Number(updates.price);
        if (!Number.isFinite(pr) || pr < 0) return sendJson(res, 400, { message: "Price must be zero or more" });
      }
      if (updates.capacity !== undefined) {
        const cap = Number(updates.capacity);
        if (!Number.isInteger(cap) || cap < 1 || cap > 10000) return sendJson(res, 400, { message: "Capacity must be between 1 and 10000" });
        if (cap < Number(existing.registeredCount || 0)) return sendJson(res, 409, { message: "Capacity cannot be below the current registrations" });
      }
      const newStart = updates.startDate !== undefined ? Date.parse(updates.startDate) : Date.parse(existing.startDate);
      const newEnd = updates.endDate !== undefined ? Date.parse(updates.endDate) : Date.parse(existing.endDate);
      if ((updates.startDate !== undefined || updates.endDate !== undefined)) {
        if (Number.isNaN(newStart) || Number.isNaN(newEnd)) return sendJson(res, 400, { message: "Start and end dates must be valid dates" });
        if (newEnd < newStart) return sendJson(res, 400, { message: "End date must be after the start date" });
        const existingStartMs = Date.parse(existing.startDate);
        if (updates.startDate !== undefined && !Number.isNaN(existingStartMs) && existingStartMs >= Date.now() && newStart < Date.now() - 5 * 60 * 1000) {
          return sendJson(res, 400, { message: "Start date cannot be moved into the past" });
        }
      }
      const { createdByEmail: _c, registeredCount: _r, isFeatured: _f, upiId: _u, ...safeUpdates } = updates;
      if (safeUpdates.organizer && typeof safeUpdates.organizer === "object") {
        const orgName = typeof safeUpdates.organizer.name === "string" && safeUpdates.organizer.name.trim()
          ? safeUpdates.organizer.name.trim().slice(0, 80)
          : (existing.organizer?.name || "Community Organizer");
        safeUpdates.organizer = { ...safeUpdates.organizer, name: orgName, email: existing.organizer?.email || existing.createdByEmail };
      }
      // isFeatured is admin-only (server-enforced): previously PATCH
      // stripped it always, so the Home featured section could never
      // gain a new event; now an admin may set it, nobody else can.
      const nextFeatured = isAdmin(session.email) && typeof updates.isFeatured === "boolean" ? updates.isFeatured : existing.isFeatured;
      const merged = { ...existing, ...safeUpdates, id: existing.id, createdByEmail: existing.createdByEmail, registeredCount: existing.registeredCount, isFeatured: nextFeatured };
      // Participation belongs to hackathons only: changing the
      // category away (or a stale config on a non-hackathon) drops it.
      if (merged.category !== "Technology & Hackathons") delete merged.participation;
      if (updates.participation === null) delete merged.participation;
      const supa = await fetch(
        supabaseBase() + "/rest/v1/events?id=eq." + encodeURIComponent(singleId),
        { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: merged }) },
      );
      if (!supa.ok) {
        try { console.error("Events PATCH failed:", supa.status); } catch {}
        return sendJson(res, 502, { message: "Could not update shared event" });
      }
      return sendJson(res, 200, stripEventPublic(merged));
    } catch (err: any) {
      try { console.error("Events PATCH failed:", err?.message || err); } catch {}
      return sendJson(res, 502, { message: "Could not update shared event" });
    }
  }

  if (req.method === "DELETE") {
    try {
      const session = await verifySession(req);
      if (!session) return sendJson(res, 401, { message: "Sign in required" });
      const rlDel = await checkRateLimit(`events:delete:${session.email}`, 20, 60 * 60 * 1000);
      if (!rlDel.allowed && !rlDel.tableMissing) {
        return sendJson(res, 429, { message: "Too many event deletions. Try again shortly." }, { "Retry-After": String(rlDel.retryAfter) });
      }
      const singleId = firstQuery(req.query, "id");
      if (!singleId) return sendJson(res, 400, { message: "Missing event id" });
      const existing = await fetchEvent(singleId);
      if (!existing) return sendJson(res, 404, { message: "Event not found" });
      // Deleting also requires STILL-approved management.
      if (!(await mayManageEventActive(existing, session.email))) return sendJson(res, 403, { message: "Only the event owner or an admin can delete an event." });
      // Deleting used to orphan every registration: attendees kept
      // valid-looking passes for an event that 404s, paid attendees
      // had no refund signal, and nobody was told. Now the delete
      // cancels all active registrations, refunds confirmed Razorpay
      // passes, and emails every affected attendee (all best-effort
      // except the event delete itself, which is last).
      const regRes = await fetchJson(
        `${supabaseBase()}/rest/v1/registrations?select=id,data&limit=1000`,
        { headers: supabaseHeaders() },
      );
      const rows = regRes.ok && Array.isArray(regRes.body) ? regRes.body.map((r: any) => r.data).filter(Boolean) : [];
      const affected = rows.filter((r: any) => r.eventId === singleId && (r.status === "pending" || r.status === "confirmed"));
      let cancelledCount = 0;
      let refundedCount = 0;
      const refundFailed: string[] = [];
      const emailed = new Set<string>();
      let emailedCount = 0;
      for (const r of affected) {
        const next: any = { ...r, status: "cancelled", cancelledReason: "event_deleted" };
        if (r.status === "confirmed" && r.paymentMethod === "razorpay" && r.razorpayPaymentId && !r.refundId) {
          const rf = await refundRazorpayPayment(r.razorpayPaymentId);
          if (rf.ok) {
            next.refundStatus = "initiated";
            next.refundId = rf.refundId;
            refundedCount++;
          } else {
            next.refundStatus = "failed";
            refundFailed.push(r.razorpayPaymentId);
          }
        }
        const patched = await fetchJson(
          `${supabaseBase()}/rest/v1/registrations?id=eq.${encodeURIComponent(r.id)}`,
          { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: next }) },
        );
        if (patched.ok) cancelledCount++;
        if (r.userEmail && !emailed.has(norm(r.userEmail))) {
          emailed.add(norm(r.userEmail));
          try {
            if (await sendEventCancelledEmail(r.userEmail, existing, next.refundStatus === "initiated")) emailedCount++;
          } catch { /* best-effort */ }
        }
      }
      await fetch(supabaseBase() + "/rest/v1/events?id=eq." + encodeURIComponent(singleId), {
        method: "DELETE", headers: supabaseHeaders(),
      });
      return sendJson(res, 200, { success: true, cancelledCount, refundedCount, refundFailed, emailedCount });
    } catch (err: any) {
      try { console.error("Events DELETE failed:", err?.message || err); } catch {}
      return sendJson(res, 502, { message: "Could not delete shared event" });
    }
  }

  res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Cache-Control": "no-store" });
  return res.end(JSON.stringify({ message: "Method not allowed" }));
}
