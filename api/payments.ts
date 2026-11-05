// Locora Razorpay Standard Checkout — NO IMPORTS, NO node:crypto, NO SDK.
// This file is self-contained like every other api/*.ts in this project
// (relative imports and the node:crypto import have both failed live with
// FUNCTION_INVOCATION_FAILED; the import-free pattern works). Razorpay is
// called over its plain REST API with fetch, so no `razorpay` npm package
// is needed and nothing is added to package.json.
//
// Routes (see vercel.json rewrites; the frontend calls these URLs):
//   POST /api/create-order   -> /api/payments?action=create-order
//   POST /api/verify-payment -> /api/payments?action=verify-payment
// One function file keeps the Vercel Hobby 12-function limit safe
// (the project is at 9 functions; this makes 10).
//
// Security model — read this before changing anything:
// - The amount NEVER comes from the browser. create-order takes only a
//   registrationId, loads the stored event, and prices the order from
//   the event's stored price. A caller who pays less for an expensive
//   event can never confirm it, because verify checks the captured
//   amount against the stored price.
// - A payment is only ever tied to one registration: the Razorpay order
//   is created with receipt = registrationId, and verify requires the
//   stored razorpayOrderId on that registration to equal the order being
//   verified. Cross-registration verification is refused.
// - AUTH (audit fix): both actions require a valid locora_session and
//   only the registration's owner may call them. Previously neither
//   endpoint verified a session at all, and registration ids were
//   predictable (reg-<timestamp>), so anyone could probe a victim's
//   pending row, reuse its already-paid order, and take its ticket code
//   through the recovery path without paying. Owner checks return 404
//   (not 403) so a stranger cannot even tell whether an id exists.
// - The browser checkout success callback alone never issues a pass.
//   verify requires either (a) a valid HMAC-SHA256 signature
//   (order_id + "|" + payment_id, keyed with RAZORPAY_KEY_SECRET, via
//   WebCrypto), or (b) a server-side recovery fetch: the order's payment
//   list from Razorpay itself, showing a captured payment. Both paths
//   then fetch the payment from Razorpay (secret-authenticated) and
//   check status === 'captured', order_id, and amount.
// - The amount truth is the Razorpay ORDER, not the live event price:
//   verify compares the captured amount against the order's own amount
//   (and against the amountPaise snapshot stored on the registration at
//   order creation, when one exists). An organizer editing the event
//   price after an order exists can no longer orphan a captured payment.
// - Idempotent: confirming an already-confirmed registration with the
//   same payment returns success without reissuing a ticket or bumping
//   the event count twice. Confirmation itself is compare-and-swap
//   (the row must still be pending at write time), so two parallel
//   verifies cannot issue two different ticket codes for one pass.
// - Secrets come only from Vercel env vars: RAZORPAY_KEY_ID (public,
//   returned to the browser with the order so no VITE_ build var is
//   needed) and RAZORPAY_KEY_SECRET (server only, never returned, never
//   in the repo). If either is missing, both endpoints fail closed 503.
// - Manual UPI/UTR payments are untouched: this adds a Razorpay path
//   alongside them. A Razorpay pending registration never triggers the
//   organizer-approval emails (see api/registrations.ts).

export function getEnv(name: string): string {
  try {
    const env = (globalThis as any).process?.env;
    return (env && env[name]) || "";
  } catch {
    return "";
  }
}

export function sendJson(res: any, status: number, obj: any): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

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

function esc(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Ticket codes were LOC-<1000..9999>-TK via Math.random: only 9,000
// values, so collisions across events were a matter of time, and the
// client generated its own codes too. Now: 6 crypto-random characters
// (no lookalikes), server-generated only, ~2 billion values.
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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// HMAC-SHA256 via WebCrypto. Returns lowercase hex.
async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto unavailable");
  const cryptoKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return bytesToHex(new Uint8Array(sig));
}

function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

// Client IP for rate limiting. The FIRST x-forwarded-for entry is
// client-controlled (an attacker can spoof it and rotate it to dodge
// per-IP limits); Vercel appends the real connecting IP last, so the
// LAST entry is the trustworthy one. Single-entry headers are unaffected.
function getClientIp(req: any): string {
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

async function loadUserByEmail(email: string): Promise<{ id: string; data: any } | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/locora_users?select=id,data&data->>email=eq.${encodeURIComponent(norm(email))}`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0];
}

// Same session verification as api/events.ts / api/auth.ts (HMAC
// locora_session cookie, expiry, revocation list, sessionVersion).
// Returns null on any failure — callers treat null as unauthenticated.
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
    } catch {
      // Fail closed: a Supabase error must not revive a revoked token.
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
      // Fail closed: without the version check, a token invalidated by
      // "sign out everywhere" or a password reset would be accepted
      // again during a Supabase outage.
      return null;
    }
    return { email };
  } catch {
    return null;
  }
}

// Supabase-backed rate limit (table rate_limits). If the table is
// missing, allow rather than bricking payments — the limit takes
// effect once the table exists (see SECURITY_FIX_SETUP.md).
async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfter: number; tableMissing: boolean }> {
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
    await fetchJson(`${supabaseBase()}/rest/v1/rate_limits`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ id: key, data: next }),
    });
    return { allowed: true, retryAfter: 0, tableMissing: false };
  } catch {
    return { allowed: true, retryAfter: 0, tableMissing: false };
  }
}

// Fail closed on mutations when the limiter is unavailable: a missing
// rate_limits table must never silently disable abuse protection on
// payments. Returns true when a response was already sent.
function limited(res: any, rl: { allowed: boolean; retryAfter: number; tableMissing: boolean }, message: string): boolean {
  if (rl.allowed) return false;
  if (rl.tableMissing) {
    sendJson(res, 503, { message: "Rate limiting is not configured. Please ask the admin to run the rate_limits setup SQL." });
  } else {
    sendJson(res, 429, { message }, { "Retry-After": String(rl.retryAfter) });
  }
  return true;
}

// Full refund of a captured Razorpay payment. Used when a payment was
// captured but no pass can be issued (event full, event cancelled or
// ended): money must not sit captured with nothing to show for it.
async function refundRazorpayPayment(paymentId: string): Promise<{ ok: boolean; refundId?: string }> {
  try {
    const res = await fetchJson(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      headers: { Authorization: razorpayAuthHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok && res.body?.id) return { ok: true, refundId: res.body.id };
    // Re-check before reporting failure: a parallel refund (or a
    // response lost to a timeout) may already have moved the money.
    try {
      const pay = await fetchJson(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: razorpayAuthHeader() },
      });
      if (pay.ok && Number(pay.body?.amount_refunded || 0) > 0) {
        const list = await fetchJson(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
          headers: { Authorization: razorpayAuthHeader() },
        });
        const first = Array.isArray(list.body?.items) ? list.body.items[0] : null;
        return { ok: true, refundId: first?.id };
      }
    } catch { /* fall through to failure */ }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// True when an order has a captured payment that has NOT been (fully)
// refunded — i.e. the order can still be recovered via verify. Used by
// create-order so a fully-refunded order does not brick re-payment.
async function hasUsableCapturedPayment(orderId: string): Promise<boolean> {
  try {
    const list = await fetchJson(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`, {
      headers: { Authorization: razorpayAuthHeader() },
    });
    if (!list.ok || !Array.isArray(list.body?.items)) return true; // cannot tell — do not brick the flow; verify is authoritative
    return list.body.items.some((pay: any) => pay && pay.status === "captured" && Number(pay.amount_refunded || 0) < Number(pay.amount || 0));
  } catch {
    return true;
  }
}

function razorpayAuthHeader(): string {
  const keyId = getEnv("RAZORPAY_KEY_ID");
  const secret = getEnv("RAZORPAY_KEY_SECRET");
  const raw = `${keyId}:${secret}`;
  try {
    return `Basic ${(globalThis as any).btoa(raw)}`;
  } catch {
    const Buf = (globalThis as any).Buffer;
    if (Buf) return `Basic ${Buf.from(raw, "utf-8").toString("base64")}`;
    throw new Error("Base64 unavailable");
  }
}

async function loadRegistration(id: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/registrations?id=eq.${encodeURIComponent(id)}&select=data`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data || null;
}

async function loadEvent(id: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/events?id=eq.${encodeURIComponent(id)}&select=data`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data || null;
}

async function saveRegistration(reg: any): Promise<boolean> {
  const { ok } = await fetchJson(
    `${supabaseBase()}/rest/v1/registrations?id=eq.${encodeURIComponent(reg.id)}`,
    { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: reg }) },
  );
  return ok;
}

// Compare-and-swap save: applies ONLY if the row is still pending at
// write time. Two parallel verifies of one payment: the first wins,
// the second sees an empty result and must take the idempotent path
// instead of minting a second ticket code. If this PostgREST version
// rejects the jsonb filter, the caller falls back to a re-read +
// plain save (see handleVerifyPayment) rather than failing the payment.
async function saveRegistrationIfPending(reg: any): Promise<boolean> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/registrations?id=eq.${encodeURIComponent(reg.id)}&data->>status=eq.pending`,
    { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: reg }) },
  );
  return ok && Array.isArray(body) && body.length > 0;
}

// Registrations carrying a given payment/order id (targeted jsonb
// reads, used by the payment-uniqueness check and the webhook).
async function loadRegistrationsByPaymentId(paymentId: string): Promise<any[]> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/registrations?select=id,data&data->>razorpayPaymentId=eq.${encodeURIComponent(paymentId)}&limit=5`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body)) return [];
  return body.map((row: any) => row.data).filter(Boolean);
}

async function loadRegistrationByOrderId(orderId: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/registrations?select=id,data&data->>razorpayOrderId=eq.${encodeURIComponent(orderId)}&limit=1`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data || null;
}

// Refund a captured payment and cancel its pending row (dead/full
// event, or a lost capacity race). The cancel write is
// compare-and-swap on the pending state, so it can never clobber a
// row a parallel verify just confirmed — the old plain save could.
async function refundAndCancel(reg: any, captured: any, orderId: string): Promise<{ refunded: boolean; cancelled: boolean }> {
  const rf = await refundRazorpayPayment(captured.id);
  if (!rf.ok) return { refunded: false, cancelled: false };
  const cancelled = await saveRegistrationIfPending({
    ...reg,
    status: "cancelled",
    refundStatus: "initiated",
    refundId: rf.refundId,
    razorpayPaymentId: captured.id,
    razorpayOrderId: orderId,
    amountPaise: captured.amount,
    currency: "INR",
  });
  if (!cancelled) {
    try { console.warn("refundAndCancel: payment refunded but the row was already confirmed (parallel verify won); pass kept, money returned"); } catch {}
  }
  return { refunded: true, cancelled };
}

async function bumpEventCount(eventId: string, delta: number): Promise<boolean> {
  // Atomic path first: the adjust_event_count RPC (see
  // SUPABASE_RPC_SETUP.md) increments only when a seat is actually
  // free and never lets the count pass capacity, in one statement —
  // the only real cure for last-seat races. Returns whether the count
  // actually moved, so callers can gate a confirmation on a real seat
  // reservation. Until that function is created in Supabase, fall back
  // to a capped read-modify-write: the count can never exceed capacity
  // or drop below zero, though a perfectly simultaneous pair of
  // confirms can still oversell by one pass in that fallback mode.
  try {
    const rpc = await fetchJson(`${supabaseBase()}/rest/v1/rpc/adjust_event_count`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ p_event_id: eventId, p_delta: delta }),
    });
    if (rpc.ok) return rpc.body === true;
  } catch { /* fall through to capped bump */ }
  const event = await loadEvent(eventId);
  if (!event) return false;
  const capacity = Number(event.capacity || 0);
  const cap = capacity > 0 ? capacity : Number.MAX_SAFE_INTEGER;
  const next = Math.min(cap, Math.max(0, Number(event.registeredCount || 0) + delta));
  if (next === Number(event.registeredCount || 0)) return false;
  const patched = await fetchJson(
    `${supabaseBase()}/rest/v1/events?id=eq.${encodeURIComponent(eventId)}`,
    { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: { ...event, registeredCount: next } }) },
  );
  return patched.ok;
}

// Best-effort confirmation email. Email must never fail a payment
// confirmation: every failure path returns false and is swallowed.
async function sendConfirmationEmail(reg: any, event: any, req: any): Promise<boolean> {
  try {
    const user = getEnv("GMAIL_USER");
    const pass = getEnv("GMAIL_APP_PASSWORD");
    if (!user || !pass || !reg.userEmail || !reg.ticketCode) return false;
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: pass.replace(/\s+/g, "") },
    });
    const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "locora-hyperlocal.vercel.app";
    const link = `https://${host}/my-registrations`;
    const title = event?.title || "your event";
    // The amount actually captured (snapshot on the registration), not
    // the live event price — the price may have changed since payment.
    const amount = typeof reg.amountPaise === "number"
      ? `₹${(reg.amountPaise / 100).toFixed(2).replace(/\.00$/, "")}`
      : (typeof event?.price === "number" ? `₹${event.price}` : "");
    await transporter.sendMail({
      from: user,
      to: reg.userEmail,
      subject: `You're registered: ${title}`,
      text: `Your payment of ${amount} for "${title}" was received. Your ticket code is ${reg.ticketCode}. View it here: ${link}`,
      html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;background:#FAF8F5;padding:24px;"><div style="background:#fff;border:1px solid #E7E3DB;border-top:4px solid #C25E00;border-radius:16px;padding:24px;"><h2 style="color:#1E3F35;">You're registered: ${esc(title)}</h2><p style="color:#1E2320;">Your Razorpay payment${amount ? ` of <strong>${esc(amount)}</strong>` : ""} was received and your pass is confirmed.</p><div style="background:#FAF8F5;border:1px solid #E7E3DB;border-radius:12px;padding:16px;text-align:center;margin:20px 0;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5F635D;margin-bottom:6px;">Your ticket code</div><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;letter-spacing:2px;font-weight:700;color:#1E3F35;">${esc(reg.ticketCode)}</div></div><p><a href="${esc(link)}" style="background:#1E3F35;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">View your ticket</a></p></div></div>`,
    });
    return true;
  } catch {
    return false;
  }
}

async function handleCreateOrder(req: any, res: any): Promise<void> {
  const session = await verifySession(req);
  if (!session) {
    sendJson(res, 401, { message: "Sign in required" });
    return;
  }
  const rl = await checkRateLimit(`payments:create-order:${session.email}`, 30, 10 * 60 * 1000);
  if (limited(res, rl, "Too many payment attempts. Try again shortly.")) return;
  const body = await readBody(req);
  const registrationId = typeof body.registrationId === "string" ? body.registrationId.trim() : "";
  if (!registrationId) {
    sendJson(res, 400, { message: "registrationId is required" });
    return;
  }
  const reg = await loadRegistration(registrationId);
  // Owner-only, and deliberately 404 (not 403) for strangers so the
  // endpoint cannot be used to probe whether a registration id exists.
  if (!reg || norm(reg.userEmail) !== session.email) {
    sendJson(res, 404, { message: "Registration not found" });
    return;
  }
  if (reg.status === "confirmed") {
    sendJson(res, 409, { message: "This registration is already confirmed" });
    return;
  }
  if (reg.status !== "pending") {
    sendJson(res, 409, { message: "This registration is not pending payment" });
    return;
  }
  const event = await loadEvent(reg.eventId);
  if (!event) {
    sendJson(res, 404, { message: "Event not found" });
    return;
  }
  // No orders for unpublished, cancelled, or ended events. (Status is
  // only enforced when present, so legacy rows without a status field
  // keep working.)
  if (event.status && event.status !== "published") {
    sendJson(res, 409, { message: "This event is not open for payments" });
    return;
  }
  if (event.endDate && !Number.isNaN(Date.parse(event.endDate)) && new Date(event.endDate).getTime() < Date.now()) {
    sendJson(res, 409, { message: "This event has ended" });
    return;
  }
  const price = Number(event.price);
  if (!Number.isFinite(price) || price <= 0) {
    sendJson(res, 400, { message: "This event is not a paid event" });
    return;
  }
  const amountPaise = Math.round(price * 100);
  if (amountPaise < 100) {
    sendJson(res, 400, { message: "Amount must be at least 100 paise" });
    return;
  }
  // Capacity is checked at registration time; re-check here so a
  // no-spot pending row cannot start a payment for a full event.
  if (reg.holdsSpot === false && Number(event.registeredCount || 0) >= Number(event.capacity || 0)) {
    sendJson(res, 409, { message: "This event is at full capacity" });
    return;
  }
  const keyId = getEnv("RAZORPAY_KEY_ID");
  const headers = { Authorization: razorpayAuthHeader(), "Content-Type": "application/json" };

  // Reuse an existing order for this registration instead of creating
  // a new one on every retry — this also bounds order spam to one live
  // order per pending registration.
  if (reg.razorpayOrderId) {
    const existing = await fetchJson(`https://api.razorpay.com/v1/orders/${encodeURIComponent(reg.razorpayOrderId)}`, { headers });
    if (existing.ok && existing.body) {
      const ord = existing.body;
      if (ord.status === "paid") {
        // A paid order is recovered via verify — unless its payment was
        // fully refunded, in which case the stored order id is cleared
        // so the user can pay again (a refunded order used to brick
        // re-payment forever: alreadyPaid -> verify 400, forever).
        // A paid order is also honoured even if the event price changed
        // since: the amount snapshot is the price at order time, and
        // abandoning a captured payment would strand the money.
        const usable = await hasUsableCapturedPayment(ord.id);
        if (usable) {
          sendJson(res, 200, { order_id: ord.id, amount: ord.amount, currency: ord.currency, key_id: keyId, alreadyPaid: true });
          return;
        }
        await saveRegistration({ ...reg, razorpayOrderId: undefined, razorpayPaymentId: undefined, refundId: undefined, refundStatus: undefined });
        // Fall through to create a fresh order below.
      } else if (ord.amount === amountPaise && ord.currency === "INR") {
        sendJson(res, 200, { order_id: ord.id, amount: ord.amount, currency: ord.currency, key_id: keyId });
        return;
      }
      // Price changed since the order was created and the order is
      // unpaid: fall through and create a fresh order for the current
      // price. The old unpaid order is simply abandoned (verify refuses
      // it, see below).
    } else if (existing.status === 401) {
      sendJson(res, 401, { message: "Razorpay authentication failed" });
      return;
    }
    // Any other fetch failure falls through to creating a new order;
    // a stale stored order id must not block payment.
  }

  const created = await fetchJson("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers,
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: registrationId.slice(0, 40),
      notes: { eventId: reg.eventId, registrationId },
    }),
  });
  if (!created.ok || !created.body?.id) {
    if (created.status === 401) {
      sendJson(res, 401, { message: "Razorpay authentication failed" });
      return;
    }
    sendJson(res, 500, { message: "Failed to create payment order" });
    return;
  }
  const order = created.body;
  // Store the order on the pending row so verify can bind the payment
  // to this registration, plus the amount snapshot: verify compares
  // against this snapshot and the order itself, never the live event
  // price (which the organizer may edit after the order exists).
  // Failure to store must not lose the order: the frontend still gets
  // it, but verify will refuse it until the row carries it — so a
  // store failure is a 500, not a silent gap.
  const stored = await saveRegistration({ ...reg, razorpayOrderId: order.id, paymentMethod: "razorpay", amountPaise: order.amount, currency: "INR" });
  if (!stored) {
    sendJson(res, 500, { message: "Failed to store payment order" });
    return;
  }
  sendJson(res, 200, { order_id: order.id, amount: order.amount, currency: order.currency, key_id: keyId });
}

async function handleVerifyPayment(req: any, res: any): Promise<void> {
  const body = await readBody(req);
  const registrationId = typeof body.registrationId === "string" ? body.registrationId.trim() : "";
  const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id.trim() : "";
  const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id.trim() : "";
  const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature.trim() : "";
  if (!registrationId || !orderId) {
    sendJson(res, 400, { message: "registrationId and razorpay_order_id are required" });
    return;
  }
  // Standard path needs all three fields; recovery (already-paid order)
  // needs only the order id and is handled below.
  const isSignaturePath = Boolean(paymentId && signature);
  if (!isSignaturePath && paymentId) {
    sendJson(res, 400, { message: "razorpay_signature is required" });
    return;
  }
  const session = await verifySession(req);
  if (!session) {
    sendJson(res, 401, { message: "Sign in required" });
    return;
  }
  const rl = await checkRateLimit(`payments:verify:${session.email}`, 60, 10 * 60 * 1000);
  if (limited(res, rl, "Too many payment verifications. Try again shortly.")) return;
  const reg = await loadRegistration(registrationId);
  // Owner-only, 404 (not 403) for strangers — see handleCreateOrder.
  if (!reg || norm(reg.userEmail) !== session.email) {
    sendJson(res, 404, { message: "Registration not found" });
    return;
  }
  if (reg.status === "confirmed") {
    // Idempotent replay: the same payment confirming twice must not
    // reissue a ticket or bump the count again.
    if (reg.razorpayPaymentId && (!paymentId || reg.razorpayPaymentId === paymentId)) {
      sendJson(res, 200, { success: true, ticketCode: reg.ticketCode, alreadyConfirmed: true });
      return;
    }
    sendJson(res, 409, { message: "This registration is already confirmed with a different payment" });
    return;
  }
  if (reg.status !== "pending") {
    sendJson(res, 409, { message: "This registration is not pending payment" });
    return;
  }
  // Binding check: the order must be the one stored on this row.
  if (!reg.razorpayOrderId || reg.razorpayOrderId !== orderId) {
    sendJson(res, 400, { message: "Payment order does not match this registration" });
    return;
  }
  const event = await loadEvent(reg.eventId);
  if (!event) {
    sendJson(res, 404, { message: "Event not found" });
    return;
  }
  const headers = { Authorization: razorpayAuthHeader() };

  // The Razorpay order itself is the amount truth — NOT the live event
  // price, which the organizer may have edited after the order was
  // created (that used to orphan captured payments forever). A snapshot
  // stored at order creation must also match when one exists, so a
  // swapped order cannot be substituted for the real one.
  const orderRes = await fetchJson(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, { headers });
  if (!orderRes.ok || !orderRes.body) {
    if (orderRes.status === 401) { sendJson(res, 401, { message: "Razorpay authentication failed" }); return; }
    sendJson(res, 500, { message: "Failed to verify payment order" });
    return;
  }
  const orderAmount = Number(orderRes.body.amount);
  if (!Number.isFinite(orderAmount) || orderAmount <= 0 || orderRes.body.currency !== "INR") {
    sendJson(res, 400, { message: "Payment order is invalid" });
    return;
  }
  if (typeof reg.amountPaise === "number" && reg.amountPaise !== orderAmount) {
    sendJson(res, 400, { message: "Payment amount does not match the order" });
    return;
  }
  // The order must have been created FOR this registration: create-order
  // sets receipt = registrationId, so an order id planted on another
  // event's pending row (copied from a row the attacker legitimately
  // paid for) cannot confirm a pass here. Without this, one captured
  // ₹1 payment confirmed a pass on every same-priced event.
  if (orderRes.body.receipt !== registrationId) {
    sendJson(res, 400, { message: "Payment order does not match this registration" });
    return;
  }

  let captured: any = null;
  if (isSignaturePath) {
    // Signature first: a mismatch never marks anything paid, and the
    // payment is not even fetched in that case.
    let expectedSig: string;
    try {
      expectedSig = await hmacSha256Hex(getEnv("RAZORPAY_KEY_SECRET"), `${orderId}|${paymentId}`);
    } catch {
      sendJson(res, 500, { message: "Signature verification unavailable" });
      return;
    }
    if (!ctEqual(expectedSig.toLowerCase(), signature.toLowerCase())) {
      sendJson(res, 400, { message: "Payment signature mismatch" });
      return;
    }
    const payRes = await fetchJson(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers });
    if (!payRes.ok || !payRes.body) {
      if (payRes.status === 401) { sendJson(res, 401, { message: "Razorpay authentication failed" }); return; }
      sendJson(res, 500, { message: "Failed to verify payment" });
      return;
    }
    captured = payRes.body;
  } else {
    // Recovery path: the order was already paid but the browser never
    // completed verify (closed tab, network drop). Razorpay's own
    // payment list for this order is the proof — no signature exists
    // for the frontend to send in this case.
    const listRes = await fetchJson(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}/payments`, { headers });
    if (!listRes.ok || !listRes.body) {
      if (listRes.status === 401) { sendJson(res, 401, { message: "Razorpay authentication failed" }); return; }
      sendJson(res, 500, { message: "Failed to verify payment" });
      return;
    }
    const items = Array.isArray(listRes.body.items) ? listRes.body.items : [];
    captured = items.find((p: any) => p && p.status === "captured");
    if (!captured) {
      sendJson(res, 400, { message: "No captured payment found for this order" });
      return;
    }
  }

  if (!captured || captured.status !== "captured" || captured.order_id !== orderId || Number(captured.amount) !== orderAmount) {
    sendJson(res, 400, { message: "Payment is not captured for the full order amount" });
    return;
  }
  // A refunded (even partially) payment must not issue a pass. Clear
  // the dead order id from the row first, so the next Pay Now starts
  // fresh instead of looping alreadyPaid -> 400 forever.
  if (Number(captured.amount_refunded || 0) > 0) {
    try {
      const cleared: any = { ...reg };
      delete cleared.razorpayOrderId;
      delete cleared.razorpayPaymentId;
      delete cleared.refundId;
      delete cleared.refundStatus;
      delete cleared.paidAt;
      await saveRegistration(cleared);
    } catch { /* the 400 below is the important part */ }
    sendJson(res, 400, { message: "This payment was refunded and cannot issue a pass" });
    return;
  }
  // Payment-id uniqueness: the same captured payment must never
  // confirm two passes (the receipt check above binds the ORDER; this
  // binds the PAYMENT — a second row carrying the same payment id is
  // refused even if its order somehow also matched).
  const priorUses = await loadRegistrationsByPaymentId(captured.id).catch(() => []);
  if (priorUses.some((r: any) => r && r.id !== registrationId && r.status === "confirmed")) {
    sendJson(res, 400, { message: "This payment has already been used for another registration" });
    return;
  }
  // Dead events and full events never issue passes. The money is
  // refunded first when possible; only if the refund call itself fails
  // does the row stay pending with a contact-the-organizer message, so
  // the payment stays visible in the organizer's queue instead of
  // vanishing with the money captured. The event is re-read NOW — the
  // first read predates several Razorpay round trips, so an event
  // deleted or filled in the meantime must refund instead of confirm
  // (this also closes the DELETE-vs-verify race: a deleted event reads
  // as missing here).
  const eventNow = (await loadEvent(reg.eventId).catch(() => null)) || event;
  const eventDead = (eventNow.status && eventNow.status !== "published") ||
    (eventNow.endDate && !Number.isNaN(Date.parse(eventNow.endDate)) && new Date(eventNow.endDate).getTime() < Date.now());
  const eventFull = reg.holdsSpot === false && Number(eventNow.registeredCount || 0) >= Number(eventNow.capacity || 0);
  if (eventDead || eventFull) {
    const rc = await refundAndCancel(reg, captured, orderId);
    if (rc.refunded) {
      sendJson(res, 409, { message: eventDead ? "This event is no longer open. Your payment has been refunded." : "This event is now at full capacity. Your payment has been refunded." });
      return;
    }
    sendJson(res, 409, { message: "This event cannot issue a pass right now. Your payment was captured — please contact the organizer for a refund." });
    return;
  }
  // Re-read + compare-and-swap: only a still-pending row may confirm,
  // so two parallel verifies cannot mint two ticket codes for one pass.
  const fresh = await loadRegistration(registrationId);
  if (!fresh) {
    sendJson(res, 404, { message: "Registration not found" });
    return;
  }
  if (fresh.status === "confirmed") {
    if (fresh.razorpayPaymentId && fresh.razorpayPaymentId === captured.id) {
      sendJson(res, 200, { success: true, ticketCode: fresh.ticketCode, alreadyConfirmed: true, registrationId: reg.id, paymentId: captured.id });
      return;
    }
    sendJson(res, 409, { message: "This registration is already confirmed with a different payment" });
    return;
  }
  if (fresh.status !== "pending") {
    sendJson(res, 409, { message: "This registration is not pending payment" });
    return;
  }
  // Reserve the seat BEFORE the compare-and-swap confirm, so two
  // parallel verifies for different rows cannot both take the last
  // seat (the old confirm-then-bump overbooked). On a lost race the
  // reservation is released.
  let reserved = false;
  if (fresh.holdsSpot === false) {
    reserved = await bumpEventCount(reg.eventId, 1).catch(() => false);
    if (!reserved) {
      const rc = await refundAndCancel(fresh, captured, orderId);
      sendJson(res, 409, { message: rc.refunded ? "This event is now at full capacity. Your payment has been refunded." : "This event cannot issue a pass right now. Your payment was captured — please contact the organizer for a refund." });
      return;
    }
  }
  const confirmed: any = {
    ...fresh,
    status: "confirmed",
    ticketCode: fresh.ticketCode || newTicketCode(),
    paymentMethod: "razorpay",
    razorpayPaymentId: captured.id,
    razorpayOrderId: orderId,
    amountPaise: captured.amount,
    currency: "INR",
    paidAt: new Date().toISOString(),
    // A stale refundId from an earlier cancelled payment must not
    // survive into the new pass (it would suppress the next refund).
    refundId: undefined,
    refundStatus: undefined,
  };
  let saved = await saveRegistrationIfPending(confirmed);
  if (!saved) {
    // Either lost a race (the parallel verify confirmed first) or the
    // CAS filter is unsupported here: re-read to tell which.
    const again = await loadRegistration(registrationId);
    if (again && again.status === "confirmed" && again.razorpayPaymentId === captured.id) {
      if (reserved) { try { await bumpEventCount(reg.eventId, -1); } catch {} }
      sendJson(res, 200, { success: true, ticketCode: again.ticketCode, alreadyConfirmed: true, registrationId: reg.id, paymentId: captured.id });
      return;
    }
    if (again && again.status === "pending") {
      saved = await saveRegistration(confirmed);
    }
    if (!saved) {
      if (reserved) { try { await bumpEventCount(reg.eventId, -1); } catch {} }
      sendJson(res, 409, { message: "This registration was already processed" });
      return;
    }
  }
  try { await sendConfirmationEmail(confirmed, eventNow, req); } catch { /* best-effort */ }
  sendJson(res, 200, { success: true, ticketCode: confirmed.ticketCode, registrationId: reg.id, paymentId: captured.id });
}

// Raw request body as a string: the webhook signature is computed
// over the exact bytes Razorpay sent, so the body must NOT be parsed
// first. (Vercel does not parse bodies for these functions, so the
// stream read below is the normal path; if a runtime ever pre-parses
// it, the signature check fails closed with 401 rather than silently
// accepting a forged event.)
async function readRawBody(req: any): Promise<string> {
  const b = (req as any).body;
  if (typeof b === "string") return b;
  if (b && typeof b === "object") return JSON.stringify(b);
  return new Promise((resolve) => {
    try {
      let data = "";
      const timer = setTimeout(() => resolve(data), 3000);
      req.on("data", (chunk: any) => { data += chunk; });
      req.on("end", () => { clearTimeout(timer); resolve(data); });
      req.on("error", () => { clearTimeout(timer); resolve(data); });
    } catch { resolve(""); }
  });
}

async function handleRazorpayWebhook(req: any, res: any): Promise<void> {
  const secret = getEnv("RAZORPAY_WEBHOOK_SECRET");
  if (!secret) {
    sendJson(res, 503, { message: "Razorpay webhook is not configured" });
    return;
  }
  const signature = String(req.headers?.["x-razorpay-signature"] || "");
  const raw = await readRawBody(req);
  let expected = "";
  try {
    expected = await hmacSha256Hex(secret, raw);
  } catch {
    sendJson(res, 500, { message: "Signature verification unavailable" });
    return;
  }
  if (!signature || !ctEqual(expected.toLowerCase(), signature.toLowerCase())) {
    sendJson(res, 401, { message: "Invalid webhook signature" });
    return;
  }
  let payload: any = null;
  try { payload = JSON.parse(raw); } catch {
    sendJson(res, 400, { message: "Invalid webhook payload" });
    return;
  }
  const eventType = String(payload?.event || "");
  const entity = payload?.payload?.payment?.entity || payload?.payload?.refund?.entity || null;
  if (!entity) { sendJson(res, 200, { received: true }); return; }
  const headers = { Authorization: razorpayAuthHeader() };

  if (eventType === "payment.captured") {
    const orderId = String(entity.order_id || "");
    const paymentId = String(entity.id || "");
    if (!orderId || !paymentId) { sendJson(res, 200, { received: true }); return; }
    const reg = await loadRegistrationByOrderId(orderId).catch(() => null);
    if (!reg || reg.status !== "pending") { sendJson(res, 200, { received: true }); return; }
    // Re-verify against Razorpay — never trust the webhook body alone.
    const payRes = await fetchJson(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers });
    if (!payRes.ok || !payRes.body) { sendJson(res, 200, { received: true }); return; }
    const captured = payRes.body;
    if (captured.status !== "captured" || captured.order_id !== orderId) { sendJson(res, 200, { received: true }); return; }
    if (Number(captured.amount_refunded || 0) > 0) { sendJson(res, 200, { received: true }); return; }
    const orderRes = await fetchJson(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, { headers });
    if (!orderRes.ok || !orderRes.body || orderRes.body.receipt !== reg.id) { sendJson(res, 200, { received: true }); return; }
    if (Number(captured.amount) !== Number(orderRes.body.amount)) { sendJson(res, 200, { received: true }); return; }
    if (typeof reg.amountPaise === "number" && reg.amountPaise !== Number(captured.amount)) { sendJson(res, 200, { received: true }); return; }
    const event = await loadEvent(reg.eventId).catch(() => null);
    if (!event) { sendJson(res, 200, { received: true }); return; }
    const eventDead = (event.status && event.status !== "published") ||
      (event.endDate && !Number.isNaN(Date.parse(event.endDate)) && new Date(event.endDate).getTime() < Date.now());
    const eventFull = reg.holdsSpot === false && Number(event.registeredCount || 0) >= Number(event.capacity || 0);
    if (eventDead || eventFull) {
      await refundAndCancel(reg, captured, orderId);
      sendJson(res, 200, { received: true });
      return;
    }
    let reserved = false;
    if (reg.holdsSpot === false) {
      reserved = await bumpEventCount(reg.eventId, 1).catch(() => false);
      if (!reserved) {
        await refundAndCancel(reg, captured, orderId);
        sendJson(res, 200, { received: true });
        return;
      }
    }
    const confirmed: any = {
      ...reg,
      status: "confirmed",
      ticketCode: reg.ticketCode || newTicketCode(),
      paymentMethod: "razorpay",
      razorpayPaymentId: captured.id,
      razorpayOrderId: orderId,
      amountPaise: captured.amount,
      currency: "INR",
      paidAt: new Date().toISOString(),
      refundId: undefined,
      refundStatus: undefined,
    };
    const saved = await saveRegistrationIfPending(confirmed);
    if (!saved) {
      if (reserved) { try { await bumpEventCount(reg.eventId, -1); } catch {} }
      sendJson(res, 200, { received: true });
      return;
    }
    try { await sendConfirmationEmail(confirmed, event, req); } catch { /* best-effort */ }
    sendJson(res, 200, { received: true });
    return;
  }

  if (eventType === "payment.refunded" || eventType === "refund.processed" || eventType === "refund.created") {
    // A refund initiated from the Razorpay dashboard (or by another
    // path) must void the pass and release the seat, not leave a
    // confirmed ticket for refunded money.
    const paymentId = String(entity.payment_id || "");
    const refundId = String(entity.id || "");
    if (!paymentId) { sendJson(res, 200, { received: true }); return; }
    const rows = await loadRegistrationsByPaymentId(paymentId).catch(() => []);
    const target = rows.find((r: any) => r && r.status === "confirmed");
    if (target) {
      const fresh = await loadRegistration(target.id).catch(() => null);
      if (fresh && fresh.status === "confirmed") {
        const cancelled: any = { ...fresh, status: "cancelled", refundStatus: "initiated", refundId: refundId || fresh.refundId };
        await saveRegistration(cancelled);
        try { await bumpEventCount(cancelled.eventId, -1); } catch {}
      }
    }
    sendJson(res, 200, { received: true });
    return;
  }

  sendJson(res, 200, { received: true });
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "Method not allowed" });
      return;
    }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, { message: "Shared registrations database is not configured" });
      return;
    }
    if (!getEnv("RAZORPAY_KEY_ID") || !getEnv("RAZORPAY_KEY_SECRET")) {
      sendJson(res, 503, { message: "Razorpay is not configured" });
      return;
    }
    // Live mode ONLY: test keys are refused outright, not warned
    // about. Test payments verify as captured, so a test key in
    // production would issue real passes for fake money — and the
    // product no longer has a test mode at all. Until live keys
    // (rzp_live_…) are in Vercel Production env vars, checkout
    // fails closed with a clear message instead of a fake pass.
    if (getEnv("RAZORPAY_KEY_ID").startsWith("rzp_test_")) {
      try { console.warn("Razorpay test-mode key refused: live keys required"); } catch {}
      sendJson(res, 503, { message: "Live Razorpay payments are not configured yet" });
      return;
    }
    const url = new URL(req.url || "/api/payments", "http://localhost");
    const action = url.searchParams.get("action") || "";
    if (action === "create-order") {
      await handleCreateOrder(req, res);
      return;
    }
    if (action === "verify-payment") {
      await handleVerifyPayment(req, res);
      return;
    }
    if (action === "webhook") {
      await handleRazorpayWebhook(req, res);
      return;
    }
    sendJson(res, 400, { message: "Unknown payments action" });
  } catch (err) {
    // Generic message to the client; the detail stays in server logs.
    try { console.error("Payments API failed:", err instanceof Error ? err.message : err); } catch {}
    sendJson(res, 500, { message: "Payments API failed" });
  }
}
