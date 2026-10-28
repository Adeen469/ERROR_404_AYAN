import { createHmac, timingSafeEqual, scryptSync, randomBytes, createHash } from "crypto";
// Shared server helpers for Locora security fix (Phase 1 Finding 1+).
// Used by api/registrations.ts, api/events.ts, api/messages.ts,
// api/auth/* and api/me.ts. No secrets are hardcoded here: SESSION_SECRET,
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come only from Vercel env vars.
// If SESSION_SECRET is missing, session verification fails closed (null)
// and login/signup/Google callback must refuse to issue a session.

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

// POST /api/notify — account emails: welcome + new sign-in alerts.
//
//   POST /api/notify { action: "welcome", email, name? }
//     -> welcome email, sent at most ONCE per email address, ever.
//   POST /api/notify { action: "login", email }
//     -> "new sign-in" email with device + location, at most 5 per
//        email per hour.
//
// Callers (the app after a local sign-in/sign-up, and the Google
// callback page after a Google sign-in) fire this and ignore failures:
// account emails must never break sign-in or sign-up, so this always
// answers 200 JSON { mailed: boolean, reason?: string } for a
// well-formed request, and only 400/405 for a malformed one.
//
// SECURITY FIX (production hardening): this endpoint is now SESSION-
// GATED. A valid locora_session cookie is required, and body.email
// must equal the session email, otherwise 401 — an unauthenticated
// caller can no longer trigger mail to any address. The caps above
// (enforced in Supabase) still apply, and every template is fixed
// (the only caller-controlled text is the display name, HTML-escaped
// and length-limited). Without the email_log table this fails CLOSED:
// no mail is sent, so a missing table can never become an open relay.
// Callers (fire-and-forget, failures ignored, so a 401 never breaks
// sign-in): src/services/auth-service.ts after a local sign-in/sign-up
// (cookie already set by /api/auth/login or /api/auth/signup), and the
// Google callback page after a Google sign-in (cookie set by the
// callback response before its script runs).
//
// Location is best-effort: the sign-in IP is looked up via ip-api
// (server-side, 3s timeout, private IPs skipped). If the lookup fails,
// the email says "Unknown location" rather than guessing.
//
// This is a Vercel Serverless Function, self-contained (no imports
// from api/_lib), following the same shape as api/registrations.ts.
// Sending uses Gmail SMTP via nodemailer, dynamically imported only
// when a send actually happens, gated on GMAIL_USER / GMAIL_APP_PASSWORD.





function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


function cleanName(name: string): string {
  return (name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 100);
}

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

function secondaryButton(label: string, href: string): string {
  return `<a href="${href}" style="display:inline-block;background:#ffffff;color:#1E3F35;border:1px solid #1E3F35;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px;">${label}</a>`;
}





// Best-effort "Browser on OS" from a User-Agent string. Unknown agents
// stay "Unknown device" rather than a guessed value.
export function parseDevice(ua: string): string {
  const u = ua || "";
  let browser = "Unknown browser";
  if (/Edg\//.test(u)) browser = "Edge";
  else if (/OPR\//.test(u)) browser = "Opera";
  else if (/SamsungBrowser\//.test(u)) browser = "Samsung Internet";
  else if (/CriOS/.test(u)) browser = "Chrome (iOS)";
  else if (/FxiOS/.test(u)) browser = "Firefox (iOS)";
  else if (/Chrome\//.test(u)) browser = "Chrome";
  else if (/Firefox\//.test(u)) browser = "Firefox";
  else if (/Safari\//.test(u) && /Version\//.test(u)) browser = "Safari";
  let os = "Unknown device";
  if (/Windows NT/.test(u)) os = "Windows";
  else if (/Android/.test(u)) os = "Android";
  else if (/iPhone|iPad/.test(u)) os = "iOS";
  else if (/Mac OS X/.test(u)) os = "macOS";
  else if (/Linux/.test(u)) os = "Linux";
  if (browser === "Unknown browser" && os === "Unknown device") return "Unknown device";
  return `${browser} on ${os}`;
}

async function getLocation(ip: string): Promise<string> {
  if (!ip) return "";
  if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80:)/.test(ip)) return "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!res.ok) return "";
    const body: any = await res.json();
    if (body?.status !== "success") return "";
    return [body.city, body.regionName, body.country].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}

function istNow(): string {
  try {
    return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date().toISOString();
  }
}

export function buildWelcomeEmail(name: string, email: string): { to: string; subject: string; text: string; html: string } {
  const display = esc(cleanName(name) || "there");
  const text = [
    `Hi ${cleanName(name) || "there"},`,
    `Welcome to Locora! Your account (${email}) is ready.`,
    `Discover events near you: https://locora-hyperlocal.vercel.app/discover`,
  ].join("\n\n");
  const html = emailLayout(
    "Welcome to Locora",
    bodyText(`Hi ${display},`) +
      bodyText(`Welcome to Locora! Your account (${esc(email)}) is ready.`) +
      primaryButton("Discover events near you", `${SITE_URL}/discover`),
  );
  return { to: email, subject: "Welcome to Locora", text, html };
}

export function buildLoginEmail(email: string, device: string, location: string, ip: string): { to: string; subject: string; text: string; html: string } {
  const when = `${istNow()} (IST)`;
  const loc = location || "Unknown location";
  const lines = [
    `There was a new sign-in to your Locora account (${email}).`,
    `When: ${when}`,
    `Device: ${device}`,
    `Location: ${loc}`,
    ip ? `IP address: ${ip}` : "",
    `If this wasn't you, change your password right away.`,
    `Secure your account:`,
    `Change your password: ${SITE_URL}/forgot-password`,
    `Sign out: ${SITE_URL}/logout`,
    `The sign-out link signs out the device that opens it.`,
  ].filter(Boolean);
  const text = lines.join("\n\n");
  const html = emailLayout(
    "New sign-in to your account",
    bodyText(`There was a new sign-in to your Locora account (${esc(email)}).`) +
      detailRow("When", esc(when)) +
      detailRow("Device", esc(device)) +
      detailRow("Location", esc(loc)) +
      (ip ? detailRow("IP address", esc(ip)) : "") +
      `<div style="background:#FAF8F5;border:1px solid #E7E3DB;border-radius:12px;padding:14px 16px;margin-top:16px;font-size:15px;line-height:1.6;color:#1E2320;font-weight:600;">If this wasn't you, change your password right away.</div>` +
      `<h2 style="font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.3;color:#1E3F35;margin:24px 0 12px;">Secure your account</h2>` +
      primaryButton("Change your password", `${SITE_URL}/forgot-password`) +
      `<p style="margin:12px 0 0;">${secondaryButton("Sign out", `${SITE_URL}/logout`)}</p>` +
      `<p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#5F635D;">The sign-out link signs out the device that opens it.</p>`,
  );
  return { to: email, subject: "New sign-in to your Locora account", text, html };
}

async function sendMail(mail: { to: string; subject: string; text: string; html: string } | null): Promise<boolean> {
  const user = getEnv("GMAIL_USER");
  const pass = getEnv("GMAIL_APP_PASSWORD");
  if (!user || !pass || !mail) return false;
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: pass.replace(/\s+/g, "") },
    });
    await transporter.sendMail({ from: user, ...mail });
    return true;
  } catch (err) {
    console.warn("Account email failed:", err);
    return false;
  }
}

// email_log lookups. Returns null when the table cannot be read
// (missing table, bad response), which the handler treats as
// fail-closed: no mail without a working cap check.
async function hasWelcome(email: string): Promise<boolean | null> {
  const url =
    `${supabaseBase()}/rest/v1/email_log?select=created_at` +
    `&email=eq.${encodeURIComponent(email)}&kind=eq.welcome&limit=1`;
  const { ok, body } = await fetchJson(url, { headers: supabaseHeaders() });
  if (!ok || !Array.isArray(body)) return null;
  return body.length > 0;
}

async function loginCountLastHour(email: string): Promise<number | null> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const url =
    `${supabaseBase()}/rest/v1/email_log?select=created_at` +
    `&email=eq.${encodeURIComponent(email)}&kind=eq.login&created_at=gte.${encodeURIComponent(since)}`;
  const { ok, body } = await fetchJson(url, { headers: supabaseHeaders() });
  if (!ok || !Array.isArray(body)) return null;
  return body.length;
}

async function logSend(email: string, kind: string): Promise<void> {
  try {
    await fetchJson(`${supabaseBase()}/rest/v1/email_log`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ email, kind }),
    });
  } catch {
    // A missed log row only risks a duplicate mail later, never a
    // failed sign-in; the caller already succeeded.
  }
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "POST only" });
      return;
    }
    const session = await verifySession(req);
    if (!session) {
      sendJson(res, 401, { message: "Sign in required" });
      return;
    }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, { message: "Shared email log is not configured. See ACCOUNT_EMAILS_SETUP.md." });
      return;
    }
    const body = await readBody(req);
    const action = body?.action;
    const email = norm(body?.email || "");
    if ((action !== "welcome" && action !== "login") || !validEmail(email)) {
      sendJson(res, 400, { message: "Pass action 'welcome' or 'login' and a valid email." });
      return;
    }
    if (email !== session.email) {
      sendJson(res, 401, { message: "Sign in required" });
      return;
    }

    if (action === "welcome") {
      const already = await hasWelcome(email);
      if (already === null) {
        sendJson(res, 200, { mailed: false, reason: "email-log-unavailable" });
        return;
      }
      if (already) {
        sendJson(res, 200, { mailed: false, reason: "already-welcomed" });
        return;
      }
      const sent = await sendMail(buildWelcomeEmail(body?.name || "", email));
      if (sent) await logSend(email, "welcome");
      sendJson(res, 200, { mailed: sent, reason: sent ? undefined : "not-configured" });
      return;
    }

    // action === "login"
    const count = await loginCountLastHour(email);
    if (count === null) {
      sendJson(res, 200, { mailed: false, reason: "email-log-unavailable" });
      return;
    }
    if (count >= 5) {
      sendJson(res, 200, { mailed: false, reason: "rate-limited" });
      return;
    }
    const forwarded = req.headers?.["x-forwarded-for"] || req.headers?.["X-Forwarded-For"] || "";
    const ip = String(forwarded).split(",")[0].trim();
    const ua = req.headers?.["user-agent"] || req.headers?.["User-Agent"] || "";
    const device = parseDevice(String(ua));
    const location = await getLocation(ip);
    const sent = await sendMail(buildLoginEmail(email, device, location, ip));
    if (sent) await logSend(email, "login");
    sendJson(res, 200, { mailed: sent, reason: sent ? undefined : "not-configured" });
    return;
  } catch (err) {
    console.warn("notify handler failed:", err);
    sendJson(res, 200, { mailed: false, reason: "error" });
  }
}
