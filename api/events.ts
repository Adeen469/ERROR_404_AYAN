// Shared server helpers for Locora security fix — NO node:crypto; ONE import (H2 rate-limit, see below).
// This file is inlined into each api/*.ts function because this project's
// Vercel functions have historically been self-contained (no static imports:
// the previous _lib import and the node:crypto import both failed live with
// FUNCTION_INVOCATION_FAILED, while the import-free api/auth/google.ts worked).
// Crypto uses only WebCrypto (globalThis.crypto.subtle) + btoa/atob, which
// work in Node and Edge runtimes without any import. No secrets are hardcoded:
// SESSION_SECRET, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come only from
// Vercel env vars. If SESSION_SECRET is missing, session verification fails
// closed (null) and login/signup/Google callback must refuse to issue a session.
// H2 (audit #4): the ONLY static import in this file — the shared
// rate-limit module (api/_lib/rate-limit.ts). See its header for the
// live _lib-import risk + the live-test step after deploy.
import { checkRateLimit, getClientIp } from "./_lib/rate-limit";
import { originAllowed, isMutationMethod } from "./_lib/origin-check";

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
// H3 (audit #4): the CALLER writes refundStatus "processing" (+ the
// full amount, M17) to the row BEFORE calling this, and finalises
// it after. This helper itself guards the retry side: on every call
// it FIRST re-reads the payment from Razorpay and checks
// amount_refunded, and only then POSTs — so a retry after a lost
// response never double-refunds. It also sends
// `Idempotency-Key: refund-<registrationId>` when the caller passes
// registrationId. IDEMPOTENCY WARNING (verified 2026-11-06 against
// Razorpay's public docs): Razorpay documents idempotency keys ONLY
// for Payouts (`X-Payout-Idempotency`) and Route transfers
// (`X-Transfer-Idempotency`); no public doc says the standard
// Payments refund endpoint honours `Idempotency-Key`. The header is
// sent best-effort and is NOT relied on — the pre-read above + the
// processing claim are the real double-refund guards, and a live
// Razorpay test is still owed to prove whether the header has any
// effect on refunds. Razorpay itself also refuses a second FULL
// refund with 400 ("already been fully refunded").
async function refundRazorpayPayment(paymentId: string, registrationId?: string): Promise<{ ok: boolean; refundId?: string; alreadyRefunded?: boolean }> {
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
    // Retry guard first: read the payment from Razorpay. If it is
    // already fully refunded, recover the existing refund id
    // (GET /payments/:id/refunds) and return success WITHOUT
    // posting a second refund.
    try {
      const pay = await fetchJson(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: auth },
      });
      if (pay.ok && pay.body) {
        const already = Number(pay.body.amount_refunded || 0);
        const target = Number(pay.body.amount || 0);
        if (target > 0 && already >= target) {
          let existingRefundId: string | undefined;
          try {
            const list = await fetchJson(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refunds?count=10`, {
              headers: { Authorization: auth },
            });
            const items = Array.isArray(list.body?.items) ? list.body.items : [];
            const match = items.find((r: any) => r && Number(r.amount || 0) >= target) || items[0];
            if (match?.id) existingRefundId = match.id;
          } catch { /* refund id stays unknown; the row still records initiated */ }
          return { ok: true, refundId: existingRefundId, alreadyRefunded: true };
        }
      }
      // A failed pre-read must not block the refund: Razorpay
      // refuses a duplicate FULL refund itself (400), and the
      // processing claim means only one attempt is in flight.
    } catch { /* fall through to the POST below */ }
    const headers: Record<string, string> = { Authorization: auth, "Content-Type": "application/json" };
    if (registrationId) headers["Idempotency-Key"] = `refund-${registrationId}`;
    const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      headers,
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

// L7 (audit #4): the maximum ticket price for an event, in rupees.
// Prices were validated only as "zero or more", so a typo (or a
// crafted body) could list a ₹10,00,00,000 ticket. ₹10,00,000 is far
// above any real community-event ticket and still leaves headroom for
// premium workshops; the same cap applies to create, edit, and the
// per-choice extras (which already cap at ₹1,00,000 each).
const MAX_EVENT_PRICE_RUPEES = 1000000;

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

// M8 (audit #4): allowlists for event POST/PATCH. Exported so they
// are unit-testable (see test_auditfix_e.mts).
export const EVENT_CATEGORIES = [
  "Technology & Hackathons",
  "Workshops & Learning",
  "Live Music & Culture",
  "Fitness & Outdoors",
  "Food & Community",
  "Art & Creative",
  "Volunteering & Impact",
];
export const EVENT_STATUSES = ["published", "draft", "cancelled", "completed"];

// Cover images are either bundled site assets (relative paths) or
// https photos (Unsplash presets). Anything else — javascript:,
// data: URIs, protocol-relative // URLs — is refused.
function isSafeCoverImage(u: string): boolean {
  if (!u) return true;
  if (u.startsWith("/")) return !u.startsWith("//") && u.length <= 500;
  try {
    const parsed = new URL(u);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && u.length <= 500;
  } catch {
    return false;
  }
}

// Validates the M8 fields when present (undefined = not supplied, so
// POST defaults and PATCH no-change both pass). Returns an error
// string, or null when the supplied values are all allowed.
export function validateEventMeta(input: {
  status?: unknown; category?: unknown; slug?: unknown; summary?: unknown; coverImage?: unknown;
}): string | null {
  if (input.status !== undefined && EVENT_STATUSES.indexOf(String(input.status)) === -1) {
    return "Invalid event status";
  }
  if (input.category !== undefined && EVENT_CATEGORIES.indexOf(String(input.category)) === -1) {
    return "Unknown event category";
  }
  if (typeof input.slug === "string" && input.slug !== "") {
    if (input.slug.length > 100) return "Slug must be 100 characters or fewer";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
      return "Slug must be lowercase letters, numbers and hyphens only";
    }
  }
  if (typeof input.summary === "string" && input.summary.length > 300) {
    return "Summary must be 300 characters or fewer";
  }
  if (typeof input.coverImage === "string" && input.coverImage.trim() !== "" && !isSafeCoverImage(input.coverImage.trim())) {
    return "Cover image must be an http(s) URL or a site-relative path";
  }
  return null;
}

// Organizer allowlist: only these fields are ever stored from a
// caller-supplied organizer object — everything else (role flags,
// ids, payment handles, arbitrary keys) is stripped. Name/email are
// forced by the caller afterwards (profile name / session email);
// eventsCount / totalAttendeesServed are display counters, kept
// only as finite numbers >= 0.
export function allowlistedOrganizer(input: any): any {
  const o = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const str = (v: any, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const num = (v: any) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
  return {
    id: str(o.id, 80) || "org-community",
    name: str(o.name, 80),
    slug: str(o.slug, 100) || "community-organizer",
    avatar: str(o.avatar, 500),
    bio: str(o.bio, 500),
    location: str(o.location, 200),
    eventsCount: num(o.eventsCount),
    totalAttendeesServed: num(o.totalAttendeesServed),
  };
}

// Category registration options (Workshops & Learning, Live Music &
// Culture): the organizer defines choices per group (f-1/f-2/f-3);
// the attendee picks one per group at registration. The group keys
// are the contract with the client (src/utils/event-options.ts) —
// keep them in sync. Only these two categories may store options;
// every other category strips them (see POST/PATCH below).
const EVENT_OPTION_GROUPS: Record<string, string[]> = {
  "Workshops & Learning": ["activity", "session", "kit"],
  "Live Music & Culture": ["ticketCategory", "seatingZone", "showTiming"],
};

// Validates + normalizes an `options` payload: { groupKey: [
// { label, extraPrice?, cap? } ] }. Returns { value } with the
// normalized object (empty object = no groups configured), or
// { error } with the first problem found. Unknown group keys, empty
// or over-long labels, duplicate labels within a group, non-integer
// or out-of-range extraPrice / cap are all refused.
function validateEventOptions(category: string, raw: any): { value?: any; error?: string } {
  const allowed = EVENT_OPTION_GROUPS[category];
  if (!allowed) return { value: {} };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "Options must be an object" };
  const value: any = {};
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return { error: `Unknown option group "${key}"` };
    const list = raw[key];
    if (!Array.isArray(list)) return { error: `Options for "${key}" must be a list` };
    if (list.length > 20) return { error: "At most 20 choices per option group" };
    const seen = new Set<string>();
    const choices: any[] = [];
    for (const c of list) {
      if (!c || typeof c !== "object" || Array.isArray(c)) return { error: "Each option choice must be an object" };
      const label = typeof c.label === "string" ? c.label.trim() : "";
      if (!label) return { error: "Each option choice needs a label" };
      if (label.length > 60) return { error: "Option labels must be 60 characters or fewer" };
      const lower = label.toLowerCase();
      if (seen.has(lower)) return { error: `Duplicate option "${label}"` };
      seen.add(lower);
      const extraPrice = c.extraPrice === undefined || c.extraPrice === null || c.extraPrice === "" ? 0 : Number(c.extraPrice);
      if (!Number.isInteger(extraPrice) || extraPrice < 0 || extraPrice > 100000) return { error: "Extra price must be a whole number of rupees between 0 and 100000" };
      let cap: number | undefined = undefined;
      if (c.cap !== undefined && c.cap !== null && c.cap !== "") {
        cap = Number(c.cap);
        if (!Number.isInteger(cap) || cap < 1 || cap > 10000) return { error: "Option cap must be a whole number between 1 and 10000" };
      }
      choices.push(cap === undefined ? { label, extraPrice } : { label, extraPrice, cap });
    }
    if (choices.length > 0) value[key] = choices;
  }
  return { value };
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

async function fetchAllEvents(query?: any): Promise<any[]> {
  // Sweep G (audit #4 final sweep): push the exact-match category
  // filter server-side when Discover is filtered by one. The
  // in-memory applyFilters below still runs unchanged, and its
  // category test is the same exact === on the untrimmed value, so
  // the result (rows, totals, order) is identical — the server just
  // ships fewer rows. Only category is pushed: the free-text query,
  // the case-insensitive location filters and the date/price filters
  // cannot be expressed as exact PostgREST matches without changing
  // semantics, so they stay in-memory; an unfiltered list still
  // loads up to 1,000 rows (a full server-side search/pagination
  // rewrite is the remaining step, not this sweep). The filter uses
  // idx_events_category in db-indexes.sql. If the filtered fetch is
  // ever rejected, fall back to the unfiltered read rather than
  // failing Discover.
  const cat = typeof query?.category === "string" ? query.category : "";
  const catFilter =
    cat && cat !== "All" && cat !== "All Categories"
      ? `&data->>category=eq.${encodeURIComponent(cat)}`
      : "";
  const tryFetch = async (extra: string): Promise<{ rows: any[] | null; detail: string }> => {
    const res = await fetch(
      supabaseBase() + `/rest/v1/events?select=data&order=created_at.desc&limit=1000${extra}`,
      { headers: supabaseHeaders() },
    );
    const rows = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(rows)) {
      return { rows: null, detail: rows && rows.message ? rows.message : "Supabase query failed" };
    }
    return { rows: rows.map((r: any) => r.data).filter(Boolean), detail: "" };
  };
  if (catFilter) {
    const filtered = await tryFetch(catFilter);
    if (filtered.rows !== null) return filtered.rows;
  }
  const all = await tryFetch("");
  if (all.rows === null) throw new Error(all.detail);
  return all.rows;
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
      message: "Shared events database is not configured on the server.",
    });
  }

  // L3 (audit #4): mutations from another site are refused — see
  // api/_lib/origin-check.ts. GETs are exempt (public reads).
  if (isMutationMethod(req) && !originAllowed(req)) {
    return sendJson(res, 403, { message: "Request origin not allowed" });
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
      const fetchPromise = singleId ? fetchEvent(singleId) : fetchAllEvents(req.query);
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
      // M8: status/category/slug/summary/coverImage allowlists.
      // (status is forced to "published" below, so it is validated
      // as the constant here; category/slug/summary/coverImage come
      // from the body.)
      const metaError = validateEventMeta({ status: "published", category: p.category, slug: p.slug, summary: p.summary, coverImage: p.coverImage });
      if (metaError) return sendJson(res, 400, { message: metaError });
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
      // Category registration options (Workshops & Learning, Live
      // Music & Culture): organizer-defined choices per group; any
      // other category stores no options at all — the config is
      // stripped below, never trusted from the body.
      let options: any = undefined;
      if (p.options !== undefined && p.options !== null && EVENT_OPTION_GROUPS[p.category]) {
        const v = validateEventOptions(p.category, p.options);
        if (v.error) return sendJson(res, 400, { message: v.error });
        options = Object.keys(v.value || {}).length > 0 ? v.value : undefined;
      }
      const price = p.price === undefined || p.price === null || p.price === "" ? 0 : Number(p.price);
      if (!Number.isFinite(price) || price < 0 || price > MAX_EVENT_PRICE_RUPEES) return sendJson(res, 400, { message: "Price must be between 0 and ₹10,00,000" });
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
        id, title, slug: typeof p.slug === "string" && p.slug ? p.slug : slugify(title),
        summary: typeof p.summary === "string" && p.summary ? p.summary : (description ? description.slice(0, 140) : "Local community gathering."),
        description, category: p.category || "Food & Community",
        coverImage: typeof p.coverImage === "string" ? p.coverImage.trim() : "", startDate: startRaw,
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
        // M8: requireAttendeeDetails is a boolean flag, never a
        // caller-supplied truthy value of another type.
        requireAttendeeDetails: typeof p.requireAttendeeDetails === "boolean" ? p.requireAttendeeDetails : true,
        // Team participation (validated above; undefined for every
        // other category, so nothing is stored there).
        participation,
        // Category registration options (validated above; undefined
        // for every other category, so nothing is stored there).
        options,
        capacity, registeredCount: 0, status: "published",
        organizer: {
          // M8: organizer fields are allowlisted — a crafted body
          // cannot smuggle extra keys (roles, payment handles) onto
          // the stored organizer. Name/email are forced server-side.
          ...allowlistedOrganizer(p.organizer),
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
      // M8: status/category/slug/summary/coverImage allowlists on
      // edits too (only the supplied fields are checked).
      const metaError = validateEventMeta(updates);
      if (metaError) return sendJson(res, 400, { message: metaError });
      if (typeof updates.coverImage === "string") updates.coverImage = updates.coverImage.trim();
      // M8: requireAttendeeDetails is a boolean flag on edit too.
      if (updates.requireAttendeeDetails !== undefined) {
        updates.requireAttendeeDetails = updates.requireAttendeeDetails === true;
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
      // Category registration options edit (same rules as POST): an
      // object with per-group choice lists, or null to clear it. A
      // non-object value is refused. Validated against the MERGED
      // category (the category may change in the same edit); the
      // merged-category check below strips options whenever the
      // event is not a workshop or concert. An object that
      // normalizes to no groups clears the config.
      if (updates.options !== undefined && updates.options !== null) {
        if (typeof updates.options !== "object" || Array.isArray(updates.options)) {
          return sendJson(res, 400, { message: "Options must be an object" });
        }
        const mergedCategory = updates.category !== undefined ? updates.category : existing.category;
        if (EVENT_OPTION_GROUPS[mergedCategory]) {
          const v = validateEventOptions(mergedCategory, updates.options);
          if (v.error) return sendJson(res, 400, { message: v.error });
          updates.options = Object.keys(v.value || {}).length > 0 ? v.value : null;
        }
      }
      if (updates.price !== undefined) {
        const pr = Number(updates.price);
        if (!Number.isFinite(pr) || pr < 0 || pr > MAX_EVENT_PRICE_RUPEES) return sendJson(res, 400, { message: "Price must be between 0 and ₹10,00,000" });
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
        // M8: organizer fields are allowlisted on edit too — the
        // stored organizer keeps only the allowed keys, with the
        // name from above and the email forced to the stored owner.
        safeUpdates.organizer = {
          ...allowlistedOrganizer(safeUpdates.organizer),
          name: orgName,
          email: existing.organizer?.email || existing.createdByEmail,
        };
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
      // Options belong to workshops and concerts only: changing the
      // category away (or a stale config on another category) drops them.
      if (!EVENT_OPTION_GROUPS[merged.category]) delete merged.options;
      if (updates.options === null) delete merged.options;
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
      // H8: load this event's registrations in pages with a
      // targeted eventId filter — not one full-table read.
      const rows: any[] = [];
      for (let page = 0; page < 10; page++) {
        const regRes = await fetchJson(
          `${supabaseBase()}/rest/v1/registrations?select=id,data&data->>eventId=eq.${encodeURIComponent(singleId)}&limit=1000&offset=${page * 1000}`,
          { headers: supabaseHeaders() },
        );
        if (!regRes.ok) break;
        const pageRows = Array.isArray(regRes.body) ? regRes.body.map((r: any) => r.data).filter(Boolean) : [];
        rows.push(...pageRows);
        if (pageRows.length < 1000) break;
      }
      const affected = rows.filter((r: any) => r.status === "pending" || r.status === "confirmed");
      let cancelledCount = 0;
      let refundedCount = 0;
      const refundFailed: string[] = [];
      const emailed = new Set<string>();
      let emailedCount = 0;
      for (const r of affected) {
        const next: any = { ...r, status: "cancelled", cancelledReason: "event_deleted" };
        if (r.status === "confirmed" && r.paymentMethod === "razorpay" && r.razorpayPaymentId && !r.refundId) {
          // M17: an organizer-deleted event is refunded IN FULL
          // (never the 10% attendee-cancel rate) — the amount is
          // the stored snapshot, fee 0. H3: the claim is written
          // FIRST (cancelled + refundStatus "processing" + the
          // amounts, one PATCH) and only then is Razorpay called;
          // the final PATCH below finalises it with "initiated" +
          // refundId (or "failed" + the amount owed). A failed
          // refund NEVER un-cancels the row — the event is deleted
          // either way, and the failed record is what the organizer
          // resolves in the Razorpay dashboard. A row already
          // "processing" is left alone (another attempt is in
          // flight); a zero-amount row has nothing to refund.
          const refundAmountPaise = Number(r.amountPaise) || 0;
          if (r.refundStatus === "processing") {
            next.refundStatus = "processing";
            next.refundAmountPaise = refundAmountPaise;
            next.refundFeePaise = 0;
            refundFailed.push(r.razorpayPaymentId);
          } else if (refundAmountPaise > 0) {
            next.refundStatus = "processing";
            next.refundAmountPaise = refundAmountPaise;
            next.refundFeePaise = 0;
            try {
              await fetchJson(
                `${supabaseBase()}/rest/v1/registrations?id=eq.${encodeURIComponent(r.id)}`,
                { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: next }) },
              );
            } catch { /* claim is best-effort ordering; the final PATCH below still records the outcome */ }
            const rf = await refundRazorpayPayment(r.razorpayPaymentId, r.id);
            if (rf.ok) {
              next.refundStatus = "initiated";
              if (rf.refundId) next.refundId = rf.refundId;
              refundedCount++;
            } else {
              next.refundStatus = "failed";
              refundFailed.push(r.razorpayPaymentId);
            }
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
