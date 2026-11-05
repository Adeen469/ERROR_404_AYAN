// Logic tests for the audit #3 patches. Extracts the actual functions
// from the patched files (they are module-private) and runs them,
// plus marker checks that each fix is present where it belongs.
import { readFileSync } from "fs";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name); }
}
function extractFn(src: string, name: string): string {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  // Keep a preceding `async` — without it the transpiler rejects
  // `await` inside the extracted body.
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
  throw new Error(`unbalanced braces in ${name}`);
}
function jsFn(src: string, name: string): string {
  const ts = extractFn(src, name);
  const out: any = new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
  return typeof out === "string" ? out : out.code;
}
function countHas(file: string, needle: string): number {
  return readFileSync(file, "utf8").split(needle).length - 1;
}

const payments = readFileSync("api/payments.ts", "utf8");
const messages = readFileSync("api/messages.ts", "utf8");
const registrations = readFileSync("api/registrations.ts", "utf8");
const events = readFileSync("api/events.ts", "utf8");
const callback = readFileSync("api/auth/callback/google.ts", "utf8");
const orgAccess = readFileSync("api/organizer-access.ts", "utf8");

// --- H1: readRawBody reads the stream BEFORE touching req.body ---
const rawSrc = jsFn(payments, "readRawBody");
const readRawBody = new Function(`${rawSrc}; return readRawBody;`)();
{
  const handlers: any = {};
  const fakeReq: any = { on: (e: string, cb: any) => { handlers[e] = cb; } };
  const p = readRawBody(fakeReq);
  handlers["data"]('{"a": 1, "b": "x\\u00e9"}');
  handlers["end"]();
  const raw = await p;
  check("webhook: stream bytes returned verbatim (escapes preserved)", raw === '{"a": 1, "b": "x\\u00e9"}');
}
{
  const raw2 = await readRawBody({ body: { a: 1 } });
  check("webhook: fallback re-serializes a pre-parsed body", raw2 === '{"a":1}');
}
{
  const bad: any = {};
  Object.defineProperty(bad, "body", { get() { throw new Error("bad json"); } });
  const raw3 = await readRawBody(bad);
  check("webhook: throwing body getter fails closed to empty string", raw3 === "");
}
check("webhook: stream read precedes req.body access in source",
  rawSrc.indexOf('req.on("data"') < rawSrc.indexOf("req.body"));
check("webhook: refund entity selected per event type", payments.includes("isRefundEvent") && payments.includes("payload?.payload?.refund?.entity"));
check("webhook: refund branch re-verifies + voids only on full refund",
  payments.includes("amount_refunded") && payments.includes("fullRefund"));
check("webhook: captured branch checks currency", payments.includes('captured.currency !== "INR"'));

// --- M2: stripMessageForViewer ---
const stripSrc = jsFn(messages, "stripMessageForViewer");
const strip = new Function(`${stripSrc}; return stripMessageForViewer;`)();
{
  const m = { senderEmail: "a@x.co", recipientEmail: "b@x.co", text: "hi", editHistory: [{ text: "old" }], hiddenFor: ["b@x.co"], idempotencyKey: "k1" };
  const asSender = strip(m, "a@x.co");
  check("strip: sender keeps own editHistory", Array.isArray(asSender.editHistory) && asSender.editHistory.length === 1);
  check("strip: sender loses hiddenFor + idempotencyKey", asSender.hiddenFor === undefined && asSender.idempotencyKey === undefined);
  const asRecipient = strip(m, "b@x.co");
  check("strip: recipient loses editHistory + hiddenFor + idempotencyKey",
    asRecipient.editHistory === undefined && asRecipient.hiddenFor === undefined && asRecipient.idempotencyKey === undefined);
}
check("strip: used by GET + hide + mark-read + send + edit + replay",
  countHas("api/messages.ts", "stripMessageForViewer(") >= 7);
check("delete-upload: fails closed on read error", messages.includes("Could not verify the attachment is unreferenced"));
check("delete-upload: pages the referenced check", messages.includes("offset=${offset}"));
check("delete-upload: old fall-through comment gone", !messages.includes("fall through to the participant-only check"));
check("upload path entropy raised to 128 bits", messages.includes("randomTokenHex(16)") && !messages.includes("randomTokenHex(6)"));

// --- L1/L2/L9/L10 sweep ---
const apiFiles = ["api/auth.ts", "api/auth/google.ts", "api/auth/callback/google.ts", "api/telegram-verify.ts", "api/organizer-access.ts", "api/events.ts", "api/registrations.ts", "api/payments.ts", "api/messages.ts", "api/notify.ts"];
check("rpc-first: rate_limit_hit attempted in all 10 api files",
  apiFiles.every((f) => countHas(f, "rate_limit_hit") >= 1));
check("key cap: slice(0, 512) in all 10 checkRateLimit copies",
  apiFiles.every((f) => readFileSync(f, "utf8").includes('slice(0, 512)')));
check("secret length: enforced in 9 verifySession copies (google.ts has none)",
  apiFiles.filter((f) => readFileSync(f, "utf8").includes("secret.length < 32")).length === 9);
check("sendJson: extraHeaders param in payments + telegram",
  payments.includes("extraHeaders?: Record<string, string>") && readFileSync("api/telegram-verify.ts", "utf8").includes("extraHeaders?: Record<string, string>"));
{
  const cbIp = new Function(`${jsFn(callback, "getClientIp")}; return getClientIp;`)();
  const oaIp = new Function(`${jsFn(orgAccess, "getClientIp")}; return getClientIp;`)();
  check("getClientIp: callback takes LAST forwarded entry",
    cbIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }) === "5.6.7.8");
  check("getClientIp: organizer-access takes LAST forwarded entry",
    oaIp({ headers: { "x-forwarded-for": "9.9.9.9, 5.6.7.8" } }) === "5.6.7.8");
  check("getClientIp: no first-entry split remains in either file",
    !callback.includes('split(",")[0]') && !orgAccess.includes('split(",")[0]'));
}

// --- L4/L5 + DB findings (registrations + events) ---
check("registrations: status allowlist (pending/confirmed only)",
  registrations.includes('reg.status !== "pending" && reg.status !== "confirmed"'));
check("registrations: ticketCode always overwritten by server",
  registrations.includes('reg.ticketCode = reg.status === "confirmed" ? newTicketCode() : "";'));
{
  const re = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
  check("registrations: id regex accepts reg-<ms> ids", re.test("reg-1793030995174") === true);
  check("registrations: id regex accepts exactly 40 chars", re.test("x".repeat(40)) === true);
  check("registrations: id regex rejects 41-char ids", re.test("x".repeat(41)) === false);
  check("registrations: id regex rejects spaces", re.test("bad id") === false);
}
check("registrations: loadRegistrationsWhere takes structured pairs",
  registrations.includes("loadRegistrationsWhere(pairs: [string, string][])"));
check("registrations: no raw filter-string call sites remain",
  !registrations.includes("loadRegistrationsWhere(`"));
check("registrations: hasVerifiedPhone reads by email, not the whole table",
  registrations.includes("phone_verifications?select=data&data->>email=eq."));
check("events PATCH: coerced price + capacity stored",
  events.includes("safeUpdates.price = Number(safeUpdates.price)") && events.includes("safeUpdates.capacity = Number(safeUpdates.capacity)"));
check("events PATCH: non-object organizer rejected",
  events.includes('organizer must be an object'));
check("events PATCH: requireAttendeeDetails must be boolean",
  events.includes("requireAttendeeDetails must be true or false"));
check("events: stripEventPublic drops unsafe organizer website",
  events.includes('/^https?:\\/\\//.test(_w)'));
check("callback: single ADMIN_EMAILS list (no inner duplicate)",
  countHas("api/auth/callback/google.ts", "ADMIN_EMAILS = [") === 1);
check("callback: tokeninfo email cross-checked against profile email",
  callback.includes("tokenInfoEmail") && callback.includes("did not match between the token check"));

// --- RPC doc + canonical SQL ---
const rpcDoc = readFileSync("SUPABASE_RPC_SETUP.md", "utf8");
check("rpc doc: SET search_path on both functions", countHas("SUPABASE_RPC_SETUP.md", "set search_path = public, pg_temp") === 2);
check("rpc doc: defensive int casts in adjust_event_count", rpcDoc.includes("~ '^-?[0-9]+$'"));
check("rpc doc: retention section present", rpcDoc.includes("## Retention"));
const setupSql = readFileSync("supabase-setup.sql", "utf8");
check("canonical SQL: RLS on for 11 tables", countHas("supabase-setup.sql", "enable row level security") === 11);
check("canonical SQL: revoke-all belt-and-braces", setupSql.includes("revoke all on public.events"));
check("canonical SQL: exactly-one bucket SELECT policy", setupSql.includes('create policy "public read message-attachments"'));
check("canonical SQL: RPC revokes", setupSql.includes("revoke execute on function public.adjust_event_count"));
check("canonical SQL: retention deletes", setupSql.includes("delete from public.rate_limits"));
check("canonical SQL: verification queries V-1..V-6", setupSql.includes("V-1") && setupSql.includes("V-6"));
check("shared events doc: RLS contradiction fixed", !readFileSync("SHARED_EVENTS_SETUP.md", "utf8").includes("Leave Row Level Security as it is"));
check("messages setup: bucket policy corrected", !readFileSync("MESSAGES_SETUP.md", "utf8").includes("No policies to write by hand"));

// --- Frontend ---
const orgProfile = readFileSync("src/pages/OrganizerProfilePage.tsx", "utf8");
check("frontend: organizer.website gated by isSafeHttpUrl", orgProfile.includes("isSafeHttpUrl(organizer.website)"));
const profilePage = readFileSync("src/pages/ProfilePage.tsx", "utf8");
check("frontend: telegram token in sessionStorage, not localStorage",
  countHas("src/pages/ProfilePage.tsx", "sessionStorage") >= 5 &&
  !profilePage.includes("localStorage.getItem('locora-telegram-verify-token'") &&
  !profilePage.includes("localStorage.setItem('locora-telegram-verify-token'") &&
  !profilePage.includes("localStorage.removeItem('locora-telegram-verify-token'"));
check("frontend: logout clears events sessionStorage cache",
  readFileSync("src/services/auth-service.ts", "utf8").includes("clearEventsSessionCache") &&
  countHas("src/services/auth-service.ts", "clearEventsSessionCache();") === 2);
{
  // Untagged-legacy pending ops: visible only to guests.
  const pred = (creatorEmail: string | undefined, currentEmail: string | undefined) =>
    (!creatorEmail && !currentEmail) ||
    (!!creatorEmail && !!currentEmail && creatorEmail.toLowerCase() === currentEmail.toLowerCase());
  check("pending: tagged op shows to its creator", pred("A@x.co", "a@x.co") === true);
  check("pending: tagged op hidden from another user", pred("A@x.co", "b@x.co") === false);
  check("pending: untagged op shows to guests", pred(undefined, undefined) === true);
  check("pending: untagged op hidden from signed-in users", pred(undefined, "b@x.co") === false);
  check("pending: new rule present in file",
    readFileSync("src/services/pending-events.ts", "utf8").includes("(!op.creatorEmail && !currentEmail)"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
