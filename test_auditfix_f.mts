// Audit #4 fix batch F — LOWS L1–L10 (plus the user-authorised
// password-policy change for new sign-ups). Runs with:
//   bun test_auditfix_f.mts        (from ~/workspace/vecna-calendar-auditfix-f)
// Same pattern as the other auditfix suites: server helpers are
// imported directly where the module is side-effect free (origin
// check, esc, safeLinkUrl, temp ids), the rest are marker checks on
// the real code. L10 is "leave server.ts alone" — asserted here by
// its untouched content, not by a change.
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { originAllowed, isMutationMethod } from "./api/_lib/origin-check.ts";
import { esc } from "./api/auth/callback/google.ts";
import { safeLinkUrl, newTempId } from "./src/services/messages-service.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name); }
}
const read = (p: string) => readFileSync(p, "utf8");

// ================= L1: CSP =================
const vercel = JSON.parse(read("vercel.json"));
const csp = vercel.headers
  .find((h: any) => h.source === "/(.*)")
  .headers.find((h: any) => h.key === "Content-Security-Policy").value as string;
const directive = (name: string) => {
  const m = csp.match(new RegExp(`${name}\\s+([^;]+)`));
  return m ? m[1].trim() : "";
};
check("L1: vercel.json parses and the CSP header is present", csp.includes("default-src 'self'"));
check("L1: img-src has no bare https: (pinned hosts only)",
  !/(^| )https:( |$)/.test(directive("img-src")) &&
  directive("img-src").includes("https://images.unsplash.com") &&
  directive("img-src").includes("https://*.supabase.co") &&
  directive("img-src").includes("https://lh3.googleusercontent.com"));
check("L1: font-src has no bare https: (fonts.gstatic.com only)",
  !/(^| )https:( |$)/.test(directive("font-src")) &&
  directive("font-src").includes("https://fonts.gstatic.com"));
check("L1: connect-src has no bare wss: (pinned wss://*.supabase.co)",
  !/(^| )wss:( |$)/.test(directive("connect-src")) &&
  directive("connect-src").includes("wss://*.supabase.co") &&
  directive("connect-src").includes("https://*.supabase.co") &&
  ["https://countriesnow.space", "https://ipwho.is", "https://ipapi.co", "https://nominatim.openstreetmap.org"].every((h) => directive("connect-src").includes(h)));
check("L1: frame-src no longer lists api.razorpay.com (never framed)",
  !directive("frame-src").includes("api.razorpay.com") &&
  directive("frame-src").includes("https://checkout.razorpay.com"));
check("L1: script-src keeps 'unsafe-inline' AND the CSP note documents why a nonce/hash is impossible",
  directive("script-src").includes("'unsafe-inline'") &&
  !("_cspNote" in vercel) &&
  read("SECURITY_FIX_SETUP.md").includes("no static hash can match") &&
  read("SECURITY_FIX_SETUP.md").includes("no per-response nonce is possible"));
check("L1: Google callback still serves its inline <script> (the reason 'unsafe-inline' stays)",
  read("api/auth/callback/google.ts").includes("<script>") &&
  read("api/auth/callback/google.ts").includes("escapeForScript(JSON.stringify(returnTo))"));
check("L1: style-src keeps 'unsafe-inline' for the <style> blocks in ImageUploadField",
  directive("style-src").includes("'unsafe-inline'") &&
  read("src/components/events/ImageUploadField.tsx").includes("<style>"));

// ================= L2: OAuth error escaping =================
check("L2: esc() escapes HTML specials",
  esc(`<script>"&'`) === "&lt;script&gt;&quot;&amp;'");
check("L2: errorPage escapes heading + detail (reflected error_description)",
  read("api/auth/callback/google.ts").includes("<h1>${esc(heading)}</h1><p>${esc(detail)}</p>"));
check("L2: htmlPage escapes the <title>",
  read("api/auth/callback/google.ts").includes("<title>${esc(title)}</title>"));
check("L2: noscript returnTo href + calendar email are escaped",
  read("api/auth/callback/google.ts").includes('<a href="${esc(returnTo)}">') &&
  read("api/auth/callback/google.ts").includes("as ${esc(calendarEmail)}"));

// ================= L3: Origin/Referer check =================
check("L3: originAllowed allows same-origin, localhost, Vercel previews; no headers pass (webhook/curl)",
  originAllowed({ headers: { origin: "https://locora-hyperlocal.vercel.app" } }) &&
  originAllowed({ headers: { origin: "http://localhost:5173" } }) &&
  originAllowed({ headers: { origin: "https://locora-git-x.vercel.app" } }) &&
  originAllowed({ headers: {} }) &&
  originAllowed({ headers: { referer: "https://locora-hyperlocal.vercel.app/discover" } }));
check("L3: originAllowed refuses a foreign Origin, an opaque 'null', and a foreign Referer",
  !originAllowed({ headers: { origin: "https://evil.example.com" } }) &&
  !originAllowed({ headers: { origin: "null" } }) &&
  !originAllowed({ headers: { referer: "https://evil.example.com/x" } }));
check("L3: isMutationMethod covers POST/PATCH/PUT/DELETE, not GET",
  isMutationMethod({ method: "POST" }) && isMutationMethod({ method: "PATCH" }) &&
  isMutationMethod({ method: "DELETE" }) && !isMutationMethod({ method: "GET" }));
const mutFiles = ["api/auth.ts", "api/messages.ts", "api/events.ts", "api/registrations.ts", "api/notify.ts", "api/organizer-access.ts"];
for (const p of mutFiles) {
  check(`L3: ${p} enforces the origin check on mutations`,
    !read(p).includes('from "./_lib/origin-check"') &&
    read(p).includes("INLINED from api/_lib/origin-check.ts") &&
    read(p).includes("originAllowed(req)") &&
    read(p).includes('message: "Request origin not allowed"'));
}
check("L3: phone-otp enforces the origin check (POST-only endpoint)",
  !read("api/phone-otp.ts").includes('from "./_lib/origin-check"') &&
  read("api/phone-otp.ts").includes("INLINED from api/_lib/origin-check.ts") &&
  read("api/phone-otp.ts").includes("originAllowed(req)"));
check("L3: payments enforces the origin check but EXEMPTS the Razorpay webhook explicitly",
  read("api/payments.ts").includes('action !== "webhook" && !originAllowed(req)') &&
  read("api/payments.ts").includes("carries no browser Origin"));
check("L3: no new Vercel function file (shared module under api/_lib only)",
  existsSync("api/_lib/origin-check.ts") && !existsSync("api/origin-check.ts"));

// ================= L4: HEAD fallback =================
{
  const m = read("api/messages.ts");
  const v = m.slice(m.indexOf("async function verifyAttachment"));
  check("L4: verifyAttachment falls back to HEAD + Content-Length when the Range GET gives no total",
    v.includes('fetch(url, { method: "HEAD" })') &&
    v.includes('headRes.headers.get("content-length")') &&
    v.includes("MAX_ATTACHMENT_BYTES"));
}

// ================= L5: generic errors =================
check("L5: events 503 no longer names SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY",
  read("api/events.ts").includes("Shared events database is not configured on the server.") &&
  !read("api/events.ts").includes("Set SUPABASE_URL"));
check("L5: Google callback error pages no longer name GOOGLE_CLIENT_* / SESSION_SECRET",
  !read("api/auth/callback/google.ts").includes("GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing on the server") &&
  !read("api/auth/callback/google.ts").includes("SESSION_SECRET is missing on the server") &&
  !read("api/auth/callback/google.ts").includes("Check that GOOGLE_CLIENT_ID in Vercel matches"));
check("L5: phone-otp 503s no longer name the gateway key / Supabase env",
  !read("api/phone-otp.ts").includes("Fast2SMS key missing") &&
  !read("api/phone-otp.ts").includes("Supabase env missing"));

// ================= L6 =================
{
  const otp = read("api/phone-otp.ts");
  check("L6: OTP hash is an HMAC keyed by SESSION_SECRET (not unsalted SHA-256)",
    otp.includes("hmacB64url(secret, `otp:${token}:${ten}:${otp}`)") &&
    otp.includes('getEnv("SESSION_SECRET")') &&
    otp.includes("await otpHashFor(token, ten, otp)"));
  check("L6: no unsalted SHA-256 OTP hash remains (store + verify both use otpHashFor)",
    !otp.includes("sha256Hex(`${token}:${ten}:${otp}`)") &&
    (otp.match(/otpHashFor\(token, ten, otp\)/g) || []).length === 2);
}
{
  const a = read("api/auth.ts");
  check("L6: reset-confirm verifies the mark-used write (retry + honest 500)",
    a.includes("let retired = await markUsed();") &&
    a.includes("if (!retired) retired = await markUsed();") &&
    a.includes("Your password was updated, but the reset link could not be retired."));
  check("L6: logout is fail-closed — a live session whose revocation failed answers ok:false",
    a.includes("const revocationFailed = hadSession && !revoked;") &&
    a.includes("ok: !revocationFailed") &&
    a.includes("could not be revoked — it may stay valid until it expires"));
  check("L6: password min-8 for NEW signups only (server)",
    a.includes("password.length < 8 || password.length > 128") &&
    a.includes("Password must be at least 8 characters"));
  check("L6: reset-confirm keeps its own 6 minimum (no forced change for existing users)",
    a.includes("newPassword.length < 6 || newPassword.length > 128"));
  check("L6: signup client validation + placeholder match the server (8)",
    read("src/pages/SignupPage.tsx").includes("password.length < 8") &&
    read("src/pages/SignupPage.tsx").includes("At least 8 characters") &&
    read("src/services/auth-service.ts").includes("password.length < 8"));
}

// ================= L7 =================
{
  const a = read("api/auth.ts");
  check("L7: me PATCH caps country/state/city at 100 and avatar at 2000",
    a.includes('updates.country.trim().slice(0, 100)') &&
    a.includes('updates.state.trim().slice(0, 100)') &&
    a.includes('updates.city.trim().slice(0, 100)') &&
    a.includes('updates.avatar.trim().slice(0, 2000)'));
  const e = read("api/events.ts");
  check("L7: event price capped at ₹10,00,000 on create AND edit",
    e.includes("const MAX_EVENT_PRICE_RUPEES = 1000000;") &&
    e.includes("price > MAX_EVENT_PRICE_RUPEES") &&
    e.includes("pr > MAX_EVENT_PRICE_RUPEES") &&
    e.includes("Price must be between 0 and ₹10,00,000"));
}

// ================= L8 =================
{
  const r = read("api/registrations.ts");
  check("L8: newTicketCode retries on clash against the live rows",
    r.includes("function newTicketCode(existing: any[]): string") &&
    r.includes("for (let attempt = 0; attempt < 8; attempt++)") &&
    r.includes("r.ticketCode === code && r.status !== \"cancelled\"") &&
    r.includes("reg.ticketCode = newTicketCode(allRegs)"));
  check("L8: registrations load ordered server-side by created_at desc",
    r.includes("rest/v1/registrations?select=id,data&order=created_at.desc"));
  const p = read("api/payments.ts");
  check("L8: payment-confirm mints via a clash-checked unique code (targeted lookup, no full scan)",
    p.includes("async function newTicketCodeUnique()") &&
    p.includes("data->>ticketCode=eq.") &&
    p.includes("ticketCode: fresh.ticketCode || (await newTicketCodeUnique())"));
  check("L8: payments.ts has no client-side sorting left to move server-side",
    !p.includes(".sort(") && !p.includes(".reverse()"));
}

// ================= L9 =================
check("L9: motion removed from package.json and imported nowhere",
  !JSON.parse(read("package.json")).dependencies["motion"] &&
  !read("package.json").includes('"motion"') &&
  !grepTree("src", /from ['"]motion['"]/).length &&
  !grepTree("api", /from ['"]motion['"]/).length &&
  !read("server.ts").includes("motion"));
function grepTree(dir: string, re: RegExp): string[] {
  // Small recursive grep over .ts/.tsx files (test-only helper).
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = `${d}/${e}`;
      if (statSync(p).isDirectory()) { if (e !== "node_modules") walk(p); continue; }
      if (/\.(ts|tsx)$/.test(p) && re.test(read(p))) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}
check("L9: @google/genai KEPT — it is used by server.ts (L10: leave alone), so it is not dead",
  !!JSON.parse(read("package.json")).dependencies["@google/genai"] &&
  read("server.ts").includes("from '@google/genai'"));
{
  const ev = read("src/services/events-service.ts");
  check("L9: demo events seed only in demo mode (empty store is empty in production)",
    ev.includes("if (!isDemoMode()) return [];") &&
    !ev.includes("organizer: payload.organizer || DEMO_ORGANIZERS[0]"));
  check("L9: unused DEMO imports removed from registrations/saved-events services",
    !read("src/services/registrations-service.ts").includes("DEMO_EVENTS") &&
    !read("src/services/saved-events-service.ts").includes("DEMO_EVENTS"));
  check("L9: organizers-service demo lookup was already dev-gated (isDemoMode)",
    read("src/services/organizers-service.ts").includes("if (!isDemoMode())"));
}
check("L9: safeLinkUrl allows https:/blob: and rejects javascript:/data:/relative",
  safeLinkUrl("https://example.supabase.co/x.png") === "https://example.supabase.co/x.png" &&
  safeLinkUrl("blob:https://x/abc") === "blob:https://x/abc" &&
  safeLinkUrl("javascript:alert(1)") === null &&
  safeLinkUrl("data:text/html,<script>") === null &&
  safeLinkUrl("/relative/path") === null &&
  safeLinkUrl("") === null);
check("L9: temp ids carry a crypto-random suffix (no bare temp-<ms>)",
  /^temp-\d+-[0-9a-f]{12}$/.test(newTempId()) &&
  !read("src/pages/MessagesPage.tsx").includes("`temp-${Date.now()}`") &&
  !read("src/components/events/CommunityChat.tsx").includes("`temp-${Date.now()}`") &&
  read("src/pages/MessagesPage.tsx").includes("id: newTempId()") &&
  read("src/components/events/CommunityChat.tsx").includes("id: newTempId()"));
for (const p of ["src/pages/MessagesPage.tsx", "src/components/events/CommunityChat.tsx"]) {
  const s = read(p);
  check(`L9: ${p} revokes object URLs when bubbles leave pending + on unmount`,
    s.includes("URL.revokeObjectURL(url)") &&
    s.includes("pendingPreviewsRef") &&
    s.includes("URL.createObjectURL(sendingFile)"));
  check(`L9: ${p} skips poll ticks while document.hidden and resumes on visible`,
    s.includes("if (document.hidden) return;") &&
    s.includes("document.addEventListener('visibilitychange', onVisible)"));
  check(`L9: ${p} labels its chat inputs (composer + edit + file)`,
    s.includes('aria-label="Write a message"') || s.includes('aria-label="Message the community"'));
  check(`L9: ${p} validates attachment links via safeLinkUrl`,
    s.includes("safeLinkUrl(a.url)") && !s.includes("href={a.url}") && !s.includes("src={a.url}"));
}
check("L9: private-chat bubbles are keyboard-focusable — Enter starts a reply",
  read("src/pages/MessagesPage.tsx").includes("tabIndex={0}") &&
  read("src/pages/MessagesPage.tsx").includes("Press Enter to reply") &&
  read("src/pages/MessagesPage.tsx").includes("if (e.key === 'Enter')"));
check("L9: quote jump preserves hasMore (no forced false)",
  read("src/pages/MessagesPage.tsx").includes("const hadMore = hasMore;") &&
  read("src/pages/MessagesPage.tsx").includes("setHasMore(hadMore)"));
check("L9: cancel toasts carry the refund reason (24h full vs 10% fee)",
  read("src/pages/RegistrationsPage.tsx").includes("You cancelled within 24 hours of purchase, so the full amount is refunded.") &&
  read("src/pages/RegistrationsPage.tsx").includes("You cancelled more than 24 hours after purchase, so a 10% cancellation fee applies.") &&
  read("src/pages/EventDetailsPage.tsx").includes("You cancelled within 24 hours of purchase, so the full amount is refunded.") &&
  read("src/pages/EventDetailsPage.tsx").includes("You cancelled more than 24 hours after purchase, so a 10% cancellation fee applies."));

// ================= L10: server.ts untouched =================
check("L10: server.ts left alone (still the GoogleGenAI dev server, no audit markers)",
  read("server.ts").includes("from '@google/genai'") &&
  !read("server.ts").includes("audit #4") &&
  !read("server.ts").includes("L9 (audit") &&
  !read("server.ts").includes("L10 (audit"));

// ================= Scope =================
check("scope: deployed Vercel function count still 11 (10 + api/chatbot.ts)",
  (() => {
    // Same count rule as test_auditfix_b: api/**/*.ts minus _lib
    // minus .vercelignore entries.
    const ignored = new Set(read(".vercelignore").split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#")));
    const all = grepTree("api", /./);
    const deployed = all.filter((p) => !p.startsWith("api/_lib/") && !ignored.has(p));
    return deployed.length === 11;
  })());

// --- Stale-chunk recovery + stale cover resolution (2026-11-06) ---
const appTsx = read("src/App.tsx");
const errorBoundaryTsx = read("src/components/ui/ErrorBoundary.tsx");
const eventsServiceTs = read("src/services/events-service.ts");
check("chunk recovery: page chunks load through the retrying lazyPage wrapper",
  appTsx.includes("function lazyPage") &&
  (appTsx.match(/lazyPage\(\(\) => import/g) || []).length >= 20 &&
  !appTsx.includes("= lazy(() => import"));
check("chunk recovery: boundary reloads at most once on a chunk-load error",
  errorBoundaryTsx.includes("export function reloadOnceForChunkError") &&
  errorBoundaryTsx.includes("locora-chunk-reload") &&
  errorBoundaryTsx.includes("componentDidCatch") &&
  appTsx.includes("reloadOnceForChunkError(err)"));
check("covers: stale hashed /assets paths resolve to the bundled cover by stripped filename",
  eventsServiceTs.includes("withMigratedCover") &&
  eventsServiceTs.includes("replace(/-[A-Za-z0-9_-]{8,}") &&
  eventsServiceTs.includes("withMigratedCover(e)") &&
  eventsServiceTs.includes("withMigratedCover(fetched)"));

// --- Discover location: no automatic IP location (owner, 2026-11-06) ---
// Discover must never auto-fill its location filter from the
// visitor's IP (or silently from the saved profile location); the
// explicit Near-me tap stays. Profile and Create Event keep their
// IP detection — the removal is scoped to Discover only.
const discoverPageTsx = read("src/pages/DiscoverPage.tsx");
check("discover: no IP location detection on the Discover page",
  !discoverPageTsx.includes("detectLocationByIp()") &&
  !discoverPageTsx.includes("services/location-service"));
check("discover: IP detection untouched on Profile and Create Event",
  read("src/pages/ProfilePage.tsx").includes("detectLocationByIp") &&
  read("src/pages/CreateEventPage.tsx").includes("detectLocationByIp"));
check("discover: the explicit Near-me saved-location tap is still wired",
  discoverPageTsx.includes("onSavedLocation={savedLocationLabel ? handleSavedLocation : undefined}"));

// --- Eyebrow labels removed at the owner's call (2026-11-06) ---
check("labels: Home has no 'Handpicked' eyebrow above Featured Gatherings",
  !read("src/pages/HomePage.tsx").includes("Handpicked"));
check("labels: Community has no 'Site-wide room' eyebrow above its heading",
  !read("src/pages/CommunityPage.tsx").includes("Site-wide room"));

// --- Google avatar persistence (owner report, 2026-11-06) ---
// The callback hands the SPA a profile WITH the Google picture, but
// the locora_users row never stored it, so GET /me answered
// avatar:"" and validateSession wiped the browser copy seconds
// after sign-in. The row must carry the picture from day one and be
// healed on later sign-ins when it is missing or stale.
const googleCallbackTs = read("api/auth/callback/google.ts");
check("google avatar: the new-user row insert stores the Google picture",
  googleCallbackTs.includes('authProvider: "google", avatar: profile.avatar'));
check("google avatar: existing rows are healed when the stored avatar differs",
  googleCallbackTs.includes("storedAvatar !== profile.avatar") &&
  googleCallbackTs.includes("data: { ...d, avatar: profile.avatar }"));
check("google avatar: /me serves the stored row avatar",
  read("api/auth.ts").includes("avatar: profile.avatar || d.avatar"));

// --- SmartMatch live mode (owner fix, 2026-11-06) ---
// Live mode called a /smart-match/recommendations endpoint that was
// never built (404), so the page always showed Top Matches (0). The
// deterministic scorer now runs client-side in both modes.
const smartMatchTs = read("src/services/smart-match-service.ts");
check("smartmatch: no call to the never-built server endpoint remains",
  !smartMatchTs.includes("apiClient.get") &&
  !smartMatchTs.includes("smart-match/recommendations',"));
check("smartmatch: recommendations are scored from the events list locally",
  smartMatchTs.includes("eventsService.getEvents(") &&
  smartMatchTs.includes("let score = 30; // Baseline score"));
check("smartmatch: only interest-matching events are listed as Top Matches",
  smartMatchTs.includes("const interestMatched = categoryMatched || matchingTags.length > 0;") &&
  smartMatchTs.includes("if (!interestMatched) return null;"));
check("smartmatch: Home City switch — ON lists only home-city events, OFF ignores the city",
  smartMatchTs.includes("homeCityOnly?: boolean") &&
  smartMatchTs.includes("if (options?.homeCityOnly && homeCity && eventNeighborhood !== homeCity) return null;") &&
  smartMatchTs.includes("options?.preferredCity !== undefined ? options.preferredCity") &&
  read("src/pages/SmartMatchPage.tsx").includes("homeCityEnabled") &&
  read("src/pages/SmartMatchPage.tsx").includes('role="switch"'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
