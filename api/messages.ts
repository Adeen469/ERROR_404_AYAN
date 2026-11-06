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
//                      text?, attachment?, replyToId? }
//      -> stores one message and emails the recipient (best-effort).
//         text max 2000 chars; at least one of text / attachment.
//         replyToId (optional) quotes another message in the SAME
//         event + thread pair; the server validates it and freezes a
//         ~200-char snapshot (replySnapshot) at send time. Replying to
//         a deleted message is refused (400); quotes of a message
//         deleted later are scrubbed to text:"", deleted:true.
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

// One shared scrub for every message row returned to a viewer: the GET
// list deliberately strips these, but hide / mark-read / send / edit
// used to return the raw row — so a recipient could recover text the
// sender edited away (editHistory), learn the other side hid the
// message (hiddenFor), or reuse the sender's idempotency key.
function stripMessageForViewer(m: any, viewerEmail: string): any {
  const out: any = { ...m };
  delete out.hiddenFor;
  delete out.idempotencyKey;
  // M1 (audit #4): community rooms are names-only — a community row
  // must never carry either side's email to the viewer. The private
  // inbox keeps senderEmail/recipientEmail (the client files threads
  // by them); community rows never need them (senderName is shown).
  if (m.type === "community") {
    delete out.senderEmail;
    delete out.recipientEmail;
    // (replySnapshot senderEmail is dropped in the rebuild below.)
  }
  if (m.senderEmail !== viewerEmail) delete out.editHistory;
  // readBy is a list of member EMAILS — it must never reach a
  // viewer (names only, everywhere). Collapse it to a count plus
  // whether THIS viewer has seen it; the row itself keeps the list.
  if (Array.isArray(m.readBy)) {
    out.seenCount = m.readBy.length;
    out.seenByMe = m.readBy.some((e: any) => norm(e) === norm(viewerEmail));
    delete out.readBy;
  }
  // replySnapshot is rebuilt from a whitelist, never passed through
  // verbatim: a stored row must not be able to smuggle extra fields
  // (e.g. a forged snapshot carrying hidden data) to the viewer.
  if (m.replySnapshot && typeof m.replySnapshot === "object") {
    const s = m.replySnapshot;
    out.replySnapshot = {
      id: String(s.id || ""),
      // M1: community quotes are names-only too — no senderEmail.
      ...(m.type === "community" ? {} : { senderEmail: String(s.senderEmail || "") }),
      ...(s.senderName ? { senderName: String(s.senderName).slice(0, 80) } : {}),
      text: String(s.text || "").slice(0, 200),
      ...(s.attachmentName ? { attachmentName: String(s.attachmentName).slice(0, 200) } : {}),
      deleted: s.deleted === true,
    };
  }
  return out;
}

// ---- Instant delivery: full-payload private channels (2026-11-06) ----
// Supersedes the ping-only design for private + event-community
// chats (ping-only remains for the GLOBAL room, §below). Why not
// broadcast full messages on the old channels? `inbox:<email>` is
// guessable from an email alone and `community:<eventId>` is public,
// so anyone could subscribe and read live message text + attachment
// URLs — audit finding DB-H1. The ping-only design fixed that leak
// by sending id-only pings, but a ping still forces a ~2s refetch,
// so delivery was never instant.
//
// NEW design: one private channel PER USER, named by an HMAC the
// client cannot compute:
//
//   privateChannelName(email, sessionVersion) = "inbox:" +
//       hex(HMAC-SHA256(SESSION_SECRET,
//           "locora-inbox:" + lowercase(email) + ":v" + sessionVersion))
//
// Deterministic per user, unguessable without SESSION_SECRET (which
// never leaves the server). The sessionVersion is mixed in (audit
// #4 H7): it lives on the locora_users row and bumps on
// sign-out-everywhere / password reset, so a bumped user gets a NEW
// channel name and any client still subscribed to the old name
// stops receiving — the old name is never derived again. The
// caller learns its own name from GET ?action=channel, which uses
// the version baked into the verified session token (already
// checked against the stored row by verifySession); broadcasts to
// OTHER users load their stored version (loadSessionVersion /
// loadSessionVersions below). A user with no stored version (legacy
// row) derives with 0, exactly as before the bump existed.
// NO new table, NO new storage: the server derives the name on
// demand, and the client learns ONLY ITS OWN channel name from
// GET ?action=channel (session-authenticated).
// A client never learns another user's channel name, so it cannot
// subscribe to anyone else's live messages.
//
// Delivery: the server broadcasts the FULL message payload over
// Supabase Realtime's REST endpoint (POST /realtime/v1/api/broadcast
// with the service-role key — server-to-Realtime only, no browser
// involvement) to the recipient's private channel (and the sender's
// own channel, for their other tabs). The receiver renders the
// payload immediately — no refetch. Polling stays as fallback (3s
// while Realtime is down, 30s safety net while SUBSCRIBED).
//
// GLOBAL room: fan-out to "every signed-in user" is unbounded, so
// there is no member list to derive channels from. Global stays
// PING-ONLY on the public `community:global` channel (a ping carries
// no content) + a fast refetch — see the GET pagination work below.
// Typing on global is likewise ping-style (a name only, no content).
//
// Payloads carry NAMES only — never emails or phones. The broadcast
// payload is built by buildRealtimePayload, a whitelist (not the raw
// row): senderEmail/recipientEmail/recipientName are dropped, the
// reply snapshot drops its senderEmail, and readBy is collapsed to
// seenCount. `own` is computed per recipient so the receiver knows
// whether the message is theirs without seeing any email.
export async function privateChannelName(email: string, sessionVersion = 0): Promise<string | null> {
  const secret = getEnv("SESSION_SECRET");
  if (!secret || !isEmail(email || "")) return null;
  try {
    const v = Number.isFinite(sessionVersion) ? Math.trunc(sessionVersion) : 0;
    const sig = await hmacB64url(secret, "locora-inbox:" + norm(email) + ":v" + v);
    return "inbox:" + bytesToHex(b64urlToBytes(sig));
  } catch {
    return null;
  }
}

// Stored sessionVersion for one user (locora_users row
// data.sessionVersion; bumps on sign-out-everywhere / password
// reset — see api/auth.ts). Missing row / missing field = 0, the
// same default a fresh session is signed with, so legacy users
// keep working until their next bump.
export async function loadSessionVersion(email: string): Promise<number> {
  try {
    const row = await loadUserByEmail(email);
    const v = row?.data?.sessionVersion;
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

// Same, batched: ONE PostgREST read for a whole fan-out list
// (community rooms), instead of one read per member. Emails with
// no row / no version are absent from the map — callers treat a
// miss as 0.
export async function loadSessionVersions(emails: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const list = [...new Set(emails.map((e) => norm(e)).filter((e) => isEmail(e)))];
  if (!list.length) return out;
  try {
    const q = list.map((e) => encodeURIComponent(e)).join(",");
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/locora_users?select=data&data->>email=in.(${q})`,
      { headers: supabaseHeaders() },
    );
    if (ok && Array.isArray(body)) {
      for (const row of body) {
        const d = row?.data || {};
        if (isEmail(d.email || "") && typeof d.sessionVersion === "number") {
          out.set(norm(d.email), d.sessionVersion);
        }
      }
    }
  } catch { /* fall through: missing versions derive as 0 */ }
  return out;
}

// Server -> Supabase Realtime broadcast (REST). `entries` may carry
// several topics in ONE request, which is how community fan-out
// stays a single round trip. Fire-and-forget safe: never throws,
// never blocks the caller — callers that need delivery confidence
// use broadcastRealtimeSoon (bounded wait) instead.
async function broadcastRealtime(entries: { topic: string; event: string; payload: any }[]): Promise<void> {
  const base = supabaseBase();
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key || !entries.length) return;
  try {
    await fetchJson(`${base}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: entries.map((e) => ({ topic: e.topic, event: e.event, payload: e.payload, private: false })),
      }),
    });
  } catch {
    // Broadcast is speed only; the poll picks everything up anyway.
  }
}

// Bounded wait for a broadcast: the sender's POST waits at most
// ~1.2s for the realtime round trip (typically ~250ms, same host as
// the other Supabase calls), then responds anyway. The sender has
// optimistic UI, so this delay is invisible to them — but it makes
// the receiver's instant delivery near-certain instead of
// best-effort-after-response (Vercel may freeze the function once
// the response is sent, which would drop a fire-and-forget fetch).
async function broadcastRealtimeSoon(entries: { topic: string; event: string; payload: any }[]): Promise<void> {
  if (!entries.length) return;
  await Promise.race([
    broadcastRealtime(entries),
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]);
}

// Whitelisted broadcast payload for one message, as seen by one
// viewer. `own` is true when the viewer IS the sender (their other
// tabs/devices receive their own messages with own:true).
// Opaque thread routing key (cyrb53 — a small deterministic hash,
// NOT cryptographic, and it does not need to be: the key only files
// a payload into a thread inside an already-private channel).
// The payload must never carry raw emails (DB-H1), so the thread
// key is `eventId|hash(sorted pair)` instead of `eventId|a|b`.
// The client computes the same key with the identical function in
// src/services/messages-service.ts — keep the two in sync.
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function threadKeyHash(eventId: string, emailA: string, emailB: string): string {
  const pair = [norm(emailA), norm(emailB)].sort().join("|");
  return `${eventId}|${cyrb53(pair).toString(16)}`;
}

function buildRealtimePayload(m: any, viewerEmail: string): any {
  const v = stripMessageForViewer(m, viewerEmail);
  const snap = v.replySnapshot && typeof v.replySnapshot === "object"
    ? {
        id: String(v.replySnapshot.id || ""),
        senderName: String(v.replySnapshot.senderName || "").slice(0, 80),
        text: String(v.replySnapshot.text || "").slice(0, 200),
        ...(v.replySnapshot.attachmentName ? { attachmentName: String(v.replySnapshot.attachmentName).slice(0, 200) } : {}),
        deleted: v.replySnapshot.deleted === true,
      }
    : undefined;
  const out: any = {
    id: String(v.id || ""),
    type: v.type,
    eventId: String(v.eventId || ""),
    eventTitle: String(v.eventTitle || ""),
    senderName: String(v.senderName || v.senderEmail || "").slice(0, 80),
    text: String(v.text || ""),
    attachment: v.attachment || null,
    read: v.read === true,
    edited: v.edited === true,
    editedAt: v.editedAt || undefined,
    deletedForEveryone: v.deletedForEveryone === true,
    deletedAt: v.deletedAt || undefined,
    replyToId: v.replyToId || undefined,
    replySnapshot: snap,
    createdAt: v.createdAt || "",
    own: norm(m.senderEmail || "") === norm(viewerEmail || ""),
    seenCount: typeof v.seenCount === "number" ? v.seenCount : undefined,
  };
  // Private chats only: the thread key lets the receiver file the
  // message into the right thread without any email in the payload
  // (the key is a hash of the pair, not the pair itself).
  // NOTE: `own` / threadKey read the RAW row (m), not the stripped
  // copy (v) — stripMessageForViewer drops senderEmail/recipientEmail
  // for community rows (M1), so reading them from v would always
  // compute own:false.
  if (!isCommunityMessage(v) && m.senderEmail && m.recipientEmail) {
    out.threadKey = threadKeyHash(v.eventId, m.senderEmail, m.recipientEmail);
  }
  return out;
}

// Member emails for one event's community fan-out: confirmed
// registrants + the organizer + admins. The sender is included
// (their other tabs get the payload with own:true). Capped at 200
// members — beyond that the send falls back to a ping on the public
// community channel + polling (see the community send branch).
function communityMemberEmails(event: any, regs: any[]): string[] {
  const out = new Set<string>();
  const org = organizerEmailOf(event || {});
  if (org) out.add(norm(org));
  for (const r of regs || []) {
    if (r?.status === "confirmed" && isEmail(r?.userEmail || "")) out.add(norm(r.userEmail));
  }
  for (const a of ADMIN_EMAILS) out.add(norm(a));
  return [...out];
}

// ---- Replies (ported 2026-11-05 onto main@e1848d4; PR #4 is parked,
// so no audit #3 code is carried here) ----
// A reply freezes a snapshot of the quoted message at send time, so
// the quote still reads correctly after the original is edited. The
// snapshot is deliberately small and whitelisted (see
// stripMessageForViewer): id, sender, a ~200-char text slice, and the
// attachment name only — never the full text, never URLs, never
// internal fields. Edits to the original do NOT update quotes.
function buildReplySnapshot(quoted: any): any {
  const snap: any = {
    id: String(quoted.id || ""),
    senderEmail: String(quoted.senderEmail || ""),
    senderName: String(quoted.senderName || quoted.senderEmail || "").slice(0, 80),
    text: String(quoted.text || "").trim().slice(0, 200),
    deleted: false,
  };
  if (quoted.attachment && quoted.attachment.name) {
    snap.attachmentName = String(quoted.attachment.name).slice(0, 200);
  }
  return snap;
}

// Pure reply validation, kept separate from the handler so it is
// unit-testable (see test_replies.mts). Returns an error string, or
// null when the quoted message may be replied to. Self-contained
// (no norm() call) so the extracted function runs standalone.
function replyTargetError(quoted: any, eventId: string, sender: string, recipient: string): string | null {
  const lower = (s: any) => String(s || "").trim().toLowerCase();
  if (!quoted || typeof quoted !== "object") return "Quoted message not found";
  if (quoted.type === "block") return "Quoted message not found";
  if (String(quoted.eventId || "") !== String(eventId || "")) {
    return "You can only reply to a message in this conversation";
  }
  const pairOk =
    (lower(quoted.senderEmail) === lower(sender) && lower(quoted.recipientEmail) === lower(recipient)) ||
    (lower(quoted.senderEmail) === lower(recipient) && lower(quoted.recipientEmail) === lower(sender));
  if (!pairOk) return "You can only reply to a message in this conversation";
  // DESIGN CHOICE: replying to a deleted-for-everyone message is
  // refused (400) instead of storing a "deleted" snapshot. A deleted
  // message's text must not be resurrected inside a new quote, and a
  // quote that starts life as "This message was deleted" is useless.
  // Older quotes pointing at a message deleted AFTER they were sent
  // are handled the other way: the DELETE scrub below rewrites their
  // snapshot to text:"", deleted:true.
  if (quoted.deletedForEveryone) return "The message you are replying to was deleted";
  return null;
}

// ---- Community chat (one group chat per event) ----
// Community messages live in the SAME `messages` table as private
// messages — no new table, no new Vercel function (Hobby 12-function
// limit). They are distinguished by type:"community" and by a
// recipientEmail that can NEVER be a real email:
//   recipientEmail = "community:<eventId>"
// isEmail("community:evt-1") is false (no @), so the marker can never
// pass as a mail recipient, never match a private thread pair, and
// never be returned by loadMessagesFor(realEmail). The private GET
// below also filters type:"community" out explicitly — a sender's own
// community rows would otherwise match loadMessagesFor(sender) and
// leak into their private inbox. Community GET returns ONLY
// community rows for that event. No email alerts are ever sent for
// community messages (one mail per message to every attendee would
// be spam); the send branch returns before any sendMail call.
function communityRecipient(eventId: string): string {
  return `community:${String(eventId || "")}`;
}
function isCommunityMessage(m: any): boolean {
  return !!m && m.type === "community";
}

// Pure membership rule, kept separate so it is unit-testable (see
// test_community.mts). A member is: an admin, the event's organizer
// (createdByEmail, or organizer.email for legacy events without
// createdByEmail), or a user with a CONFIRMED registration for this
// event. Pending (unpaid Razorpay) and cancelled registrations are
// NOT members. Guests and signed-in non-registered users are not.
function isCommunityMember(event: any, email: string, registrations: any[]): boolean {
  if (!event || !email) return false;
  if (isAdmin(email)) return true;
  if (isEventOwner(event, email)) return true;
  const me = norm(email);
  return (registrations || []).some(
    (r: any) =>
      String(r?.eventId || "") === String(event.id || "") &&
      norm(r?.userEmail || "") === me &&
      r?.status === "confirmed",
  );
}

// Pure community-reply validation (same shape as replyTargetError,
// but for the group chat): the quoted message must be a COMMUNITY
// message in the SAME event. A private message's replyToId is refused
// here even if it is in the same event — private and community
// conversations never quote across each other.
function communityReplyTargetError(quoted: any, eventId: string): string | null {
  if (!quoted || typeof quoted !== "object") return "Quoted message not found";
  if (quoted.type === "block") return "Quoted message not found";
  if (!isCommunityMessage(quoted)) return "You can only reply to a message in this community chat";
  if (String(quoted.eventId || "") !== String(eventId || "")) {
    return "You can only reply to a message in this community chat";
  }
  if (quoted.deletedForEveryone) return "The message you are replying to was deleted";
  return null;
}

// ---- Global community chat (one site-wide room) ----
// Same messages table, type:"community", eventId "global",
// recipientEmail "community:global" (built by communityRecipient
// below — same marker pattern as event rooms, never a real email).
// Membership: ANY signed-in user — no event lookup, no
// registration check. The session check at the top of the handler
// is the only gate (guests get 401 before they reach any branch).
// Moderation: admins and approved organizers (isApprovedOrganizer,
// which returns true for admins) may delete ANY global message;
// everyone else deletes only their own, within 24h.
const GLOBAL_EVENT_ID = "global";
function isGlobalMessage(m: any): boolean {
  return isCommunityMessage(m) && String(m.eventId || "") === GLOBAL_EVENT_ID;
}
// Pure membership rule for the global room (see test_global_community.mts):
// a valid session email is a member. Kept as a function (not inlined)
// so the rule stays testable and stays in one place.
function isGlobalMember(email: string): boolean {
  return !!email && typeof email === "string" && email.trim() !== "";
}

// Registrations for one event, targeted jsonb lookup first (same
// data->> pattern as loadMessagesFor), paginated full-read fallback.
async function loadRegistrationsForEvent(eventId: string): Promise<any[]> {
  try {
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/registrations?select=id,data&data->>eventId=eq.${encodeURIComponent(eventId)}&limit=1000`,
      { headers: supabaseHeaders() },
    );
    if (ok && Array.isArray(body)) return body.map((row: any) => row.data).filter(Boolean);
  } catch { /* fall through to the paginated read */ }
  const out: any[] = [];
  for (let page = 0; page < 10; page++) {
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/registrations?select=id,data&limit=1000&offset=${page * 1000}`,
      { headers: supabaseHeaders() },
    );
    if (!ok) throw new Error("registrations table read failed");
    const rows = Array.isArray(body) ? body.map((row: any) => row.data) : [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out.filter((r: any) => String(r?.eventId || "") === String(eventId || ""));
}

// Community rows for one event, targeted jsonb lookup first.
async function loadCommunityMessages(eventId: string): Promise<any[]> {
  try {
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/messages?select=id,data&data->>type=eq.community&data->>eventId=eq.${encodeURIComponent(eventId)}&limit=1000`,
      { headers: supabaseHeaders() },
    );
    if (ok && Array.isArray(body)) return body.map((row: any) => row.data).filter(Boolean);
  } catch { /* fall through to the full read */ }
  const all = await loadAllMessages();
  return all.filter((m: any) => isCommunityMessage(m) && String(m.eventId || "") === String(eventId || ""));
}

// Paginated reads for the chat GETs (2026-11-06): the old GETs
// re-downloaded the whole history (up to 1000 rows) every 3s poll,
// so polls got slower as conversations grew. These variants take
// {limit, before, since} and return one page + hasMore; the
// unpaginated loaders above are untouched (internal callers —
// authorize, idempotency, blocks — still need the full list).
//   limit  — page size (clamped 1..100, default 50)
//   before — exclusive cursor: only rows older than this createdAt
//   since  — inclusive floor: rows with createdAt >= since (the
//            client dedupes by id, so the boundary row is safe)
// No opts (or limit omitted) still returns the full list, so the
// old no-param GET behaviour is unchanged.
async function loadMessagesForPage(
  email: string,
  opts: { limit?: number; before?: string; since?: string },
): Promise<{ messages: any[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const extra =
    (opts.before ? `&data->>createdAt=lt.${encodeURIComponent(opts.before)}` : "") +
    (opts.since ? `&data->>createdAt=gte.${encodeURIComponent(opts.since)}` : "");
  const out = new Map<string, any>();
  try {
    for (const field of ["senderEmail", "recipientEmail"]) {
      const { ok, body } = await fetchJson(
        `${supabaseBase()}/rest/v1/messages?select=id,data&data->>${field}=eq.${encodeURIComponent(norm(email))}${extra}&order=data->>createdAt.desc&limit=${limit + 1}`,
        { headers: supabaseHeaders() },
      );
      if (!ok) throw new Error("filtered messages read failed");
      if (Array.isArray(body)) for (const row of body) if (row.data?.id) out.set(row.data.id, row.data);
    }
  } catch {
    // Fall back to the full read + slice in memory: slower, but a
    // paginated GET must never 503 just because the filtered query
    // was rejected.
    const all = await loadMessagesFor(email);
    const mine = all.filter(
      (m: any) => norm(m.senderEmail || "") === norm(email) || norm(m.recipientEmail || "") === norm(email),
    );
    const sorted = mine.sort((a: any, b: any) =>
      (b.createdAt || "").localeCompare(a.createdAt || "") ||
      (b.id || "").localeCompare(a.id || ""),
    );
    const page = sorted.filter((m: any) =>
      (!opts.before || (m.createdAt || "") < opts.before) &&
      (!opts.since || (m.createdAt || "") >= opts.since),
    );
    return { messages: page.slice(0, limit).reverse(), hasMore: page.length > limit };
  }
  const merged = [...out.values()].sort((a: any, b: any) =>
    (b.createdAt || "").localeCompare(a.createdAt || "") ||
    (b.id || "").localeCompare(a.id || ""),
  );
  return { messages: merged.slice(0, limit).reverse(), hasMore: merged.length > limit };
}

async function loadCommunityMessagesPage(
  eventId: string,
  opts: { limit?: number; before?: string; since?: string },
): Promise<{ messages: any[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const extra =
    (opts.before ? `&data->>createdAt=lt.${encodeURIComponent(opts.before)}` : "") +
    (opts.since ? `&data->>createdAt=gte.${encodeURIComponent(opts.since)}` : "");
  try {
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/messages?select=id,data&data->>type=eq.community&data->>eventId=eq.${encodeURIComponent(eventId)}${extra}&order=data->>createdAt.desc&limit=${limit + 1}`,
      { headers: supabaseHeaders() },
    );
    if (ok && Array.isArray(body)) {
      const rows = body.map((row: any) => row.data).filter(Boolean);
      rows.sort((a: any, b: any) =>
        (b.createdAt || "").localeCompare(a.createdAt || "") ||
        (b.id || "").localeCompare(a.id || ""),
      );
      return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
    }
  } catch { /* fall through to the in-memory slice */ }
  const all = await loadCommunityMessages(eventId);
  const sorted = all.sort((a: any, b: any) =>
    (b.createdAt || "").localeCompare(a.createdAt || "") ||
    (b.id || "").localeCompare(a.id || ""),
  );
  const page = sorted.filter((m: any) =>
    (!opts.before || (m.createdAt || "") < opts.before) &&
    (!opts.since || (m.createdAt || "") >= opts.since),
  );
  return { messages: page.slice(0, limit).reverse(), hasMore: page.length > limit };
}

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
// Pure MP4/MOV check (unit-testable, see test_chat_realtime.mts):
// `ftyp` is usually at offset 4, but some encoders put a
// `free`/`wide` box first. Walk the top-level boxes (size + type,
// 8-byte headers) until `ftyp` is found or the head runs out —
// rejecting a real video for a leading free box was the false
// negative.
function mp4HasFtyp(head: Uint8Array): boolean {
  let pos = 0;
  while (pos + 8 <= head.length) {
    const size = (head[pos] << 24) | (head[pos + 1] << 16) | (head[pos + 2] << 8) | head[pos + 3];
    const type = String.fromCharCode(head[pos + 4], head[pos + 5], head[pos + 6], head[pos + 7]);
    if (type === "ftyp") return true;
    if (!Number.isFinite(size) || size < 8) return false;
    pos += size;
  }
  return false;
}

async function verifyAttachment(path: string, ext: string): Promise<string | null> {
  const url = `${supabaseBase()}/storage/v1/object/public/${BUCKET}/${path}`;
  let res: any;
  try {
    // 64 bytes, not 16: an MP4 may start with a `free`/`wide` box
    // before `ftyp`, and the box-walk below needs room to skip it.
    res = await fetch(url, { headers: { Range: "bytes=0-63" } });
  } catch {
    return "Could not verify the attachment — please try again";
  }
  if (res.status === 404) return "Attachment was not uploaded — please upload it again";
  if (!res.ok && res.status !== 206) return "Could not verify the attachment — please try again";
  const range = res.headers.get("content-range") || "";
  const totalMatch = range.match(/\/(\d+)\s*$/);
  if (totalMatch && Number(totalMatch[1]) > MAX_ATTACHMENT_BYTES) {
    await deleteAttachmentObject(path);
    return "Attachment exceeds the 20MB limit";
  }
  // L4 (audit #4): a Range GET does not always come back with a
  // Content-Range — some Storage/CDN responses answer 200 with no
  // range at all. "No total" used to mean "no size check", so an
  // oversized object sailed through unchecked. Fall back to a HEAD
  // request for Content-Length before giving up on the size check.
  // Only when the HEAD also yields no usable length do we proceed
  // (the magic-byte check below still runs); a HEAD failure is not
  // proof of anything, so it never rejects a good upload.
  if (!totalMatch) {
    try {
      const headRes = await fetch(url, { method: "HEAD" });
      const len = Number(headRes.headers.get("content-length") || "");
      if (Number.isFinite(len) && len > MAX_ATTACHMENT_BYTES) {
        await deleteAttachmentObject(path);
        return "Attachment exceeds the 20MB limit";
      }
    } catch {
      // Continue to the magic-byte check below.
    }
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
  let ok = true;
  if (ext === "png") ok = starts(0x89, 0x50, 0x4e, 0x47);
  else if (ext === "jpg" || ext === "jpeg") ok = starts(0xff, 0xd8, 0xff);
  else if (ext === "gif") ok = starts(0x47, 0x49, 0x46, 0x38);
  else if (ext === "webp") ok = starts(0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
  else if (ext === "pdf") ok = starts(0x25, 0x50, 0x44, 0x46);
  else if (ext === "docx" || ext === "xlsx" || ext === "xlsm") ok = starts(0x50, 0x4b, 0x03, 0x04);
  else if (ext === "doc" || ext === "xls") ok = starts(0xd0, 0xcf, 0x11, 0xe0);
  else if (ext === "mp4" || ext === "mov") {
    // MP4/MOV: `ftyp` is usually at offset 4, but some encoders
    // put a `free`/`wide` box first — see mp4HasFtyp above.
    ok = mp4HasFtyp(head);
  }
  else if (ext === "webm") ok = starts(0x1a, 0x45, 0xdf, 0xa3);
  else {
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    ok = (ALLOWED_EXTENSIONS[ext] || []).includes(ct);
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

// All messages quoting a given id, from EITHER side of the thread.
// Main's original DELETE scrub only scanned loadMessagesFor(deleter),
// so a reply written by the OTHER side kept quoting a deleted
// message. Targeted jsonb lookup (same data->> pattern main's
// loadMessagesFor already uses); on failure returns [] — a failed
// lookup must never block the delete, the scrub is best-effort.
async function loadMessagesReplyingTo(id: string): Promise<any[]> {
  try {
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/messages?select=id,data&data->>replyToId=eq.${encodeURIComponent(id)}&limit=1000`,
      { headers: supabaseHeaders() },
    );
    if (ok && Array.isArray(body)) return body.map((row: any) => row.data).filter(Boolean);
  } catch { /* fall through to the empty result below */ }
  return [];
}

// M6: crypto-random message ids (48 bits from WebCrypto, hex).
// The old `msg-<ms>-<Math.random base36>` id had far less entropy
// and Math.random is not a randomness source for identifiers.
function newMessageId(): string {
  try {
    return `msg-${Date.now().toString(36)}-${bytesToHex(randomBytes(6))}`;
  } catch {
    return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

// H8/M16: targeted idempotency lookup — ONE indexed row fetch by
// idempotencyKey + event + sender (+ recipient for private chats),
// instead of loading the sender's whole history or the event's
// whole room and scanning in memory. Returns null when no prior
// row exists OR when the lookup itself fails (callers fall back to
// the in-memory scan of data they already loaded).
async function loadMessageByIdempotencyKey(opts: {
  eventId: string; key: string; senderEmail: string; recipientEmail?: string; community: boolean;
}): Promise<any | null> {
  try {
    const q =
      `data->>idempotencyKey=eq.${encodeURIComponent(opts.key)}` +
      `&data->>eventId=eq.${encodeURIComponent(opts.eventId)}` +
      `&data->>senderEmail=eq.${encodeURIComponent(norm(opts.senderEmail))}` +
      (opts.community
        ? `&data->>type=eq.community`
        : opts.recipientEmail
          ? `&data->>recipientEmail=eq.${encodeURIComponent(norm(opts.recipientEmail))}`
          : "") +
      `&limit=1`;
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/messages?select=id,data&${q}`,
      { headers: supabaseHeaders() },
    );
    if (ok && Array.isArray(body) && body.length > 0) return body[0].data;
  } catch { /* null below: caller falls back */ }
  return null;
}

// H8: unread count via a PostgREST count=exact HEAD query — the
// server returns only the total in the Content-Range header, not
// the rows. Null when the count query fails (caller falls back to
// the in-memory count over the loaded page). LIMIT: a message the
// viewer hid for themselves (hiddenFor) but never read is still
// counted — hiddenFor cannot be expressed in the count filter, and
// hiding an unread message is a rare edge; the count stays exact
// for every message the viewer has not hidden.
async function countUnreadMessages(email: string): Promise<number | null> {
  try {
    const url =
      `${supabaseBase()}/rest/v1/messages?select=id` +
      `&data->>recipientEmail=eq.${encodeURIComponent(norm(email))}` +
      `&data->>read=eq.false&data->>type=neq.community&data->>type=neq.block`;
    const res = await fetch(url, {
      method: "HEAD",
      headers: { ...supabaseHeaders(), Prefer: "count=exact" },
    });
    const range = (res.headers as any)?.get?.("content-range") || "";
    const m = String(range).match(/\/(\d+)\s*$/);
    if (res.ok && m) return Number(m[1]);
    return null;
  } catch {
    return null;
  }
}

async function storeMessage(msg: any): Promise<void> {
  const { ok, status } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages`,
    {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ id: msg.id, data: msg }),
    },
  );
  if (ok) return;
  // M6: a 409 is a primary-key clash on the id, not a lost write —
  // re-read before failing. A retried send whose first attempt
  // already landed returns normally instead of a 503.
  if (status === 409) {
    try {
      const existing = await loadMessage(msg.id);
      if (existing) return;
    } catch { /* fall through to the throw below */ }
  }
  throw new Error("messages table write failed");
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
): string | null {
  const organizerEmail = organizerEmailOf(event);
  if (!organizerEmail) return "This event has no organizer contact";
  if (sender === recipient) return "You cannot message yourself";
  if (findBlock(existing, event.id, sender, recipient)) return "This conversation is blocked";
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
    await transporter.sendMail({ from: `"Locora" <${user}>`, ...mail });
    return true;
  } catch (err) {
    console.warn("Message email failed (message still stored):", err);
    return false;
  }
}

// Pagination params for the chat GETs (?limit=&before=&since=).
// H8: every chat GET is paginated by default (newest 50, plus
// hasMore) — there is no full-list GET anymore. Callers page
// backwards with `before` (loadOlder) or forwards with `since`
// (polls); the legacy full-list client helpers page backwards
// themselves (see messages-service.ts getMessages).
function pageOptsFromQuery(q: any): { limit?: number; before?: string; since?: string } {
  return {
    limit: Number(q?.limit) || 50,
    before: String(q?.before || ""),
    since: String(q?.since || ""),
  };
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
    // L3 (audit #4): mutations from another site are refused — see
    // api/_lib/origin-check.ts. GETs are exempt (reads + channel).
    if (isMutationMethod(req) && !originAllowed(req)) {
      sendJson(res, 403, { message: "Request origin not allowed" });
      return;
    }
    // P2-3: session first, for every method. No session -> 401, no data.
    const session = await verifySession(req);
    if (!session) {
      sendJson(res, 401, { message: "Sign in required" });
      return;
    }
    const me = session.email;

    // ---- GET: my private Realtime channel name (?action=channel) ----
    // The client learns ONLY its own channel name here (session-
    // authenticated; the HMAC needs SESSION_SECRET, which never
    // leaves the server). The Navbar, inbox and community chats all
    // read it through messagesService.getRealtimeChannel() (cached).
    // Null when SESSION_SECRET is missing — Realtime then stays
    // polling-only, exactly as before.
    if (req.method === "GET" && req.query?.action === "channel") {
      // The version baked into the verified session token (already
      // checked against the stored row by verifySession above), so
      // a bumped user learns the NEW name here and the old name
      // stops being derived anywhere (audit #4 H7).
      const channel = await privateChannelName(me, session.sessionVersion ?? 0);
      sendJson(res, 200, { realtimeChannel: channel });
      return;
    }

    // ---- GET: community chat (?community=1&eventId=x) ----
    // Membership-gated: only confirmed registrants, the organizer
    // and admins see anything. Everyone else gets 403 with
    // member:false — the client renders the locked placeholder from
    // that, never an error banner. No messages leak to non-members.
    if (req.method === "GET" && req.query?.community === "1") {
      const rlC = await checkRateLimit(`msg:community-get:${getClientIp(req)}:${me}`, 300, 10 * 60 * 1000);
      if (!rlC.allowed && !rlC.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlC.retryAfter) });
        return;
      }
      const eventId = String(req.query?.eventId || "");
      if (!eventId) {
        sendJson(res, 400, { message: "eventId is required" });
        return;
      }
      // Global room: no event, no registrations — any signed-in
      // user is a member (the session check above already ran).
      // Returns ONLY global rows; event-community rows are excluded
      // by loadCommunityMessages("global") + the eventId filter.
      if (eventId === GLOBAL_EVENT_ID) {
        const pageOpts = pageOptsFromQuery(req.query);
        let rows: any[];
        let hasMore = false;
        try {
          // H8: paginated by default (newest 50) — no full-list GET.
          const page = await loadCommunityMessagesPage(GLOBAL_EVENT_ID, pageOpts);
          rows = page.messages;
          hasMore = page.hasMore;
        } catch {
          sendJson(res, 503, { message: "Messages are not set up yet" });
          return;
        }
        const visible = rows
          .filter((m: any) => !((m.hiddenFor || []) as string[]).includes(me))
          .map((m: any) => stripMessageForViewer(m, me));
        visible.sort((a: any, b: any) =>
          (a.createdAt || "").localeCompare(b.createdAt || "") ||
          (a.id || "").localeCompare(b.id || ""),
        );
        sendJson(res, 200, {
          messages: visible,
          member: true,
          canPost: true,
          // Moderator flag for the client (delete-any buttons):
          // admins + approved organizers moderate the global room.
          isOrganizer: await isApprovedOrganizer(me),
          hasMore,
        });
        return;
      }
      const event = await loadEvent(eventId);
      if (!event) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      let regs: any[];
      try {
        regs = await loadRegistrationsForEvent(eventId);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      if (!isCommunityMember(event, me, regs)) {
        sendJson(res, 403, { message: "Register to join the community chat", member: false, canPost: false });
        return;
      }
      const pageOpts = pageOptsFromQuery(req.query);
      let rows: any[];
      let hasMore = false;
      try {
        // H8: paginated by default (newest 50) — no full-list GET.
        const page = await loadCommunityMessagesPage(eventId, pageOpts);
        rows = page.messages;
        hasMore = page.hasMore;
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      const visible = rows
        .filter(
          (m: any) =>
            !((m.hiddenFor || []) as string[]).includes(me),
        )
        .map((m: any) => stripMessageForViewer(m, me));
      visible.sort((a: any, b: any) =>
        (a.createdAt || "").localeCompare(b.createdAt || "") ||
        (a.id || "").localeCompare(b.id || ""),
      );
      sendJson(res, 200, {
        messages: visible,
        member: true,
        canPost: true,
        isOrganizer: mayManageEvent(event, me),
        hasMore,
      });
      return;
    }

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
      let hasMore = false;
      const pageOpts = pageOptsFromQuery(req.query);
      try {
        // H8: paginated by default (newest 50) — no full-list GET.
        const page = await loadMessagesForPage(userEmail, pageOpts);
        all = page.messages;
        hasMore = page.hasMore;
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
            m.type !== "community" &&
            (m.senderEmail === userEmail || m.recipientEmail === userEmail) &&
            !((m.hiddenFor || []) as string[]).includes(userEmail),
        )
        // Server-internal fields must not leak to the counterparty:
        // hiddenFor would tell B that A deleted the message for
        // themselves, idempotencyKey is a bearer-ish token, and
        // editHistory keeps edited-away text readable after an edit.
        .map((m: any) => stripMessageForViewer(m, userEmail));
      if (req.query?.unreadCount === "1") {
        // H8: the count comes from a count=exact HEAD query, not
        // from loading the rows. Null = the count query failed, so
        // fall back to the in-memory count over the loaded page.
        const counted = await countUnreadMessages(userEmail);
        if (counted !== null) {
          sendJson(res, 200, { count: counted });
          return;
        }
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
      sendJson(res, 200, { messages: mine, hasMore });
      return;
    }

    const body = await readBody(req);

    // ---- POST: typing indicator (ephemeral, nothing is stored) ----
    // The client sends this (throttled ~2s) while typing; the server
    // broadcasts {type:'typing', name} to the other side's private
    // channel (private/event community) or to the public
    // `community:global` channel (global — a name only, no content,
    // and global names are public to signed-in members anyway).
    // Validation mirrors the send gates, so a stranger cannot make
    // "X is typing…" appear in a conversation they are not part of.
    // Rate-limited like the other write actions; the payload is
    // broadcast with a bounded wait, like a send.
    if (req.method === "POST" && body.action === "typing") {
      const rlType = await checkRateLimit(`msg:typing:${me}`, 90, 10 * 60 * 1000);
      if (!rlType.allowed && !rlType.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlType.retryAfter) });
        return;
      }
      const eventId = String(body.eventId || "");
      if (!eventId) {
        sendJson(res, 400, { message: "eventId is required" });
        return;
      }
      let senderName = me;
      try {
        const profile = await loadUserByEmail(me);
        if (profile && typeof profile.data?.name === "string" && profile.data.name.trim()) {
          senderName = profile.data.name.trim().slice(0, 80);
        }
      } catch { /* fall back to the email address */ }
      const isCommunityTyping = body.community === true;
      if (isCommunityTyping && eventId === GLOBAL_EVENT_ID) {
        await broadcastRealtimeSoon([{
          topic: `community:${GLOBAL_EVENT_ID}`,
          event: "typing",
          payload: { name: senderName },
        }]);
        sendJson(res, 200, { typing: true });
        return;
      }
      if (isCommunityTyping) {
        const [event, regs] = await Promise.all([
          loadEvent(eventId),
          loadRegistrationsForEvent(eventId).catch(() => null),
        ]);
        if (!event || !regs || !isCommunityMember(event, me, regs)) {
          sendJson(res, 403, { message: "Register to join the community chat" });
          return;
        }
        const members = communityMemberEmails(event, regs).filter((e) => norm(e) !== norm(me));
        const versions = await loadSessionVersions(members);
        const entries: { topic: string; event: string; payload: any }[] = [];
        for (const email of members.slice(0, 200)) {
          const channel = await privateChannelName(email, versions.get(norm(email)) ?? 0);
          if (channel) entries.push({ topic: channel, event: "typing", payload: { name: senderName, eventId } });
        }
        await broadcastRealtimeSoon(entries);
        sendJson(res, 200, { typing: true });
        return;
      }
      const recipient = norm(body.recipientEmail || "");
      if (!isEmail(recipient) || recipient === norm(me)) {
        sendJson(res, 400, { message: "A valid recipient is required" });
        return;
      }
      const [event, existing] = await Promise.all([
        loadEvent(eventId),
        loadMessagesFor(me).catch(() => null),
      ]);
      if (!event || !existing) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      const denied = authorizeContact(event, me, recipient, existing);
      if (denied) {
        sendJson(res, 403, { message: denied });
        return;
      }
      const channel = await privateChannelName(recipient, await loadSessionVersion(recipient));
      if (channel) {
        await broadcastRealtimeSoon([{
          topic: channel,
          event: "typing",
          payload: { name: senderName, threadKey: threadKeyHash(eventId, me, recipient) },
        }]);
      }
      sendJson(res, 200, { typing: true });
      return;
    }

    // ---- POST: batch mark-as-read (no new polling call) ----
    // One call marks many messages read (the old client PATCHed each
    // unread message individually, then reloaded). Private rows set
    // read:true (recipient-only, as before); community rows append
    // the viewer to readBy (capped at 200) and report seenCount /
    // seenByMe through stripMessageForViewer. After marking, a
    // {type:'read'} event goes to each message's SENDER channel so
    // their ✓ flips to ✓✓ live (fire-and-forget: if it drops, the
    // next poll shows the same state).
    if (req.method === "POST" && body.action === "mark-read") {
      const rlMark = await checkRateLimit(`msg:markread:${me}`, 120, 10 * 60 * 1000);
      if (!rlMark.allowed && !rlMark.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlMark.retryAfter) });
        return;
      }
      const ids: string[] = Array.isArray(body.ids)
        ? body.ids.map((x: any) => String(x || "")).filter(Boolean).slice(0, 100)
        : [];
      if (!ids.length) {
        sendJson(res, 400, { message: "ids are required" });
        return;
      }
      let marked = 0;
      const readEntries: { topic: string; event: string; payload: any }[] = [];
      // Sender channel versions, loaded lazily once per distinct
      // sender in this request (H7): a bumped sender's read receipt
      // must go to their CURRENT channel, not the pre-bump name.
      const senderVersions = new Map<string, number>();
      const versionFor = async (email: string): Promise<number> => {
        const key = norm(email || "");
        if (!senderVersions.has(key)) senderVersions.set(key, await loadSessionVersion(key));
        return senderVersions.get(key) ?? 0;
      };
      for (const id of ids) {
        let msg: any = null;
        try { msg = await loadMessage(id); } catch { msg = null; }
        if (!msg) continue;
        if (isCommunityMessage(msg)) {
          if (msg.eventId === GLOBAL_EVENT_ID) {
            if (!isGlobalMember(me)) continue;
          } else {
            const event = await loadEvent(msg.eventId);
            if (!event) continue;
            let regs: any[] = [];
            try { regs = await loadRegistrationsForEvent(msg.eventId); } catch { continue; }
            if (!isCommunityMember(event, me, regs)) continue;
          }
          const readBy: string[] = Array.isArray(msg.readBy) ? msg.readBy : [];
          if (readBy.some((e: any) => norm(e) === norm(me))) continue;
          readBy.push(me);
          // Dedupe (M12): two parallel mark-read calls can both pass
          // the check above and append the same email twice, which
          // would inflate seenCount. Keep first-seen order, cap 200.
          const seenEmails = new Set<string>();
          msg.readBy = readBy
            .filter((e: any) => {
              const n = norm(e);
              if (seenEmails.has(n)) return false;
              seenEmails.add(n);
              return true;
            })
            .slice(0, 200);
          try {
            await updateMessageData(msg);
            marked++;
            const channel = await privateChannelName(String(msg.senderEmail || ""), await versionFor(String(msg.senderEmail || "")));
            if (channel) readEntries.push({ topic: channel, event: "read", payload: { id, seenCount: msg.readBy.length } });
          } catch { /* best-effort */ }
        } else {
          if (norm(msg.recipientEmail || "") !== norm(me)) continue;
          if (msg.read === true) continue;
          msg.read = true;
          try {
            await updateMessageData(msg);
            marked++;
            const channel = await privateChannelName(String(msg.senderEmail || ""), await versionFor(String(msg.senderEmail || "")));
            if (channel) readEntries.push({ topic: channel, event: "read", payload: { id } });
          } catch { /* best-effort */ }
        }
      }
      if (readEntries.length) broadcastRealtime(readEntries).catch(() => {});
      sendJson(res, 200, { marked });
      return;
    }

    // ---- DELETE: delete for everyone (sender only) ----
    if (req.method === "DELETE") {
      const rlDel = await checkRateLimit(`msg:delete:${me}`, 60, 10 * 60 * 1000);
      if (!rlDel.allowed && !rlDel.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlDel.retryAfter) });
        return;
      }
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
      // Community moderation: the organizer / admin may delete ANY
      // community message (no 24h window — moderation is not a
      // personal undo), while a sender deleting their own community
      // message keeps the same 24h window as a private message.
      // Private messages stay sender-only, as before.
      let canModerateCommunity = false;
      if (isCommunityMessage(msg)) {
        if (isGlobalMessage(msg)) {
          // Global room moderation: admins + approved organizers
          // may delete ANY global message (no 24h window).
          canModerateCommunity = await isApprovedOrganizer(userEmail);
        } else {
          const event = await loadEvent(msg.eventId);
          canModerateCommunity = !!event && mayManageEvent(event, userEmail);
        }
      }
      if (msg.senderEmail !== userEmail && !canModerateCommunity) {
        sendJson(res, 403, { message: "Only the sender can delete for everyone" });
        return;
      }
      // A delete-for-everyone window: after 24 hours the message is
      // part of the other side's history and only "delete for me"
      // remains. (Previously there was no window at all, and no
      // tombstone — the other side's conversation just lost messages
      // without explanation.)
      const ageMs = Date.now() - Date.parse(msg.createdAt || "");
      if (!canModerateCommunity && Number.isFinite(ageMs) && ageMs > 24 * 60 * 60 * 1000) {
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
      // message must not survive inside someone else's quote). Both
      // sides are scrubbed: loadMessagesReplyingTo finds replies from
      // either participant, not just the deleter's own messages.
      try {
        const quoting = await loadMessagesReplyingTo(id);
        for (const m of quoting) {
          if (m.replySnapshot) {
            m.replySnapshot = { ...m.replySnapshot, text: "", deleted: true };
            try { await updateMessageData(m); } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }
      // Instant tombstone: private → both participants' channels;
      // event community → fan-out to members (same list as send);
      // global → ping-only on the public channel (no content).
      try {
        if (isGlobalMessage(tombstoned)) {
          await broadcastRealtimeSoon([{
            topic: `community:${GLOBAL_EVENT_ID}`,
            event: "deleted",
            payload: { id: tombstoned.id },
          }]);
        } else if (isCommunityMessage(tombstoned)) {
          const [event, regs] = await Promise.all([
            loadEvent(tombstoned.eventId),
            loadRegistrationsForEvent(tombstoned.eventId).catch(() => null),
          ]);
          const members = event && regs ? communityMemberEmails(event, regs) : [];
          const versions = await loadSessionVersions(members);
          const entries: { topic: string; event: string; payload: any }[] = [];
          for (const email of members.slice(0, 200)) {
            const channel = await privateChannelName(email, versions.get(norm(email)) ?? 0);
            if (channel) entries.push({ topic: channel, event: "deleted", payload: buildRealtimePayload(tombstoned, email) });
          }
          if (entries.length) await broadcastRealtimeSoon(entries);
          else await broadcastRealtimeSoon([{ topic: `community:${tombstoned.eventId}`, event: "deleted", payload: { id: tombstoned.id } }]);
        } else {
          const entries: { topic: string; event: string; payload: any }[] = [];
          const delVersions = await loadSessionVersions([tombstoned.senderEmail, tombstoned.recipientEmail]);
          for (const email of [tombstoned.senderEmail, tombstoned.recipientEmail]) {
            const channel = await privateChannelName(String(email || ""), delVersions.get(norm(String(email || ""))) ?? 0);
            if (channel) entries.push({ topic: channel, event: "deleted", payload: buildRealtimePayload(tombstoned, email) });
          }
          await broadcastRealtimeSoon(entries);
        }
      } catch { /* broadcast is speed only; polling is the fallback */ }
      sendJson(res, 200, { deleted: true, message: tombstoned });
      return;
    }

    // ---- POST: "Delete for me" (hide for one user) ----
    if (req.method === "POST" && body.action === "hide") {
      const rlHide = await checkRateLimit(`msg:hide:${me}`, 60, 10 * 60 * 1000);
      if (!rlHide.allowed && !rlHide.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlHide.retryAfter) });
        return;
      }
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
      sendJson(res, 200, { message: stripMessageForViewer(msg, userEmail) });
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
      if (!rlBlock.allowed && !rlBlock.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlBlock.retryAfter) });
        return;
      }
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
      try {
        existing = await loadMessagesFor(me);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      if (body.action === "block") {
        if (!threadPairExists(existing, eventId, me, target)) {
          sendJson(res, 403, { message: "You can only block someone you have a conversation with" });
          return;
        }
        if (!findBlock(existing, eventId, me, target)) {
          try {
            await storeMessage({
              id: `block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      const mine = existing.filter((m: any) => m.type === "block" && m.eventId === eventId && m.blockerEmail === me && m.blockedEmail === target);
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
    // ---- POST: delete an uploaded attachment object ----
    // M2 (audit #4): deleting used to be unauthenticated-ownership
    // and un-rate-limited — anyone with a path could delete anyone
    // else's attachment. Now: rate-limited (20 / 10 min), and when a
    // stored message references the path, only its sender or the
    // event's organizer/admin may delete it (403 otherwise). When NO
    // message references the path it is a just-uploaded file whose
    // send failed or was aborted — the client's orphan cleanup after
    // a failed send — and the uploader may delete it: the path
    // suffix is crypto-random (see upload-url), so it is
    // unguessable, and the rate limit bounds blind probing.
    if (req.method === "POST" && body.action === "delete-upload") {
      const rlDelUp = await checkRateLimit(`msg:delete-upload:${me}`, 20, 10 * 60 * 1000);
      if (!rlDelUp.allowed && !rlDelUp.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlDelUp.retryAfter) });
        return;
      }
      const path = String(body.path || "");
      const pathOk = /^[A-Za-z0-9_-]+\/[0-9]+-[a-z0-9]+\.[A-Za-z0-9]+$/.test(path);
      if (!pathOk) {
        sendJson(res, 400, { message: "Invalid attachment path" });
        return;
      }
      let referenced: any = null;
      try {
        const { ok, body: rows } = await fetchJson(
          `${supabaseBase()}/rest/v1/messages?select=id,data&data->attachment->>path=eq.${encodeURIComponent(path)}&limit=1`,
          { headers: supabaseHeaders() },
        );
        if (ok && Array.isArray(rows) && rows.length > 0) referenced = rows[0].data;
      } catch { /* fall through to the history fallback below */ }
      if (!referenced) {
        // Fallback when the nested-jsonb filter is rejected: scan
        // the caller's own history (already session-scoped) plus
        // the event's community room (community rows are not in
        // loadMessagesFor — their recipient is the marker).
        try {
          const mine = await loadMessagesFor(me);
          referenced = mine.find((m: any) => m?.attachment?.path === path) || null;
        } catch { /* unreferenced: treated as the uploader's orphan */ }
        if (!referenced) {
          try {
            const comm = await loadCommunityMessages(path.split("/")[0]);
            referenced = comm.find((m: any) => m?.attachment?.path === path) || null;
          } catch { /* unreferenced: treated as the uploader's orphan */ }
        }
      }
      if (referenced) {
        const isSender = norm(referenced.senderEmail || "") === norm(me);
        let isManager = false;
        if (!isSender) {
          try {
            const ev = await loadEvent(referenced.eventId || path.split("/")[0]);
            isManager = !!ev && mayManageEvent(ev, me);
          } catch { isManager = false; }
        }
        if (!isSender && !isManager) {
          sendJson(res, 403, { message: "You can only delete your own uploads" });
          return;
        }
      }
      await deleteAttachmentObject(path);
      sendJson(res, 200, { deleted: true });
      return;
    }

    // ---- POST: signed upload URL ----
    if (req.method === "POST" && body.action === "upload-url") {
      const rlUpload = await checkRateLimit(`msg:upload:${me}`, 20, 10 * 60 * 1000);
      if (!rlUpload.allowed && !rlUpload.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlUpload.retryAfter) });
        return;
      }
      const eventId = String(body.eventId || "");
      const sender = me;
      const fileName = String(body.fileName || "");
      const fileSize = Number(body.fileSize || 0);
      const fileType = String(body.fileType || "");
      if (!eventId || !fileName) {
        sendJson(res, 400, { message: "eventId and fileName are required" });
        return;
      }
      // Community uploads reuse this exact path: the recipient is
      // the community marker (never a real email, never mailed), and
      // membership replaces authorizeContact. Size/type checks and
      // the magic-byte verification at send time are unchanged.
      const isCommunityUpload = body.community === true;
      // Recipient: if organizerId is given, resolve it from the stored
      // event (P2-4); otherwise fall back to a caller recipient that
      // authorizeContact() still validates against the stored event.
      const eventForRecipient = await loadEvent(eventId);
      let recipient = norm(body.recipientEmail || "");
      if (isCommunityUpload) {
        recipient = communityRecipient(eventId);
      } else if (body.organizerId && eventForRecipient) {
        const orgEmail = organizerEmailOf(eventForRecipient);
        if (orgEmail) recipient = orgEmail;
      }
      if (!isCommunityUpload && !isEmail(recipient)) {
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
      // Global room has no stored event: the session user is a
      // member by definition, so use a stand-in event row instead
      // of 404ing on loadEvent("global").
      const isGlobalUpload = isCommunityUpload && eventId === GLOBAL_EVENT_ID;
      // The event was already loaded above (eventForRecipient) —
      // load it once, not twice. The history + registration reads
      // are independent, so they run in parallel.
      const event = isGlobalUpload
        ? { id: GLOBAL_EVENT_ID, title: "Community" }
        : eventForRecipient;
      if (!event) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      let existing: any[] = [];
      let regs: any[] | null = null;
      try {
        const [history, registrations] = await Promise.all([
          loadMessagesFor(sender),
          isCommunityUpload && !isGlobalUpload ? loadRegistrationsForEvent(eventId) : Promise.resolve(null),
        ]);
        existing = history;
        regs = registrations;
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      if (isCommunityUpload) {
        // Global room: any session user is a member — no
        // registration check. Event rooms keep the check below.
        if (!isGlobalUpload) {
          if (!regs || !isCommunityMember(event, sender, regs)) {
            sendJson(res, 403, { message: "Register to join the community chat" });
            return;
          }
        }
      } else {
        const denied = authorizeContact(event, sender, recipient, existing);
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
      }
      const path = `${sanitizePathSegment(eventId)}/${Date.now()}-${bytesToHex(randomBytes(5))}.${ext}`;
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

    // ---- POST: send a COMMUNITY message ----
    // Group chat for one event. No email alerts are ever sent here
    // (one mail per message to every attendee would be spam) — this
    // branch returns before any sendMail call. Membership, reply
    // validation and attachment verification mirror the private
    // send; the only differences are the community marker recipient
    // and the membership gate in place of authorizeContact.
    if (req.method === "POST" && body.community === true) {
      const rlCommunity = await checkRateLimit(`msg:community-send:${me}`, 60, 60 * 60 * 1000);
      if (!rlCommunity.allowed && !rlCommunity.tableMissing) {
        sendJson(res, 429, { message: "Too many messages. Try again shortly." }, { "Retry-After": String(rlCommunity.retryAfter) });
        return;
      }
      const eventId = String(body.eventId || "");
      const sender = me;
      const text = String(body.text || "").trim().slice(0, MAX_TEXT_CHARS);
      const attachment = body.attachment || null;
      if (!eventId) {
        sendJson(res, 400, { message: "eventId is required" });
        return;
      }
      // SEND-PATH SPEED (2026-11-06): the profile, event and
      // registration reads are independent — run them in parallel
      // instead of one after another (~3 sequential round trips
      // saved before the row even exists).
      const isGlobalSend = eventId === GLOBAL_EVENT_ID;
      let senderName = sender;
      let event: any = null;
      let regs: any[] = [];
      try {
        const [profile, loadedEvent, loadedRegs] = await Promise.all([
          loadUserByEmail(sender).catch(() => null),
          isGlobalSend ? Promise.resolve({ id: GLOBAL_EVENT_ID, title: "Community" }) : loadEvent(eventId),
          isGlobalSend ? Promise.resolve([]) : loadRegistrationsForEvent(eventId),
        ]);
        if (profile && typeof profile.data?.name === "string" && profile.data.name.trim()) {
          senderName = profile.data.name.trim().slice(0, 80);
        }
        event = loadedEvent;
        regs = loadedRegs || [];
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      if (!event) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      // Global room: no registrations to check — any session
      // user is a member (isGlobalMember). Event rooms keep it.
      if (!isGlobalSend && !isCommunityMember(event, sender, regs)) {
        sendJson(res, 403, { message: "Register to join the community chat" });
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
      // Community replies: the quoted message must be a COMMUNITY
      // message in this same event. A private message's id is refused
      // even for the same event (see communityReplyTargetError).
      // The quote lookup and the idempotency lookup are independent
      // — run them together, not one after another.
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.slice(0, 100) : "";
      const wantsReply = body.replyToId !== undefined && body.replyToId !== null && String(body.replyToId).trim() !== "";
      let replyToId = "";
      let replySnapshot: any = null;
      let prior: any = null;
      {
        const [quoted, priorRow] = await Promise.all([
          wantsReply ? loadMessage(String(body.replyToId).trim().slice(0, 200)).catch(() => null) : Promise.resolve(null),
          // H8/M16: targeted idempotency lookup (one indexed row),
          // not a load of the room's whole history.
          idempotencyKey ? loadMessageByIdempotencyKey({ eventId, key: idempotencyKey, senderEmail: sender, community: true }) : Promise.resolve(null),
        ]);
        if (wantsReply) {
          replyToId = String(body.replyToId).trim().slice(0, 200);
          if (!quoted) {
            sendJson(res, 400, { message: "Quoted message not found" });
            return;
          }
          const replyError = communityReplyTargetError(quoted, eventId);
          if (replyError) {
            sendJson(res, 400, { message: replyError });
            return;
          }
          replySnapshot = buildReplySnapshot(quoted);
        }
        if (idempotencyKey) {
          // The targeted lookup already matched sender + event +
          // key; the sender check below is defence-in-depth.
          prior = priorRow && priorRow.senderEmail === sender ? priorRow : null;
          if (prior) {
            sendJson(res, 200, { message: stripMessageForViewer(prior, sender), idempotent: true });
            return;
          }
        }
      }
      if (cleanAttachment) {
        const sniffError = await verifyAttachment(cleanAttachment.path, extensionOf(cleanAttachment.name));
        if (sniffError) {
          sendJson(res, 400, { message: sniffError });
          return;
        }
      }
      const msg: any = {
        id: newMessageId(),
        type: "community",
        eventId,
        eventTitle: event.title || "",
        senderEmail: sender,
        senderName,
        recipientEmail: communityRecipient(eventId),
        text: text || "",
        attachment: cleanAttachment,
        read: false,
        hiddenFor: [],
        createdAt: new Date().toISOString(),
      };
      if (idempotencyKey) msg.idempotencyKey = idempotencyKey;
      if (replyToId) {
        msg.replyToId = replyToId;
        msg.replySnapshot = replySnapshot;
      }
      try {
        await storeMessage(msg);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // Instant delivery: event rooms fan the FULL payload out to
      // every member's private channel (one batched REST call);
      // rooms over 200 members fall back to a ping on the public
      // community channel + polling. The global room is ping-only
      // by design (unbounded audience — see the header above).
      // No email alert for community messages, by design.
      try {
        if (isGlobalSend) {
          await broadcastRealtimeSoon([{
            topic: `community:${GLOBAL_EVENT_ID}`,
            event: "message",
            payload: { id: msg.id },
          }]);
        } else {
          const members = communityMemberEmails(event, regs);
          if (members.length > 200) {
            await broadcastRealtimeSoon([{
              topic: `community:${eventId}`,
              event: "message",
              payload: { id: msg.id },
            }]);
          } else {
            const sendVersions = await loadSessionVersions(members);
            const entries: { topic: string; event: string; payload: any }[] = [];
            for (const email of members) {
              const channel = await privateChannelName(email, sendVersions.get(norm(email)) ?? 0);
              if (channel) entries.push({ topic: channel, event: "message", payload: buildRealtimePayload(msg, email) });
            }
            await broadcastRealtimeSoon(entries);
          }
        }
      } catch { /* broadcast is speed only; polling is the fallback */ }
      sendJson(res, 200, { message: stripMessageForViewer(msg, sender) });
      return;
    }

    // ---- POST: send a message ----
    if (req.method === "POST") {
      const rlSend = await checkRateLimit(`msg:send:${me}`, 60, 60 * 60 * 1000);
      if (!rlSend.allowed && !rlSend.tableMissing) {
        sendJson(res, 429, { message: "Too many messages. Try again shortly." }, { "Retry-After": String(rlSend.retryAfter) });
        return;
      }
      const eventId = String(body.eventId || "");
      const sender = me;
      const text = String(body.text || "").trim().slice(0, MAX_TEXT_CHARS);
      const attachment = body.attachment || null;
      if (!eventId) {
        sendJson(res, 400, { message: "eventId is required" });
        return;
      }
      // SEND-PATH SPEED (2026-11-06): the sender profile, the event
      // and the sender's history are independent — run them in
      // parallel, and load the event ONCE (it used to load twice).
      // Display names stay server-derived, never caller-supplied:
      // the old code stored body.senderName verbatim (spoofable).
      let senderName = sender;
      let eventForRecipient: any = null;
      let existing: any[] = [];
      try {
        const [profile, loadedEvent, history] = await Promise.all([
          loadUserByEmail(sender).catch(() => null),
          loadEvent(eventId),
          loadMessagesFor(sender),
        ]);
        if (profile && typeof profile.data?.name === "string" && profile.data.name.trim()) {
          senderName = profile.data.name.trim().slice(0, 80);
        }
        eventForRecipient = loadedEvent;
        existing = history;
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // Recipient resolution (P2-4): organizerId -> stored event's
      // organiser email. A caller-supplied recipientEmail is only used
      // when no organizerId is given, and authorizeContact() below
      // still validates it against the stored event.
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
      // The event + history were already loaded above, in parallel —
      // no second loadEvent, no second history read.
      const event = eventForRecipient;
      const denied = authorizeContact(event, sender, recipient, existing);
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
      // Replies: optional replyToId, validated server-side — the
      // quoted message must exist, be in this event, and be in this
      // exact thread pair (either direction). A caller-supplied
      // snapshot is NEVER trusted: the snapshot is rebuilt here from
      // the stored quoted row, frozen at send time.
      let replyToId = "";
      let replySnapshot: any = null;
      if (body.replyToId !== undefined && body.replyToId !== null && String(body.replyToId).trim() !== "") {
        replyToId = String(body.replyToId).trim().slice(0, 200);
        let quoted: any = null;
        try { quoted = await loadMessage(replyToId); } catch { quoted = null; }
        if (!quoted) {
          sendJson(res, 400, { message: "Quoted message not found" });
          return;
        }
        const replyError = replyTargetError(quoted, eventId, sender, recipient);
        if (replyError) {
          sendJson(res, 400, { message: replyError });
          return;
        }
        replySnapshot = buildReplySnapshot(quoted);
      }
      // Send idempotency: a lost response + Retry used to create a
      // duplicate message (the client cleared the draft before the send
      // completed). A retry carrying the same key returns the original
      // row instead of storing a second one. M16: the lookup is
      // scoped by eventId + recipientEmail, not just the key — a key
      // reused across threads must not return another thread's row.
      const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.slice(0, 100) : "";
      if (idempotencyKey) {
        let prior = await loadMessageByIdempotencyKey({ eventId, key: idempotencyKey, senderEmail: sender, recipientEmail: recipient, community: false });
        if (!prior) {
          // Fallback: the sender's history is already loaded above
          // for authorizeContact, so this in-memory scan costs no
          // extra read when the targeted lookup fails.
          prior = existing.find((m: any) => m.type !== "community" && m.idempotencyKey === idempotencyKey && m.senderEmail === sender && String(m.eventId || "") === String(eventId) && norm(m.recipientEmail || "") === norm(recipient)) || null;
        }
        if (prior) {
          sendJson(res, 200, { message: stripMessageForViewer(prior, sender), mailed: false, idempotent: true });
          return;
        }
      }
      // Attachments are verified against their real bytes here (see
      // verifyAttachment): declared size/type/extension alone were
      // bypassable, because the browser uploads straight to Storage.
      // The recipient-profile read is independent — run it with the
      // sniff instead of after it.
      let recipientName = recipient;
      const [sniffError, recipientProfile] = await Promise.all([
        cleanAttachment
          ? verifyAttachment(cleanAttachment.path, extensionOf(cleanAttachment.name))
          : Promise.resolve(null),
        recipient === organizerEmailOf(event)
          ? Promise.resolve(null)
          : loadUserByEmail(recipient).catch(() => null),
      ]);
      if (sniffError) {
        sendJson(res, 400, { message: sniffError });
        return;
      }
      // Recipient display name (the old thread list showed the viewer's
      // OWN name for sender-side threads, because no recipient name was
      // ever stored): the organizer's name from the stored event, or
      // the attendee's profile name.
      try {
        if (recipient === organizerEmailOf(event)) {
          if (event.organizer && typeof event.organizer.name === "string" && event.organizer.name.trim()) {
            recipientName = event.organizer.name.trim().slice(0, 80);
          }
        } else if (recipientProfile && typeof recipientProfile.data?.name === "string" && recipientProfile.data.name.trim()) {
          recipientName = recipientProfile.data.name.trim().slice(0, 80);
        }
      } catch { /* fall back to the email address */ }
      const msg: any = {
        id: newMessageId(),
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
      if (replyToId) {
        msg.replyToId = replyToId;
        msg.replySnapshot = replySnapshot;
      }
      try {
        await storeMessage(msg);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // Instant delivery: the FULL payload goes to the recipient's
      // private channel (and the sender's own, for their other tabs)
      // — the receiver renders it with no refetch. Bounded wait so
      // the sender's POST never stalls on Realtime.
      try {
        const entries: { topic: string; event: string; payload: any }[] = [];
        // The sender is me: my version is in the verified session.
        // The recipient's stored version is loaded (one read).
        const recipientVersion = await loadSessionVersion(String(recipient || ""));
        for (const email of [recipient, sender]) {
          const v = norm(String(email || "")) === norm(sender || "") ? (session.sessionVersion ?? 0) : recipientVersion;
          const channel = await privateChannelName(String(email || ""), v);
          if (channel) entries.push({ topic: channel, event: "message", payload: buildRealtimePayload(msg, email) });
        }
        await broadcastRealtimeSoon(entries);
      } catch { /* broadcast is speed only; polling is the fallback */ }
      // Best-effort alert, FIRE-AND-FORGET: awaiting Gmail used to
      // push the POST past the client's 15s timeout on a slow SMTP
      // day, so the sender saw "Failed to send" for a message that
      // WAS stored. The mail still goes out; the response does not
      // wait for it. `mailed` reports false here because delivery is
      // no longer awaited — the client never depended on it.
      sendMail(buildMessageEmail(msg, event)).catch(() => {});
      sendJson(res, 200, { message: stripMessageForViewer(msg, sender), mailed: false });
      return;
    }

    // ---- PATCH: edit text (own message, within 1 hour) / mark read ----
    if (req.method === "PATCH") {
      const rlPatch = await checkRateLimit(`msg:patch:${me}`, 60, 10 * 60 * 1000);
      if (!rlPatch.allowed && !rlPatch.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlPatch.retryAfter) });
        return;
      }
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
        // Community edits need CURRENT membership: a member who
        // cancelled after posting can no longer edit (or post) in
        // the group chat. Organizer/admin keep access via the
        // membership rule itself.
        // Global room: any session user who sent it may edit
        // within 1h — the sender check above already ran, and
        // there is no registration to lose. Event rooms keep the
        // current-membership check below.
        if (isCommunityMessage(msg) && msg.eventId !== GLOBAL_EVENT_ID) {
          const event = await loadEvent(msg.eventId);
          if (!event) {
            sendJson(res, 404, { message: "Event not found" });
            return;
          }
          let regs: any[];
          try {
            regs = await loadRegistrationsForEvent(msg.eventId);
          } catch {
            sendJson(res, 503, { message: "Messages are not set up yet" });
            return;
          }
          if (!isCommunityMember(event, editor, regs)) {
            sendJson(res, 403, { message: "Register to join the community chat" });
            return;
          }
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
        // Instant edit: the other side updates in place from the
        // full payload (private: both channels; event community:
        // fan-out; global: ping-only, no content).
        try {
          if (isGlobalMessage(msg)) {
            await broadcastRealtimeSoon([{ topic: `community:${GLOBAL_EVENT_ID}`, event: "edited", payload: { id: msg.id } }]);
          } else if (isCommunityMessage(msg)) {
            const [event, regs] = await Promise.all([
              loadEvent(msg.eventId),
              loadRegistrationsForEvent(msg.eventId).catch(() => null),
            ]);
            const members = event && regs ? communityMemberEmails(event, regs) : [];
            const editVersions = await loadSessionVersions(members);
            const entries: { topic: string; event: string; payload: any }[] = [];
            for (const email of members.slice(0, 200)) {
              const channel = await privateChannelName(email, editVersions.get(norm(email)) ?? 0);
              if (channel) entries.push({ topic: channel, event: "edited", payload: buildRealtimePayload(msg, email) });
            }
            if (entries.length) await broadcastRealtimeSoon(entries);
            else await broadcastRealtimeSoon([{ topic: `community:${msg.eventId}`, event: "edited", payload: { id: msg.id } }]);
          } else {
            const entries: { topic: string; event: string; payload: any }[] = [];
            const editVersions = await loadSessionVersions([msg.senderEmail, msg.recipientEmail]);
            for (const email of [msg.senderEmail, msg.recipientEmail]) {
              const channel = await privateChannelName(String(email || ""), editVersions.get(norm(String(email || ""))) ?? 0);
              if (channel) entries.push({ topic: channel, event: "edited", payload: buildRealtimePayload(msg, email) });
            }
            await broadcastRealtimeSoon(entries);
          }
        } catch { /* broadcast is speed only; polling is the fallback */ }
        sendJson(res, 200, { message: stripMessageForViewer(msg, me) });
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
      // Read receipt, live: the sender's ✓ flips to ✓✓ without
      // waiting for a poll. Fire-and-forget — if it drops, the next
      // poll shows the same state.
      try {
        const channel = await privateChannelName(String(msg.senderEmail || ""), await loadSessionVersion(String(msg.senderEmail || "")));
        if (channel) broadcastRealtime([{ topic: channel, event: "read", payload: { id: msg.id } }]).catch(() => {});
      } catch { /* broadcast is speed only */ }
      sendJson(res, 200, { message: stripMessageForViewer(msg, recipient) });
      return;
    }

    sendJson(res, 405, { message: "Method not allowed" });
  } catch (err) {
    console.warn("messages handler failed:", err);
    sendJson(res, 500, { message: "Something went wrong" });
  }
}
