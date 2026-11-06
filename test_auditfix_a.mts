// Audit #4 fix tests — agent A scope (C1 + C2 + M17 phone-otp status).
// Runs with:
//   bun test_auditfix_a.mts   (from ~/workspace/vecna-calendar-auditfix-a)
// Marker checks (the handlers are not importable as modules — they are
// default-exported Vercel handlers with top-level env reads) plus
// extracted-function logic checks, same pattern as test_replies.mts.
// No live calls: nothing here touches Supabase, Google, or Vercel.
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

const status = readFileSync("api/calendar/status.ts", "utf8");
const calEvents = readFileSync("api/calendar/events.ts", "utf8");
const calStart = readFileSync("api/auth/google-calendar.ts", "utf8");
const callback = readFileSync("api/auth/callback/google.ts", "utf8");
const phoneOtp = readFileSync("api/phone-otp.ts", "utf8");
const calService = readFileSync("src/services/calendar-service.ts", "utf8");
const eventsService = readFileSync("src/services/events-service.ts", "utf8");
const vercelignore = readFileSync(".vercelignore", "utf8");

// --- C1: api/events/[id].ts is gone, no caller remains ---
check("C1: api/events/[id].ts file deleted", !existsSync("api/events/[id].ts"));
check("C1: .vercelignore no longer lists the deleted route",
  !vercelignore.includes("api/events/\\[id\\].ts") && !vercelignore.includes("api/events/[id].ts"));
check("C1: frontend fetches single events via /events?id=, not /events/<id>",
  eventsService.includes("apiClient.get<EventItem>('/events', { id })"));
check("C1: no apiClient call to /events/<id> anywhere in src",
  !/apiClient\.(get|post|patch|delete)\s*\(\s*['"`]\/events\/\$\{/.test(eventsService));
check("C1: no vercel.json rewrite routes /api/events/<id>",
  !readFileSync("vercel.json", "utf8").includes("/api/events/"));

// --- C2: calendar status route ---
check("C2 status: handler verifies the session", status.includes("verifySession(req)"));
check("C2 status: no session -> 401",
  status.includes('sendJson(res, 401, { message: "Sign in required" })'));
check("C2 status: userId derived from session (locora_users row)",
  status.includes("resolveUserId(session.email)") && status.includes("loadUserByEmail"));
check("C2 status: no client-supplied userId is read",
  !status.includes('firstQuery(req.query, "userId")') && !status.includes("body.userId"));
check("C2 status: DELETE still fails closed 503 when the table is absent",
  status.includes('code === "PGRST205"') && status.includes("calendar_connections table has not been created yet"));
check("C2 status: DELETE keys off the derived userId only",
  status.includes("user_id=eq.\" +\n          encodeURIComponent(userId)") ||
  status.includes("encodeURIComponent(userId)"));

// --- C2: calendar events route ---
check("C2 events: handler verifies the session", calEvents.includes("verifySession(req)"));
check("C2 events: no session -> 401",
  calEvents.includes('sendJson(res, 401, { message: "Sign in required" })'));
check("C2 events: POST ignores body.userId",
  !calEvents.includes("body.userId") && calEvents.includes('typeof body.eventId === "string"'));
check("C2 events: missing table -> 503 (not silent not-connected)",
  calEvents.includes("tableMissing") && calEvents.includes('sendJson(res, 503, {'));
check("C2 events: POST records the created Google event id",
  calEvents.includes("recordCreatedEvent(userId, eventId, inserted.id)"));
check("C2 events: DELETE refuses an unrecorded calendar event id with 403",
  calEvents.includes('sendJson(res, 403, {') && calEvents.includes("was not created by Locora for this account"));
check("C2 events: DELETE resolves the Google id from the recorded ledger only",
  calEvents.includes("recordedIds(connection)") && calEvents.includes("encodeURIComponent(googleEventId)"));
check("C2 events: DELETE never deletes the raw client-supplied id directly",
  !calEvents.includes("encodeURIComponent(calendarEventId)"));
check("C2 events: ledger entry is forgotten after a successful delete",
  calEvents.includes("forgetCreatedEvent(userId, locoraEventId)"));

// recordedIds logic (extracted from the real file and run)
const recordedIds: any = new Function(`${jsFn(calEvents, "recordedIds")}; return recordedIds;`)();
check("ledger: missing data -> empty map", JSON.stringify(recordedIds(null)) === "{}");
check("ledger: missing created_event_ids -> empty map", JSON.stringify(recordedIds({})) === "{}");
check("ledger: array value is not treated as a map", JSON.stringify(recordedIds({ created_event_ids: ["x"] })) === "{}");
check("ledger: keeps only string ids",
  JSON.stringify(recordedIds({ created_event_ids: { e1: "g1", e2: 42, e3: "" } })) === JSON.stringify({ e1: "g1" }));

// --- C2: connect-flow start + callback ---
check("C2 start: handler verifies the session", calStart.includes("verifySession(req)"));
check("C2 start: no session -> 401", calStart.includes("401"));
check("C2 start: no client-supplied userId is read", !calStart.includes("req.query?.userId"));
check("C2 start: state.userId is the session user's row id",
  calStart.includes("const userId = userRow.id;") && calStart.includes("userId, returnTo"));
check("C2 callback: calendar branch verifies the session",
  callback.includes("if (state.purpose === \"calendar\")") && callback.includes("await verifySession(req)"));
check("C2 callback: no session -> 403 error page",
  callback.includes("You must be signed in to Locora to connect Google Calendar"));
check("C2 callback: state.userId must equal the session user's row id",
  callback.includes('state.userId !== calendarUserId'));
check("C2 callback: connection stored under the session row id, not state",
  callback.includes("const calendarUserId = sessionUserRow.id;"));

// --- C2: frontend service stops sending userId ---
check("C2 service: no userId anywhere in calendar-service.ts", !calService.includes("userId"));
check("C2 service: getStatus sends no params", calService.includes("apiClient.get<CalendarStatus>('/calendar/status')"));
check("C2 service: connect sends returnTo only, no userId",
  calService.includes("`/api/auth/google-calendar?returnTo=${encodeURIComponent(returnTo)}`"));
check("C2 service: addEvent posts eventId only",
  calService.includes("apiClient.post<CalendarAddResult>('/calendar/events', { eventId })"));

// --- C2: calendar files stay out of the deployment ---
check("C2: calendar routes stay in .vercelignore (not re-enabled)",
  vercelignore.includes("api/calendar/status.ts") &&
  vercelignore.includes("api/calendar/events.ts") &&
  vercelignore.includes("api/auth/google-calendar.ts"));

// --- M17: phone-otp status requires session + email match ---
const statusBlock = phoneOtp.slice(phoneOtp.indexOf('if (body.action === "status")'));
check("M17: status requires a valid session",
  statusBlock.includes("await verifySession(req)") &&
  statusBlock.includes('sendJson(res, 401, { message: "Sign in required" })'));
check("M17: status refuses a row whose email is not the session email",
  statusBlock.includes('norm(row.email || "") !== session.email') &&
  statusBlock.includes('sendJson(res, 403, { message: "You can only check your own verification status" })'));
check("M17: status still answers not_found for an unknown token",
  statusBlock.includes('sendJson(res, 200, { status: "not_found" })'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
