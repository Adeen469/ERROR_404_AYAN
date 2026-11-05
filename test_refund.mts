// Logic + marker tests for the 24h / 10% refund rule (2026-11-05,
// user-confirmed: 24h counted FROM PURCHASE; after 24h the user gets
// 90% back, 10% cancellation fee). Runs with:
//   bun test_refund.mts        (from ~/workspace/vecna-calendar-refund)
// Same extraction pattern as test_replies.mts: the server refundQuote
// is module-private, so it is extracted from the real file and run.
// The client getRefundQuote is extracted the same way, and every
// amount case is run against BOTH — server and preview must agree.
import { readFileSync } from "fs";

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
  // NOTE: unlike test_replies.mts, refundQuote/getRefundQuote carry an
  // object-literal return-type annotation (`: { ... } | null {`), so
  // the first "{" after the parameter list is inside the annotation,
  // not the body. The body brace is the first "{" followed by a newline.
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
const privacyPage = readFileSync("src/pages/PrivacyPage.tsx", "utf8");
const formatters = readFileSync("src/utils/formatters.ts", "utf8");

// --- Pure refund amounts: server refundQuote + client getRefundQuote ---
// Both reference the module-level REFUND_WINDOW_MS const, so it is
// defined in the eval scope (the extracted functions are otherwise
// self-contained).
const REFUND_WINDOW = `const REFUND_WINDOW_MS = 24 * 60 * 60 * 1000;`;
const refundQuote: any = new Function(`${REFUND_WINDOW}\n${jsFn(registrations, "refundQuote")}; return refundQuote;`)();
const getRefundQuote: any = new Function(`${REFUND_WINDOW}\n${jsFn(service, "getRefundQuote")}; return getRefundQuote;`)();

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
function paidReg(amountPaise: number, paidHoursAgo: number): any {
  return {
    amountPaise,
    paymentMethod: "razorpay",
    razorpayPaymentId: "pay_123",
    paidAt: new Date(NOW - paidHoursAgo * HOUR).toISOString(),
    registeredAt: new Date(NOW - paidHoursAgo * HOUR).toISOString(),
  };
}
function expectBoth(name: string, reg: any, nowMs: number, expected: any) {
  const s = refundQuote(reg, nowMs);
  const c = getRefundQuote(reg, nowMs);
  check(`${name} (server)`, JSON.stringify(s) === JSON.stringify(expected));
  check(`${name} (client preview agrees)`, JSON.stringify(c) === JSON.stringify(expected));
}

expectBoth("refund: 1h after purchase, ₹500 → full",
  paidReg(50000, 1), NOW, { refundAmountPaise: 50000, refundFeePaise: 0, isFull: true });
expectBoth("refund: exactly 24h after purchase → full (boundary inclusive)",
  paidReg(50000, 24), NOW, { refundAmountPaise: 50000, refundFeePaise: 0, isFull: true });
expectBoth("refund: 24h + 1s after purchase → 90%",
  paidReg(50000, 24 + 1 / 3600), NOW, { refundAmountPaise: 45000, refundFeePaise: 5000, isFull: false });
expectBoth("refund: 48h after purchase, ₹199 → fee ₹19.90, refund ₹179.10",
  paidReg(19900, 48), NOW, { refundAmountPaise: 17910, refundFeePaise: 1990, isFull: false });
expectBoth("refund: fee rounding — ₹19.95, 10% = 199.5 paise → fee 200",
  paidReg(1995, 48), NOW, { refundAmountPaise: 1795, refundFeePaise: 200, isFull: false });
expectBoth("refund: ₹1 (100 paise), 48h → full (tiny-amount edge)",
  paidReg(100, 48), NOW, { refundAmountPaise: 100, refundFeePaise: 0, isFull: true });
expectBoth("refund: ₹0.50 (50 paise), 48h → full",
  paidReg(50, 48), NOW, { refundAmountPaise: 50, refundFeePaise: 0, isFull: true });
expectBoth("refund: 101 paise, 48h → full (computed refund 91p < ₹1 floor)",
  paidReg(101, 48), NOW, { refundAmountPaise: 101, refundFeePaise: 0, isFull: true });
expectBoth("refund: ₹10, 48h → fee ₹1, refund ₹9",
  paidReg(1000, 48), NOW, { refundAmountPaise: 900, refundFeePaise: 100, isFull: false });

// Anchor fallbacks
{
  const noPaidAt = { amountPaise: 50000, paymentMethod: "razorpay", razorpayPaymentId: "pay_1", createdAt: new Date(NOW - 48 * HOUR).toISOString(), registeredAt: new Date(NOW - 1 * HOUR).toISOString() };
  expectBoth("refund: missing paidAt falls back to createdAt (48h → 90%)",
    noPaidAt, NOW, { refundAmountPaise: 45000, refundFeePaise: 5000, isFull: false });
  const onlyRegisteredAt = { amountPaise: 50000, paymentMethod: "razorpay", razorpayPaymentId: "pay_1", registeredAt: new Date(NOW - 1 * HOUR).toISOString() };
  expectBoth("refund: missing paidAt+createdAt falls back to registeredAt (1h → full)",
    onlyRegisteredAt, NOW, { refundAmountPaise: 50000, refundFeePaise: 0, isFull: true });
  const noAnchor = { amountPaise: 50000, paymentMethod: "razorpay", razorpayPaymentId: "pay_1" };
  expectBoth("refund: no anchor at all → full (fail in user's favour)",
    noAnchor, NOW, { refundAmountPaise: 50000, refundFeePaise: 0, isFull: true });
}

// Nothing refundable
check("refund: free row (amount 0) → null",
  refundQuote({ amountPaise: 0, paymentMethod: "razorpay", razorpayPaymentId: "pay_1", paidAt: new Date(NOW - HOUR).toISOString() }, NOW) === null);
check("refund: manual payment row → null",
  refundQuote({ amountPaise: 50000, paymentMethod: "manual", razorpayPaymentId: "pay_1", paidAt: new Date(NOW - HOUR).toISOString() }, NOW) === null);
check("refund: no payment id → null",
  refundQuote({ amountPaise: 50000, paymentMethod: "razorpay", paidAt: new Date(NOW - HOUR).toISOString() }, NOW) === null);
check("refund: client agrees on free row → null",
  getRefundQuote({ amountPaise: 0, paymentMethod: "razorpay", razorpayPaymentId: "pay_1", paidAt: new Date(NOW - HOUR).toISOString() }, NOW) === null);

// --- formatPaise (extracted with its formatPrice dependency) ---
const formatPrice: any = new Function(`${jsFn(formatters, "formatPrice")}; return formatPrice;`)();
const formatPaise: any = new Function(`${jsFn(formatters, "formatPrice")}\n${jsFn(formatters, "formatPaise")}; return formatPaise;`)();
check("formatPaise: paise shown with exactly two decimals", formatPaise(17910) === "₹179.10");
check("formatPaise: ₹500", formatPaise(50000) === "₹500");
check("formatPaise: ₹1,00,000 groups Indian-style", formatPaise(10000000) === "₹1,00,000");

// --- Server: attendee-cancel path uses the quote + partial amount ---
check("server: cancel branch computes the quote from the stored row",
  registrations.includes("const quote = refundQuote(existing);"));
check("server: cancel passes the partial amount only after 24h",
  registrations.includes("refundRazorpayPayment(existing.razorpayPaymentId, quote.isFull ? undefined : quote.refundAmountPaise)"));
check("server: cancel stores the refund amount + fee on the row",
  registrations.includes("merged.refundAmountPaise = quote.refundAmountPaise") &&
  registrations.includes("merged.refundFeePaise = quote.refundFeePaise"));
check("server: refund helper takes an optional amount (partial refund)",
  registrations.includes("refundRazorpayPayment(paymentId: string, amountPaise?: number)") &&
  registrations.includes("{ amount: amountPaise }"));
check("server: cancel still proceeds when the refund call fails",
  registrations.includes('merged.refundStatus = rf.ok ? "initiated" : "failed"'));
check("server: check-in refuses cancelled rows",
  registrations.includes("Only confirmed registrations can be checked in"));
check("server: reactivation clears stale refund bookkeeping",
  registrations.includes("refundStatus: undefined, refundId: undefined, refundAmountPaise: undefined, refundFeePaise: undefined"));
check("server: POST strips smuggled refund fields from the client body",
  registrations.includes("delete (reg as any).refundStatus;") &&
  registrations.includes("delete (reg as any).refundId;"));

// --- Full refunds elsewhere are UNCHANGED ---
check("payments: verify 409 path still calls the full refund (no amount arg)",
  payments.includes("refundRazorpayPayment(captured.id)") &&
  !payments.includes("refundAmountPaise"));
check("payments: helper is still full-refund only (no amount param)",
  payments.includes("async function refundRazorpayPayment(paymentId: string):"));
check("events: organizer DELETE still calls the full refund (no amount arg)",
  events.includes("refundRazorpayPayment(r.razorpayPaymentId)") &&
  !events.includes("refundAmountPaise"));

// --- Client: preview before confirm + refund in the success toast ---
check("client: cancelRegistration returns the cancelled row (refund fields)",
  service.includes("async cancelRegistration(registrationId: string): Promise<AttendeeRegistration | null>"));
check("client: EventDetailsPage shows the refund preview in the dialog",
  detailsPage.includes("cancelRefundMessage") && detailsPage.includes("full refund of"));
check("client: EventDetailsPage toast states the initiated refund amount",
  detailsPage.includes("has been initiated to your original payment method"));
check("client: RegistrationsPage shows the refund preview in the dialog",
  myRegsPage.includes("cancelRefundMessage") && myRegsPage.includes("90%"));
check("client: RegistrationsPage toast states the initiated refund amount",
  myRegsPage.includes("has been initiated to your original payment method"));
check("client: PrivacyPage states the 24h / 10% rule",
  privacyPage.includes("24") && privacyPage.includes("10%") &&
  privacyPage.includes("within 24") && privacyPage.includes("cancelled") &&
  privacyPage.includes("immediately"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
