// Tests for organizer payout details (assisted manual settlement):
// the organizer saves bank/UPI details on their own /me profile, the
// server normalizes them, public profiles NEVER carry them, and the
// organizer console shows collected / refunds / payable totals.
// Runs with: bun test_payouts.mts
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
  i = src.indexOf("{", i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`function ${name} body not closed`);
}

const auth = readFileSync("api/auth.ts", "utf8");
const types = readFileSync("src/types/index.ts", "utf8");
const page = readFileSync("src/pages/OrganizerEventsPage.tsx", "utf8");

// --- sanitizePayoutDetails: run the real server helper ---
function jsFn(src: string, name: string): string {
  const ts = extractFn(src, name);
  const out: any = new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
  return typeof out === "string" ? out : out.code;
}
const sanitize = new Function(
  `${jsFn(auth, "sanitizePayoutDetails")}; return sanitizePayoutDetails;`
)() as (raw: any) => any;

const full = sanitize({
  holderName: "  Ayan Ansari  ",
  upiId: " ayan@okhdfcbank ",
  accountNumber: "5010 0234 5678",
  ifsc: "hdfc0001234",
});
check("sanitize: trims holder name", full?.holderName === "Ayan Ansari");
check("sanitize: trims UPI id", full?.upiId === "ayan@okhdfcbank");
check("sanitize: strips spaces from account number", full?.accountNumber === "501002345678");
check("sanitize: uppercases IFSC", full?.ifsc === "HDFC0001234");
check("sanitize: UPI-only is fine", sanitize({ holderName: "A", upiId: "a@okicici" })?.upiId === "a@okicici");
check("sanitize: missing holder name -> undefined", sanitize({ upiId: "a@okicici" }) === undefined);
check("sanitize: non-object -> undefined", sanitize("nope") === undefined && sanitize(null) === undefined);
check("sanitize: non-string fields dropped", sanitize({ holderName: "A", upiId: 42 })?.upiId === undefined);

// --- server wiring ---
check("PROFILE_FIELDS accepts payoutDetails", /PROFILE_FIELDS = \[[^\]]*"payoutDetails"/.test(auth));
const publicProfileBody = extractFn(auth, "publicProfile");
check("publicProfile NEVER carries payoutDetails", !publicProfileBody.includes("payoutDetails"));
check("/me GET echoes payout details to the owner only", auth.includes("withOwnerPayout(publicProfile(row, me, session.role), row?.data?.profile)"));
check("/me PATCH normalizes before storing", auth.includes("const pd = sanitizePayoutDetails(updates.payoutDetails);"));

// --- types + client ---
check("PayoutDetails type exists", types.includes("export interface PayoutDetails"));
check("UserProfile carries payoutDetails", types.includes("payoutDetails?: PayoutDetails"));
check("console: payable totals card", page.includes("Payable to you") && page.includes("Collected") && page.includes("Refunds"));
check("console: totals from confirmed Razorpay rows minus refunds",
  page.includes("r.paymentMethod === 'razorpay'") && page.includes("r.refundAmountPaise"));
check("console: account number shown masked (last 4 only)",
  page.includes("savedPayout.accountNumber.slice(-4)") && page.includes("••••"));
check("console: saves through updateProfile", page.includes("authService.updateProfile({") && page.includes("payoutDetails: {"));
check("console: requires holder name and a destination",
  page.includes("Account holder name required") && page.includes("Payout destination missing"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
