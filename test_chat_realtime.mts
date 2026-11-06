// Logic + marker tests for the instant-chat Realtime design
// (2026-11-06): full-payload private channels, fast send path,
// attachment + UI fixes. Runs with:
//   bun test_chat_realtime.mts   (from ~/workspace/vecna-calendar-chatfix)
// Same extraction pattern as test_replies.mts: module-private
// helpers are extracted from the real files and run.
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
  const paramClose = i;
  i = src.indexOf("{", i);
  // Return-type object annotation (e.g. `: { limit?: number } | null`):
  // the first `{` opens the annotation, not the body — skip past its
  // balanced braces and take the next `{` as the body open.
  const sig = src.slice(paramClose, i);
  if (/:\s*$/.test(sig)) {
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
// `export const NAME = [ ... ];` — bracket-match the array literal.
function jsConstArray(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = [`);
  if (start < 0) throw new Error(`const ${name} not found`);
  let i = src.indexOf("[", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) return `const ${name} = ${src.slice(src.indexOf("[", start), i + 1)};`;
    }
  }
  throw new Error(`unbalanced brackets in ${name}`);
}

const messages = readFileSync("api/messages.ts", "utf8");
const service = readFileSync("src/services/messages-service.ts", "utf8");
const page = readFileSync("src/pages/MessagesPage.tsx", "utf8");
const community = readFileSync("src/components/events/CommunityChat.tsx", "utf8");
const realtime = readFileSync("src/services/realtime-service.ts", "utf8");
const navbar = readFileSync("src/components/layout/Navbar.tsx", "utf8");

// --- 1. Channel derivation (privateChannelName, live) ---
process.env.SESSION_SECRET = "test-secret-for-chat-realtime";
const { privateChannelName }: any = new Function(`
${jsFn(messages, "getEnv")}
${jsFn(messages, "norm")}
${jsFn(messages, "isEmail")}
${jsFn(messages, "bytesToHex")}
${jsFn(messages, "b64urlToBytes")}
${jsFn(messages, "bytesToB64url")}
${jsFn(messages, "hmacB64url")}
${jsFn(messages, "privateChannelName")}
return { privateChannelName };
`)();

const ch1 = await privateChannelName("alice@example.com");
const ch1b = await privateChannelName("alice@example.com");
const ch2 = await privateChannelName("bob@example.com");
const ch1case = await privateChannelName("Alice@Example.COM");
check("channel: stable per email", !!ch1 && ch1 === ch1b);
check("channel: different per email", ch1 !== ch2);
check("channel: case-insensitive email", ch1 === ch1case);
check("channel: inbox: + 64 hex chars", /^inbox:[0-9a-f]{64}$/.test(ch1 || ""));
check("channel: contains no part of the email",
  !ch1.includes("alice") && !ch1.includes("example"));
process.env.SESSION_SECRET = "a-different-secret";
const ch1rot = await privateChannelName("alice@example.com");
check("channel: secret rotation changes it", !!ch1rot && ch1rot !== ch1);
process.env.SESSION_SECRET = "test-secret-for-chat-realtime";
check("channel: null without a secret",
  (await privateChannelName("alice@example.com")) !== null &&
  (await (async () => {
    const saved = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    const r = await privateChannelName("alice@example.com");
    process.env.SESSION_SECRET = saved;
    return r;
  })()) === null);

// --- 2. Broadcast payload strip (buildRealtimePayload, live) ---
const { stripMessageForViewer, buildRealtimePayload }: any = new Function(`
${jsFn(messages, "norm")}
${jsFn(messages, "cyrb53")}
${jsFn(messages, "threadKeyHash")}
${jsFn(messages, "stripMessageForViewer")}
${jsFn(messages, "isCommunityMessage")}
${jsFn(messages, "buildRealtimePayload")}
return { stripMessageForViewer, buildRealtimePayload };
`)();
const row = {
  id: "msg-9", type: "private", eventId: "evt-1", eventTitle: "Hackathon",
  senderEmail: "alice@example.com", recipientEmail: "bob@example.com",
  senderName: "Alice", text: "hi bob",
  attachment: { name: "pic.png", size: 1234, type: "image/png", url: "https://cdn.example/pic.png" },
  read: false, edited: false, createdAt: "2026-11-06T10:00:00.000Z",
  replySnapshot: { id: "msg-8", senderEmail: "bob@example.com", senderName: "Bob", text: "quoted", deleted: false },
  readBy: ["bob@example.com"],
  phone: "+91-9999999999",
};
const payloadBob = buildRealtimePayload(row, "bob@example.com");
const payloadJson = JSON.stringify(payloadBob);
check("payload: no email anywhere in the payload",
  !payloadJson.includes("alice@example.com") && !payloadJson.includes("bob@example.com"));
check("payload: no phone anywhere in the payload",
  !payloadJson.includes("9999999999"));
check("payload: attachment url present",
  payloadBob.attachment?.url === "https://cdn.example/pic.png");
check("payload: sender name present", payloadBob.senderName === "Alice");
check("payload: reply snapshot is name-only",
  payloadBob.replySnapshot?.senderName === "Bob" && !("senderEmail" in (payloadBob.replySnapshot || {})));
check("payload: own flag true for sender",
  buildRealtimePayload(row, "alice@example.com").own === true);
check("payload: own flag false for recipient", payloadBob.own === false);
check("payload: threadKey present for private, no emails in it",
  typeof payloadBob.threadKey === "string" &&
  payloadBob.threadKey.startsWith("evt-1|") &&
  !payloadBob.threadKey.includes("@"));
check("payload: seenCount from readBy, readBy stripped",
  payloadBob.seenCount === 1 && !("readBy" in payloadBob));
const commPayload = buildRealtimePayload(
  { ...row, type: "community", recipientEmail: "community:evt-1", readBy: ["alice@example.com", "bob@example.com"] },
  "bob@example.com");
check("payload: no threadKey for community", !("threadKey" in commPayload));
check("payload: community seenCount", commPayload.seenCount === 2);
check("payload: stripMessageForViewer keeps senderEmail for the GET path only",
  stripMessageForViewer(row, "bob@example.com").senderEmail === "alice@example.com" &&
  !("readBy" in stripMessageForViewer(row, "bob@example.com")));

// --- 2b. Server/client threadKeyHash agreement (live) ---
// The payload's thread key is a hash of the pair, not the pair
// itself — both sides must compute the identical key or the
// receiver cannot file the message into its thread.
const { threadKeyHash: serverKey }: any = new Function(`
${jsFn(messages, "norm")}
${jsFn(messages, "cyrb53")}
${jsFn(messages, "threadKeyHash")}
return { threadKeyHash };
`)();
const { threadKeyHash: clientKey }: any = new Function(`
${jsFn(service, "cyrb53")}
${jsFn(service, "threadKeyHash")}
return { threadKeyHash };
`)();
check("threadKey: server and client compute the same key",
  serverKey("evt-1", "alice@example.com", "bob@example.com") ===
  clientKey("evt-1", "alice@example.com", "bob@example.com"));
check("threadKey: matches the payload's key",
  payloadBob.threadKey === serverKey("evt-1", "alice@example.com", "bob@example.com"));
check("threadKey: order-independent, different pair differs",
  serverKey("evt-1", "bob@example.com", "alice@example.com") ===
  serverKey("evt-1", "alice@example.com", "bob@example.com") &&
  serverKey("evt-1", "alice@example.com", "carol@example.com") !==
  serverKey("evt-1", "alice@example.com", "bob@example.com"));

// --- 3. Community fan-out member list (live) ---
const { communityMemberEmails }: any = new Function(`
const ADMIN_EMAILS = ["mr.adeen946@gmail.com", "ayan.work937@gmail.com"];
${jsFn(messages, "norm")}
${jsFn(messages, "isEmail")}
${jsFn(messages, "organizerEmailOf")}
${jsFn(messages, "communityMemberEmails")}
return { communityMemberEmails };
`)();
const members = communityMemberEmails({ createdByEmail: "org@example.com" }, [
  { userEmail: "alice@example.com", status: "confirmed" },
  { userEmail: "pending@example.com", status: "pending" },
  { userEmail: "cancelled@example.com", status: "cancelled" },
  { userEmail: "ALICE@example.com", status: "confirmed" },
]);
check("fan-out: confirmed attendee + organizer + admins",
  members.includes("alice@example.com") && members.includes("org@example.com") &&
  members.includes("mr.adeen946@gmail.com") && members.includes("ayan.work937@gmail.com"));
check("fan-out: pending/cancelled excluded",
  !members.includes("pending@example.com") && !members.includes("cancelled@example.com"));
check("fan-out: deduped case-insensitively",
  members.filter((m: string) => m === "alice@example.com").length === 1);

// --- 4. MP4 box-walk + HEIC rejection (live) ---
const { mp4HasFtyp }: any = new Function(`${jsFn(messages, "mp4HasFtyp")}; return { mp4HasFtyp };`)();
const box = (type: string, size: number) => {
  const b = new Uint8Array(size);
  b[0] = (size >> 24) & 255; b[1] = (size >> 16) & 255; b[2] = (size >> 8) & 255; b[3] = size & 255;
  b.set([...type].map((c) => c.charCodeAt(0)), 4);
  return b;
};
const concat = (...arrs: Uint8Array[]) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
check("mp4: ftyp at offset 4 accepted",
  mp4HasFtyp(concat(box("ftyp", 24), box("mdat", 100))) === true);
check("mp4: leading free box then ftyp accepted",
  mp4HasFtyp(concat(box("free", 16), box("ftyp", 24))) === true);
check("mp4: leading wide box then ftyp accepted",
  mp4HasFtyp(concat(box("wide", 16), box("ftyp", 24))) === true);
check("mp4: no ftyp rejected",
  mp4HasFtyp(concat(box("mdat", 100))) === false);
check("mp4: truncated head rejected",
  mp4HasFtyp(new Uint8Array([0, 0, 0, 24])) === false);

const svcScope: any = new Function(`
${jsConstArray(service, "ALLOWED_EXTENSIONS")}
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
${jsFn(service, "extensionOf")}
${jsFn(service, "validateAttachment")}
return { validateAttachment };
`)();
check("attach: HEIC rejected with a plain message",
  (svcScope.validateAttachment(new File([new Uint8Array(10)], "photo.heic", { type: "image/heic" })) || "").includes("HEIC"));
check("attach: jpg allowed",
  svcScope.validateAttachment(new File([new Uint8Array(10)], "pic.jpg", { type: "image/jpeg" })) === null);
check("attach: empty file rejected",
  (svcScope.validateAttachment(new File([], "x.jpg", { type: "image/jpeg" })) || "").includes("empty"));
check("attach: >20MB rejected",
  (svcScope.validateAttachment(new File([new Uint8Array(21 * 1024 * 1024)], "big.mp4", { type: "video/mp4" })) || "").includes("20MB"));

// --- 5. Shared chat UI helpers (live) ---
const ui: any = new Function(`
${jsFn(service, "dayLabel")}
${jsFn(service, "fmtChatTime")}
${jsFn(service, "isNearBottom")}
return { dayLabel, fmtChatTime, isNearBottom };
`)();
const nowIso = new Date().toISOString();
const yestIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
check("ui: dayLabel Today", ui.dayLabel(nowIso) === "Today");
check("ui: dayLabel Yesterday", ui.dayLabel(yestIso) === "Yesterday");
check("ui: dayLabel old date shows a date",
  /\d{4}/.test(ui.dayLabel("2026-01-05T10:00:00.000Z")));
check("ui: fmtChatTime is time-only",
  /\d{1,2}:\d{2}/.test(ui.fmtChatTime(nowIso)) && !ui.fmtChatTime(nowIso).includes("Nov"));
const fakeEl = (scrollHeight: number, scrollTop: number, clientHeight: number) =>
  ({ scrollHeight, scrollTop, clientHeight });
check("ui: near bottom true",
  ui.isNearBottom(fakeEl(1000, 880, 100)) === true);
check("ui: far from bottom false",
  ui.isNearBottom(fakeEl(1000, 0, 100)) === false);
check("ui: null element counts as near bottom",
  ui.isNearBottom(null) === true);
check("ui: custom threshold respected",
  ui.isNearBottom(fakeEl(1000, 700, 100), 120) === false &&
  ui.isNearBottom(fakeEl(1000, 700, 100), 250) === true);

// --- 6. Pagination params (live) ---
const { pageOptsFromQuery }: any = new Function(`${jsFn(messages, "pageOptsFromQuery")}; return { pageOptsFromQuery };`)();
check("paging: no params → null (old behaviour kept)",
  pageOptsFromQuery({}) === null);
check("paging: limit honoured",
  pageOptsFromQuery({ limit: "25" })?.limit === 25);
check("paging: bad limit → default 50",
  pageOptsFromQuery({ limit: "abc" })?.limit === 50);
check("paging: before/since passed through",
  pageOptsFromQuery({ before: "2026-11-01T00:00:00.000Z", since: "2026-11-05T00:00:00.000Z" })?.before === "2026-11-01T00:00:00.000Z" &&
  pageOptsFromQuery({ before: "2026-11-01T00:00:00.000Z", since: "2026-11-05T00:00:00.000Z" })?.since === "2026-11-05T00:00:00.000Z");

// --- 7. Send path (markers on the real server file) ---
check("send: Gmail never awaited before the response",
  !messages.includes("await sendMail"));
check("send: mail is fire-and-forget",
  messages.includes("sendMail(buildMessageEmail(msg, event)).catch(() => {})"));
check("send: private send broadcasts full payload to both channels",
  messages.includes("for (const email of [recipient, sender])") &&
  messages.includes("buildRealtimePayload(msg, email)"));
check("send: broadcast is bounded (1.2s race)",
  messages.includes("broadcastRealtimeSoon") && messages.includes("setTimeout(resolve, 1200)"));
check("send: server broadcasts via Supabase Realtime REST",
  messages.includes("/realtime/v1/api/broadcast"));
check("send: independent reads parallelised",
  (messages.match(/Promise\.all/g) || []).length >= 4);
check("send: GET ?action=channel issues the private channel",
  messages.includes('action === "channel"') && messages.includes("privateChannelName(me)"));
check("send: GET pagination wired",
  messages.includes("pageOptsFromQuery") &&
  messages.includes("loadMessagesForPage") &&
  messages.includes("loadCommunityMessagesPage"));
check("send: typing action exists (rate-limited)",
  messages.includes('body.action === "typing"') && messages.includes("msg:typing:"));
check("send: mark-read action exists",
  messages.includes('body.action === "mark-read"'));
check("send: read receipt broadcast is {type:'read'}",
  messages.includes('event: "read"'));
check("send: global room is ping-only by design",
  messages.includes("topic: `community:${GLOBAL_EVENT_ID}`") &&
  messages.includes("payload: { id: msg.id }"));
check("send: big community rooms fall back to ping (>200)",
  messages.includes("members.length > 200"));

// --- 8. Client: full-payload receive, no refetch ---
check("client: inbox subscribes to the private channel",
  page.includes("subscribeToPrivateChannel(") && page.includes("getRealtimeChannel()"));
check("client: inbox renders full payloads without refetch",
  page.includes("applyRealtimeMessage") && page.includes("setMessages((prev)"));
check("client: inbox handles message/edited/deleted/read/typing events",
  page.includes("ev.type === 'message'") && page.includes("ev.type === 'read'") && page.includes("ev.type === 'typing'"));
check("client: community subscribes to the private channel (event rooms)",
  community.includes("subscribeToPrivateChannel("));
check("client: community keeps the ping subscribe for global",
  community.includes("subscribeToCommunity("));
check("client: ping fallback still exists when Realtime is absent",
  realtime.includes("client = url && anon ? createClient(url, anon) : null") &&
  page.includes("realtimeLive ? 30000 : 3000") &&
  community.includes("realtimeLive ? 30000 : 3000"));

// --- 9. Attachments: failed sends + pending previews ---
check("client: community failed bubble keeps a Retry button",
  community.includes("Retry") && community.includes("failed"));
check("client: pending attachment renders a local preview",
  community.includes("localPreview") && community.includes("PendingAttachment"));
check("client: no empty img src / href in community",
  !community.includes('<img src=""') && !community.includes('<a href=""'));
check("client: community file input has the inbox accept list",
  community.includes('accept=".jpg,.jpeg,.png,.gif,.webp,.mp4,.webm,.mov,.pdf,.doc,.docx,.xls,.xlsx,.xlsm"'));
check("client: upload progress shown in both chats",
  page.includes("uploadProgress") && community.includes("uploadProgress") && community.includes("Uploading…"));

// --- 10. UI: scroll guard, separators, skeletons, typing, receipts ---
check("client: scroll guard + new-messages pill in both chats",
  page.includes("isNearBottom") && page.includes("{newCount} new message") &&
  community.includes("isNearBottom") && community.includes("{newCount} new message"));
check("client: date separators + time-only stamps in both chats",
  page.includes("dayLabel(") && page.includes("fmtChatTime(") &&
  community.includes("dayLabel(") && community.includes("fmtChatTime("));
check("client: community box is ~60vh, not max-h-96",
  community.includes("max-h-[60vh]") && !community.includes("max-h-96"));
check("client: loading skeletons in both chats",
  page.includes("animate-pulse") && community.includes("animate-pulse"));
check("client: typing indicator shown in both chats",
  page.includes("is typing…") && community.includes("typing…"));
check("client: read receipts rendered in both chats",
  page.includes("✓✓ Seen") && community.includes("Seen by"));
check("client: navbar badge refreshes on a Realtime message",
  navbar.includes("subscribeToPrivateChannel") && navbar.includes("getUnreadCount"));
check("client: full-payload handler exists in realtime-service",
  realtime.includes("subscribeToPrivateChannel") && realtime.includes("RealtimeFullEvent"));

// --- 11. Instant-clear + stored-but-response-lost reconcile (2026-11-06) ---
// The generic signature cannot be extracted verbatim (extractFn looks
// for `function name(`), so de-genericise the copy first — the body
// is pure and uses no other helper.
const servicePlain = service.replace(
  /export function reconcileFailedPending<[\s\S]*?>\(/,
  "export function reconcileFailedPending(",
);
const { reconcileFailedPending }: any = new Function(
  `${jsFn(servicePlain, "reconcileFailedPending")}\nreturn { reconcileFailedPending };`,
)();
const ME = "me@example.com";
const T0 = "2026-11-06T12:26:00.000Z";
const failedHi: any = { failed: true, senderEmail: ME, text: "Hi", attachment: null, createdAt: T0 };
const serverHi: any = { senderEmail: ME, text: "Hi", attachment: null, createdAt: "2026-11-06T12:26:01.000Z" };
check("reconcile: matching failed bubble is dropped",
  reconcileFailedPending([failedHi], [serverHi], ME).length === 0);
check("reconcile: different text is kept",
  reconcileFailedPending([failedHi], [{ ...serverHi, text: "Hello" }], ME).length === 1);
check("reconcile: other sender is kept",
  reconcileFailedPending([failedHi], [{ ...serverHi, senderEmail: "other@example.com" }], ME).length === 1);
check("reconcile: outside the 60s window is kept",
  reconcileFailedPending([failedHi], [{ ...serverHi, createdAt: "2026-11-06T12:28:01.000Z" }], ME).length === 1);
check("reconcile: exactly 60s is still a match",
  reconcileFailedPending([failedHi], [{ ...serverHi, createdAt: "2026-11-06T12:27:00.000Z" }], ME).length === 0);
check("reconcile: in-flight (not failed) bubble is kept even when matching",
  reconcileFailedPending([{ ...failedHi, failed: false, pending: true }], [serverHi], ME).length === 1);
check("reconcile: attachment name must match",
  reconcileFailedPending(
    [{ ...failedHi, attachment: { name: "a.png" } }],
    [{ ...serverHi, attachment: { name: "b.png" } }], ME).length === 1);
check("reconcile: matching attachment name is dropped",
  reconcileFailedPending(
    [{ ...failedHi, attachment: { name: "a.png" } }],
    [{ ...serverHi, attachment: { name: "a.png" } }], ME).length === 0);
check("reconcile: one server row matches one failed bubble only (no double-drop)",
  reconcileFailedPending([failedHi, { ...failedHi }], [serverHi], ME).length === 1);
check("reconcile: empty inputs return pending unchanged",
  reconcileFailedPending([failedHi], [], ME).length === 1 &&
  reconcileFailedPending([], [serverHi], ME).length === 0);
check("reconcile: server strips idempotencyKey, so matching cannot use it",
  messages.includes("delete out.idempotencyKey") &&
  service.includes("stripMessageForViewer() deletes it"));
const pageSend = extractFn(page, "handleSend");
const pageRetry = extractFn(page, "retrySend");
const commSend = extractFn(community, "handleSend");
const commRetry = extractFn(community, "retrySend");
check("instant-clear: inbox handleSend clears before the first await",
  pageSend.indexOf("setDraft('');") >= 0 &&
  pageSend.indexOf("setDraft('');") < pageSend.indexOf("await "));
check("instant-clear: inbox handleSend clears exactly once (no success-path clear)",
  (pageSend.match(/setDraft\(''\);/g) || []).length === 1 &&
  (pageSend.match(/setFile\(null\);/g) || []).length === 1 &&
  (pageSend.match(/setReplyTo\(null\);/g) || []).length === 1);
check("instant-clear: inbox retrySend clears before the first await",
  pageRetry.indexOf("setDraft('');") >= 0 &&
  pageRetry.indexOf("setDraft('');") < pageRetry.indexOf("await "));
check("instant-clear: community handleSend clears before the first await",
  commSend.indexOf("setDraft('');") >= 0 &&
  commSend.indexOf("setDraft('');") < commSend.indexOf("await "));
check("instant-clear: community handleSend clears exactly once (no success-path clear)",
  (commSend.match(/setDraft\(''\);/g) || []).length === 1 &&
  (commSend.match(/setFile\(null\);/g) || []).length === 1 &&
  (commSend.match(/setReplyTo\(null\);/g) || []).length === 1);
check("instant-clear: community retrySend clears before the first await",
  commRetry.indexOf("setDraft('');") >= 0 &&
  commRetry.indexOf("setDraft('');") < commRetry.indexOf("await "));
check("instant-clear: stale 'cleared only on success' rule is gone",
  !page.includes("cleared only on success") && !community.includes("cleared only on success"));
check("reconcile: inbox reconciles on load, poll and Realtime arrival",
  page.includes("reconcilePending(page.messages)") && page.includes("reconcilePending([merged])"));
check("reconcile: community reconciles on load, poll and Realtime arrival",
  community.includes("reconcilePending(data.messages)") &&
  community.includes("reconcilePending(page.messages)") &&
  community.includes("reconcilePending([merged])"));
check("reconcile: failed bubble going away clears the composer error line",
  page.includes("if (!next.some((p) => p.failed)) setSendError('')") &&
  community.includes("if (!next.some((p) => p.failed)) setSendError('')"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
