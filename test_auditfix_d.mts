// Audit #4 fix batch D — H6 webhook, H7 channel rotation, H9 typing,
// H10 reconcile scoping, H11 load-failure UI, M12 seen-count guard,
// M13 liveness retries, M14 load/jump errors + memoised bubbles.
// Runs with:
//   bun test_auditfix_d.mts   (from ~/workspace/vecna-calendar-auditfix-d)
// Same extraction pattern as test_chat_realtime.mts for module-private
// helpers; exported helpers are imported directly.
import { readFileSync } from "fs";
import { createHmac } from "crypto";
import { Readable } from "stream";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name); }
}
function extractFn(src: string, name: string): string {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  if (src.slice(start - 6, start) === "async ") start -= 6;
  let i = src.indexOf("(", start);
  let pdepth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") pdepth++;
    else if (src[i] === ")") { pdepth--; if (pdepth === 0) break; }
  }
  const paramClose = i;
  i = src.indexOf("{", i);
  const sig = src.slice(paramClose, i);
  if (/:\\s*$/.test(sig)) {
    let d = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") d++;
      else if (src[i] === "}") { d--; if (d === 0) { i++; break; } }
    }
    i = src.indexOf("{", i);
  }
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function jsFn(src: string, name: string): string {
  const ts = extractFn(src, name);
  const out: any = new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
  return typeof out === "string" ? out : out.code;
}

const payments = readFileSync("api/payments.ts", "utf8");
const messages = readFileSync("api/messages.ts", "utf8");
const service = readFileSync("src/services/messages-service.ts", "utf8");
const realtime = readFileSync("src/services/realtime-service.ts", "utf8");
const page = readFileSync("src/pages/MessagesPage.tsx", "utf8");
const community = readFileSync("src/components/events/CommunityChat.tsx", "utf8");
const details = readFileSync("src/pages/EventDetailsPage.tsx", "utf8");
const eventsService = readFileSync("src/services/events-service.ts", "utf8");
const setupDoc = readFileSync("MESSAGES_SETUP.md", "utf8");

// ---- Env for the imported server modules (read at call time) ----
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "auditfix-d-test-secret-at-least-32-chars-long";
process.env.RAZORPAY_KEY_ID = "rzp_live_auditfixd";
process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_auditfixd_test_secret";

const paymentsMod: any = await import("./api/payments.ts");
const messagesMod: any = await import("./api/messages.ts");

// ================= H6 — Razorpay webhook =================
const WEBHOOK_SECRET = "whsec_auditfixd_test_secret";
const rawBody = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 19900, status: "captured" } } },
});
const goodSig = createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

check("webhook: known test vector verifies",
  await paymentsMod.verifyRazorpayWebhookSignature(WEBHOOK_SECRET, rawBody, goodSig) === true);
check("webhook: wrong signature refused",
  await paymentsMod.verifyRazorpayWebhookSignature(WEBHOOK_SECRET, rawBody, "0".repeat(64)) === false);
check("webhook: tampered body refused",
  await paymentsMod.verifyRazorpayWebhookSignature(WEBHOOK_SECRET, rawBody + " ", goodSig) === false);
check("webhook: empty secret fails closed",
  await paymentsMod.verifyRazorpayWebhookSignature("", rawBody, goodSig) === false);
check("webhook: empty signature fails closed",
  await paymentsMod.verifyRazorpayWebhookSignature(WEBHOOK_SECRET, rawBody, "") === false);
check("webhook: readRawBody returns exact bytes from a stream req",
  await (async () => {
    const req: any = Readable.from([rawBody]);
    req.body = undefined;
    const { raw, parsed } = await paymentsMod.readRawBody(req);
    return raw === rawBody && parsed?.event === "payment.captured";
  })());
check("webhook: readRawBody accepts a pre-stringified body",
  await (async () => {
    const { raw, parsed } = await paymentsMod.readRawBody({ body: rawBody });
    return raw === rawBody && parsed?.payload?.payment?.entity?.id === "pay_1";
  })());
check("webhook: handler is wired (no new function file)",
  payments.includes('action === "webhook"') && !payments.includes("api/webhook"));

// Webhook end-to-end with a stubbed fetch (Supabase + Razorpay).
// The stub holds one registration row; the first payment.captured
// confirms it, the replay is idempotent, refund events mark the row.
const regState: any = {
  id: "reg-1",
  status: "pending",
  eventId: "evt-1",
  userEmail: "attendee@example.com",
  razorpayOrderId: "order_1",
  razorpayPaymentId: null,
  amountPaise: 19900,
  holdsSpot: true,
  ticketCode: null,
};
const eventRow: any = { id: "evt-1", status: "published", registeredCount: 0, capacity: 10 };
const savedRows: any[] = [];
(globalThis as any).fetch = async (url: string, init?: any) => {
  const method = (init?.method || "GET").toUpperCase();
  const json = async (body: any, ok = true, status = 200) => ({ ok, status, json: async () => body });
  if (url.includes("/rest/v1/registrations?data->>razorpayOrderId=eq.order_1")) {
    return json([{ data: { ...regState } }]);
  }
  if (url.includes("/rest/v1/registrations?data->>razorpayPaymentId=eq.pay_1")) {
    return regState.razorpayPaymentId === "pay_1" ? json([{ data: { ...regState } }]) : json([]);
  }
  if (url.includes("/rest/v1/registrations?data->>razorpayOrderId=eq.order_unknown")) {
    return json([]);
  }
  if (url === "https://api.razorpay.com/v1/payments/pay_1") {
    return json({ id: "pay_1", status: "captured", order_id: "order_1", amount: 19900, amount_refunded: 0 });
  }
  if (url === "https://api.razorpay.com/v1/orders/order_1") {
    return json({ id: "order_1", amount: 19900, currency: "INR" });
  }
  if (url.includes("/rest/v1/events?id=eq.evt-1")) {
    return json([{ data: { ...eventRow } }]);
  }
  if (url.includes("/rest/v1/registrations?id=eq.reg-1&select=data")) {
    return json([{ data: { ...regState } }]);
  }
  if (url.includes("/rest/v1/registrations?id=eq.reg-1&data->>status=eq.pending") && method === "PATCH") {
    // CAS confirm: first call wins, later calls see a confirmed row.
    if (regState.status !== "pending") return json([]);
    const body = JSON.parse(init.body);
    Object.assign(regState, body.data);
    savedRows.push({ ...regState });
    return json([{ data: { ...regState } }]);
  }
  if (url.includes("/rest/v1/registrations?id=eq.reg-1") && method === "PATCH") {
    const body = JSON.parse(init.body);
    Object.assign(regState, body.data);
    savedRows.push({ ...regState });
    return json([{ data: { ...regState } }]);
  }
  return json(null, false, 404);
};
function mockRes() {
  const r: any = { status: 0, body: "" };
  r.writeHead = (s: number) => { r.status = s; };
  r.end = (b: string) => { r.body = b; };
  return r;
}
function mockWebhookReq(raw: string, sig: string) {
  return {
    method: "POST",
    url: "/api/payments?action=webhook",
    headers: { "x-razorpay-signature": sig },
    body: raw,
  };
}
const capturedRaw = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 19900, status: "captured" } } },
});
const capturedSig = createHmac("sha256", WEBHOOK_SECRET).update(capturedRaw).digest("hex");

const res1: any = mockRes();
await paymentsMod.default(mockWebhookReq(capturedRaw, capturedSig), res1);
const body1 = JSON.parse(res1.body || "{}");
check("webhook: payment.captured confirms the pending registration",
  res1.status === 200 && body1.success === true && typeof body1.ticketCode === "string" && regState.status === "confirmed" && regState.razorpayPaymentId === "pay_1");
check("webhook: replay of the same captured event is idempotent (no second ticket)",
  await (async () => {
    const before = savedRows.length;
    const res: any = mockRes();
    await paymentsMod.default(mockWebhookReq(capturedRaw, capturedSig), res);
    const b = JSON.parse(res.body || "{}");
    return res.status === 200 && b.alreadyConfirmed === true && b.ticketCode === body1.ticketCode && savedRows.length === before;
  })());
check("webhook: bad signature is refused without touching the row",
  await (async () => {
    const before = savedRows.length;
    const res: any = mockRes();
    await paymentsMod.default(mockWebhookReq(capturedRaw, "deadbeef"), res);
    return res.status === 401 && savedRows.length === before;
  })());
check("webhook: missing webhook secret fails closed (503)",
  await (async () => {
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const res: any = mockRes();
    await paymentsMod.default(mockWebhookReq(capturedRaw, capturedSig), res);
    process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    return res.status === 503;
  })());
check("webhook: unknown order is ignored with 200 (no retry loop)",
  await (async () => {
    const raw = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_9", order_id: "order_unknown", amount: 100, status: "captured" } } },
    });
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    const res: any = mockRes();
    await paymentsMod.default(mockWebhookReq(raw, sig), res);
    const b = JSON.parse(res.body || "{}");
    return res.status === 200 && b.ignored === "unknown order";
  })());
const refundCreatedRaw = JSON.stringify({
  event: "refund.created",
  payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 19900, status: "created" } } },
});
const refundCreatedSig = createHmac("sha256", WEBHOOK_SECRET).update(refundCreatedRaw).digest("hex");
const resRefund: any = mockRes();
await paymentsMod.default(mockWebhookReq(refundCreatedRaw, refundCreatedSig), resRefund);
const refundBody = JSON.parse(resRefund.body || "{}");
check("webhook: refund.created marks refundStatus/refundId on the row",
  resRefund.status === 200 && refundBody.refundStatus === "initiated" && refundBody.refundId === "rfnd_1" && regState.refundStatus === "initiated" && regState.refundId === "rfnd_1");
const refundProcessedRaw = JSON.stringify({
  event: "refund.processed",
  payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 19900, status: "processed" } } },
});
const refundProcessedSig = createHmac("sha256", WEBHOOK_SECRET).update(refundProcessedRaw).digest("hex");
const resRefund2: any = mockRes();
await paymentsMod.default(mockWebhookReq(refundProcessedRaw, refundProcessedSig), resRefund2);
const refundBody2 = JSON.parse(resRefund2.body || "{}");
check("webhook: refund.processed advances the row to processed",
  resRefund2.status === 200 && refundBody2.refundStatus === "processed" && regState.refundStatus === "processed");
check("webhook: payment.refunded is NOT handled (not a real Razorpay event)",
  !payments.includes('eventName === "payment.refunded"'));
check("webhook: owner step documented (URL + events)",
  setupDoc.includes("https://locora-hyperlocal.vercel.app/api/payments?action=webhook") &&
  setupDoc.includes("payment.captured") && setupDoc.includes("refund.created") && setupDoc.includes("refund.processed"));

// ================= H7 — channel rotation =================
const ch0 = await messagesMod.privateChannelName("User@Example.com", 0);
const ch0b = await messagesMod.privateChannelName("user@example.com", 0);
const ch1 = await messagesMod.privateChannelName("user@example.com", 1);
const ch2 = await messagesMod.privateChannelName("user@example.com", 2);
const chOther = await messagesMod.privateChannelName("other@example.com", 0);
check("channel: name is deterministic for the same email + version", ch0 === ch0b && typeof ch0 === "string" && ch0.startsWith("inbox:"));
check("channel: bumped sessionVersion changes the channel name", ch0 !== ch1 && ch1 !== ch2);
check("channel: old name is no longer derived after a bump (only the new version derives)", ch1 !== ch0 && (await messagesMod.privateChannelName("user@example.com", 1)) === ch1);
check("channel: different users still get different channels", ch0 !== chOther);
check("channel: default version is 0 (legacy rows keep working)", (await messagesMod.privateChannelName("user@example.com")) === ch0);
check("channel: ?action=channel uses the session's version",
  messages.includes("privateChannelName(me, session.sessionVersion"));
check("channel: broadcasts load the recipient's stored version",
  messages.includes("loadSessionVersion") && messages.includes("loadSessionVersions"));
check("channel: rotation runbook documented",
  setupDoc.includes("SESSION_SECRET rotation runbook") && setupDoc.includes("at least 32 random bytes") && setupDoc.includes("sign-out-everywhere"));

// ================= H9 — private typing =================
// Server and client threadKeyHash must agree (extracted live).
const { threadKeyHash: serverKey }: any = new Function(
  `${jsFn(messages, "norm")}\n${jsFn(messages, "cyrb53")}\n${jsFn(messages, "threadKeyHash")}\nreturn { threadKeyHash };`,
)();
const { threadKeyHash: clientKey, threadKey: clientRawKey }: any = new Function(
  `${jsFn(service, "cyrb53")}\n${jsFn(service, "threadKeyHash")}\n${jsFn(service, "threadKey")}\nreturn { threadKeyHash, threadKey };`,
)();
const ME = "me@example.com";
const OTHER = "organizer@example.com";
const EVT = "evt-123";
const hashed = serverKey(EVT, ME, OTHER);
check("typing: server and client threadKeyHash agree", hashed === clientKey(EVT, ME, OTHER));
check("typing: hashed key never equals the raw thread key (old comparison could never match)",
  hashed !== clientRawKey(EVT, ME, OTHER));
check("typing: page compares the incoming hash against the selected thread's hash",
  page.includes("threadKeyHash(selected.eventId, meEmail, selected.otherEmail)"));
check("typing: page normalises the incoming hash to the raw key via a known message",
  page.includes("threadKeyHash(m.eventId, m.senderEmail, m.recipientEmail) === ev.threadKey"));

// ================= H10 — reconcile scoping =================
const servicePlain = service.replace(
  /export function reconcileFailedPending<[\s\S]*?>\(/,
  "export function reconcileFailedPending(",
);
const { reconcileFailedPending }: any = new Function(
  `${jsFn(servicePlain, "reconcileFailedPending")}\nreturn { reconcileFailedPending };`,
)();
const T0 = "2026-11-06T12:26:00.000Z";
const failedHi: any = { failed: true, eventId: "evt-1", senderEmail: ME, recipientEmail: OTHER, text: "Hi", attachment: null, createdAt: T0 };
const serverHiSame: any = { eventId: "evt-1", senderEmail: ME, recipientEmail: OTHER, text: "Hi", attachment: null, createdAt: "2026-11-06T12:26:01.000Z" };
check("reconcile: same thread + event still drops the failed bubble",
  reconcileFailedPending([failedHi], [serverHiSame], ME).length === 0);
check("reconcile: same text in a DIFFERENT event is kept (H10)",
  reconcileFailedPending([failedHi], [{ ...serverHiSame, eventId: "evt-2" }], ME).length === 1);
check("reconcile: same text in a DIFFERENT thread of the same event is kept (H10)",
  reconcileFailedPending([failedHi], [{ ...serverHiSame, recipientEmail: "someone-else@example.com" }], ME).length === 1);
check("reconcile: community same text in a different room is kept (H10)",
  reconcileFailedPending(
    [{ ...failedHi, recipientEmail: "community:evt-1" }],
    [{ ...serverHiSame, eventId: "evt-2", recipientEmail: "community:evt-2" }],
    ME,
  ).length === 1);
check("reconcile: community same text in the same room still drops",
  reconcileFailedPending(
    [{ ...failedHi, recipientEmail: "community:evt-1" }],
    [{ ...serverHiSame, recipientEmail: "community:evt-1" }],
    ME,
  ).length === 0);
check("reconcile: missing scope on either side falls back to the old match",
  reconcileFailedPending(
    [{ failed: true, senderEmail: ME, text: "Hi", attachment: null, createdAt: T0 }],
    [{ senderEmail: ME, text: "Hi", attachment: null, createdAt: "2026-11-06T12:26:01.000Z" }],
    ME,
  ).length === 0);

// ================= H11 — load-failure UI =================
check("load-failure: details page has a distinct error state with Retry",
  details.includes("load this event") &&
  details.includes("Try again") &&
  details.includes("onClick={loadEventData}") &&
  details.includes("loadFailed"));
check("load-failure: genuine not-found screen is kept for a successful empty load",
  details.includes("Event Not Found") && details.includes("may have been removed or does not exist"));
check("load-failure: strict event fetch throws on remote failure with no local copy",
  eventsService.includes("strict?: boolean") &&
  eventsService.includes("if (!local) throw") &&
  details.includes("getEventById(eventId, { strict: true })"));
check("load-failure: a 404 stays a genuine not-found, not an error",
  eventsService.includes("(err as any)?.status !== 404"));

// ================= M12 — seen-count guard =================
check("seen-count: server dedupes readBy before writing (parallel mark-read cannot double-append)",
  messages.includes("Dedupe (M12)") && messages.includes("seenEmails"));
check("seen-count: read broadcast carries seenCount for community rows",
  messages.includes("payload: { id, seenCount: msg.readBy.length }"));
check("seen-count: client increments only rows still unseen at apply time",
  community.includes("ids.includes(m.id) && !m.seenByMe"));

// ================= M13 — liveness retries =================
check("liveness: Realtime client creation is bounded-retry, not cached-null-forever",
  realtime.includes("MAX_REALTIME_CLIENT_ATTEMPTS") &&
  realtime.includes("REALTIME_CLIENT_RETRY_BASE_MS") &&
  realtime.includes("resetRealtimeClient"));
check("liveness: getRealtimeClient still returns null without VITE vars (live import)",
  await (async () => {
    const rt: any = await import("./src/services/realtime-service.ts");
    rt.resetRealtimeClient();
    return rt.getRealtimeClient() === null;
  })());
check("liveness: channel-name cache has a TTL and a reset",
  service.includes("REALTIME_CHANNEL_CACHE_MS") && service.includes("resetRealtimeChannelCache"));
check("liveness: event rooms track private and ping channels separately",
  community.includes("privateLive") && community.includes("pingLive") &&
  community.includes("setPrivateLive(s === 'SUBSCRIBED')") &&
  community.includes("setPingLive(s === 'SUBSCRIBED')"));

// ================= M14 — load/jump errors + memo =================
check("m14: community loadOlder surfaces its error with Retry",
  community.includes("loadOlderError") && community.includes("Could not load older messages."));
check("m14: community jumpToQuoted surfaces a miss instead of doing nothing",
  community.includes("jumpError") && community.includes("Could not find that message"));
check("m14: inbox loadOlder surfaces its error with Retry",
  page.includes("loadOlderError") && page.includes("Could not load older messages."));
check("m14: inbox jumpToQuoted surfaces a miss instead of doing nothing",
  page.includes("jumpError") && page.includes("Could not find that message"));
check("m14: bubble components are memoised",
  community.includes("React.memo(function QuoteView") &&
  community.includes("React.memo(function AttachmentView") &&
  community.includes("React.memo(function PendingAttachment") &&
  page.includes("React.memo(function QuoteView") &&
  page.includes("React.memo(function AttachmentView"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
