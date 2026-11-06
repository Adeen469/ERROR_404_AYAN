// Consolidated auth endpoint — Hobby-plan Serverless Function count fix.
// Vercel Hobby allows at most 12 Serverless Functions per deployment.
// This repo had 17 api files, so every deployment since Oct 28 failed
// at "Deploying outputs" with the 12-function limit (the TS2688 lines
// in earlier build logs were non-fatal transpilation warnings, not the
// failure). This single file replaces five endpoints:
//   /api/auth/login, /api/auth/signup, /api/auth/logout,
//   /api/auth/reset, /api/auth/verify-email,
//   /api/auth/resend-verification, /api/me
// (see vercel.json rewrites + .vercelignore: the old files stay in the
// repo but are excluded from deployment). /api/auth/google and
// /api/auth/callback/google stay separate files on purpose: the Google
// Cloud redirect URI must keep pointing at the callback path.
// H1 (audit #4, link-based email verification): local sign-ups create
// the account with emailVerified:false and NO session; the emailed link
// is GET /api/auth/verify-email?token=<raw> which verifies and 302s to
// the /verify-email result page. Only the SHA-256 hash of the token is
// stored, on the locora_users row itself — no new table. Google
// accounts are never gated (Google already verified the email).
// Routing: vercel.json rewrites each old URL to /api/auth?endpoint=<name>.
// The dispatcher below also falls back to the request pathname, so it
// works whether or not the rewrite changed req.url. NOTE: the reset
// handler's own body.action ("request"/"confirm") is unrelated to the
// ?endpoint= query param used here for routing.
// All handlers below are byte-identical to the original files; only
// the shared helpers were deduplicated (they were identical in every
// file) and each handler was renamed (handleLogin, etc.).

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
// H2 (audit #4): static imports in this file are the shared
// rate-limit module (api/_lib/rate-limit.ts) and the L3 origin check
// (api/_lib/origin-check.ts). See the rate-limit header for the
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

const SITE_URL = "https://locora-hyperlocal.vercel.app";

// ---- H1: link-based email verification (audit #4) ----
// Token storage: on the locora_users row data itself, so NO new
// Supabase table is needed:
//   { emailVerified: boolean, emailVerificationTokenHash: string (SHA-256 hex),
//     emailVerificationExpiresAt: ISO string }
// Only the hash is ever stored; the raw token exists only in the emailed
// link (and transiently in memory while sending it) and is never logged.
// A token is single-use: verifying clears the hash + expiry from the row,
// so a reused link finds no row and fails as invalid. Legacy local rows
// created before H1 have NO emailVerified field — they are grandfathered
// (treated as verified) so H1 never locks out an existing account; only
// rows created after H1 carry emailVerified:false. Google rows are never
// gated: Google verified the email, and the callback stamps
// authProvider:"google" (see api/auth/callback/google.ts, untouched).
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export function isEmailVerificationRequired(userData: any): boolean {
  if (!userData || typeof userData !== "object") return false;
  // Gate ONLY local accounts with an explicit emailVerified:false.
  // Google accounts (authProvider "google") and legacy rows with no
  // emailVerified field are NOT gated.
  return userData.authProvider === "local" && userData.emailVerified === false;
}

export function verificationLink(rawToken: string): string {
  return `${SITE_URL}/api/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
}

async function sendVerificationMail(to: string, rawToken: string): Promise<boolean> {
  const user = getEnv("GMAIL_USER");
  const pass = getEnv("GMAIL_APP_PASSWORD");
  if (!user || !pass) return false;
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass: pass.replace(/\s+/g, "") } });
    const link = verificationLink(rawToken);
    await transporter.sendMail({
      from: `"Locora" <${user}>`, to,
      subject: "Verify your Locora email",
      text: `Welcome to Locora! Confirm your email address with this link within 24 hours (it can only be used once):\n\n${link}\n\nIf you did not create a Locora account, ignore this email.`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;"><h2 style="color:#1E3F35;">Verify your Locora email</h2><p>Confirm your email address with this link within 24 hours (it can only be used once):</p><p><a href="${link}" style="display:inline-block;background:#1E3F35;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;">Verify my email</a></p><p>If you did not create a Locora account, ignore this email.</p></div>`,
    });
    return true;
  } catch { return false; }
}

// Generate a fresh 256-bit token for this row, store ONLY its SHA-256
// hash + a 24h expiry on the row, return the raw token (for the email
// link) or null if the row could not be updated. Regenerating invalidates
// any earlier link for the same account.
async function issueVerificationToken(userRow: { id: string; data: any }): Promise<string | null> {
  try {
    const raw = randomTokenHex(32);
    const updated = {
      ...userRow.data,
      emailVerified: false,
      emailVerificationTokenHash: await hashToken(raw),
      emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS).toISOString(),
    };
    const up = await fetchJson(`${supabaseBase()}/rest/v1/locora_users?id=eq.${encodeURIComponent(userRow.id)}`, {
      method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: updated }),
    });
    if (!up.ok) return null;
    return raw;
  } catch { return null; }
}

async function sendVerificationEmailForRow(userRow: { id: string; data: any }): Promise<boolean> {
  const raw = await issueVerificationToken(userRow);
  if (!raw) return false;
  return sendVerificationMail(userRow.data?.email || "", raw);
}

async function sendResetMail(to: string, rawToken: string): Promise<boolean> {
  const user = getEnv("GMAIL_USER");
  const pass = getEnv("GMAIL_APP_PASSWORD");
  if (!user || !pass) return false;
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass: pass.replace(/\s+/g, "") } });
    const link = `${SITE_URL}/reset-password?token=${encodeURIComponent(rawToken)}`;
    await transporter.sendMail({
      from: `"Locora" <${user}>`, to,
      subject: "Reset your Locora password",
      text: `You asked to reset your Locora password. Use this link within 1 hour (it can only be used once):\n\n${link}\n\nIf you did not ask for this, ignore this email — your password has not changed.`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;"><h2 style="color:#1E3F35;">Reset your Locora password</h2><p>Use this link within 1 hour (it can only be used once):</p><p><a href="${link}" style="display:inline-block;background:#1E3F35;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;">Reset password</a></p><p>If you did not ask for this, ignore this email — your password has not changed.</p></div>`,
    });
    return true;
  } catch { return false; }
}

const PROFILE_FIELDS = ["name", "bio", "phone", "country", "state", "city", "interests", "avatar"];

function publicProfile(row: any, sessionEmail: string, sessionRole: string): any {
  const d = row?.data || {};
  const profile = d.profile || {};
  return {
    id: row?.id || `usr-${sessionEmail}`,
    email: sessionEmail,
    name: d.name || profile.name || "Community Member",
    role: d.role || sessionRole,
    authProvider: d.authProvider || "local",
    avatar: profile.avatar || d.avatar || "",
    bio: profile.bio || d.bio || "",
    phone: profile.phone || "",
    phoneVerified: profile.phoneVerified || false,
    country: profile.country || "",
    state: profile.state || "",
    city: profile.city || "",
    interests: Array.isArray(profile.interests) ? profile.interests : (d.interests || []),
    createdAt: d.createdAt || "",
  };
}

async function handleLogin(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) { sendJson(res, 503, { message: "Sign-in is not configured yet" }); return; }
    if (!getEnv("SESSION_SECRET")) { sendJson(res, 500, { message: "Sign-in is not configured yet" }); return; }
    const body = await readBody(req);
    const email = norm(body.email || "");
    const password = String(body.password || "");
    if (!isEmail(email) || !password) { sendJson(res, 401, { message: "Invalid credentials" }); return; }
    const rlIp = await checkRateLimit(`login:ip:${getClientIp(req)}`, 30, 60 * 60 * 1000);
    const rlEmail = await checkRateLimit(`login:email:${email}`, 10, 60 * 60 * 1000);
    // H2 (audit #4): fail CLOSED on auth mutations. A missing
    // rate_limits table means no brute-force protection, so sign-in
    // is refused (503) rather than run unlimited. GETs and non-auth
    // mutations stay fail-open (see api/_lib/rate-limit.ts).
    if (rlIp.tableMissing || rlEmail.tableMissing) {
      sendJson(res, 503, { message: "Sign-in is temporarily unavailable. Please try again shortly." });
      return;
    }
    if (!rlIp.allowed || !rlEmail.allowed) {
      sendJson(res, 429, { message: "Too many sign-in attempts. Try again later." }, { "Retry-After": String(Math.max(rlIp.retryAfter, rlEmail.retryAfter)) });
      return;
    }
    // Admin accounts sign in with Google only, never with a local password.
    if (isAdmin(email)) { sendJson(res, 401, { message: "Invalid credentials" }); return; }
    const userRow = await loadUserByEmail(email);
    // Dummy verify for unknown / Google accounts, to keep timing similar.
    const stored = userRow && userRow.data?.authProvider === "local" ? userRow.data.passwordHash : "pbkdf2$75097d9373b5f84d30d42a1dcc82968d$0f9079f7eace8a2aa8760f5104ac26180ba137b6064a8ab1615fafd6993a49bf$100000";
    if (!userRow || userRow.data?.authProvider !== "local" || !(await verifyPassword(password, stored))) {
      sendJson(res, 401, { message: "Invalid credentials" });
      return;
    }
    const d = userRow.data;
    // H1: a local account whose email is not verified yet cannot sign
    // in, even with the right password. The caller authenticated, so
    // telling them (and only them) the reason is safe. Google accounts
    // never reach this branch (authProvider !== "local" fails above),
    // and legacy local rows without emailVerified are grandfathered
    // (see isEmailVerificationRequired).
    if (isEmailVerificationRequired(d)) {
      sendJson(res, 403, {
        message: "Please verify your email before signing in. Check your inbox (and spam) for the verification link.",
        code: "email_not_verified", email, needsVerification: true,
      });
      return;
    }
    const role = isAdmin(email) ? "admin" : (d.role || "attendee");
    const jwt = await signSession(email, role, "local", typeof d.sessionVersion === "number" ? d.sessionVersion : 0);
    sendJson(res, 200, {
      user: { id: userRow.id, email, name: d.name || "Community Member", role, authProvider: "local" },
    }, { "Set-Cookie": sessionCookie(jwt, req) });
  } catch {
    sendJson(res, 500, { message: "Sign-in failed" });
  }
}

async function handleSignup(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) { sendJson(res, 503, { message: "Sign-up is not configured yet" }); return; }
    if (!getEnv("SESSION_SECRET")) { sendJson(res, 500, { message: "Sign-up is not configured yet" }); return; }
    const body = await readBody(req);
    const email = norm(body.email || "");
    const name = String(body.name || "").trim().slice(0, 100) || "Community Member";
    const password = String(body.password || "");
    if (!isEmail(email)) { sendJson(res, 400, { message: "A valid email is required" }); return; }
    // L6 (audit #4, user-authorised 2026-11-06): NEW sign-ups need a
    // password of at least 8 characters (was 6). Existing users are
    // unaffected — no migration, no forced resets; their stored hashes
    // keep working as-is. Reset-confirm keeps its own 6 minimum.
    if (password.length < 8 || password.length > 128) { sendJson(res, 400, { message: "Password must be at least 8 characters" }); return; }
    if (isAdmin(email)) { sendJson(res, 403, { message: "Admin accounts sign in with Google, not with a local password." }); return; }
    const rl = await checkRateLimit(`signup:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000);
    // Per-email limit too: the old per-IP-only limit was bypassable by
    // rotating a spoofed X-Forwarded-For header, leaving mass account
    // creation effectively unthrottled.
    const rlEmail = await checkRateLimit(`signup:email:${email}`, 5, 60 * 60 * 1000);
    // H2 (audit #4): fail CLOSED on auth mutations — a missing
    // rate_limits table means no cap on mass account creation, so
    // sign-up is refused (503) rather than run unlimited.
    if (rl.tableMissing || rlEmail.tableMissing) {
      sendJson(res, 503, { message: "Sign-up is temporarily unavailable. Please try again shortly." });
      return;
    }
    if (!rl.allowed || !rlEmail.allowed) {
      sendJson(res, 429, { message: "Too many sign-ups. Try again later." }, { "Retry-After": String(Math.max(rl.retryAfter, rlEmail.retryAfter)) });
      return;
    }
    const existing = await loadUserByEmail(email);
    // H1: the 409 stays generic — the same response whether the email
    // exists or not, and whether it is verified or not (no enumeration).
    // One quiet exception, invisible in the response: if the existing
    // account is a local account that has NOT verified its email yet, a
    // fresh verification link is re-sent, so a user who lost the first
    // email is not stuck behind a bare "already exists".
    if (existing) {
      if (isEmailVerificationRequired(existing.data)) {
        try { await sendVerificationEmailForRow(existing); } catch {}
      }
      sendJson(res, 409, { message: "An account with this email already exists. Sign in instead — or use 'Trouble signing in?' if you didn't create it. If you signed up recently and have not verified your email yet, check your inbox (and spam) for the verification link." });
      return;
    }
    // H1: create the account UNVERIFIED and issue NO session. The
    // account can sign in only after the emailed link is clicked.
    // The raw token is generated here, its SHA-256 hash (only) is
    // stored on the row, and the raw token is emailed once, below.
    const rawVerificationToken = randomTokenHex(32);
    const id = `usr-${Date.now()}`;
    const row = { id, data: { email, name, role: "attendee", authProvider: "local", passwordHash: await hashPassword(password), sessionVersion: 0, createdAt: new Date().toISOString(), emailVerified: false, emailVerificationTokenHash: await hashToken(rawVerificationToken), emailVerificationExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS).toISOString() } };
    const { ok } = await fetchJson(`${supabaseBase()}/rest/v1/locora_users`, {
      method: "POST", headers: supabaseHeaders(), body: JSON.stringify(row),
    });
    if (!ok) { sendJson(res, 500, { message: "Could not create the account" }); return; }
    // Mailer missing must not brick sign-up (unlike the reset flow,
    // the account itself is already created): the user can resend the
    // link later, once the mailer is configured. Warn loudly instead.
    let emailSent = false;
    try {
      emailSent = await sendVerificationMail(email, rawVerificationToken);
      if (!emailSent) console.warn("H1: verification email NOT sent during sign-up (mailer not configured?) — account created unverified; resend once GMAIL_USER / GMAIL_APP_PASSWORD are set");
    } catch {}
    sendJson(res, 201, { user: { id, email, name, role: "attendee", authProvider: "local" }, needsVerification: true, email, emailSent });
  } catch {
    sendJson(res, 500, { message: "Sign-up failed" });
  }
}

async function handleLogout(req: any, res: any): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
  // Previously the revocation result was silently ignored: when the
  // revoked_tokens table was missing (or the insert failed), logout
  // still reported success while the 7-day token stayed valid. Now the
  // response says whether the token was actually revoked, and
  // { everywhere: true } bumps sessionVersion so EVERY session for
  // this account (all devices) stops working — the "sign out
  // everywhere" that previously only a password reset could do.
  let revoked = false;
  let everywhere = false;
  let hadSession = false;
  try {
    const session = await verifySession(req);
    if (session) {
      hadSession = true;
      revoked = await revokeSessionToken(req);
      const body = await readBody(req);
      if (body && body.everywhere === true) {
        const userRow = await loadUserByEmail(session.email);
        if (userRow) {
          const updated = { ...userRow.data, sessionVersion: typeof userRow.data.sessionVersion === "number" ? userRow.data.sessionVersion + 1 : 1 };
          const up = await fetchJson(`${supabaseBase()}/rest/v1/locora_users?id=eq.${encodeURIComponent(userRow.id)}`, {
            method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: updated }),
          });
          everywhere = up.ok;
        } else {
          // No profile row yet (e.g. a Google sign-in from before rows
          // were recorded, or row creation failed silently): the bump
          // above silently did nothing, so "sign out everywhere" only
          // ever signed out this device — exactly the reported bug.
          // Create the row stamped at version 1: every session issued
          // so far carries v 0 (or no version at all), so the version
          // check in verifySession now rejects all of them.
          const created = await fetchJson(`${supabaseBase()}/rest/v1/locora_users`, {
            method: "POST", headers: supabaseHeaders(),
            body: JSON.stringify({ id: `usr-${Date.now()}`, data: { email: session.email, name: "Community Member", role: session.role, authProvider: session.authProvider, sessionVersion: 1, createdAt: new Date().toISOString() } }),
          });
          everywhere = created.ok;
        }
      }
    }
  } catch {}
  // L6 (audit #4): logout used to answer ok:true even when the
  // server-side revocation failed (missing revoked_tokens table or a
  // failed insert), while the 7-day token stayed valid. The cookie is
  // still cleared — this browser stops sending it — but a live session
  // whose revocation failed is now reported honestly as ok:false, so
  // the caller knows the token may still be replayable until it
  // expires. No session at all (already signed out) still answers
  // ok:true: there was nothing to revoke.
  const revocationFailed = hadSession && !revoked;
  if (revocationFailed) {
    try { console.error("L6: logout could not revoke the server session (revoked_tokens insert failed)"); } catch {}
  }
  sendJson(res, 200, { ok: !revocationFailed, revoked, everywhere, ...(revocationFailed ? { message: "Signed out of this browser, but the server session could not be revoked — it may stay valid until it expires." } : {}) }, { "Set-Cookie": clearSessionCookie(req) });
}

async function handleReset(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) { sendJson(res, 503, { message: "Password reset is not configured yet" }); return; }
    const body = await readBody(req);
    const action = body.action;

    if (action === "request") {
      const email = norm(body.email || "");
      if (!isEmail(email)) { sendJson(res, 400, { message: "A valid email is required" }); return; }
      const rlIp = await checkRateLimit(`reset:req:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000);
      const rlEmail = await checkRateLimit(`reset:req:email:${email}`, 5, 60 * 60 * 1000);
      // H2 (audit #4): fail CLOSED — password-reset request is an
      // auth mutation; without the table there is no cap on reset
      // mail, so refuse (503) rather than run unlimited.
      if (rlIp.tableMissing || rlEmail.tableMissing) {
        sendJson(res, 503, { message: "Password reset is temporarily unavailable. Please try again shortly." });
        return;
      }
      if (!rlIp.allowed || !rlEmail.allowed) {
        sendJson(res, 429, { message: "Too many reset requests. Try again later." }, { "Retry-After": String(Math.max(rlIp.retryAfter, rlEmail.retryAfter)) });
        return;
      }
      // Mailer missing for everyone -> honest 503, not a fake success.
      if (!getEnv("GMAIL_USER") || !getEnv("GMAIL_APP_PASSWORD")) { sendJson(res, 503, { message: "Password reset email is not configured yet" }); return; }
      const generic = { ok: true, message: "If an account exists for that email, a reset link has been sent. It expires in 1 hour." };
      const userRow = await loadUserByEmail(email);
      if (!userRow || userRow.data?.authProvider !== "local" || !userRow.data?.passwordHash) { sendJson(res, 200, generic); return; }
      const raw = randomTokenHex(32);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await fetchJson(`${supabaseBase()}/rest/v1/password_resets`, {
        method: "POST", headers: supabaseHeaders(),
        body: JSON.stringify({ id: `rst-${Date.now()}-${randomTokenHex(4)}`, data: { email, tokenHash: await hashToken(raw), expiresAt, used: false, createdAt: new Date().toISOString() } }),
      });
      await sendResetMail(email, raw);
      sendJson(res, 200, generic);
      return;
    }

    if (action === "confirm") {
      const token = String(body.token || "");
      const newPassword = String(body.newPassword || "");
      if (!token || newPassword.length < 6 || newPassword.length > 128) { sendJson(res, 400, { message: "A valid reset token and a password of at least 6 characters are required" }); return; }
      const rl = await checkRateLimit(`reset:confirm:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000);
      // H2 (audit #4): fail CLOSED — reset confirm is an auth
      // mutation; without the table there is no cap on token
      // guessing, so refuse (503) rather than run unlimited.
      if (rl.tableMissing) {
        sendJson(res, 503, { message: "Password reset is temporarily unavailable. Please try again shortly." });
        return;
      }
      if (!rl.allowed) { sendJson(res, 429, { message: "Too many attempts. Try again later." }, { "Retry-After": String(rl.retryAfter) }); return; }
      const tokenHash = await hashToken(token);
      const { ok, body: rows } = await fetchJson(
        `${supabaseBase()}/rest/v1/password_resets?select=id,data&data->>tokenHash=eq.${encodeURIComponent(tokenHash)}`,
        { headers: supabaseHeaders() },
      );
      if (!ok || !Array.isArray(rows) || rows.length === 0) { sendJson(res, 400, { message: "This reset link is invalid or has expired" }); return; }
      const resetRow = rows[0];
      const d = resetRow.data || {};
      if (d.used || !d.expiresAt || Date.parse(d.expiresAt) < Date.now()) { sendJson(res, 400, { message: "This reset link is invalid or has expired" }); return; }
      const userRow = await loadUserByEmail(d.email);
      if (!userRow || userRow.data?.authProvider !== "local") { sendJson(res, 400, { message: "This reset link is invalid or has expired" }); return; }
      const updated = { ...userRow.data, passwordHash: await hashPassword(newPassword), sessionVersion: typeof userRow.data.sessionVersion === "number" ? userRow.data.sessionVersion + 1 : 1 };
      const up = await fetchJson(`${supabaseBase()}/rest/v1/locora_users?id=eq.${encodeURIComponent(userRow.id)}`, {
        method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: updated }),
      });
      if (!up.ok) { sendJson(res, 500, { message: "Could not reset the password" }); return; }
      // L6 (audit #4): the mark-used write used to be fire-and-forget —
      // a failed PATCH left the reset link live for replay. Verify it
      // happened (one retry); if it still fails, say so honestly
      // instead of claiming full success: the password IS changed, but
      // the link was not retired, so the response is a 500 telling the
      // user to sign in with the new password.
      const markUsed = async () => {
        const m = await fetchJson(`${supabaseBase()}/rest/v1/password_resets?id=eq.${encodeURIComponent(resetRow.id)}`, {
          method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: { ...d, used: true } }),
        });
        return m.ok;
      };
      let retired = await markUsed();
      if (!retired) retired = await markUsed();
      if (!retired) {
        try { console.error("L6: password reset succeeded but the reset link could not be marked used (row " + resetRow.id + ")"); } catch {}
        sendJson(res, 500, { message: "Your password was updated, but the reset link could not be retired. Sign in with your new password." });
        return;
      }
      sendJson(res, 200, { ok: true, message: "Your password has been reset. You can now sign in." });
      return;
    }

    sendJson(res, 400, { message: "Unknown action" });
  } catch {
    sendJson(res, 500, { message: "Password reset failed" });
  }
}

// ---- H1: verify-email + resend-verification ----
async function handleVerifyEmail(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "GET" && req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      if (req.method === "GET") { res.writeHead(302, { Location: `${SITE_URL}/verify-email?status=error` }); res.end(); return; }
      sendJson(res, 503, { message: "Email verification is not configured yet" }); return;
    }
    const isGet = req.method === "GET";
    let token = "";
    if (isGet) {
      try { token = new URL(req.url || "/", "http://localhost").searchParams.get("token") || ""; } catch { token = ""; }
    } else {
      const body = await readBody(req);
      token = String(body.token || "");
    }
    const redirect = (status: string) => { res.writeHead(302, { Location: `${SITE_URL}/verify-email?status=${status}` }); res.end(); };
    const fail = (status: string, message: string) => {
      if (isGet) redirect(status);
      else sendJson(res, 400, { message });
    };
    if (!token) { fail("invalid", "This verification link is invalid or has expired."); return; }
    const rl = await checkRateLimit(`verify:confirm:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000);
    // H2 deliberately leaves verify-email fail-OPEN: this is the H1
    // flow (owned by the H1 agent), not an auth/OTP mutation in the
    // H2 fail-closed set (login/signup/OTP/reset). A missing table
    // only logs; the limit takes effect once the table exists.
    if (rl.tableMissing) {
      try { console.warn("Rate limits unavailable during email verification — proceeding without limits"); } catch {}
    } else if (!rl.allowed) {
      if (isGet) { redirect("too-many"); return; }
      sendJson(res, 429, { message: "Too many attempts. Try again later." }, { "Retry-After": String(rl.retryAfter) }); return;
    }
    const tokenHash = await hashToken(token);
    const { ok, body: rows } = await fetchJson(
      `${supabaseBase()}/rest/v1/locora_users?select=id,data&data->>emailVerificationTokenHash=eq.${encodeURIComponent(tokenHash)}`,
      { headers: supabaseHeaders() },
    );
    if (!ok || !Array.isArray(rows) || rows.length === 0) { fail("invalid", "This verification link is invalid or has expired."); return; }
    const userRow = rows[0];
    const d = userRow.data || {};
    // Single-use: a verified row has its token hash cleared (below), so
    // a reused link finds no row and fails as invalid, above.
    if (d.emailVerified === true) {
      if (isGet) { redirect("verified"); return; }
      sendJson(res, 200, { ok: true, message: "Your email is already verified. You can now sign in." }); return;
    }
    if (!d.emailVerificationExpiresAt || Date.parse(d.emailVerificationExpiresAt) < Date.now()) {
      fail("expired", "This verification link has expired. Request a new one from the sign-in page.");
      return;
    }
    const { emailVerificationTokenHash: _h, emailVerificationExpiresAt: _e, ...rest } = d;
    const updated = { ...rest, emailVerified: true };
    const up = await fetchJson(`${supabaseBase()}/rest/v1/locora_users?id=eq.${encodeURIComponent(userRow.id)}`, {
      method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: updated }),
    });
    if (!up.ok) { fail("error", "Could not verify your email. Try the link again or request a new one."); return; }
    // Deliberately NO auto-sign-in from the link click: the user signs
    // in normally afterwards, with their password.
    if (isGet) { redirect("verified"); return; }
    sendJson(res, 200, { ok: true, message: "Your email has been verified. You can now sign in." });
  } catch {
    sendJson(res, 500, { message: "Email verification failed" });
  }
}

async function handleResendVerification(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) { sendJson(res, 503, { message: "Email verification is not configured yet" }); return; }
    const body = await readBody(req);
    const email = norm(body.email || "");
    if (!isEmail(email)) { sendJson(res, 400, { message: "A valid email is required" }); return; }
    const rlIp = await checkRateLimit(`verify:resend:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000);
    const rlEmail = await checkRateLimit(`verify:resend:email:${email}`, 5, 60 * 60 * 1000);
    // H2 deliberately leaves verification resend fail-OPEN (H1 flow —
    // see the verify:confirm note above, same reason).
    if (rlIp.tableMissing || rlEmail.tableMissing) {
      try { console.warn("Rate limits unavailable during verification resend — proceeding without limits"); } catch {}
    } else if (!rlIp.allowed || !rlEmail.allowed) {
      sendJson(res, 429, { message: "Too many verification requests. Try again later." }, { "Retry-After": String(Math.max(rlIp.retryAfter, rlEmail.retryAfter)) });
      return;
    }
    // Generic by design (no enumeration): the same response whether the
    // email exists or not, whether it is verified already, or whether
    // the mailer is even configured. Only an unverified LOCAL account
    // actually gets a fresh link (regenerating invalidates the old one).
    const generic = { ok: true, message: "If an account exists for that email, a verification link has been sent. It expires in 24 hours." };
    const userRow = await loadUserByEmail(email);
    if (!userRow || !isEmailVerificationRequired(userRow.data)) { sendJson(res, 200, generic); return; }
    try { await sendVerificationEmailForRow(userRow); } catch {}
    sendJson(res, 200, generic);
  } catch {
    sendJson(res, 500, { message: "Could not resend the verification email" });
  }
}

async function handleMe(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "GET" && req.method !== "PATCH") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    const session = await verifySession(req);
    if (!session) { sendJson(res, 401, { message: "Sign in required" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) { sendJson(res, 503, { message: "Profile storage is not configured yet" }); return; }
    const me = session.email;

    if (req.method === "GET") {
      const row = await loadUserByEmail(me);
      sendJson(res, 200, publicProfile(row, me, session.role));
      return;
    }

    // PATCH
    const body = await readBody(req);
    const updates: Record<string, any> = {};
    for (const key of PROFILE_FIELDS) if (body[key] !== undefined) updates[key] = body[key];
    if (typeof updates.bio === "string") updates.bio = updates.bio.slice(0, 1000);
    if (typeof updates.name === "string") updates.name = updates.name.trim().slice(0, 100) || undefined;
    // L7 (audit #4): the remaining free-text profile fields were
    // uncapped — a caller could store megabytes of location/avatar
    // text on the row. Same trim-and-cap pattern as name/bio above.
    if (typeof updates.country === "string") updates.country = updates.country.trim().slice(0, 100);
    if (typeof updates.state === "string") updates.state = updates.state.trim().slice(0, 100);
    if (typeof updates.city === "string") updates.city = updates.city.trim().slice(0, 100);
    if (typeof updates.avatar === "string") updates.avatar = updates.avatar.trim().slice(0, 2000);
    if (typeof updates.phone === "string") {
      const digits = updates.phone.replace(/\D/g, "");
      if (updates.phone && (digits.length < 7 || digits.length > 15)) { sendJson(res, 400, { message: "Mobile number must be 7-15 digits" }); return; }
    }
    // Interests may include custom ones typed by the user on Profile:
    // keep only real strings, trimmed, at most 40 chars each, at most
    // 20 total, de-duplicated case-insensitively. These saved interests
    // are what the event-recommendation emails match against.
    if (updates.interests !== undefined) {
      if (!Array.isArray(updates.interests)) {
        delete updates.interests;
      } else {
        const seen = new Set<string>();
        updates.interests = updates.interests
          .filter((i: any) => typeof i === "string")
          .map((i: string) => i.trim().slice(0, 40))
          .filter((i: string) => {
            if (!i) return false;
            const k = i.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .slice(0, 20);
      }
    }
    const row = await loadUserByEmail(me);
    if (!row) {
      // Google user (or a user created before locora_users existed):
      // create a profile row now, with no password, rather than failing.
      const data: any = { email: me, name: updates.name || "Community Member", role: session.role, authProvider: session.authProvider, profile: updates };
      const created = await fetchJson(`${supabaseBase()}/rest/v1/locora_users`, {
        method: "POST", headers: supabaseHeaders(), body: JSON.stringify({ id: `usr-${Date.now()}`, data }),
      });
      if (!created.ok) { sendJson(res, 500, { message: "Could not save profile" }); return; }
      sendJson(res, 200, publicProfile({ id: created.body?.[0]?.id, data }, me, session.role));
      return;
    }
    const d = row.data || {};
    const profile = { ...(d.profile || {}), ...updates };
    // Changing the number resets verification (same rule as before).
    if (updates.phone !== undefined && updates.phone !== (d.profile?.phone || d.phone || "")) profile.phoneVerified = false;
    const merged = { ...d, profile, name: updates.name || d.name, phone: undefined, bio: undefined };
    delete merged.phone; delete merged.bio;
    const up = await fetchJson(`${supabaseBase()}/rest/v1/locora_users?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: merged }),
    });
    if (!up.ok) { sendJson(res, 500, { message: "Could not save profile" }); return; }
    sendJson(res, 200, publicProfile({ id: row.id, data: merged }, me, session.role));
  } catch {
    sendJson(res, 500, { message: "Profile update failed" });
  }
}


function resolveEndpoint(req: any): string {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const q = url.searchParams.get('endpoint');
    if (q) return q;
    const p = url.pathname || '';
    if (p.endsWith('/auth/login')) return 'login';
    if (p.endsWith('/auth/signup')) return 'signup';
    if (p.endsWith('/auth/logout')) return 'logout';
    if (p.endsWith('/auth/reset')) return 'reset';
    if (p.endsWith('/auth/verify-email')) return 'verify-email';
    if (p.endsWith('/auth/resend-verification')) return 'resend-verification';
    if (p.endsWith('/me')) return 'me';
  } catch {}
  return '';
}

export default async function handler(req: any, res: any): Promise<void> {
  const endpoint = resolveEndpoint(req);
  // L3 (audit #4): a mutation carrying a foreign Origin/Referer is
  // refused (CSRF backstop — see api/_lib/origin-check.ts). GETs are
  // exempt: the verify-email link click carries no Origin.
  if (isMutationMethod(req) && !originAllowed(req)) {
    return sendJson(res, 403, { message: "Request origin not allowed" });
  }
  if (endpoint === 'login') return handleLogin(req, res);
  if (endpoint === 'signup') return handleSignup(req, res);
  if (endpoint === 'logout') return handleLogout(req, res);
  if (endpoint === 'reset') return handleReset(req, res);
  if (endpoint === 'verify-email') return handleVerifyEmail(req, res);
  if (endpoint === 'resend-verification') return handleResendVerification(req, res);
  if (endpoint === 'me') return handleMe(req, res);
  return sendJson(res, 404, { message: 'Unknown auth endpoint' });
}
