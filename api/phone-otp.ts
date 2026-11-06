// SMS OTP phone verification via Fast2SMS — replaces the old Telegram
// contact-share flow (api/telegram-verify.ts, removed).
//
// Flow:
//   1. The Locora profile page calls POST { action: "send", email, phone }.
//      A 6-digit OTP is generated here, only its SHA-256 hash is stored
//      (Supabase phone_verifications table, status "pending_otp", 10-min
//      expiry), and the code itself is delivered by Fast2SMS
//      (route "otp" — Fast2SMS's pre-approved OTP template, so no DLT
//      template of our own is needed to start; see FAST2SMS_OTP_SETUP.md).
//   2. The user types the code; the page calls
//      POST { action: "verify", token, otp }. On a hash match (constant-
//      time compare, max 5 attempts) the row becomes "verified".
//   3. Verified rows are the attestation record: api/registrations.ts
//      server-checks them (email + phone digits, status "verified")
//      before stamping a registration's phoneVerified badge — unchanged
//      from the Telegram flow, so no changes were needed there.
//
// Security notes:
//   - "send" and "verify" require a valid Locora session whose email
//     matches the verification row (same audit fix the Telegram flow
//     had: previously anyone could mint tokens for any address).
//   - The OTP itself is never stored or logged — only its hash, bound
//     to the row token and phone so a hash cannot be replayed against
//     another number.
//   - Sends are rate-limited per email and per phone (rate_limits
//     table, shared helper pattern with the other api/ handlers).
//
// Env (Vercel Production): FAST2SMS_API_KEY (Sensitive, server-only —
// never VITE_-prefixed), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SESSION_SECRET.
// Table: phone_verifications (token text pk, data jsonb, created_at) —
// the same table the Telegram flow used; verified rows keep the same
// { email, phone, status: "verified", verifiedAt } shape.

// H2 (audit #4): the ONLY static import in this file — the shared
// rate-limit module (api/_lib/rate-limit.ts). See its header for the
// live _lib-import risk + the live-test step after deploy.
import { checkRateLimit } from "./_lib/rate-limit";
import { originAllowed } from "./_lib/origin-check";

function getEnv(name: string): string {
  try {
    const v = (process as any)?.env?.[name];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

function sendJson(res: any, status: number, obj: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
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
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

// ---- Session verification (same scheme as api/telegram-verify.ts) ----
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

// L6 (audit #4): the stored OTP hash was an unsalted SHA-256 of
// `token:phone:otp` — a leaked phone_verifications row could be
// brute-forced offline (6 digits). It is now an HMAC-SHA256 keyed by
// SESSION_SECRET (the same server secret that signs sessions), so the
// row alone is useless without the secret. NOTE: rows stored before
// this change carry the old hash and fail verification — the user
// just sends a fresh code (codes live 10 minutes anyway).
async function otpHashFor(token: string, ten: string, otp: string): Promise<string> {
  const secret = getEnv("SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return hmacB64url(secret, `otp:${token}:${ten}:${otp}`);
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
    return { email };
  } catch {
    return null;
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

// Sweep G (audit #4 final sweep): targeted lookups. send/verify/
// status used to load the WHOLE phone_verifications table on every
// call and find the row in memory. Rows are keyed by the token
// column (verify/status — token is the table's primary key) or by
// data->>email (send — covered by idx_phone_verifications_email in
// db-indexes.sql). Either helper falls back to the full read if the
// filtered query is ever rejected, and still throws when the table
// itself is missing, so the callers' 503 paths are unchanged.
async function loadRowByToken(token: string): Promise<any | null> {
  try {
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/${TABLE}?token=eq.${encodeURIComponent(token)}&select=token,data`,
      { headers: supabaseHeaders() },
    );
    if (!ok) throw new Error("filtered phone_verifications read failed");
    if (!Array.isArray(body) || body.length === 0) return null;
    const row = body[0];
    return { token: row.token, ...(row.data || {}) };
  } catch {
    const rows = await loadRows();
    return rows.find((r) => r.token === token) || null;
  }
}

async function loadRowsByEmail(email: string): Promise<any[]> {
  try {
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/${TABLE}?select=token,data&data->>email=eq.${encodeURIComponent(email)}`,
      { headers: supabaseHeaders() },
    );
    if (!ok) throw new Error("filtered phone_verifications read failed");
    if (!Array.isArray(body)) return [];
    return body.map((row: any) => ({ token: row.token, ...(row.data || {}) }));
  } catch {
    return loadRows();
  }
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
  const rest = { ...(data || {}) };
  delete rest.token;
  await fetchJson(
    `${supabaseBase()}/rest/v1/${TABLE}?token=eq.${encodeURIComponent(token)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({ data: rest }),
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

// Fast2SMS sends to Indian numbers as bare 10 digits. Accepts the
// profile's stored forms: "9876543210", "+91 98765 43210",
// "919876543210", "09876543210". Returns null for anything else.
function indianTenDigits(phone: string): string | null {
  let d = digits(phone);
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) return d;
  return null;
}

function isExpired(row: any): boolean {
  const t = Date.parse(row.createdAt || "");
  if (Number.isNaN(t)) return true;
  return Date.now() - t > OTP_TTL_MS;
}

function generateOtp(): string {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === "function") {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return String(100000 + (buf[0] % 900000));
  }
  return String(100000 + Math.floor(Math.random() * 900000));
}

function generateToken(): string {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().replace(/-/g, "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

// Delivers the OTP through Fast2SMS's bulkV2 API on the "otp" route,
// which uses Fast2SMS's own pre-approved OTP template — the variable
// value is our code. Throws with the gateway's message on failure.
async function sendFast2SmsOtp(tenDigits: string, otp: string): Promise<void> {
  const apiKey = getEnv("FAST2SMS_API_KEY");
  const { ok, body } = await fetchJson("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      route: "otp",
      variables_values: otp,
      numbers: tenDigits,
      flash: 0,
    }),
  });
  if (!ok || !body || body.return !== true) {
    const msg = Array.isArray(body?.message)
      ? body.message.join(", ")
      : typeof body?.message === "string"
        ? body.message
        : "SMS gateway rejected the request";
    throw new Error(msg);
  }
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "Method not allowed" });
      return;
    }
    // L3 (audit #4): mutations from another site are refused — see
    // api/_lib/origin-check.ts.
    if (!originAllowed(req)) {
      sendJson(res, 403, { message: "Request origin not allowed" });
      return;
    }
    const body = await readBody(req);

    if (!supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, { message: "Verification is not set up yet" });
      return;
    }

    if (body.action === "send") {
      const session = await verifySession(req);
      if (!session) {
        sendJson(res, 401, { message: "Sign in required" });
        return;
      }
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const phone = typeof body.phone === "string" ? body.phone.trim() : "";
      if (!isEmail(email)) {
        sendJson(res, 400, { message: "A valid email is required" });
        return;
      }
      if (norm(email) !== session.email) {
        sendJson(res, 403, { message: "You can only verify your own number" });
        return;
      }
      const ten = indianTenDigits(phone);
      if (!ten) {
        sendJson(res, 400, { message: "Enter a valid Indian mobile number (10 digits)" });
        return;
      }
      if (!getEnv("FAST2SMS_API_KEY")) {
        // L5 (audit #4): no gateway internals in the user-facing message.
        sendJson(res, 503, { message: "SMS verification is not set up yet" });
        return;
      }
      // H2 (audit #4): fail CLOSED — OTP send is an auth mutation;
      // without the rate_limits table there is no send cap, so refuse
      // (503) rather than send unlimited SMS. GETs stay fail-open.
      const rlEmail = await checkRateLimit(`phoneotp:send:${session.email}`, 5, 60 * 60 * 1000);
      if (rlEmail.tableMissing) {
        sendJson(res, 503, { message: "SMS verification is temporarily unavailable. Please try again shortly." });
        return;
      }
      if (!rlEmail.allowed) {
        sendJson(res, 429, { message: "Too many OTP requests. Try again later." });
        return;
      }
      const rlPhone = await checkRateLimit(`phoneotp:send:phone:${ten}`, 5, 60 * 60 * 1000);
      if (rlPhone.tableMissing) {
        sendJson(res, 503, { message: "SMS verification is temporarily unavailable. Please try again shortly." });
        return;
      }
      if (!rlPhone.allowed) {
        sendJson(res, 429, { message: "Too many OTP requests for this number. Try again later." });
        return;
      }
      let rows: any[];
      try {
        rows = await loadRowsByEmail(email);
      } catch {
        sendJson(res, 503, {
          message: "Verification is temporarily unavailable. Please try again shortly.",
        });
        return;
      }
      // One live OTP per email: drop earlier pending ones first.
      for (const r of rows) {
        if (r.email === email && r.status === "pending_otp") {
          try {
            await deleteRow(r.token);
          } catch {
            // Best-effort; the new OTP still works.
          }
        }
      }
      const token = generateToken();
      const otp = generateOtp();
      const otpHash = await otpHashFor(token, ten, otp);
      try {
        await insertRow(token, {
          email,
          phone,
          status: "pending_otp",
          otpHash,
          attempts: 0,
          createdAt: new Date().toISOString(),
        });
      } catch {
        sendJson(res, 503, {
          message: "Verification is temporarily unavailable. Please try again shortly.",
        });
        return;
      }
      try {
        await sendFast2SmsOtp(ten, otp);
      } catch (err) {
        // No live row for a code that never went out.
        try {
          await deleteRow(token);
        } catch {}
        // Sweep G: the gateway error text used to be returned to the
        // user ("Could not send the SMS: <gateway detail>") — it
        // stays in server logs now.
        try { console.warn("Fast2SMS send failed:", err instanceof Error ? err.message : err); } catch {}
        sendJson(res, 502, {
          message: "Could not send the SMS. Please try again shortly.",
        });
        return;
      }
      sendJson(res, 200, { token, expiresInSec: Math.floor(OTP_TTL_MS / 1000) });
      return;
    }

    if (body.action === "verify") {
      const session = await verifySession(req);
      if (!session) {
        sendJson(res, 401, { message: "Sign in required" });
        return;
      }
      const token = typeof body.token === "string" ? body.token.trim() : "";
      const otp = typeof body.otp === "string" ? body.otp.trim() : "";
      if (!token || !/^\d{6}$/.test(otp)) {
        sendJson(res, 400, { message: "Enter the 6-digit code" });
        return;
      }
      // H2 (audit #4): NEW limit — verify previously had no
      // rate-limit call at all (only the per-token 5-attempt cap
      // below). 20/hour per email mirrors the confirm-style 20/hour
      // used by reset:confirm / verify:confirm in api/auth.ts.
      // Fail CLOSED (503) when the rate_limits table is missing.
      const rlVerify = await checkRateLimit(`phoneotp:verify:${session.email}`, 20, 60 * 60 * 1000);
      if (rlVerify.tableMissing) {
        sendJson(res, 503, { message: "SMS verification is temporarily unavailable. Please try again shortly." });
        return;
      }
      if (!rlVerify.allowed) {
        sendJson(res, 429, { message: "Too many verification attempts. Try again later." });
        return;
      }
      let row: any | null;
      try {
        row = await loadRowByToken(token);
      } catch {
        sendJson(res, 503, {
          message: "Verification is temporarily unavailable. Please try again shortly.",
        });
        return;
      }
      if (!row) {
        sendJson(res, 400, { message: "This code request is no longer valid. Send a new OTP." });
        return;
      }
      if (norm(row.email || "") !== session.email) {
        sendJson(res, 403, { message: "You can only verify your own number" });
        return;
      }
      if (row.status === "verified") {
        sendJson(res, 200, { status: "verified" });
        return;
      }
      if (row.status !== "pending_otp") {
        sendJson(res, 400, { message: "This code request is no longer valid. Send a new OTP." });
        return;
      }
      if (isExpired(row)) {
        try {
          await updateRow(row.token, { ...row, status: "expired", otpHash: "" });
        } catch {
          // Best-effort.
        }
        sendJson(res, 400, { message: "This OTP expired (codes last 10 minutes). Send a new one." });
        return;
      }
      const attempts = typeof row.attempts === "number" ? row.attempts : 0;
      if (attempts >= MAX_OTP_ATTEMPTS) {
        sendJson(res, 400, { message: "Too many wrong attempts. Send a new OTP." });
        return;
      }
      const ten = indianTenDigits(row.phone || "") || digits(row.phone || "");
      const candidate = await otpHashFor(token, ten, otp);
      if (!row.otpHash || !ctEqual(candidate, row.otpHash)) {
        const nextAttempts = attempts + 1;
        const locked = nextAttempts >= MAX_OTP_ATTEMPTS;
        try {
          await updateRow(row.token, {
            ...row,
            attempts: nextAttempts,
            ...(locked ? { status: "locked", otpHash: "" } : {}),
          });
        } catch {
          // Best-effort; the response below still refuses.
        }
        sendJson(res, 400, {
          message: locked
            ? "Too many wrong attempts. Send a new OTP."
            : `Incorrect OTP. ${MAX_OTP_ATTEMPTS - nextAttempts} attempt${MAX_OTP_ATTEMPTS - nextAttempts === 1 ? "" : "s"} left.`,
        });
        return;
      }
      await updateRow(row.token, {
        ...row,
        status: "verified",
        verifiedAt: new Date().toISOString(),
        otpHash: "",
      });
      sendJson(res, 200, { status: "verified" });
      return;
    }

    if (body.action === "status") {
      // M17: status is not public — it needs a valid session, and the
      // row's email must be the session email. A token belonging to
      // another account is refused 403, same as send/verify.
      const session = await verifySession(req);
      if (!session) {
        sendJson(res, 401, { message: "Sign in required" });
        return;
      }
      // Sweep G: status is a POST that can flip an expired row, and
      // it previously had no rate limit while send/verify did.
      // Fail-open per session (the client calls it once on mount to
      // resume an OTP); 60/10min matches msg:patch.
      const rlStatus = await checkRateLimit(`phoneotp:status:${session.email}`, 60, 10 * 60 * 1000);
      if (!rlStatus.allowed && !rlStatus.tableMissing) {
        sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rlStatus.retryAfter) });
        return;
      }
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token) {
        sendJson(res, 400, { message: "Token required" });
        return;
      }
      let row: any | null;
      try {
        row = await loadRowByToken(token);
      } catch {
        sendJson(res, 503, {
          message: "Verification is temporarily unavailable. Please try again shortly.",
        });
        return;
      }
      if (!row) {
        sendJson(res, 200, { status: "not_found" });
        return;
      }
      if (norm(row.email || "") !== session.email) {
        sendJson(res, 403, { message: "You can only check your own verification status" });
        return;
      }
      if (row.status === "verified") {
        sendJson(res, 200, { status: "verified" });
        return;
      }
      if (row.status === "pending_otp") {
        if (isExpired(row)) {
          try {
            await updateRow(row.token, { ...row, status: "expired", otpHash: "" });
          } catch {
            // Best-effort.
          }
          sendJson(res, 200, { status: "expired" });
          return;
        }
        sendJson(res, 200, { status: "pending" });
        return;
      }
      sendJson(res, 200, { status: "expired" });
      return;
    }

    sendJson(res, 400, { message: "Unknown request" });
  } catch (err) {
    try { console.error("Phone OTP failed:", err instanceof Error ? err.message : err); } catch {}
    sendJson(res, 500, { message: "Verification failed" });
  }
}
