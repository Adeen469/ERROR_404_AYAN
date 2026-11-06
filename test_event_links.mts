// Tests for organizer community links on events (WhatsApp group +
// community page): set at creation with http(s) validation, stored
// on the event, and revealed on the event page ONLY inside the
// confirmed-registration branch. Runs with: bun test_event_links.mts
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
function jsFn(src: string, name: string): string {
  const ts = extractFn(src, name);
  const out: any = new Bun.Transpiler({ loader: "ts" }).transformSync(ts);
  return typeof out === "string" ? out : out.code;
}

const types = readFileSync("src/types/index.ts", "utf8");
const eventsApi = readFileSync("api/events.ts", "utf8");
const createPage = readFileSync("src/pages/CreateEventPage.tsx", "utf8");
const detailsPage = readFileSync("src/pages/EventDetailsPage.tsx", "utf8");
const messagesService = readFileSync("src/services/messages-service.ts", "utf8");

// --- types ---
check("EventItem carries whatsappGroupUrl", types.includes("whatsappGroupUrl?: string"));
check("EventItem carries communityUrl", types.includes("communityUrl?: string"));

// --- server: create + update validation/storage ---
check("create: community links validated http(s) + capped",
  eventsApi.includes('for (const key of ["whatsappGroupUrl", "communityUrl"])') &&
  eventsApi.includes('"Community link must be a valid http(s) URL"'));
check("create: links stored on the event",
  eventsApi.includes("whatsappGroupUrl: communityLinks.whatsappGroupUrl || undefined") &&
  eventsApi.includes("communityUrl: communityLinks.communityUrl || undefined"));
check("update: links validated on edit too",
  eventsApi.includes('updates[key] !== undefined') && eventsApi.includes("updates[key] = m;"));
check("public serializer strips only owner fields (links pass through)",
  eventsApi.includes("const { createdByEmail: _c, upiId: _u, organizer, ...rest } = event;"));

// --- create page ---
check("create page: Community Links section with both inputs",
  createPage.includes("Community Links") &&
  createPage.includes("WhatsApp group link, e.g. https://chat.whatsapp.com/") &&
  createPage.includes("Community link, e.g. https://"));
check("create page: links sent in the create payload",
  createPage.includes("whatsappGroupUrl: whatsappGroupUrl.trim() || undefined") &&
  createPage.includes("communityUrl: communityUrl.trim() || undefined"));
check("create page: links validated before submit",
  createPage.includes("errs[key] = 'Link must start with http:// or https://.'"));
check("create page: hidden-until-registered helper text",
  createPage.includes("only registered attendees can see and open them"));

// --- details page: gated reveal ---
const regBranchStart = detailsPage.indexOf("isRegistered ? (");
const regBranchEnd = detailsPage.indexOf("isPaymentPending", regBranchStart);
const regBranch = regBranchStart >= 0 && regBranchEnd > regBranchStart
  ? detailsPage.slice(regBranchStart, regBranchEnd) : "";
check("details: WhatsApp button lives INSIDE the registered branch",
  regBranch.includes("Join the WhatsApp group"));
check("details: community button lives INSIDE the registered branch",
  regBranch.includes("Visit the community page"));
check("details: buttons render only through safeLinkUrl (https only)",
  regBranch.includes("safeLinkUrl(event.whatsappGroupUrl)") &&
  regBranch.includes("safeLinkUrl(event.communityUrl)"));
const beforeBranch = detailsPage.slice(0, regBranchStart);
check("details: no link buttons before the registered branch",
  !beforeBranch.includes("Join the WhatsApp group") && !beforeBranch.includes("Visit the community page"));

// --- safeLinkUrl: run the real helper ---
const safeLinkUrl = new Function(
  `${jsFn(messagesService, "safeLinkUrl")}; return safeLinkUrl;`
)() as (u?: string | null) => string | null;
check("safeLinkUrl: https WhatsApp invite passes", safeLinkUrl("https://chat.whatsapp.com/AbC123") === "https://chat.whatsapp.com/AbC123");
check("safeLinkUrl: http rejected", safeLinkUrl("http://chat.whatsapp.com/AbC123") === null);
check("safeLinkUrl: javascript: rejected", safeLinkUrl("javascript:alert(1)") === null);
check("safeLinkUrl: empty -> null", safeLinkUrl("") === null && safeLinkUrl(undefined) === null);

// --- edit page: same section, prefilled, clearable ---
const editPage = readFileSync("src/pages/EditEventPage.tsx", "utf8");
check("edit page: Community Links section with both inputs",
  editPage.includes("Community Links") &&
  editPage.includes("WhatsApp group link, e.g. https://chat.whatsapp.com/") &&
  editPage.includes("Community link, e.g. https://"));
check("edit page: fields prefilled from the stored event",
  editPage.includes("setWhatsappGroupUrl(data.whatsappGroupUrl || '')") &&
  editPage.includes("setCommunityUrl(data.communityUrl || '')"));
check("edit page: links sent in the update payload (empty clears)",
  editPage.includes("whatsappGroupUrl: whatsappGroupUrl.trim(),") &&
  editPage.includes("communityUrl: communityUrl.trim(),"));
check("edit page: links validated before submit",
  editPage.includes("errs[key] = 'Link must start with http:// or https://.'"));

// --- public surfaces never reference the links ---
for (const f of ["src/components/events/EventCard.tsx", "src/pages/DiscoverPage.tsx", "src/pages/HomePage.tsx"]) {
  const src = readFileSync(f, "utf8");
  check(`${f.split("/").pop()}: no community-link fields`, !src.includes("whatsappGroupUrl") && !src.includes("communityUrl"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
