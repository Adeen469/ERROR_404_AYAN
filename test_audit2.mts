// Logic tests for the audit #2 patches. Extracts the actual functions
// from the patched files (they are module-private) and runs them.
import { readFileSync } from "fs";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name); }
}
function extractFn(src: string, name: string): string {
  // returns the function transpiled to plain JS (the sources are TS)
  // grabs `function name(...) {...}` — the body brace is the first `{`
  // AFTER the parameter list's closing paren (type annotations may
  // contain braces of their own).
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
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

const telegram = readFileSync("api/telegram-verify.ts", "utf8");
const events = readFileSync("api/events.ts", "utf8");

// --- numbersMatch ---
const nmSrc = jsFn(telegram, "numbersMatch") + "\n" + jsFn(telegram, "digits");
const numbersMatch = new Function(`${nmSrc}; return numbersMatch;`)();
check("numbersMatch: exact international match", numbersMatch("919876543210", "919876543210") === true);
check("numbersMatch: bare 10-digit vs +91 (legit flow)", numbersMatch("9876543210", "919876543210") === true);
check("numbersMatch: +91 vs +1 same 10 digits REJECTED (the finding)", numbersMatch("919876543210", "19876543210") === false);
check("numbersMatch: different numbers rejected", numbersMatch("919876543210", "919876543211") === false);
check("numbersMatch: empty rejected", numbersMatch("", "919876543210") === false);
check("numbersMatch: formatted input (+91 98765 43210)", numbersMatch("+91 98765 43210", "919876543210") === true);

// --- isValidCoverImage (events.ts) ---
const coverSrc = jsFn(events, "isValidCoverImage");
const isValidCoverImage = new Function(`${coverSrc}; return isValidCoverImage;`)();
check("cover: /assets bundled path ok", isValidCoverImage("/assets/event_x.jpg") === true);
check("cover: https unsplash ok", isValidCoverImage("https://images.unsplash.com/photo-1?w=800") === true);
check("cover: data:image upload ok", isValidCoverImage("data:image/jpeg;base64,/9j/") === true);
check("cover: javascript: rejected", isValidCoverImage("javascript:alert(1)") === false);
check("cover: data:text/html rejected", isValidCoverImage("data:text/html,<script>") === false);
check("cover: >1MB rejected", isValidCoverImage("https://x.co/" + "a".repeat(1024 * 1024)) === false);
check("cover: empty ok", isValidCoverImage("") === true);

// --- cleanSubject (events.ts) ---
const subjSrc = jsFn(events, "cleanSubject");
const cleanSubject = new Function(`${subjSrc}; return cleanSubject;`)();
check("cleanSubject: strips CRLF", cleanSubject("Party\r\nBcc: victim@x.com") === "Party Bcc: victim@x.com");
check("cleanSubject: plain title unchanged", cleanSubject("Diwali Night") === "Diwali Night");

// --- limited() fail-closed helper (events.ts copy) ---
// limited() calls sendJson; stub it.
const limitedSrc = jsFn(events, "limited");
const sendJsonStub = `function sendJson(res, status, obj, extra) { res.status = status; res.body = obj; res.extra = extra; }`;
const limited = new Function(`${sendJsonStub}; ${limitedSrc}; return limited;`)();
{
  const res: any = {};
  check("limited: tableMissing -> 503", limited(res, { allowed: false, retryAfter: 0, tableMissing: true }, "x") === true && res.status === 503);
  const res2: any = {};
  check("limited: over limit -> 429 + Retry-After", limited(res2, { allowed: false, retryAfter: 42, tableMissing: false }, "slow down") === true && res2.status === 429 && res2.extra?.["Retry-After"] === "42");
  const res3: any = {};
  check("limited: allowed -> false, no response written", limited(res3, { allowed: true, retryAfter: 0, tableMissing: false }, "x") === false && res3.status === undefined);
}

// --- PATCH allowlist (events.ts): sensitive fields must NOT be accepted ---
const patchFields = events.match(/const PATCH_FIELDS = \[([^\]]+)\]/)?.[1] || "";
for (const bad of ["createdByEmail", "registeredCount", "isFeatured", "upiId", "razorpayOrderId", "razorpayPaymentId", "refundId", "id"]) {
  check(`PATCH allowlist excludes ${bad}`, !patchFields.includes(`"${bad}"`));
}
for (const good of ["title", "price", "capacity", "status", "mapUrl", "organizer", "tags"]) {
  check(`PATCH allowlist includes ${good}`, patchFields.includes(`"${good}"`));
}

// --- Webhook dispatch exists in payments.ts ---
const payments = readFileSync("api/payments.ts", "utf8");
check("payments: webhook action dispatched", payments.includes('if (action === "webhook")'));
check("payments: receipt checked in verify", payments.includes("orderRes.body.receipt!== registrationId") || payments.includes("orderRes.body.receipt !== registrationId"));
check("payments: payment-reuse check exists", payments.includes("loadRegistrationsByPaymentId(captured.id)"));
check("payments: refunded-order markers cleared", payments.includes("delete cleared.razorpayOrderId"));
check("payments: no Math.random in ticket code primary path", !payments.includes("Math.random() * chars.length") || payments.includes("crypto.getRandomValues"));

// --- messages.ts: block loader + fail-closed ---
const messages = readFileSync("api/messages.ts", "utf8");
check("messages: loadBlocksFor queries both block fields", messages.includes('for (const field of ["blockerEmail", "blockedEmail"])') && messages.includes("data->>${field}=eq."));
check("messages: authorizeContact reads blocks", messages.includes("blocks"));
check("messages: GET strips hiddenFor", messages.includes("hiddenFor: undefined") || messages.includes("delete (m as any).hiddenFor") || messages.includes("hiddenFor"));
check("messages: no Math.random remains", !messages.includes("Math.random"));

// --- registrations.ts: payment-marker strip + capacity gate ---
const regs = readFileSync("api/registrations.ts", "utf8");
check("registrations: strips razorpayOrderId on POST", regs.includes("delete reg.razorpayOrderId"));
check("registrations: strips refundId on POST", regs.includes("delete reg.refundId"));
check("registrations: reserve-before-insert", regs.includes("reserved = await bumpEventCount(reg.eventId, 1)"));
check("registrations: bumpEventCount returns boolean", regs.includes("Promise<boolean>"));

// --- auth.ts: PBKDF2 600k + password min 8 + atomic reset ---
const auth = readFileSync("api/auth.ts", "utf8");
check("auth: PBKDF2 600000 for new hashes", auth.includes("iterations: 600000") && auth.includes("$600000"));
check("auth: signup password min 8", auth.includes("password.length < 8"));
check("auth: reset confirm atomic mark (conditional update)", auth.includes("data->>used=eq.false"));
check("auth: RPC preference in checkRateLimit", auth.includes("rpc/rate_limit_hit"));

// --- callback: calendar branch gone, PKCE + email_verified ---
const cb = readFileSync("api/auth/callback/google.ts", "utf8");
check("callback: no calendar references", !/calendar/i.test(cb));
check("callback: code_verifier sent", cb.includes("code_verifier: codeVerifier"));
check("callback: tokeninfo iss check", cb.includes('info.iss === "https://accounts.google.com"'));
check("callback: email_verified enforced", cb.includes("email_verified"));
check("callback: state compared with ctEqual", cb.includes("ctEqual(cookieCsrf, state.csrf)"));
check("callback: nonce CSP on success page", cb.includes("script-src 'nonce-"));

// --- google start: PKCE challenge in the auth URL ---
const start = readFileSync("api/auth/google.ts", "utf8");
check("start: code_challenge in params", start.includes("code_challenge: codeChallenge"));
check("start: S256 method", start.includes('code_challenge_method: "S256"'));
check("start: verifier in cookie only", start.includes("locora_oauth_state=${csrf}.${codeVerifier}"));
check("start: rate limited", start.includes("oauth:start:"));

// --- vercel.json CSP ---
const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
const spaHeaders = vercel.headers.find((h: any) => h.source === "/((?!api/).*)");
const csp = spaHeaders.headers.find((h: any) => h.key === "Content-Security-Policy").value;
check("vercel: script-src has no unsafe-inline", !csp.split("script-src")[1].split(";")[0].includes("unsafe-inline"));
check("vercel: connect-src has supabase", csp.includes("https://*.supabase.co") && csp.includes("wss://*.supabase.co"));
check("vercel: no bare wss:", !csp.replace("wss://", "").includes("wss:"));
check("vercel: webhook rewrite present", vercel.rewrites.some((r: any) => r.source === "/api/razorpay-webhook"));
check("vercel: api headers carry no CSP (callback sets its own)", !vercel.headers.find((h: any) => h.source === "/api/(.*)").headers.some((x: any) => x.key === "Content-Security-Policy"));

// --- server.ts gate ---
const server = readFileSync("server.ts", "utf8");
check("server: refuses NODE_ENV=production", server.includes("NODE_ENV=production") && server.includes("process.exit(1)"));
check("server: binds 127.0.0.1", server.includes("app.listen(PORT, '127.0.0.1'"));

// --- RPC SQL present ---
const rpcDoc = readFileSync("SUPABASE_RPC_SETUP.md", "utf8");
check("rpc doc: rate_limits table SQL", rpcDoc.includes("create table if not exists public.rate_limits"));
check("rpc doc: rate_limit_hit function", rpcDoc.includes("create or replace function public.rate_limit_hit"));
check("rpc doc: atomic upsert (on conflict)", rpcDoc.includes("on conflict (id) do update"));
check("rpc doc: service_role grant", rpcDoc.includes("grant execute on function public.rate_limit_hit"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
