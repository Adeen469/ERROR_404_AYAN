// Logic + marker tests for the Locora community chat (one group
// chat per event). Runs with:
//   bun test_community.mts        (from ~/workspace/vecna-calendar-community)
// Same extraction pattern as test_replies.mts: the server helpers
// are module-private, so they are extracted from the real file and
// run. Membership + reply validation are pure functions; the rest
// are marker checks on the real server/client code.
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
  throw new Error(`unbalanced braces in ${name}`);
}
function jsFn(src: string, name: string): string {
  const ts = extractFn(src, name);
  const out: any = new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
  return typeof out === "string" ? out : out.code;
}

const messages = readFileSync("api/messages.ts", "utf8");
const service = readFileSync("src/services/messages-service.ts", "utf8");
const chat = readFileSync("src/components/events/CommunityChat.tsx", "utf8");
const details = readFileSync("src/pages/EventDetailsPage.tsx", "utf8");
const realtime = readFileSync("src/services/realtime-service.ts", "utf8");

// Pure helpers, evaluated together so isCommunityMember can call
// norm / isAdmin / isEventOwner. ADMIN_EMAILS mirrors the const in
// api/messages.ts (admin emails are already in the public repo).
const prelude = [
  `const ADMIN_EMAILS = ["mr.adeen946@gmail.com", "ayan.work937@gmail.com"];`,
  jsFn(messages, "norm"),
  jsFn(messages, "isEmail"),
  jsFn(messages, "isAdmin"),
  jsFn(messages, "isEventOwner"),
  jsFn(messages, "isCommunityMessage"),
  jsFn(messages, "isCommunityMember"),
  jsFn(messages, "communityReplyTargetError"),
  jsFn(messages, "buildReplySnapshot"),
  jsFn(messages, "stripMessageForViewer"),
].join("\n");
const helpers: any = new Function(
  `${prelude}; return { isCommunityMember, communityReplyTargetError, buildReplySnapshot, stripMessageForViewer, isEmail };`,
)();
const { isCommunityMember, communityReplyTargetError, buildReplySnapshot, stripMessageForViewer, isEmail } = helpers;

const event = { id: "evt-1", createdByEmail: "org@x.com", organizer: { email: "org@x.com", name: "Org" } };
const legacyEvent = { id: "evt-2", organizer: { email: "legacy@x.com", name: "Legacy" } };
const confirmed = [{ eventId: "evt-1", userEmail: "a@x.com", status: "confirmed" }];
const pending = [{ eventId: "evt-1", userEmail: "a@x.com", status: "pending" }];
const cancelled = [{ eventId: "evt-1", userEmail: "a@x.com", status: "cancelled" }];
const otherEvent = [{ eventId: "evt-9", userEmail: "a@x.com", status: "confirmed" }];

// --- Membership ---
check("member: confirmed registration can join",
  isCommunityMember(event, "a@x.com", confirmed) === true);
check("member: confirmed match is case-insensitive",
  isCommunityMember(event, "A@X.COM", confirmed) === true);
check("member: pending (unpaid) registration cannot join",
  isCommunityMember(event, "a@x.com", pending) === false);
check("member: cancelled registration cannot join",
  isCommunityMember(event, "a@x.com", cancelled) === false);
check("member: no registration cannot join",
  isCommunityMember(event, "a@x.com", []) === false);
check("member: organizer (createdByEmail) can join without registering",
  isCommunityMember(event, "org@x.com", []) === true);
check("member: legacy organizer.email fallback works",
  isCommunityMember(legacyEvent, "legacy@x.com", []) === true);
check("member: admin can join without registering",
  isCommunityMember(event, "mr.adeen946@gmail.com", []) === true);
check("member: confirmed registration for ANOTHER event does not count",
  isCommunityMember(event, "a@x.com", otherEvent) === false);
check("member: no event / no email is not a member",
  isCommunityMember(null, "a@x.com", confirmed) === false &&
  isCommunityMember(event, "", confirmed) === false);

// --- Community marker: never a real email, never a private thread ---
check("marker: community recipient is not an email",
  isEmail("community:evt-1") === false);
check("marker: server builds recipient as community:<eventId>",
  messages.includes('`community:${String(eventId || "")}`'));
check("marker: community send stores type community + marker recipient",
  messages.includes('type: "community",') &&
  messages.includes("recipientEmail: communityRecipient(eventId)"));

// --- No cross-leak ---
check("leak: private GET excludes community rows",
  messages.includes('m.type !== "community"'));
check("leak: community loader returns only community rows for the event",
  messages.includes("isCommunityMessage(m)") &&
  messages.includes('data->>type=eq.community'));
check("leak: community GET returns member/isOrganizer flags, 403 locked otherwise",
  messages.includes("member: true") && messages.includes("member: false"));
check("leak: private inbox client filters community rows too",
  service.includes("m.type !== 'community'"));
check("leak: private send idempotency ignores community rows",
  messages.includes('m.type !== "community" && m.idempotencyKey'));

// --- Community replies ---
const comm = {
  id: "c-1", type: "community", eventId: "evt-1", senderEmail: "a@x.com",
  senderName: "A", text: "hello all", deletedForEveryone: false,
};
const priv = {
  id: "p-1", eventId: "evt-1", senderEmail: "a@x.com", recipientEmail: "b@x.com",
  senderName: "A", text: "private hi", deletedForEveryone: false,
};
check("reply: same-event community reply allowed",
  communityReplyTargetError(comm, "evt-1") === null);
check("reply: cross-event community reply rejected",
  communityReplyTargetError(comm, "evt-2") !== null);
check("reply: private message replyToId rejected in community chat",
  communityReplyTargetError(priv, "evt-1") !== null);
check("reply: block row rejected",
  communityReplyTargetError({ ...comm, type: "block" }, "evt-1") !== null);
check("reply: deleted community message refused",
  (communityReplyTargetError({ ...comm, deletedForEveryone: true }, "evt-1") || "").includes("deleted"));
check("reply: missing quoted message rejected",
  communityReplyTargetError(null, "evt-1") !== null);
check("reply: snapshot frozen from community message",
  buildReplySnapshot({ ...comm, text: "x".repeat(500) }).text.length === 200);
check("reply: server validates community quotes via communityReplyTargetError",
  messages.includes("communityReplyTargetError(quoted, eventId)"));

// --- Strip + moderation ---
{
  const row = {
    id: "c-9", type: "community", eventId: "evt-1", senderEmail: "a@x.com",
    senderName: "A", recipientEmail: "community:evt-1", text: "hi",
    hiddenFor: ["a@x.com"], idempotencyKey: "k-1",
    replyToId: "c-1",
    replySnapshot: { id: "c-1", senderEmail: "b@x.com", text: "quoted", smuggled: "secret" },
  };
  const out = stripMessageForViewer(row, "b@x.com");
  check("strip: community row hides hiddenFor + idempotencyKey",
    out.hiddenFor === undefined && out.idempotencyKey === undefined);
  check("strip: community snapshot smuggled field dropped",
    out.replySnapshot.smuggled === undefined && out.replySnapshot.text === "quoted");
}
check("moderation: organizer/admin can delete any community message",
  messages.includes("canModerateCommunity"));
check("moderation: edit requires current community membership",
  messages.includes("isCommunityMember(event, editor, regs)"));
check("moderation: delete scrub covers community quotes via replyToId lookup",
  messages.includes("loadMessagesReplyingTo(id)"));

// --- No email alerts for community messages ---
check("email: community send never mails (only the private send does)",
  messages.split("sendMail(buildMessageEmail").length - 1 === 1 &&
  messages.includes("No email alert for community messages"));

// --- Attachments reuse the verified path ---
check("attachments: community upload-url branch exists (membership-gated)",
  messages.includes("isCommunityUpload") &&
  messages.includes("isCommunityMember(event, sender, regs)"));
check("attachments: community send verifies magic bytes like private send",
  messages.includes("verifyAttachment(cleanAttachment.path"));

// --- Realtime: per-event ping, id-only ---
check("realtime: subscribeToCommunity on community:<eventId>",
  realtime.includes("subscribeToCommunity") &&
  realtime.includes("`community:${eventId}`"));
check("realtime: broadcastToCommunity exists",
  realtime.includes("broadcastToCommunity"));
check("realtime: ping payload is id only (shared broadcastPing)",
  realtime.includes("const payload = { id };") &&
  !realtime.includes("payload.message"));
check("realtime: community channel documented as public-id, content-free",
  realtime.includes("community:<eventId>"));

// --- Client ---
check("client: getCommunityMessages + sendCommunityMessage exist",
  service.includes("getCommunityMessages") && service.includes("sendCommunityMessage"));
check("client: community upload-url helper exists",
  service.includes("requestCommunityUploadUrl"));
check("client: CommunityChat shows locked placeholder to non-members",
  chat.includes("Join this event to chat with attendees") &&
  chat.includes("Register to join the community chat"));
check("client: CommunityChat shows names only (never renders senderEmail)",
  chat.includes("m.senderName") && !chat.includes("{m.senderEmail}"));
check("client: CommunityChat subscribes to community pings",
  chat.includes("subscribeToCommunity("));
check("client: CommunityChat no longer broadcasts after send/edit/delete (server fans out)",
  !chat.includes("broadcastToCommunity") &&
  messages.includes("communityMemberEmails(event, regs)"));
check("client: CommunityChat has Reply + quote bar",
  chat.includes("Reply") && chat.includes("Replying to"));
check("client: CommunityChat polls 3s, 30s when Realtime is live",
  chat.includes("realtimeLive ? 30000 : 3000"));
check("client: EventDetailsPage renders CommunityChat below the organizer card",
  details.includes("CommunityChat") &&
  details.includes("<CommunityChat") &&
  details.indexOf("<CommunityChat") > details.indexOf("Message organizer"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
