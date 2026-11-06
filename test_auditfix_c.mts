// Audit #4 fix tests — agent C scope (H3 refund-before-persist,
// H4 capacity RPC, H5 holdsSpot, M14 refund-preview label,
// M17 refund amounts on all three refund sites).
// Runs with:
//   bun test_auditfix_c.mts   (from ~/workspace/vecna-calendar-auditfix-c)
// Marker checks (handlers are default-exported Vercel handlers) plus
// extracted-function logic checks, same pattern as test_refund.mts /
// test_auditfix_a.mts. No live calls: nothing here touches Supabase,
// Razorpay, Google, or Vercel — Razorpay/Supabase are stubbed.
import { readFileSync, existsSync } from "fs";

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
  // Return-type annotations carry "{" too (e.g. Promise<{...}>), so
  // the body brace is the first "{" followed by a newline.
  i = src.indexOf("{\n", i);
  if (i < 0) throw new Error(`body brace not found for ${name}`);
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

const registrations = readFileSync("api/registrations.ts", "utf8");
const payments = readFileSync("api/payments.ts", "utf8");
const events = readFileSync("api/events.ts", "utf8");
const service = readFileSync("src/services/registrations-service.ts", "utf8");
const detailsPage = readFileSync("src/pages/EventDetailsPage.tsx", "utf8");
const myRegsPage = readFileSync("src/pages/RegistrationsPage.tsx", "utf8");

// ================= H5 — holdsSpot: one predicate =================
// Legacy semantics (src/types/index.ts L149-153, the authority):
// undefined = legacy row that already holds a seat; false = new
// pending row that holds NO seat; true = holds one.
const rowHoldsSpotReg: any = new Function(`${jsFn(registrations, "rowHoldsSpot")}; return rowHoldsSpot;`)();
const rowHoldsSpotPay: any = new Function(`${jsFn(payments, "rowHoldsSpot")}; return rowHoldsSpot;`)();
const rowNeedsSpotPay: any = new Function(`${jsFn(payments, "rowNeedsSpot")}; return rowNeedsSpot;`)();
check("H5: rowHoldsSpot(undefined) = true (legacy row holds a seat)", rowHoldsSpotReg({}) === true && rowHoldsSpotPay({}) === true);
check("H5: rowHoldsSpot(true) = true", rowHoldsSpotReg({ holdsSpot: true }) === true);
check("H5: rowHoldsSpot(false) = false (new pending holds no seat)", rowHoldsSpotReg({ holdsSpot: false }) === false);
check("H5: rowNeedsSpot is the exact negation of rowHoldsSpot",
  rowNeedsSpotPay({}) === false && rowNeedsSpotPay({ holdsSpot: true }) === false && rowNeedsSpotPay({ holdsSpot: false }) === true);
check("H5: payments uses the named predicate at all three sites (create-order, eventFull, confirm bump)",
  (payments.match(/rowNeedsSpot\(/g) || []).length >= 4); // 1 def + 3 call sites
check("H5: payments has NO bare holdsSpot === false check outside the helper (only the helper + its comment)",
  (payments.match(/\.holdsSpot === false/g) || []).length === 2); // comment line + rowNeedsSpot return
check("H5: the audit's suggested `!== true` was NOT applied as code anywhere (it would double-count legacy rows)",
  !/(reg|fresh|existing|baseDead|record|registration)\.holdsSpot !== true/.test(payments) &&
  !/(reg|fresh|existing|baseDead|record|registration)\.holdsSpot !== true/.test(registrations));
check("H5: registrations cancel uses rowHoldsSpot for the pending decrement",
  registrations.includes("(existing.status === 'pending' && rowHoldsSpot(existing))"));
check("H5: client service + EventDetailsPage agree (undefined holds a spot)",
  service.includes("(record.status === 'pending' && record.holdsSpot !== false)") &&
  detailsPage.includes("(registration.status === 'pending' && registration.holdsSpot !== false)"));
check("H5: the reasoning is documented in code (legacy + the three harms of !== true)",
  payments.includes("would block a legacy holder") && payments.includes("double-counting"));

// ================= Refund rule UNCHANGED (H3/M17 change ordering only) =================
const REFUND_WINDOW = `const REFUND_WINDOW_MS = 24 * 60 * 60 * 1000;`;
const refundQuote: any = new Function(`${REFUND_WINDOW}\n${jsFn(registrations, "refundQuote")}; return refundQuote;`)();
const getRefundQuote: any = new Function(`${REFUND_WINDOW}\n${jsFn(service, "getRefundQuote")}; return getRefundQuote;`)();
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
function paidReg(amountPaise: number, paidHoursAgo: number): any {
  return { amountPaise, paymentMethod: "razorpay", razorpayPaymentId: "pay_123", paidAt: new Date(NOW - paidHoursAgo * HOUR).toISOString(), registeredAt: new Date(NOW - paidHoursAgo * HOUR).toISOString() };
}
function expectBoth(name: string, reg: any, expected: any) {
  const s = refundQuote(reg, NOW);
  const c = getRefundQuote(reg, NOW);
  check(`${name} (server)`, JSON.stringify(s) === JSON.stringify(expected));
  check(`${name} (client preview agrees)`, JSON.stringify(c) === JSON.stringify(expected));
}
expectBoth("refund rule: 1h after purchase, ₹500 → full", paidReg(50000, 1), { refundAmountPaise: 50000, refundFeePaise: 0, isFull: true });
expectBoth("refund rule: 48h after purchase, ₹199 → fee ₹19.90, refund ₹179.10", paidReg(19900, 48), { refundAmountPaise: 17910, refundFeePaise: 1990, isFull: false });
expectBoth("refund rule: ₹1 (100 paise), 48h → full (tiny-amount edge)", paidReg(100, 48), { refundAmountPaise: 100, refundFeePaise: 0, isFull: true });
expectBoth("refund rule: 101 paise, 48h → full (computed refund < ₹1 floor)", paidReg(101, 48), { refundAmountPaise: 101, refundFeePaise: 0, isFull: true });
check("refund rule: missing paidAt falls back to createdAt (48h → 90%)",
  JSON.stringify(refundQuote({ amountPaise: 50000, paymentMethod: "razorpay", razorpayPaymentId: "pay_1", createdAt: new Date(NOW - 48 * HOUR).toISOString() }, NOW)) === JSON.stringify({ refundAmountPaise: 45000, refundFeePaise: 5000, isFull: false }));
check("refund rule: no anchor at all → full (fail in user's favour)",
  JSON.stringify(refundQuote({ amountPaise: 50000, paymentMethod: "razorpay", razorpayPaymentId: "pay_1" }, NOW)) === JSON.stringify({ refundAmountPaise: 50000, refundFeePaise: 0, isFull: true }));

// ================= H3 — refund-before-persist =================
// --- registrations.ts: attendee cancel ---
check("H3 reg: claim (processing + amounts) is written BEFORE the Razorpay call",
  registrations.indexOf('refundStatus: "processing"') < registrations.indexOf("refundRazorpayPayment(existing.razorpayPaymentId"));
check("H3 reg: claim is a CAS write (only while still confirmed)",
  registrations.includes("saveRegistrationIfStill(claim, \"confirmed\")") &&
  registrations.includes("data->>status=eq.${encodeURIComponent(expectedStatus)}"));
check("H3 reg: CAS loser re-reads and returns the already-cancelled row without re-refunding",
  registrations.includes("if (freshClaim && freshClaim.status === \"cancelled\")"));
check("H3 reg: a row already processing is never re-refunded",
  registrations.includes('existing.refundStatus !== "processing"'));
check("H3 reg: finalise writes initiated/failed + refundId after the call",
  registrations.includes('refundStatus: rf.ok ? "initiated" : "failed"') &&
  registrations.includes("if (rf.refundId) finalRow.refundId = rf.refundId;"));
check("H3 reg: failed refund never un-cancels (claim is built on the cancelled merged row; finalise keeps it)",
  registrations.includes("const claim: any = {") && registrations.includes("...merged,") &&
  registrations.includes("const finalRow: any = { ...claim, refundStatus: rf.ok ? \"initiated\" : \"failed\" }") &&
  registrations.includes("merged = finalRow;"));
check("H3 reg: claim that cannot be written refuses the cancel (no silent refund loss)",
  registrations.includes('sendJson(res, 500, { message: "Failed to record refund" })'));
// --- payments.ts: verify-409 path ---
check("H3 pay: dead/full re-reads FIRST, before any refund",
  payments.indexOf("const freshDead = await loadRegistration(registrationId);") <
  payments.indexOf("refundRazorpayPayment(captured.id"));
check("H3 pay: claim (processing + full amount) is written before the Razorpay call",
  payments.includes('refundStatus: "processing", refundAmountPaise, refundFeePaise: 0') &&
  payments.indexOf('refundStatus: "processing", refundAmountPaise') < payments.indexOf("const rf = await refundRazorpayPayment(captured.id"));
check("H3 pay: a row already processing is not refunded again",
  payments.includes('if (baseDead.refundStatus === "processing")'));
check("H3 pay: a row with a refundId is never refunded again",
  payments.includes("if (baseDead.refundId)"));
check("H3 pay: failed refund records status+amount and leaves the row pending (retryable)",
  payments.includes('refundStatus: "failed", refundAmountPaise, refundFeePaise: 0'));
{
  const failBlock = payments.slice(payments.indexOf("Refund failed: record"), payments.indexOf("Refund failed: record") + 600);
  check("H3 pay: failed-refund save does not cancel the row", !failBlock.includes('status: "cancelled"'));
}
// --- events.ts: organizer DELETE ---
check("H3 events: claim (processing + amounts) is written BEFORE the Razorpay call",
  events.indexOf('next.refundStatus = "processing"') < events.indexOf("refundRazorpayPayment(r.razorpayPaymentId"));
check("H3 events: a row already processing is left alone",
  events.includes('if (r.refundStatus === "processing")'));
check("H3 events: finalise writes initiated/failed on the row",
  events.includes('next.refundStatus = "initiated"') && events.includes('next.refundStatus = "failed"'));
// --- retry pre-read + idempotency key (all three helpers) ---
for (const [label, src] of [["reg", registrations], ["pay", payments], ["events", events]] as const) {
  check(`H3 ${label}: helper re-reads the payment and checks amount_refunded before posting`,
    src.includes("amount_refunded") && src.includes("/refunds?count=10") &&
    src.indexOf("amount_refunded") < src.indexOf("/refund`"));
  check(`H3 ${label}: helper sends Idempotency-Key refund-<registrationId>`,
    src.includes('headers["Idempotency-Key"] = `refund-${registrationId}`'));
  check(`H3 ${label}: idempotency limitation is documented (Payouts/Route only, NOT relied on)`,
    src.includes("X-Payout-Idempotency") && src.includes("NOT relied on"));
}

// --- refund helper logic, run against stubbed fetch ---
function makeRefundStub(scenario: { amountRefunded: number; amount: number; refundList: any[]; postOk: boolean; postId?: string }) {
  const calls: any[] = [];
  const fetchJson = async (url: string, init?: any) => {
    calls.push({ url, init });
    if (url.includes("/refunds?count=10")) return { ok: true, status: 200, body: { items: scenario.refundList } };
    if (url.includes("/v1/payments/") && (!init || !init.method || init.method === "GET")) return { ok: true, status: 200, body: { id: "pay_1", amount: scenario.amount, amount_refunded: scenario.amountRefunded } };
    if (url.includes("/refund")) return scenario.postOk ? { ok: true, status: 200, body: { id: scenario.postId || "rfnd_new" } } : { ok: false, status: 400, body: { error: { description: "already refunded" } } };
    return { ok: false, status: 404, body: null };
  };
  const getEnv = (name: string) => (name === "RAZORPAY_KEY_ID" ? "rzp_live_x" : name === "RAZORPAY_KEY_SECRET" ? "secret" : "");
  return { calls, fetchJson, getEnv };
}
{
  const stub = makeRefundStub({ amountRefunded: 19900, amount: 19900, refundList: [{ id: "rfnd_old", amount: 19900 }], postOk: true });
  const fn: any = new Function("fetchJson", "getEnv", `${jsFn(registrations, "refundRazorpayPayment")}; return refundRazorpayPayment;`)(stub.fetchJson, stub.getEnv);
  const out = await fn("pay_1", undefined, "reg-abc");
  check("H3 logic reg: already fully refunded → returns the old refund id WITHOUT posting",
    out.ok === true && out.alreadyRefunded === true && out.refundId === "rfnd_old" && !stub.calls.some((c: any) => c.url.includes("/refund") && !c.url.includes("/refunds")));
}
{
  const stub = makeRefundStub({ amountRefunded: 0, amount: 19900, refundList: [], postOk: true });
  const fn: any = new Function("fetchJson", "getEnv", `${jsFn(registrations, "refundRazorpayPayment")}; return refundRazorpayPayment;`)(stub.fetchJson, stub.getEnv);
  const out = await fn("pay_1", 17910, "reg-abc");
  const post = stub.calls.find((c: any) => c.url.includes("/refund") && !c.url.includes("/refunds"));
  check("H3 logic reg: not yet refunded → posts the partial amount with the idempotency key",
    out.ok === true && out.refundId === "rfnd_new" &&
    post?.init?.headers?.["Idempotency-Key"] === "refund-reg-abc" &&
    JSON.parse(post.init.body).amount === 17910);
}
{
  const stub = makeRefundStub({ amountRefunded: 19900, amount: 19900, refundList: [{ id: "rfnd_old", amount: 19900 }], postOk: true });
  const razorpayAuthHeader = () => "Basic dGVzdDp0ZXN0";
  const fn: any = new Function("fetchJson", "getEnv", "razorpayAuthHeader", `${jsFn(payments, "refundRazorpayPayment")}; return refundRazorpayPayment;`)(stub.fetchJson, stub.getEnv, razorpayAuthHeader);
  const out = await fn("pay_1", "reg-xyz");
  check("H3 logic pay: already fully refunded → no second POST, old refund id recovered",
    out.ok === true && out.alreadyRefunded === true && out.refundId === "rfnd_old" && !stub.calls.some((c: any) => c.url.includes("/refund") && !c.url.includes("/refunds")));
}
{
  const stub = makeRefundStub({ amountRefunded: 0, amount: 19900, refundList: [], postOk: true, postId: "rfnd_9" });
  // events.ts posts via bare global fetch (not fetchJson): stub it so
  // no live Razorpay call is attempted, and record the headers.
  const fetchCalls: any[] = [];
  const fetchStub = async (url: string, init?: any) => { fetchCalls.push({ url, init }); return { ok: true, json: async () => ({ id: "rfnd_9" }) }; };
  const fn: any = new Function("fetchJson", "getEnv", "fetch", `${jsFn(events, "refundRazorpayPayment")}; return refundRazorpayPayment;`)(stub.fetchJson, stub.getEnv, fetchStub);
  const out = await fn("pay_1", "reg-9");
  const post = fetchCalls.find((c: any) => c.url.includes("/refund"));
  check("H3 logic events: not yet refunded → posts a full refund with the idempotency key",
    out.ok === true && out.refundId === "rfnd_9" && post?.init?.headers?.["Idempotency-Key"] === "refund-reg-9" && post?.init?.body === "{}");
}

// ================= H4 — capacity RPC =================
for (const [label, src] of [["reg", registrations], ["pay", payments]] as const) {
  check(`H4 ${label}: bump checks rpc.body === true, not just rpc.ok`,
    src.includes("if (rpc.ok) return rpc.body === true;"));
  check(`H4 ${label}: RPC-absent (not ok) falls through to the capped fail-safe fallback`,
    src.includes("/* fall through to capped bump */") && src.includes("Math.min(cap, Math.max(0, Number(event.registeredCount || 0) + delta))"));
  check(`H4 ${label}: fallback +1 at capacity refuses (returns false), -1 at 0 is fine`,
    src.includes("if (next === Number(event.registeredCount || 0)) return delta < 0;"));
  check(`H4 ${label}: remaining check-then-insert race is documented in code`,
    src.includes("check-then-insert"));
}
// --- bumpEventCount logic, run against stubbed Supabase ---
function makeBumpStub(rpc: { ok: boolean; body: any }, eventRow: any | null) {
  const calls: string[] = [];
  const fetchJson = async (url: string, init?: any) => {
    calls.push(`${init?.method || "GET"} ${url}`);
    if (url.includes("/rpc/adjust_event_count")) return { ok: rpc.ok, status: rpc.ok ? 200 : 404, body: rpc.body };
    if (url.includes("/rest/v1/events?id=eq.")) {
      if ((init?.method || "GET").toUpperCase() === "PATCH") return { ok: true, status: 200, body: [{ data: eventRow }] };
      return { ok: !!eventRow, status: eventRow ? 200 : 404, body: eventRow ? [{ data: eventRow }] : [] };
    }
    return { ok: false, status: 404, body: null };
  };
  const supabaseBase = () => "https://example.supabase.co";
  const supabaseHeaders = () => ({});
  const loadEvent = async (_id: string) => eventRow;
  return { calls, fetchJson, supabaseBase, supabaseHeaders, loadEvent };
}
async function runBump(src: string, rpc: { ok: boolean; body: any }, eventRow: any | null, delta: number) {
  const stub = makeBumpStub(rpc, eventRow);
  const fn: any = new Function("fetchJson", "supabaseBase", "supabaseHeaders", "loadEvent", `${jsFn(src, "bumpEventCount")}; return bumpEventCount;`)(stub.fetchJson, stub.supabaseBase, stub.supabaseHeaders, stub.loadEvent);
  return { out: await fn("evt-1", delta), calls: stub.calls };
}
{
  const r = await runBump(registrations, { ok: true, body: false }, { id: "evt-1", registeredCount: 10, capacity: 10 }, 1);
  check("H4 logic reg: RPC ok + body false → false, fallback NOT attempted (no event re-read)",
    r.out === false && !r.calls.some((c) => c.includes("/rest/v1/events?id=eq.") && c.startsWith("GET")));
}
{
  const r = await runBump(payments, { ok: true, body: true }, { id: "evt-1", registeredCount: 9, capacity: 10 }, 1);
  check("H4 logic pay: RPC ok + body true → true, no fallback write", r.out === true && !r.calls.some((c) => c.startsWith("PATCH")));
}
{
  const r = await runBump(registrations, { ok: false, body: null }, { id: "evt-1", registeredCount: 9, capacity: 10 }, 1);
  check("H4 logic reg: RPC absent (404) + seat free → capped fallback bumps, returns true",
    r.out === true && r.calls.some((c) => c.startsWith("PATCH")));
}
{
  const r = await runBump(payments, { ok: false, body: null }, { id: "evt-1", registeredCount: 10, capacity: 10 }, 1);
  check("H4 logic pay: RPC absent (404) + event full → fallback refuses (false), NO patch (fail safe, not open)",
    r.out === false && !r.calls.some((c) => c.startsWith("PATCH")));
}
{
  const r = await runBump(registrations, { ok: false, body: null }, { id: "evt-1", registeredCount: 0, capacity: 10 }, -1);
  check("H4 logic reg: RPC absent + decrement at 0 → true, no write (nothing to release)",
    r.out === true && !r.calls.some((c) => c.startsWith("PATCH")));
}
check("H4 reg: POST confirm rolls back to cancelled + 409 when the bump refuses",
  registrations.includes('cancelledReason: "event_full"') &&
  registrations.includes('sendJson(res, 409, { message: "This event is at full capacity" })'));
check("H4 pay: confirm gates on the bump and refunds + cancels when it refuses",
  payments.includes("if (!bumped)") &&
  payments.includes("refundRazorpayPayment(captured.id, reg.id)") &&
  payments.includes('sendJson(res, 409, { message: "This event is now at full capacity. Your payment has been refunded." })'));
check("H4 pay: if that rollback refund fails, the confirmed pass stands (recorded failed, not taken away)",
  payments.includes("refundFailed: true"));

// ================= M14 — refund preview labelled estimated =================
check("M14: EventDetailsPage preview says 'estimated' (full + partial)",
  detailsPage.includes("an estimated full refund of") && detailsPage.includes("an estimated ${formatPaise"));
check("M14: RegistrationsPage preview says 'estimated' (full + partial)",
  myRegsPage.includes("an estimated full refund of") && myRegsPage.includes("an estimated ${formatPaise"));
check("M14: old absolute wording is gone from both dialogs",
  !detailsPage.includes("You will get a full refund of") && !myRegsPage.includes("You will get a full refund of") &&
  !detailsPage.includes("You will get ${formatPaise") && !myRegsPage.includes("You will get ${formatPaise"));
check("M14: the choice (label, not a new server endpoint) is documented in both pages",
  detailsPage.includes("No server quote endpoint was built for this") &&
  myRegsPage.includes("No server quote endpoint was built for this"));
check("M14: no new quote endpoint was created (no new function file, no quote action)",
  !readFileSync("vercel.json", "utf8").includes("refund-quote") &&
  !registrations.includes("refund-quote") && !payments.includes("refund-quote"));

// ================= M17 — refund amounts on ALL THREE sites =================
check("M17 reg: amounts are on the claim row before the call",
  registrations.includes("refundAmountPaise: quote.refundAmountPaise") &&
  registrations.includes("refundFeePaise: quote.refundFeePaise"));
check("M17 pay: dead/full records the full amount + fee 0 on success and on failure",
  payments.includes('refundStatus: "initiated", refundId: rf.refundId, refundAmountPaise, refundFeePaise: 0') &&
  payments.includes('refundStatus: "failed", refundAmountPaise, refundFeePaise: 0'));
check("M17 pay: bump-rollback path also records the amounts",
  payments.includes("refundAmountPaise, refundFeePaise: 0 })"));
check("M17 events: DELETE records the full amount + fee 0 on the row",
  events.includes("next.refundAmountPaise = refundAmountPaise") &&
  events.includes("next.refundFeePaise = 0") &&
  events.includes("const refundAmountPaise = Number(r.amountPaise)"));
check("M17 events: DELETE refund is full (organizer delete, never the 10% rate)",
  events.includes("refunded IN FULL"));

// ================= Scope =================
check("scope: no new Vercel function file was created",
  !readFileSync("vercel.json", "utf8").includes("api/refund") && !existsSync("api/refund.ts"));
check("scope: no new api/*.ts file was created by this agent",
  !existsSync("api/refund-quote.ts") && !existsSync("api/_lib/refunds.ts"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
