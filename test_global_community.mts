// Logic + marker tests for the Locora GLOBAL community chat (one
// site-wide room, /community). Runs with:
//   bun test_global_community.mts   (from ~/workspace/vecna-calendar-global)
// Same extraction pattern as test_community.mts / test_replies.mts:
// the server helpers are module-private, so they are extracted from
// the real file and run. Membership + reply validation are pure
// functions; the rest are marker checks on the real server/client
// code.
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
const page = readFileSync("src/pages/CommunityPage.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const navbar = readFileSync("src/components/layout/Navbar.tsx", "utf8");
const realtime = readFileSync("src/services/realtime-service.ts", "utf8");

// Pure helpers, evaluated together (function declarations hoist,
// so cross-references like isGlobalMessage -> isCommunityMessage
// resolve regardless of order).
const prelude = [
  `const ADMIN_EMAILS = ["mr.adeen946@gmail.com", "ayan.work937@gmail.com"];`,
  `const GLOBAL_EVENT_ID = "global";`,
  jsFn(messages, "norm"),
  jsFn(messages, "isEmail"),
  jsFn(messages, "isAdmin"),
  jsFn(messages, "isEventOwner"),
  jsFn(messages, "isCommunityMessage"),
  jsFn(messages, "isGlobalMessage"),
  jsFn(messages, "isGlobalMember"),
  jsFn(messages, "communityRecipient"),
  jsFn(messages, "communityReplyTargetError"),
  jsFn(messages, "buildReplySnapshot"),
  jsFn(messages, "stripMessageForViewer"),
].join("\n");
const helpers: any = new Function(
  `${prelude}; return { isGlobalMember, isGlobalMessage, communityRecipient, communityReplyTargetError, buildReplySnapshot, stripMessageForViewer, isEmail };`,
)();
const { isGlobalMember, isGlobalMessage, communityRecipient, communityReplyTargetError, buildReplySnapshot, stripMessageForViewer, isEmail } = helpers;

// --- Global membership: any signed-in user, no registration ---
check("global member: a signed-in email is a member",
  isGlobalMember("a@x.com") === true);
check("global member: empty email is not a member",
  isGlobalMember("") === false);
check("global member: null/undefined is not a member",
  isGlobalMember(null) === false && isGlobalMember(undefined) === false);
check("global member: blank email is not a member",
  isGlobalMember("   ") === false);

// --- Global marker: never a real email, never a private thread ---
check("global marker: recipient is community:global",
  communityRecipient("global") === "community:global");
check("global marker: community:global is not an email",
  isEmail("community:global") === false);
check("global marker: global room constant is 'global'",
  messages.includes('GLOBAL_EVENT_ID = "global"'));
check("global marker: a global community row is recognised",
  isGlobalMessage({ type: "community", eventId: "global" }) === true);
check("global marker: an event community row is NOT global",
  isGlobalMessage({ type: "community", eventId: "evt-1" }) === false);
check("global marker: a private row in the global room is NOT global",
  isGlobalMessage({ eventId: "global", senderEmail: "a@x.com" }) === false);

// --- Global GET branch (server) ---
check("global GET: dedicated branch loads only global rows",
  messages.includes("loadCommunityMessages(GLOBAL_EVENT_ID)"));
check("global GET: returns member:true for any session user",
  messages.includes("if (eventId === GLOBAL_EVENT_ID)"));
check("global GET: moderator flag comes from approved organizers/admins",
  messages.includes("isOrganizer: await isApprovedOrganizer(me)"));
check("global GET: rows go through the strip whitelist",
  messages.includes("stripMessageForViewer(m, me)"));

// --- No cross-leak (three rooms stay separate) ---
check("leak: private GET excludes community rows",
  messages.includes('m.type !== "community"'));
check("leak: event GET loads only that event's rows",
  messages.includes("loadCommunityMessages(eventId)"));
check("leak: global GET loads only global rows",
  messages.includes("loadCommunityMessages(GLOBAL_EVENT_ID)"));
check("leak: private inbox client filters community rows too",
  service.includes("m.type !== 'community'"));

// --- Global send / upload skip the registration check ---
check("global send: skips the registration check",
  messages.includes("if (!isGlobalSend)"));
check("global send: stand-in event row instead of 404",
  messages.includes('? { id: GLOBAL_EVENT_ID, title: "Community" }'));
check("global upload: skips the registration check",
  messages.includes("if (!isGlobalUpload)"));
check("global edit: skips the event-membership check",
  messages.includes("msg.eventId !== GLOBAL_EVENT_ID"));
check("global delete: moderation is admins + approved organizers",
  messages.includes("isApprovedOrganizer(userEmail)"));
check("global send: no email alerts (community branch returns before sendMail)",
  (() => {
    const start = messages.indexOf("// ---- POST: send a COMMUNITY message ----");
    const end = messages.indexOf("// ---- POST: send a message ----", start);
    const section = messages.slice(start, end);
    return section.includes("No email alert for community messages") && !section.includes("sendMail(");
  })());

// --- Global replies are room-scoped ---
const globalMsg = {
  id: "g-1", type: "community", eventId: "global", senderEmail: "a@x.com",
  senderName: "A", text: "hello everyone", deletedForEveryone: false,
};
const eventMsg = {
  id: "c-1", type: "community", eventId: "evt-1", senderEmail: "a@x.com",
  senderName: "A", text: "hello event", deletedForEveryone: false,
};
const privateMsg = {
  id: "p-1", eventId: "global", senderEmail: "a@x.com",
  recipientEmail: "b@x.com", text: "private", deletedForEveryone: false,
};
check("global reply: quoting a global message is allowed",
  communityReplyTargetError(globalMsg, "global") === null);
check("global reply: quoting an EVENT community message is refused",
  communityReplyTargetError(eventMsg, "global") !== null);
check("global reply: quoting a PRIVATE message is refused",
  communityReplyTargetError(privateMsg, "global") !== null);
check("global reply: quoting a global message from an event room is refused",
  communityReplyTargetError(globalMsg, "evt-1") !== null);
check("global reply: quoting a deleted global message is refused",
  communityReplyTargetError({ ...globalMsg, deletedForEveryone: true }, "global") !== null);
check("global reply: snapshot is frozen server-side (200-char slice)",
  buildReplySnapshot({ ...globalMsg, text: "x".repeat(500) }).text.length === 200);

// --- Service wrappers ---
check("service: global wrappers exist",
  service.includes("getGlobalCommunityMessages") &&
  service.includes("sendGlobalCommunityMessage") &&
  service.includes("requestGlobalCommunityUploadUrl"));
check("service: global wrappers use eventId global",
  service.includes('getCommunityMessages("global")') &&
  service.includes('eventId: "global"'));

// --- CommunityChat global mode (no duplicated component) ---
check("component: mode prop exists (event | global)",
  chat.includes("mode?: 'event' | 'global'"));
check("component: global mode renders its own subtitle",
  chat.includes("Chat with everyone on Locora"));
check("component: global mode loads via the global wrapper",
  chat.includes("getGlobalCommunityMessages()"));
check("component: global mode sends via the global wrapper",
  chat.includes("sendGlobalCommunityMessage("));
check("component: global mode never shows the event register hint",
  chat.includes("!isGlobal && !isRegistered && !isOwner"));

// --- CommunityPage ---
check("page: CommunityPage renders CommunityChat in global mode",
  page.includes('<CommunityChat mode="global" eventId="global"'));
check("page: CommunityPage has a Community heading",
  page.includes(">Community</h1>"));

// --- Route: /community, guarded by RequireSignedIn ---
check("route: CommunityPage is lazy-loaded in App.tsx",
  app.includes("import('./pages/CommunityPage')"));
check("route: /community exists and is RequireSignedIn-guarded",
  app.includes('path="/community"') &&
  app.includes("RequireSignedIn><CommunityPage"));

// --- Navbar: Community link, signed-in nav only, NOT the profile dropdown ---
check("navbar: exactly two Community links (desktop + mobile drawer)",
  (navbar.match(/to="\/community"/g) || []).length === 2);
check("navbar: desktop link is inside a currentUser-gated block",
  (() => {
    const idx = navbar.indexOf('to="/community"');
    return navbar.slice(Math.max(0, idx - 600), idx).includes("{currentUser && (");
  })());
check("navbar: profile dropdown has no Community link",
  (() => {
    const start = navbar.indexOf("Profile Dropdown Menu");
    const end = navbar.indexOf("Sign Out", start);
    return start > 0 && end > start && !navbar.slice(start, end).includes("/community");
  })());
check("navbar: desktop link uses the same active styling as other links",
  navbar.includes("isCurrent('/community')"));

// --- Realtime: per-room ping channel, id-only ---
check("realtime: subscribeToCommunity exists for per-room pings",
  realtime.includes("subscribeToCommunity"));
check("realtime: broadcast payload is id-only",
  realtime.includes("const payload = { id };"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
