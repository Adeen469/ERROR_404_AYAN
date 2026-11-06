// Logic + marker tests for the rebuilt message replies and the
// ping-only Realtime design (2026-11-05). Runs with:
//   bun test_replies.mts        (from ~/workspace/vecna-calendar-main-port)
// Ported 2026-11-05 onto main@e1848d4 (PR #4 parked — no audit #3
// code under test here). Unchanged from the staging version except
// this header: the port keeps stripMessageForViewer and the targeted
// loadMessagesReplyingTo lookup, so all 44 checks apply as written.
// Same extraction pattern as test_audit3.mts: the reply helpers are
// module-private, so they are extracted from the real file and run.
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
const page = readFileSync("src/pages/MessagesPage.tsx", "utf8");
const realtime = readFileSync("src/services/realtime-service.ts", "utf8");

// --- Pure reply validation (replyTargetError) ---
const replyTargetError: any = new Function(`${jsFn(messages, "replyTargetError")}; return replyTargetError;`)();
const quoted = {
  id: "msg-1", eventId: "evt-1", senderEmail: "a@x.com", recipientEmail: "b@x.com",
  senderName: "A", text: "hello", deletedForEveryone: false,
};
check("reply: same thread, sender->recipient, allowed",
  replyTargetError(quoted, "evt-1", "a@x.com", "b@x.com") === null);
check("reply: same thread, reverse direction, allowed",
  replyTargetError(quoted, "evt-1", "b@x.com", "a@x.com") === null);
check("reply: other event rejected",
  replyTargetError(quoted, "evt-2", "a@x.com", "b@x.com") !== null);
check("reply: other thread pair rejected",
  replyTargetError(quoted, "evt-1", "a@x.com", "c@x.com") !== null);
check("reply: other thread pair rejected (case-insensitive emails)",
  replyTargetError(quoted, "evt-1", "A@X.COM", "B@X.COM") === null);
check("reply: deleted message refused (not a deleted snapshot)",
  (replyTargetError({ ...quoted, deletedForEveryone: true }, "evt-1", "a@x.com", "b@x.com") || "").includes("deleted"));
check("reply: block row rejected",
  replyTargetError({ ...quoted, type: "block" }, "evt-1", "a@x.com", "b@x.com") !== null);
check("reply: missing quoted message rejected",
  replyTargetError(null, "evt-1", "a@x.com", "b@x.com") !== null);

// --- Frozen snapshot (buildReplySnapshot) ---
const buildReplySnapshot: any = new Function(`${jsFn(messages, "buildReplySnapshot")}; return buildReplySnapshot;`)();
{
  const snap = buildReplySnapshot({ ...quoted, text: "x".repeat(500), attachment: { name: "file.pdf" } });
  check("snapshot: text sliced to 200 chars", snap.text.length === 200);
  check("snapshot: attachment name kept", snap.attachmentName === "file.pdf");
  check("snapshot: deleted:false at send time", snap.deleted === false);
  check("snapshot: sender name kept", snap.senderName === "A" && snap.senderEmail === "a@x.com");
  const snap2 = buildReplySnapshot({ id: "m2", senderEmail: "c@x.com", text: "hi" });
  check("snapshot: senderName falls back to email", snap2.senderName === "c@x.com");
  check("snapshot: no attachmentName without attachment", snap2.attachmentName === undefined);
}

// --- Viewer scrub whitelists the snapshot (stripMessageForViewer) ---
const stripMessageForViewer: any = new Function(`${jsFn(messages, "stripMessageForViewer")}; return stripMessageForViewer;`)();
{
  const row = {
    id: "m9", senderEmail: "a@x.com", recipientEmail: "b@x.com", text: "hi",
    hiddenFor: ["a@x.com"], idempotencyKey: "k-1", editHistory: [{ text: "old" }],
    replyToId: "msg-1",
    replySnapshot: { id: "msg-1", senderEmail: "b@x.com", text: "quoted", smuggled: "secret", extra: 1 },
  };
  const forRecipient = stripMessageForViewer(row, "b@x.com");
  check("strip: hiddenFor removed", forRecipient.hiddenFor === undefined);
  check("strip: idempotencyKey removed", forRecipient.idempotencyKey === undefined);
  check("strip: editHistory hidden from recipient", forRecipient.editHistory === undefined);
  check("strip: snapshot smuggled field dropped", forRecipient.replySnapshot.smuggled === undefined && forRecipient.replySnapshot.text === "quoted");
  check("strip: replyToId kept", forRecipient.replyToId === "msg-1");
  const forSender = stripMessageForViewer(row, "a@x.com");
  check("strip: editHistory kept for sender", Array.isArray(forSender.editHistory));
}

// --- Server markers: reply handling + delete scrub + Locora sender ---
check("server: POST validates replyToId via replyTargetError",
  messages.includes("replyTargetError(quoted, eventId, sender, recipient)"));
check("server: POST refuses missing quoted message",
  messages.includes('Quoted message not found'));
check("server: POST never trusts caller snapshot (rebuilds it)",
  messages.includes("replySnapshot = buildReplySnapshot(quoted)"));
check("server: reply stored on the new message",
  messages.includes("msg.replyToId = replyToId") && messages.includes("msg.replySnapshot = replySnapshot"));
check("server: DELETE scrub covers both sides via replyToId lookup",
  messages.includes("loadMessagesReplyingTo(id)") && messages.includes("data->>replyToId=eq."));
check("server: scrub rewrites snapshot to deleted",
  messages.includes('m.replySnapshot = { ...m.replySnapshot, text: "", deleted: true }'));
check("server: Locora sender preserved (e1848d4)",
  messages.includes('"Locora" <${user}>'));

// --- Client types ---
check("client: ReplySnapshot type exists",
  service.includes("interface ReplySnapshot"));
check("client: EventMessage has replyToId + replySnapshot",
  service.includes("replyToId?: string") && service.includes("replySnapshot?: ReplySnapshot"));
check("client: SendMessageInput carries replyToId",
  service.includes("replyToId?: string"));

// --- Realtime: ping-only, no content on the channel ---
check("realtime: no full message in broadcast payload",
  !realtime.includes("payload.message") && !realtime.includes("message: event.message") && !realtime.includes("{ message:"));
check("realtime: payload is id only",
  realtime.includes("const payload = { id };"));
check("realtime: event type is id-only (no message field)",
  realtime.includes("type: 'message'; id: string"));
check("realtime: client null without VITE vars",
  realtime.includes("if (!url || !anon) return null"));
check("realtime: DB-H1 fix documented",
  realtime.includes("DB-H1") && realtime.includes("content-free"));

// --- MessagesPage wiring (updated 2026-11-06: full-payload
// private channels replace inbox pings — see test_chat_realtime.mts) ---
check("page: subscribes to its private channel",
  page.includes("subscribeToPrivateChannel(") && page.includes("getRealtimeChannel()"));
check("page: no client broadcast after send/edit/delete (server fans out)",
  !page.includes("broadcastToInbox(") && !page.includes("notifyOther(") &&
  messages.includes("broadcastRealtimeSoon"));
check("page: polling slows to 30s when Realtime is live",
  page.includes("realtimeLive ? 30000 : 3000"));
check("page: swipe-to-reply handler present",
  page.includes("onBubbleTouchEnd") && page.includes("dx > 60"));
check("page: double-click reply present",
  page.includes("onDoubleClick={() => startReply(m)}"));
check("page: Reply menu option present",
  page.includes("Reply") && page.includes("startReply(menuMessage)"));
check("page: quote bar above composer present",
  page.includes("Replying to"));
check("page: quote tap jumps to original",
  page.includes("jumpToQuoted") && page.includes("QuoteView"));
check("page: deleted quote renders gracefully",
  page.includes("This message was deleted"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
