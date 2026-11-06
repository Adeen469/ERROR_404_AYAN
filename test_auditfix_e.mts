// Audit #4 fix batch E — H8 (indexes/performance) + M1, M2, M3*, M4*,
// M5, M6, M7, M8, M9, M16, M17. Runs with:
//   bun test_auditfix_e.mts        (from ~/workspace/vecna-calendar-auditfix-e)
// Same extraction pattern as test_community.mts / test_replies.mts:
// server helpers are module-private, so they are extracted from the
// real files and run; the rest are marker checks on the real code.
// (* M3/M4 are out of scope for this batch — phone-otp status and
// refund amounts belong to other agents; see the report.)
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
  // Body `{`: after the params a `: <return type>` may follow, and
  // the type itself may contain `{...}` (pageOptsFromQuery's
  // `{ limit?: number; ... }`). Skip the type with a small parser
  // (identifiers, balanced {} / () / [] / <>, | / & unions, =>),
  // then the next `{` is the body.
  const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const skipBalanced = (open: string, close: string) => {
    let d = 0;
    for (; i < src.length; i++) {
      if (src[i] === open) d++;
      else if (src[i] === close) { d--; if (d === 0) { i++; return; } }
    }
  };
  const parseType = (): void => {
    skipWs();
    const c = src[i];
    if (c === "{") skipBalanced("{", "}");
    else if (c === "(") { skipBalanced("(", ")"); skipWs(); if (src.slice(i, i + 2) === "=>") { i += 2; parseType(); return; } }
    else if (c === "[") skipBalanced("[", "]");
    else if (/[A-Za-z0-9_.$]/.test(c || "")) {
      while (i < src.length && /[A-Za-z0-9_.$]/.test(src[i])) i++;
      skipWs();
      if (src[i] === "<") skipBalanced("<", ">");
      if (src.slice(i, i + 2) === "[]") i += 2;
    }
    skipWs();
    if (src[i] === "|" || src[i] === "&") { i++; parseType(); }
  };
  i = i + 1;
  skipWs();
  if (src[i] === ":") { i++; parseType(); skipWs(); }
  if (src[i] !== "{") throw new Error(`body brace not found in ${name}`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}
function extractConst(src: string, name: string): string {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`const ${name} not found`);
  const end = src.indexOf("];", start);
  if (end < 0) throw new Error(`const ${name} unterminated`);
  return src.slice(start, end + 2);
}
function jsFn(src: string, name: string): string {
  const ts = extractFn(src, name);
  const out: any = new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
  return typeof out === "string" ? out : out.code;
}

const messages = readFileSync("api/messages.ts", "utf8");
const registrations = readFileSync("api/registrations.ts", "utf8");
const events = readFileSync("api/events.ts", "utf8");
const organizerAccess = readFileSync("api/organizer-access.ts", "utf8");
const notify = readFileSync("api/notify.ts", "utf8");
const payments = readFileSync("api/payments.ts", "utf8");
const service = readFileSync("src/services/messages-service.ts", "utf8");
const indexes = readFileSync("db-indexes.sql", "utf8");

// --- H8: db-indexes.sql ---
check("H8/sql: index file exists with owner-run header",
  indexes.includes("OWNER-RUN ONLY") && indexes.includes("CREATE INDEX IF NOT EXISTS"));
check("H8/sql: messages sender/recipient/eventId indexes",
  indexes.includes("idx_messages_sender") && indexes.includes("idx_messages_recipient") &&
  indexes.includes("idx_messages_event") && indexes.includes("(data->>'senderEmail')") &&
  indexes.includes("(data->>'recipientEmail')") && indexes.includes("(data->>'eventId')"));
check("H8/sql: messages community + idempotency + attachment-path indexes",
  indexes.includes("idx_messages_community") && indexes.includes("idx_messages_idempotency") &&
  indexes.includes("idx_messages_attachment_path"));
check("H8/sql: registrations event/user/event+user indexes",
  indexes.includes("idx_registrations_event") && indexes.includes("idx_registrations_user") &&
  indexes.includes("idx_registrations_event_user"));
check("H8/sql: locora_users email + phone_verifications + email_log indexes",
  indexes.includes("idx_locora_users_email") && indexes.includes("idx_phone_verifications_email") &&
  indexes.includes("idx_email_log_email_created"));
check("H8/sql: rate_limits + revoked_tokens + password_resets indexes",
  indexes.includes("idx_rate_limits_window") && indexes.includes("idx_revoked_tokens_expires") &&
  indexes.includes("idx_password_resets_token_hash"));
check("H8/sql: M6 unique index on locora_users email",
  indexes.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_locora_users_email_unique") &&
  indexes.includes("ON public.locora_users ((data->>'email'))"));

// --- H8: targeted queries + pagination defaults (live: pageOptsFromQuery) ---
const { pageOptsFromQuery }: any = new Function(
  `${jsFn(messages, "pageOptsFromQuery")}; return { pageOptsFromQuery };`,
)();
check("H8/pagination: no-param GET defaults to limit 50",
  pageOptsFromQuery(undefined).limit === 50 && pageOptsFromQuery({}).limit === 50);
check("H8/pagination: explicit limit/before/since pass through",
  pageOptsFromQuery({ limit: "10", before: "2026-01-01", since: "2025-01-01" }).limit === 10);
check("H8/pagination: messages GET always uses the page loader (no full-list branch)",
  !messages.includes("} else {\n          all = await loadMessagesFor(userEmail);") &&
  messages.includes("const page = await loadMessagesForPage(userEmail, pageOpts);"));
check("H8/pagination: community GETs always use the page loader",
  messages.includes("const page = await loadCommunityMessagesPage(GLOBAL_EVENT_ID, pageOpts);") &&
  messages.includes("const page = await loadCommunityMessagesPage(eventId, pageOpts);"));
check("H8/pagination: client legacy getMessages pages backwards via getMessagesPage",
  service.includes("await this.getMessagesPage({ limit: 50, before })") &&
  service.includes("await this.getCommunityMessagesPage(eventId, { limit: 50, before })"));
check("H8/unread: unread count uses a count=exact HEAD query",
  messages.includes('Prefer: "count=exact"') && messages.includes('method: "HEAD"') &&
  messages.includes("countUnreadMessages(userEmail)"));
check("H8/registrations: GET ?id= uses a targeted row fetch, not loadAll",
  registrations.includes("await loadRegistrationById(q.get(\"id\")") &&
  registrations.includes("rest/v1/registrations?id=eq.") &&
  !registrations.includes("const reg = all.find((r: any) => r.id === q.get(\"id\"))"));
check("H8/registrations: PATCH uses the targeted row fetch",
  registrations.includes("const existing = await loadRegistrationById(id);"));
check("H8/events: DELETE loads registrations paged + targeted by eventId",
  events.includes("data->>eventId=eq.${encodeURIComponent(singleId)}&limit=1000&offset=${page * 1000}") &&
  !events.includes("rest/v1/registrations?select=id,data&limit=1000`,\n        { headers: supabaseHeaders() },\n      );\n      const rows = regRes.ok"));
check("H8/idempotency: targeted lookup helper exists and scopes by event+sender",
  messages.includes("loadMessageByIdempotencyKey") &&
  messages.includes("data->>idempotencyKey=eq.") &&
  messages.includes("data->>eventId=eq.") &&
  messages.includes("data->>senderEmail=eq."));
check("H8/idempotency: community send no longer loads the whole room for the key",
  !messages.includes("loadCommunityMessages(eventId).catch(() => [])"));

// --- M1: community strip (live: stripMessageForViewer) ---
const { stripMessageForViewer }: any = new Function(
  `${jsFn(messages, "norm")}\n${jsFn(messages, "stripMessageForViewer")}; return { stripMessageForViewer };`,
)();
const commRow: any = {
  id: "msg-1", type: "community", eventId: "evt-1", senderEmail: "alice@example.com",
  senderName: "Alice", recipientEmail: "community:evt-1", text: "hello",
  replySnapshot: { id: "msg-0", senderEmail: "bob@example.com", senderName: "Bob", text: "quoted", deleted: false },
  readBy: ["alice@example.com"], createdAt: "2026-11-06T10:00:00.000Z",
};
const commOut = stripMessageForViewer(commRow, "bob@example.com");
check("M1: community GET row drops senderEmail + recipientEmail",
  !("senderEmail" in commOut) && !("recipientEmail" in commOut));
check("M1: community reply snapshot drops senderEmail but keeps the name",
  !("senderEmail" in (commOut.replySnapshot || {})) && commOut.replySnapshot?.senderName === "Bob");
check("M1: community row keeps senderName + text + seenCount",
  commOut.senderName === "Alice" && commOut.text === "hello" && commOut.seenCount === 1);
const privRow: any = { ...commRow, type: "private", recipientEmail: "bob@example.com" };
const privOut = stripMessageForViewer(privRow, "bob@example.com");
check("M1: private rows still keep senderEmail/recipientEmail (thread filing)",
  privOut.senderEmail === "alice@example.com" && privOut.recipientEmail === "bob@example.com");
check("M1: broadcast payload reads own/threadKey from the raw row, not the stripped copy",
  messages.includes("own: norm(m.senderEmail") && messages.includes("threadKeyHash(v.eventId, m.senderEmail, m.recipientEmail)"));

// --- M2: delete-upload ownership + rate limit ---
check("M2: delete-upload is rate-limited",
  messages.includes("checkRateLimit(`msg:delete-upload:${me}`"));
check("M2: delete-upload looks up the referencing message by attachment path",
  messages.includes("data->attachment->>path=eq."));
check("M2: delete-upload refuses a non-owner with 403",
  messages.includes("You can only delete your own uploads"));
check("M2: delete-upload allows the event organizer/admin for a referenced upload",
  messages.includes("mayManageEvent(ev, me)") && messages.includes("isManager"));

// --- M5: retention cleanup (admin-only, existing api/notify.ts) ---
check("M5: cleanup lives in the existing api/notify.ts (no new function file)",
  notify.includes('action === "cleanup"') && !notify.includes("export default async function handler") === false);
check("M5: cleanup is admin-only (403 otherwise)",
  notify.includes('if (action === "cleanup")') && notify.includes("if (!isAdmin(session.email))") &&
  notify.includes("Only admins can run cleanup."));
check("M5: cleanup is rate-limited",
  notify.includes("checkRateLimit(`notify:cleanup:${session.email}`"));
check("M5: cleanup deletes rate_limits >24h, email_log >90d, revoked/password_resets expired/used",
  notify.includes("24 * 60 * 60 * 1000") && notify.includes("90 * 24 * 60 * 60 * 1000") &&
  notify.includes("r?.data?.used === true") && notify.includes("runRetentionCleanup"));
check("M5: cleanup documents the monthly cron schedule + the Vercel-cron auth limit",
  notify.includes('cron "0 3 1 * *"') && notify.includes("Vercel\n// Cron Jobs issue unauthenticated GET requests"));

// --- M6: crypto-random ids + 409 re-read ---
check("M6: message ids are crypto-random (newMessageId, no Math.random id)",
  messages.includes("function newMessageId()") && messages.includes("bytesToHex(randomBytes(6))") &&
  messages.includes("id: newMessageId(),"));
check("M6: registration ids are crypto-random when the client sends none",
  registrations.includes("function newRegistrationId()") && registrations.includes("crypto.getRandomValues") &&
  registrations.includes("reg.id = newRegistrationId();"));
check("M6: storeMessage re-reads on a 409 clash instead of failing blindly",
  messages.includes("if (status === 409)") && messages.includes("const existing = await loadMessage(msg.id);"));
check("M6: registration insert re-reads on a 409 clash instead of failing blindly",
  registrations.includes("if (status === 409)") && registrations.includes("const clash = await loadRegistrationById(reg.id);"));

// --- M7: requireAttendeeDetails enforced server-side ---
check("M7: registrations POST enforces attendee details when the event requires them",
  registrations.includes("if (event.requireAttendeeDetails !== false)") &&
  registrations.includes("Attendee name and a valid phone number (7–15 digits) are required for this event"));
check("M7: name <=100 chars and phone 7-15 digits, digits normalized server-side",
  registrations.includes("attName.length > 100") && registrations.includes("attPhone.length < 7 || attPhone.length > 15") &&
  registrations.includes('reg.userPhone.replace(/\\D/g, "")'));

// --- M8: event allowlists (live: validateEventMeta + allowlistedOrganizer) ---
const evtPrelude = [
  extractConst(events, "EVENT_CATEGORIES"),
  extractConst(events, "EVENT_STATUSES"),
  jsFn(events, "isSafeCoverImage"),
  jsFn(events, "validateEventMeta"),
  jsFn(events, "allowlistedOrganizer"),
].join("\n");
const evtHelpers: any = new Function(
  `${evtPrelude}; return { validateEventMeta, allowlistedOrganizer, EVENT_CATEGORIES, EVENT_STATUSES };`,
)();
const { validateEventMeta, allowlistedOrganizer } = evtHelpers;
check("M8: all four event statuses are allowed, anything else refused",
  validateEventMeta({ status: "published" }) === null &&
  validateEventMeta({ status: "draft" }) === null &&
  validateEventMeta({ status: "cancelled" }) === null &&
  validateEventMeta({ status: "completed" }) === null &&
  validateEventMeta({ status: "archived" }) !== null);
check("M8: all seven categories allowed, unknown category refused",
  evtHelpers.EVENT_CATEGORIES.length === 7 &&
  validateEventMeta({ category: "Food & Community" }) === null &&
  validateEventMeta({ category: "Secret Category" }) !== null);
check("M8: slug charset enforced, over-long slug refused",
  validateEventMeta({ slug: "my-event-2026" }) === null &&
  validateEventMeta({ slug: "My Event!" }) !== null &&
  validateEventMeta({ slug: "x".repeat(101) }) !== null);
check("M8: summary capped at 300 chars",
  validateEventMeta({ summary: "ok" }) === null &&
  validateEventMeta({ summary: "x".repeat(301) }) !== null);
check("M8: coverImage allows https + site-relative, refuses javascript:/protocol-relative",
  validateEventMeta({ coverImage: "https://images.unsplash.com/x.jpg" }) === null &&
  validateEventMeta({ coverImage: "/assets/cover.jpg" }) === null &&
  validateEventMeta({ coverImage: "javascript:alert(1)" }) !== null &&
  validateEventMeta({ coverImage: "//evil.example/x.png" }) !== null);
check("M8: organizer allowlist strips extra keys, keeps display counters as numbers",
  (() => {
    const out = allowlistedOrganizer({ id: "o1", name: "Org", slug: "org", avatar: "/a.png", bio: "b", location: "City", role: "admin", upiId: "x@upi", eventsCount: 3, totalAttendeesServed: 42, extra: 1 });
    return out.name === "Org" && out.eventsCount === 3 && out.totalAttendeesServed === 42 &&
      !("role" in out) && !("upiId" in out) && !("extra" in out);
  })());
check("M8: POST + PATCH both call validateEventMeta",
  events.includes("const metaError = validateEventMeta({ status: \"published\"") &&
  events.includes("const metaError = validateEventMeta(updates);"));
check("M8: POST + PATCH store the allowlisted organizer, never a raw spread",
  events.includes("...allowlistedOrganizer(p.organizer)") &&
  events.includes("...allowlistedOrganizer(safeUpdates.organizer)") &&
  !events.includes("...(p.organizer ||"));

// --- M9: registration allowlists + free amount + server registeredAt ---
const { isAllowedRegistrationStatus }: any = new Function(
  `${jsFn(registrations, "isAllowedRegistrationStatus")}; return { isAllowedRegistrationStatus };`,
)();
check("M9: registration status allowlist accepts the known set, refuses the rest",
  isAllowedRegistrationStatus("cancelled") === true &&
  isAllowedRegistrationStatus("confirmed") === true &&
  isAllowedRegistrationStatus("pending") === true &&
  isAllowedRegistrationStatus("hacked") === false &&
  isAllowedRegistrationStatus("") === false);
check("M9: PATCH refuses a status outside the allowlist with 400",
  registrations.includes("if (nextStatus !== undefined && !isAllowedRegistrationStatus(nextStatus))") &&
  registrations.includes("Invalid registration status"));
check("M9: free rows force amountPaise=0 (client value never trusted)",
  registrations.includes("if (!isTeamJoin) reg.amountPaise = totalPaise > 0 ? totalPaise : 0;"));
check("M9: registeredAt is server-side (never client-supplied); reactivation keeps the original",
  registrations.includes("if (!reactivating) reg.registeredAt = new Date().toISOString();") &&
  registrations.includes("registeredAt: existingCancelled.registeredAt || existingCancelled.createdAt") &&
  !registrations.includes("reg.registeredAt = reg.registeredAt ||"));
check("M9: registration id charset enforced",
  registrations.includes("/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/") &&
  registrations.includes("Invalid registration id"));

// --- M16: idempotency scoping + payments fresh re-read ---
check("M16: private idempotency lookup is scoped by eventId+recipientEmail",
  messages.includes("recipientEmail: recipient, community: false") &&
  messages.includes("data->>recipientEmail=eq."));
check("M16: payments confirm path re-reads fresh (shared confirmCapturedPayment, used by verify + webhook)",
  payments.includes("async function confirmCapturedPayment(") &&
  payments.includes("const fresh = await loadRegistration(reg.id);"));
// (auditfix_c / H3: the pre-refund re-read is still `freshDead`;
// the POST-refund re-read was renamed `freshAfter` because
// `freshDead` is now the pre-refund read. The M16 property —
// re-read fresh before saving, only overwrite a still-pending row
// — is unchanged.)
check("M16: payments dead/full path now re-reads fresh before saving",
  payments.includes("const freshDead = await loadRegistration(registrationId);") &&
  payments.includes("if (!freshAfter || freshAfter.status === \"pending\")") &&
  !payments.includes("await saveRegistration({ ...reg, status: \"cancelled\""));

// --- M17: organizer-access rate limit ---
check("M17: organizer-access POST is rate-limited (request 10/h, admin 30/h)",
  organizerAccess.includes("checkRateLimit(`orgacc:request:${email}`, 10, 60 * 60 * 1000)") &&
  organizerAccess.includes("checkRateLimit(`orgacc:post:${email}`, 30, 60 * 60 * 1000)"));
check("M17: organizer-access GETs are rate-limited too",
  organizerAccess.includes("checkRateLimit(`orgacc:get:") &&
  organizerAccess.includes("checkRateLimit(`orgacc:list:"));

// --- No forbidden scope creep ---
check("scope: no new Vercel function file was created",
  !(()=>{ try { readFileSync("api/cleanup.ts", "utf8"); return true; } catch { return false; } })());
check("scope: api/payments.ts refund amounts untouched; confirm re-reads fresh via shared confirmCapturedPayment (webhook reuses it)",
  payments.includes("refundQuote") === false && // refundQuote lives in registrations.ts, not payments.ts
  payments.includes("async function confirmCapturedPayment(") &&
  payments.includes("const fresh = await loadRegistration(reg.id);"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
