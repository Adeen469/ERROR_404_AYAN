// Audit #4 final sweep — consolidated integration-state test (agent G).
// Runs with:
//   bun test_auditfix.mts   (from ~/workspace/vecna-calendar-auditfix)
// Static marker checks + extracted-function logic checks, same pattern
// as test_auditfix_a..f/h1. No live calls: nothing here touches
// Supabase, Google, or Vercel.
//
// What it pins down:
//   * the deployed surface (Vercel Hobby 12-function cap, [id].ts gone,
//     one shared rate limiter, owner SQL files, webhook + H1 actions)
//   * the sweep-G gaps closed after the merged fixes (targeted
//     registrations/phone-otp loads, reg PATCH + OTP status limits,
//     generic error strings, category push on the events list,
//     safeLinkUrl on the organizer website link)
//   * the one documented residual full-table load (pendingCounts) stays
//     explicit in code, not silent.
import { readFileSync, existsSync, readdirSync, statSync } from "fs";

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
  throw new Error(`unbalanced braces in ${name}`);
}
function jsFn(src: string, name: string): string {
  const ts = extractFn(src, name);
  const out: any = new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
  return typeof out === "string" ? out : out.code;
}

const auth = readFileSync("api/auth.ts", "utf8");
const events = readFileSync("api/events.ts", "utf8");
const messages = readFileSync("api/messages.ts", "utf8");
const payments = readFileSync("api/payments.ts", "utf8");
const registrations = readFileSync("api/registrations.ts", "utf8");
const phoneOtp = readFileSync("api/phone-otp.ts", "utf8");
const notify = readFileSync("api/notify.ts", "utf8");
const orgAcc = readFileSync("api/organizer-access.ts", "utf8");
const callback = readFileSync("api/auth/callback/google.ts", "utf8");
const orgProfile = readFileSync("src/pages/OrganizerProfilePage.tsx", "utf8");
const rateLimitLib = readFileSync("api/_lib/rate-limit.ts", "utf8");
const uploadField = readFileSync("src/components/events/ImageUploadField.tsx", "utf8");
const vercelignore = readFileSync(".vercelignore", "utf8");

// --- 1: deployed function count (Vercel Hobby cap: 12) ---
function listApiFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = `${dir}/${entry}`;
    if (statSync(p).isDirectory()) listApiFiles(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const ignored = new Set(
  vercelignore.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
);
const deployed = listApiFiles("api")
  .filter((f) => !f.startsWith("api/_lib/"))
  .filter((f) => !ignored.has(f));
console.log("deployed functions:", deployed.join(", "));
check("deployed function count <= 12 (Vercel Hobby cap)", deployed.length <= 12);
check("deployed function count is 11 (10 + api/chatbot.ts, Loci chatbot 2026-11-06)", deployed.length === 11);
for (const f of ["api/auth.ts", "api/events.ts", "api/messages.ts", "api/registrations.ts", "api/payments.ts", "api/phone-otp.ts", "api/notify.ts", "api/organizer-access.ts", "api/auth/callback/google.ts", "api/auth/google.ts"]) {
  check(`deployed set includes ${f}`, deployed.includes(f));
}

// --- 2: C1 route gone, single shared rate limiter ---
check("C1: api/events/[id].ts file deleted", !existsSync("api/events/[id].ts"));
check("PERF: slim list never ships an embedded data-URI cover over ~60KB (one measured 361KB in every list response)",
  events.includes('cover.startsWith("data:") && cover.length > 60_000'));
check("PERF: cover uploads are capped at 1024px so embedded covers stay small",
  uploadField.includes("const MAX_DIMENSION = 1024;"));
const allApiSrc = listApiFiles("api").map((f) => readFileSync(f, "utf8")).join("\n");
check("H2: checkRateLimit defined in the canonical module + inlined into the 9 deployed handlers",
  (allApiSrc.match(/function checkRateLimit\(/g) || []).length === 10);
check("H2: getClientIp defined in the canonical module + inlined into the deployed handlers (phone-otp defines it in its copy but never calls it; api/chatbot.ts carries an extra local copy)",
  (allApiSrc.match(/function getClientIp\(/g) || []).length === 11);
check("H2: shared limiter lives in api/_lib/rate-limit.ts",
  rateLimitLib.includes("export function getClientIp") && rateLimitLib.includes("export async function checkRateLimit"));
for (const [name, src] of [["auth", auth], ["events", events], ["messages", messages], ["registrations", registrations], ["payments", payments], ["phone-otp", phoneOtp], ["notify", notify], ["organizer-access", orgAcc]] as const) {
  check(`H2: ${name} carries the inlined limiter (deployed functions must not import api/_lib — those imports crash live)`,
    !src.includes('from "./_lib/') && src.includes("INLINED from api/_lib/rate-limit.ts"));
}

// --- 3: owner SQL files present with their key statements ---
check("owner SQL: db-indexes.sql present", existsSync("db-indexes.sql"));
check("owner SQL: rate-limit-rpc.sql present", existsSync("rate-limit-rpc.sql"));
const indexes = readFileSync("db-indexes.sql", "utf8");
for (const idx of ["idx_registrations_event", "idx_registrations_event_user", "idx_registrations_user", "idx_messages_idempotency", "idx_messages_sender", "idx_events_category", "idx_phone_verifications_email", "idx_locora_users_email_unique"]) {
  check(`owner SQL: db-indexes.sql defines ${idx}`, indexes.includes(idx));
}
const rpc = readFileSync("rate-limit-rpc.sql", "utf8");
check("owner SQL: rate-limit-rpc.sql defines rate_limit_hit",
  rpc.includes("create or replace function public.rate_limit_hit"));
check("owner SQL: rate-limit-rpc.sql is SECURITY DEFINER",
  rpc.toLowerCase().includes("security definer"));

// --- 4: all auditfix suites present ---
for (const s of ["test_auditfix_a.mts", "test_auditfix_b.mts", "test_auditfix_c.mts", "test_auditfix_d.mts", "test_auditfix_e.mts", "test_auditfix_f.mts", "test_auditfix_h1.mts", "test_auditfix.mts"]) {
  check(`suite file present: ${s}`, existsSync(s));
}

// --- 5: webhook + H1 actions present ---
check("H6: webhook action present in api/payments.ts",
  payments.includes('action === "webhook"'));
check("H1: verify-email action present in api/auth.ts",
  auth.includes("if (endpoint === 'verify-email')"));
check("H1: resend-verification action present in api/auth.ts",
  auth.includes("if (endpoint === 'resend-verification')"));

// --- 6: retention cleanup (M5) — admin-only, rate-limited, schedule documented ---
check("M5: cleanup action exists in api/notify.ts",
  notify.includes('action === "cleanup"'));
check("M5: cleanup is admin-only",
  notify.slice(notify.indexOf('action === "cleanup"')).includes("if (!isAdmin(session.email))"));
check("M5: cleanup is rate-limited per admin",
  notify.includes("notify:cleanup:${session.email}"));
check("M5: monthly cron schedule documented in code",
  notify.includes('0 3 1 * *'));

// --- 7: idempotency lookups are targeted ---
check("H8: messages idempotency lookup is targeted (data->>idempotencyKey=eq.)",
  messages.includes("data->>idempotencyKey=eq."));

// --- 8: sweep G — registrations targeted loads + PATCH limit ---
check("sweep G: reg PATCH is rate-limited per session",
  registrations.includes("reg:patch:${me}"));
check("sweep G: POST dedupe uses the targeted per-event load",
  registrations.includes("const allRegs = await loadRegistrationsForEvent(reg.eventId);"));
check("sweep G: POST no longer loads the whole table",
  !registrations.includes("const allRegs = await loadAllRegistrations();"));
check("sweep G: team-members uses the targeted per-event load",
  registrations.includes("const all = await loadRegistrationsForEvent(teamEventId);"));
check("sweep G: event roster uses the targeted per-event load",
  registrations.includes('const all = await loadRegistrationsForEvent(q.get("eventId") || "");'));
check("sweep G: own-list uses the targeted per-user load",
  registrations.includes("const all = await loadRegistrationsForUser(me);"));
check("sweep G: ticket-code line unchanged (test_auditfix_f invariant)",
  registrations.includes("reg.ticketCode = newTicketCode(allRegs)"));
check("sweep G: site-wide ticket-code guard exists",
  registrations.includes("ticketCodeExists(reg.ticketCode)"));
check("sweep G: pendingCounts residual full load stays explicit in code",
  registrations.includes("the full-table load is kept ONLY for this branch"));

// --- 9: sweep G — phone-otp targeted loads + status limit ---
check("sweep G: OTP verify uses the targeted token lookup",
  phoneOtp.includes("row = await loadRowByToken(token)"));
// Quick API switch (2026-11-06): the dedicated otp route is closed
// for this account (Fast2SMS support), so delivery goes on route "q"
// with the code inside the message text — never back on route "otp"
// without the KYC/DLT gate having cleared.
check("quick-api: OTP delivery uses the Fast2SMS Quick API route",
  phoneOtp.includes('route: "q"') && !phoneOtp.includes('route: "otp"'));
check("quick-api: the message text carries the generated code",
  phoneOtp.includes("Your Locora verification code is ${otp}"));
check("sweep G: token lookup interpolates the real token (not a placeholder)",
  phoneOtp.includes("token=eq.${encodeURIComponent(token)}"));
check("sweep G: OTP send uses the targeted email lookup",
  phoneOtp.includes("rows = await loadRowsByEmail(email)"));
check("sweep G: OTP send/verify/status no longer load the whole table directly",
  !phoneOtp.includes("        rows = await loadRows();"));
check("sweep G: OTP status is rate-limited per session",
  phoneOtp.includes("phoneotp:status:${session.email}"));
check("sweep G: OTP status still answers not_found for an unknown token",
  phoneOtp.slice(phoneOtp.indexOf('if (body.action === "status")')).includes('sendJson(res, 200, { status: "not_found" })'));

// --- 10: sweep G — events list category push ---
check("sweep G: events list passes the query to fetchAllEvents",
  events.includes("fetchAllEvents(req.query)"));
check("sweep G: events list pushes the category filter server-side",
  events.includes("data->>category=eq."));

// --- 11: sweep G — no env-var / doc / gateway internals in user-facing strings ---
const leakSentences: Array<[string, string, string]> = [
  ["auth.ts", auth, "rate limiting is not configured yet. See SECURITY_FIX_SETUP.md."],
  ["phone-otp.ts", phoneOtp, "rate limiting is not configured yet. See SECURITY_FIX_SETUP.md."],
  ["phone-otp.ts", phoneOtp, "Verification table is not set up yet (see FAST2SMS_OTP_SETUP.md)"],
  ["notify.ts", notify, "Shared email log is not configured. See ACCOUNT_EMAILS_SETUP.md."],
  ["organizer-access.ts", orgAcc, "organizer_access table has not been created yet in Supabase. See ORGANIZER_ACCESS_SETUP.md step 2."],
  ["organizer-access.ts", orgAcc, "Shared organizer access is not configured. See ORGANIZER_ACCESS_SETUP.md."],
  ["callback/google.ts", callback, "See CALENDAR_SETUP.md, then try connecting again."],
  ["callback/google.ts", callback, "Server said: ${detail"],
  ["phone-otp.ts", phoneOtp, "Could not send the SMS: ${"],
];
for (const [file, src, leaked] of leakSentences) {
  check(`sweep G: leaked string absent from ${file}: "${leaked.slice(0, 45)}…"`, !src.includes(leaked));
}
check("sweep G: sign-in 503 stays generic (test_auditfix_b prefix intact)",
  auth.includes('sendJson(res, 503, { message: "Sign-in is temporarily unavailable. Please try again shortly." })'));
check("sweep G: OTP 503 stays generic (test_auditfix_b prefix intact)",
  phoneOtp.includes('sendJson(res, 503, { message: "SMS verification is temporarily unavailable. Please try again shortly." })'));

// --- 12: sweep G — organizer website through safeLinkUrl ---
check("sweep G: organizer website is sanitised with safeLinkUrl",
  orgProfile.includes("const websiteUrl = safeLinkUrl(organizer.website);"));
check("sweep G: organizer website anchor uses the sanitised URL",
  orgProfile.includes("href={websiteUrl}"));
check("sweep G: no bare organizer.website href remains",
  !orgProfile.includes("href={organizer.website}"));

// --- 13: logic — safeLinkUrl (L9) ---
const service = readFileSync("src/services/messages-service.ts", "utf8");
const { safeLinkUrl }: any = new Function(
  `${jsFn(service, "safeLinkUrl")}; return { safeLinkUrl };`,
)();
check("L9/logic: safeLinkUrl allows https:", safeLinkUrl("https://example.com/a.png") === "https://example.com/a.png");
check("L9/logic: safeLinkUrl allows blob:", safeLinkUrl("blob:https://example.com/1") === "blob:https://example.com/1");
check("L9/logic: safeLinkUrl rejects javascript:", safeLinkUrl("javascript:alert(1)") === null);
check("L9/logic: safeLinkUrl rejects data:", safeLinkUrl("data:text/html,<script>") === null);
check("L9/logic: safeLinkUrl rejects file:", safeLinkUrl("file:///etc/passwd") === null);
check("L9/logic: safeLinkUrl rejects unparseable input", safeLinkUrl("not a url") === null);

// --- 14: logic — fetchAllEvents category push (sweep G) ---
const { fetchAllEvents }: any = new Function(
  `${jsFn(events, "getEnv")}\n${jsFn(events, "supabaseBase")}\n${jsFn(events, "supabaseHeaders")}\n${jsFn(events, "fetchAllEvents")}; return { fetchAllEvents };`,
)();
(process as any).env.SUPABASE_URL = "https://example.supabase.co";
(process as any).env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
const seenUrls: string[] = [];
let failFirst = false;
(globalThis as any).fetch = async (url: string) => {
  seenUrls.push(String(url));
  if (failFirst && seenUrls.length === 1) return { ok: false, json: async () => ({ message: "boom" }) };
  return { ok: true, json: async () => [{ data: { id: "e1", category: "Workshops" } }] };
};
seenUrls.length = 0;
let rows = await fetchAllEvents({ category: "Workshops" });
check("sweep G/logic: category filter is pushed server-side",
  seenUrls.length === 1 && seenUrls[0].includes("data->>category=eq.Workshops"));
check("sweep G/logic: filtered fetch still returns rows", Array.isArray(rows) && rows.length === 1);
seenUrls.length = 0;
rows = await fetchAllEvents({});
check("sweep G/logic: no category means no server-side filter",
  seenUrls.length === 1 && !seenUrls[0].includes("data->>category"));
seenUrls.length = 0;
rows = await fetchAllEvents({ category: "All" });
check("sweep G/logic: category 'All' means no server-side filter",
  seenUrls.length === 1 && !seenUrls[0].includes("data->>category"));
seenUrls.length = 0;
failFirst = true;
rows = await fetchAllEvents({ category: "Workshops" });
failFirst = false;
check("sweep G/logic: rejected filtered fetch falls back to the unfiltered read",
  seenUrls.length === 2 && seenUrls[1].includes("rest/v1/events?select=data") && !seenUrls[1].includes("data->>category"));
check("sweep G/logic: fallback still returns rows", Array.isArray(rows) && rows.length === 1);

// --- 15: M10/M11 — "New messages" pill counts arrivals only;
//      one 60s dedupe window; community send/retry/delete append
//      instead of a full reload ---
const msgSvc = readFileSync("src/services/messages-service.ts", "utf8");
const inboxPage = readFileSync("src/pages/MessagesPage.tsx", "utf8");
const communityChat = readFileSync("src/components/events/CommunityChat.tsx", "utf8");

// M10: one shared dedupe window, 60s — hide check and reconcile agree.
check("M10: PENDING_DEDUPE_WINDOW_MS is defined as 60s in messages-service",
  /export const PENDING_DEDUPE_WINDOW_MS = 60 \* 1000;/.test(msgSvc));
check("M10: reconcileFailedPending uses the shared window",
  msgSvc.includes("Math.abs(sMs - pMs) > PENDING_DEDUPE_WINDOW_MS"));
check("M10: inbox hide-window uses the shared window",
  inboxPage.includes("Date.parse(s.createdAt) - Date.parse(p.createdAt) < PENDING_DEDUPE_WINDOW_MS"));
check("M10: community hide-window uses the shared window",
  communityChat.includes("Date.parse(s.createdAt) - Date.parse(p.createdAt) < PENDING_DEDUPE_WINDOW_MS"));
check("M10: no 30s dedupe literal remains in either chat page",
  !/Date\.parse\(s\.createdAt\) - Date\.parse\(p\.createdAt\) < 30000/.test(inboxPage) &&
  !/Date\.parse\(s\.createdAt\) - Date\.parse\(p\.createdAt\) < 30000/.test(communityChat));

// M10: tail-key logic — prepend leaves the key, append changes it.
const { lastVisibleKey }: any = new Function(
  `${jsFn(msgSvc, "lastVisibleKey")}; return { lastVisibleKey };`,
)();
const o1 = { id: "o1", createdAt: "2026-11-06T09:58:00.000Z" };
const o2 = { id: "o2", createdAt: "2026-11-06T09:59:00.000Z" };
const n1 = { id: "n1", createdAt: "2026-11-06T10:00:00.000Z" };
const n2 = { id: "n2", createdAt: "2026-11-06T10:01:00.000Z" };
check("M10/logic: tail key of an empty list is ''", lastVisibleKey([]) === "");
check("M10/logic: prepend (loadOlder) leaves the tail key unchanged",
  lastVisibleKey([o2, n1]) === lastVisibleKey([o1, o2, n1]));
check("M10/logic: append (new arrival) changes the tail key",
  lastVisibleKey([o2, n1]) !== lastVisibleKey([o2, n1, n2]));
check("M10/logic: edit/tombstone (same id) leaves the tail key unchanged",
  lastVisibleKey([o2, n1]) === lastVisibleKey([o2, { id: "n1", createdAt: "2026-11-06T10:00:00.000Z" }]));
check("M10/logic: same-tail reload leaves the tail key unchanged",
  lastVisibleKey([o2, n1]) === lastVisibleKey([o2, n1]));

// M10: scroll effects key on the tail, and reset on thread/room switch.
check("M10: inbox scroll effect guards on the tail key",
  inboxPage.includes("if (tailKey === lastSeenKeyRef.current) return;") &&
  inboxPage.includes("[visibleMessages.length, tailKey]"));
check("M10: community scroll effect guards on the tail key",
  communityChat.includes("if (tailKey === lastSeenKeyRef.current) return;") &&
  communityChat.includes("[visible.length, tailKey]"));
check("M10: inbox resets the tail tracker on thread switch",
  inboxPage.includes("lastSeenKeyRef.current = '';"));
check("M10: community resets the tail tracker on room switch",
  communityChat.includes("lastSeenKeyRef.current = '';"));

// M11: community send/retry/delete append, no full reload.
const sendFn = extractFn(communityChat, "handleSend");
const retryFn = extractFn(communityChat, "retrySend");
const deleteFn = extractFn(communityChat, "handleDeleteConfirm");
check("M11: community handleSend appends the created row and does not reload",
  sendFn.includes("setMessages((prev) => (prev.some((m) => m.id === created.id)") &&
  !sendFn.includes("load(true)"));
check("M11: community retrySend appends the created row and does not reload",
  retryFn.includes("setMessages((prev) => (prev.some((m) => m.id === created.id)") &&
  !retryFn.includes("load(true)"));
check("M11: community delete applies the tombstone locally and does not reload",
  deleteFn.includes("deletedForEveryone: true") && !deleteFn.includes("load(true)"));
const pollNewStart = communityChat.indexOf("const pollNew = useCallback");
const pollNewEnd = communityChat.indexOf("}, [currentUser?.email, eventId, load, reconcilePending]);", pollNewStart);
const pollNewFn = communityChat.slice(pollNewStart, pollNewEnd);
check("M11: full reload is still reserved for the ping fallback (pollNew) and quote jumps",
  pollNewFn.includes("await load(true)") &&
  extractFn(communityChat, "jumpToQuoted").includes("load(true)"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
