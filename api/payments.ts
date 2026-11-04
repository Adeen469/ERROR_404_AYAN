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
// - The browser checkout success callback alone never issues a pass.
//   verify requires either (a) a valid HMAC-SHA256 signature
//   (order_id + "|" + payment_id, keyed with RAZORPAY_KEY_SECRET, via
//   WebCrypto), or (b) a server-side recovery fetch: the order's payment
//   list from Razorpay itself, showing a captured payment. Both paths
//   then fetch the payment from Razorpay (secret-authenticated) and
//   check status === 'captured', order_id, and amount.
// - Idempotent: confirming an already-confirmed registration with the
//   same payment returns success without reissuing a ticket or bumping
//   the event count twice.
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

function newTicketCode(): string {
  return `LOC-${Math.floor(1000 + Math.random() * 9000)}-TK`;
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

async function bumpEventCount(eventId: string, delta: number): Promise<void> {
  const event = await loadEvent(eventId);
  if (!event) return;
  const next = Math.max(0, Number(event.registeredCount || 0) + delta);
  if (next === Number(event.registeredCount || 0)) return;
  await fetchJson(
    `${supabaseBase()}/rest/v1/events?id=eq.${encodeURIComponent(eventId)}`,
    { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: { ...event, registeredCount: next } }) },
  );
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
    const amount = typeof event?.price === "number" ? `₹${event.price}` : "";
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
  const body = await readBody(req);
  const registrationId = typeof body.registrationId === "string" ? body.registrationId.trim() : "";
  if (!registrationId) {
    sendJson(res, 400, { message: "registrationId is required" });
    return;
  }
  const reg = await loadRegistration(registrationId);
  if (!reg) {
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

  // Reuse an existing unpaid order for this registration instead of
  // creating a new one on every retry — this also bounds order spam to
  // one live order per pending registration.
  if (reg.razorpayOrderId) {
    const existing = await fetchJson(`https://api.razorpay.com/v1/orders/${encodeURIComponent(reg.razorpayOrderId)}`, { headers });
    if (existing.ok && existing.body) {
      const ord = existing.body;
      if (ord.amount === amountPaise && ord.currency === "INR") {
        if (ord.status === "paid") {
          // Payment was captured but verify never completed (e.g. the
          // browser closed). Tell the frontend to recover via verify
          // instead of opening a checkout for an already-paid order.
          sendJson(res, 200, { order_id: ord.id, amount: ord.amount, currency: ord.currency, key_id: keyId, alreadyPaid: true });
          return;
        }
        sendJson(res, 200, { order_id: ord.id, amount: ord.amount, currency: ord.currency, key_id: keyId });
        return;
      }
      // Price changed since the order was created: fall through and
      // create a fresh order for the current price. The old unpaid
      // order is simply abandoned (verify refuses it, see below).
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
  // to this registration. Failure to store must not lose the order:
  // the frontend still gets it, but verify will refuse it until the
  // row carries it — so a store failure is a 500, not a silent gap.
  const stored = await saveRegistration({ ...reg, razorpayOrderId: order.id, paymentMethod: "razorpay" });
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
  const reg = await loadRegistration(registrationId);
  if (!reg) {
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
  const expectedPaise = Math.round(Number(event.price) * 100);
  const headers = { Authorization: razorpayAuthHeader() };

  // The Razorpay order itself must still match the current price.
  const orderRes = await fetchJson(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, { headers });
  if (!orderRes.ok || !orderRes.body) {
    if (orderRes.status === 401) { sendJson(res, 401, { message: "Razorpay authentication failed" }); return; }
    sendJson(res, 500, { message: "Failed to verify payment order" });
    return;
  }
  if (orderRes.body.amount !== expectedPaise || orderRes.body.currency !== "INR") {
    sendJson(res, 400, { message: "Payment amount does not match the event price" });
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

  if (!captured || captured.status !== "captured" || captured.order_id !== orderId || Number(captured.amount) !== expectedPaise) {
    sendJson(res, 400, { message: "Payment is not captured for the full event price" });
    return;
  }
  // Same capacity guard as organizer approval: a no-spot pending row
  // takes a slot only on confirmation, and only if one is free. If the
  // event filled up after payment, the pass is NOT issued here — the
  // organizer must refund from the Razorpay dashboard (auto-refund is
  // a follow-up, not silently attempted).
  if (reg.holdsSpot === false && Number(event.registeredCount || 0) >= Number(event.capacity || 0)) {
    sendJson(res, 409, { message: "This event is now at full capacity. Please contact the organizer for a refund." });
    return;
  }
  const confirmed: any = {
    ...reg,
    status: "confirmed",
    ticketCode: reg.ticketCode || newTicketCode(),
    paymentMethod: "razorpay",
    razorpayPaymentId: captured.id,
    razorpayOrderId: orderId,
  };
  const saved = await saveRegistration(confirmed);
  if (!saved) {
    sendJson(res, 500, { message: "Failed to confirm registration" });
    return;
  }
  try {
    if (reg.holdsSpot === false) await bumpEventCount(reg.eventId, 1);
  } catch { /* count bump failure must not undo a paid confirmation */ }
  try { await sendConfirmationEmail(confirmed, event, req); } catch { /* best-effort */ }
  sendJson(res, 200, { success: true, ticketCode: confirmed.ticketCode, registrationId: reg.id, paymentId: captured.id });
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
    sendJson(res, 400, { message: "Unknown payments action" });
  } catch (err) {
    sendJson(res, 500, { message: err instanceof Error ? err.message : "Payments API failed" });
  }
}
