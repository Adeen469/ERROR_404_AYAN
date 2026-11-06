// Audit #4 fix tests — agent B scope (HIGH H2: rate limiting).
// Runs with:
//   bun test_auditfix_b.mts   (from ~/workspace/vecna-calendar-auditfix-b)
// Marker checks + extracted-function logic checks + live-module logic
// checks with a stubbed fetch, same pattern as test_auditfix_a.mts.
// No live calls: nothing here touches Supabase, Google, or Vercel —
// fetch is stubbed and env vars are set in-process only.
import { readFileSync, existsSync, readdirSync } from "fs";
import { getClientIp, checkRateLimit } from "./api/_lib/rate-limit.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name); }
}
function countOcc(src: string, re: RegExp): number {
  return (src.match(re) || []).length;
}
// Remove the inlined api/_lib blocks (they sit between the INLINED
// marker comment and a column-0 "})();") so source scans below only
// see the handler's own code, exactly as when the helpers were imports.
function stripInlined(src: string): string {
  return src.replace(/\/\/ INLINED from api\/_lib\/[\s\S]*?\n\}\)\(\);\n/g, "");
}
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return "";
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return "";
}
const normFn = (s: string) =>
  s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim();
// Inlined copies carry 2 extra spaces of indent from the IIFE wrap.
const normInlined = (s: string) =>
  s.split("\n").map((l) => l.replace(/^  /, "").replace(/\s+$/, "")).join("\n").trim();
// All api TS sources, excluding the shared module itself.
function allApiSrc(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) out.push({ path: p, src: readFileSync(p, "utf8") });
    }
  };
  walk("api");
  return out;
}
const apiFiles = allApiSrc();
const byPath = (p: string) => apiFiles.find((f) => f.path === p)!.src;
const rateLimit = readFileSync("api/_lib/rate-limit.ts", "utf8");
const auth = byPath("api/auth.ts");
const phoneOtp = byPath("api/phone-otp.ts");
const events = byPath("api/events.ts");
const messages = byPath("api/messages.ts");
const registrations = byPath("api/registrations.ts");
const organizerAccess = byPath("api/organizer-access.ts");
const payments = byPath("api/payments.ts");
const notify = byPath("api/notify.ts");
const rpcSql = readFileSync("rate-limit-rpc.sql", "utf8");
const vercelignore = readFileSync(".vercelignore", "utf8");

// --- 1: the canonical definitions live in the shared module; deployed
// handlers carry inlined copies, because importing api/_lib from a
// deployed function crashes it live on this project's Vercel setup
// (FUNCTION_INVOCATION_FAILED — see the module header for the history).
const defs = apiFiles.filter((f) => /function checkRateLimit\(/.test(f.src));
check("H2: checkRateLimit definitions = canonical module + 9 inlined handler copies",
  defs.length === 10 && defs.some((f) => f.path === "api/_lib/rate-limit.ts"));
const ipDefs = apiFiles.filter((f) => /function getClientIp\(/.test(f.src));
check("H2: getClientIp definitions = canonical module + inlined handler copies (phone-otp's copy defines it but never calls it; api/chatbot.ts also carries a copy)",
  ipDefs.length === 10 && ipDefs.some((f) => f.path === "api/_lib/rate-limit.ts"));

// --- 2: every deployed caller carries an inlined copy and calls it;
// no deployed file imports api/_lib (those imports crash live) ---
const callers = ["api/auth.ts", "api/events.ts", "api/messages.ts", "api/registrations.ts",
  "api/notify.ts", "api/organizer-access.ts", "api/payments.ts", "api/phone-otp.ts"];
for (const p of callers) {
  const src = byPath(p);
  check(`H2: ${p} carries the inlined limiter and calls it`,
    !src.includes('from "./_lib/rate-limit"') &&
    src.includes("INLINED from api/_lib/rate-limit.ts") &&
    /function checkRateLimit\(/.test(src) && src.includes("checkRateLimit("));
}
for (const p of ["api/auth/login.ts", "api/auth/signup.ts", "api/auth/reset.ts"]) {
  check(`H2: ${p} (vercelignored reference copy) imports the shared module via the corrected path`,
    byPath(p).includes('from "../_lib/rate-limit"'));
}
for (const p of ["api/auth/logout.ts", "api/me.ts", "api/auth/callback/google.ts"]) {
  check(`H2: ${p} (no call sites) has no leftover copy`,
    !/function (checkRateLimit|getClientIp)\(/.test(byPath(p)));
}
// --- 2b: the inlined copies must not drift from the canonical module ---
for (const p of callers) {
  check(`H2: ${p} inlined checkRateLimit is identical to the canonical module`,
    normInlined(extractFn(byPath(p), "checkRateLimit")) === normFn(extractFn(rateLimit, "checkRateLimit")));
}
for (const p of callers) {
  check(`H2: ${p} inlined getClientIp is identical to the canonical module`,
    normInlined(extractFn(byPath(p), "getClientIp")) === normFn(extractFn(rateLimit, "getClientIp")));
}
check("H2: api/_lib/session.ts re-exports the shared helpers (surface preserved)",
  byPath("api/_lib/session.ts").includes('export { checkRateLimit, getClientIp } from "./rate-limit";'));
{
  // Code lines only (header comments legitimately name the forbidden
  // imports in prose): no line of actual code may be an import.
  const codeLines = rateLimit.split("\n").filter((l) => {
    const s = l.trim();
    return s !== "" && !s.startsWith("//");
  });
  check("H2: shared module itself has zero static imports (no node:crypto confound)",
    codeLines.every((l) => !l.startsWith("import ") && !l.includes("require(")));
}
check("H2: shared module is under api/_lib, not a new function file",
  existsSync("api/_lib/rate-limit.ts") && !existsSync("api/rate-limit.ts"));
{
  // Deployed function count stays 11 (Hobby cap 12): api/**/*.ts minus
  // _lib minus .vercelignore entries.
  const ignored = new Set(vercelignore.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#")));
  const deployed = apiFiles.filter((f) => !f.path.startsWith("api/_lib/") && !ignored.has(f.path));
  check("H2: deployed Vercel function count still 11 (cap 12)",
    deployed.length === 11);
}

// --- 3: getClientIp uses the LAST x-forwarded-for entry ---
check("H2: getClientIp returns the LAST entry of a multi-hop header",
  getClientIp({ headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9" } }) === "9.9.9.9");
check("H2: getClientIp ignores a spoofed FIRST entry (attacker IP first, real IP last)",
  getClientIp({ headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.7" } }) === "203.0.113.7");
check("H2: getClientIp single IP unchanged",
  getClientIp({ headers: { "x-forwarded-for": "203.0.113.7" } }) === "203.0.113.7");
check("H2: getClientIp trims whitespace / skips empty entries",
  getClientIp({ headers: { "x-forwarded-for": " 1.1.1.1 , , 2.2.2.2 " } }) === "2.2.2.2");
check("H2: getClientIp falls back to x-real-ip",
  getClientIp({ headers: { "x-real-ip": "3.3.3.3" } }) === "3.3.3.3");
check("H2: getClientIp returns unknown with no IP headers",
  getClientIp({ headers: {} }) === "unknown");
check("H2: shared module documents the LAST-entry rationale",
  rateLimit.includes("LAST") && rateLimit.includes("spoofed"));

// --- 4: checkRateLimit logic (stubbed fetch, in-process env) ---
const realFetch = globalThis.fetch;
const realEnvUrl = process.env.SUPABASE_URL;
const realEnvKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
function stubFetch(handler: (url: string, init: any) => any) {
  (globalThis as any).fetch = async (url: string, init: any) => handler(url, init);
}
function resp(ok: boolean, status: number, body: any) {
  return { ok, status, json: async () => body };
}
{
  // (a) RPC present and refusing: no fallback GET is issued.
  let calls: string[] = [];
  stubFetch((url: string) => {
    calls.push(url);
    if (url.includes("/rpc/rate_limit_hit")) return resp(true, 200, { allowed: false, retryAfter: 42 });
    return resp(false, 404, {});
  });
  const r = await checkRateLimit("k1", 5, 3600000);
  check("H2: RPC hit returning allowed=false is honoured (no fallback)",
    r.allowed === false && r.retryAfter === 42 && r.tableMissing === false && calls.length === 1);
}
{
  // (b) RPC missing (404) -> fallback GET finds no row -> upsert -> allowed.
  let calls: string[] = [];
  stubFetch((url: string) => {
    calls.push(url);
    if (url.includes("/rpc/rate_limit_hit")) return resp(false, 404, { message: "function not found" });
    if (url.includes("/rate_limits?id=eq.")) return resp(true, 200, []);
    return resp(true, 200, [{ id: "k2", data: { count: 1, windowStart: Date.now() } }]);
  });
  const r = await checkRateLimit("k2", 5, 3600000);
  check("H2: RPC missing falls back to upsert path and allows first hit",
    r.allowed === true && r.tableMissing === false && calls.some((u) => u.includes("/rate_limits?id=eq.")));
}
{
  // (c) RPC missing + GET 404 -> tableMissing (fail-closed signal).
  stubFetch((url: string) => {
    if (url.includes("/rpc/rate_limit_hit")) return resp(false, 404, {});
    return resp(false, 404, {});
  });
  const r = await checkRateLimit("k3", 5, 3600000);
  check("H2: missing table surfaces tableMissing=true",
    r.allowed === false && r.tableMissing === true);
}
{
  // (d) No Supabase env at all -> tableMissing.
  delete process.env.SUPABASE_URL;
  const r = await checkRateLimit("k4", 5, 3600000);
  check("H2: missing Supabase env surfaces tableMissing=true",
    r.allowed === false && r.tableMissing === true);
  process.env.SUPABASE_URL = "https://example.supabase.co";
}
{
  // (e) Fallback path: row at the limit inside the window -> refused with retryAfter.
  const now = Date.now();
  stubFetch((url: string) => {
    if (url.includes("/rpc/rate_limit_hit")) return resp(false, 404, {});
    if (url.includes("/rate_limits?id=eq.")) return resp(true, 200, [{ data: { count: 5, windowStart: now - 1000 } }]);
    return resp(true, 200, []);
  });
  const r = await checkRateLimit("k5", 5, 3600000);
  check("H2: fallback refuses at-limit window with a retryAfter",
    r.allowed === false && r.tableMissing === false && r.retryAfter > 0);
}
{
  // (f) Fallback path: upsert 404 (table dropped between GET and POST)
  // -> tableMissing. (This is the payments/phone-otp divergence: those
  // copies ignored the upsert result and never reported it.)
  stubFetch((url: string) => {
    if (url.includes("/rpc/rate_limit_hit")) return resp(false, 404, {});
    if (url.includes("/rate_limits?id=eq.")) return resp(true, 200, []);
    return resp(false, 404, {});
  });
  const r = await checkRateLimit("k6", 5, 3600000);
  check("H2: upsert 404 surfaces tableMissing=true (stricter canonical copy kept)",
    r.allowed === false && r.tableMissing === true);
}
(globalThis as any).fetch = realFetch;
if (realEnvUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = realEnvUrl;
if (realEnvKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = realEnvKey;

// --- 5: fail CLOSED (503) on auth/OTP mutations when the table is missing ---
function sliceFrom(src: string, marker: string): string {
  return src.slice(src.indexOf(marker));
}
check("H2: login fails closed 503 on tableMissing",
  sliceFrom(auth, "async function handleLogin").includes('sendJson(res, 503, { message: "Sign-in is temporarily unavailable'));
check("H2: signup fails closed 503 on tableMissing",
  sliceFrom(auth, "async function handleSignup").includes('sendJson(res, 503, { message: "Sign-up is temporarily unavailable'));
check("H2: password-reset request fails closed 503 on tableMissing",
  sliceFrom(auth, 'if (action === "request")').includes('sendJson(res, 503, { message: "Password reset is temporarily unavailable'));
check("H2: password-reset confirm fails closed 503 on tableMissing",
  sliceFrom(auth, 'if (action === "confirm")').includes('sendJson(res, 503, { message: "Password reset is temporarily unavailable'));
check("H2: OTP send (email key) fails closed 503 on tableMissing",
  sliceFrom(phoneOtp, 'body.action === "send"').includes("if (rlEmail.tableMissing)") &&
  sliceFrom(phoneOtp, 'body.action === "send"').includes('sendJson(res, 503, { message: "SMS verification is temporarily unavailable'));
check("H2: OTP send (phone key) fails closed 503 on tableMissing",
  sliceFrom(phoneOtp, 'body.action === "send"').includes("if (rlPhone.tableMissing)"));
check("H2: OTP verify is rate-limited (new phoneotp:verify key) and fails closed 503",
  phoneOtp.includes("checkRateLimit(`phoneotp:verify:${session.email}`, 20, 60 * 60 * 1000)") &&
  sliceFrom(phoneOtp, 'body.action === "verify"').includes("if (rlVerify.tableMissing)"));

// Handler-level: login/signup/reset-confirm really answer 503 when the
// table is missing (stubbed fetch 404s on RPC + GET, real handler code).
{
  const mod: any = await import("./api/auth.ts");
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.SESSION_SECRET = "test-secret-for-h2-check-only";
  (globalThis as any).fetch = async () => resp(false, 404, { message: "relation does not exist" });
  const call = async (endpoint: string, body: any) => {
    let status = 0; let payload: any = null;
    const res: any = {
      writeHead: (s: number) => { status = s; },
      end: (d: string) => { try { payload = JSON.parse(d); } catch { payload = d; } },
    };
    await mod.default({ method: "POST", url: `/api/auth?endpoint=${endpoint}`, headers: {}, body }, res);
    return { status, payload };
  };
  const login = await call("login", { email: "a@example.com", password: "secret123" });
  check("H2: live handler login -> 503 when rate_limits is missing",
    login.status === 503 && /temporarily unavailable/.test(login.payload?.message || ""));
  const signup = await call("signup", { email: "b@example.com", name: "B", password: "secret123" });
  check("H2: live handler signup -> 503 when rate_limits is missing",
    signup.status === 503 && /temporarily unavailable/.test(signup.payload?.message || ""));
  const resetReq = await call("reset", { action: "request", email: "a@example.com" });
  check("H2: live handler reset request -> 503 when rate_limits is missing",
    resetReq.status === 503 && /temporarily unavailable/.test(resetReq.payload?.message || ""));
  const resetConfirm = await call("reset", { action: "confirm", token: "tok123", newPassword: "secret123" });
  check("H2: live handler reset confirm -> 503 when rate_limits is missing",
    resetConfirm.status === 503 && /temporarily unavailable/.test(resetConfirm.payload?.message || ""));
  (globalThis as any).fetch = realFetch;
  delete process.env.SESSION_SECRET;
  if (realEnvUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = realEnvUrl;
  if (realEnvKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = realEnvKey;
}

// --- 6: fail OPEN for reads (and non-auth mutations): no 503 on tableMissing ---
for (const [name, src] of [["events", events], ["messages", messages], ["registrations", registrations], ["organizer-access", organizerAccess], ["notify", notify], ["payments", payments]] as const) {
  const body = stripInlined(src);
  const mentions = countOcc(body, /tableMissing/g);
  const failOpenGuards = countOcc(body, /!\w+\.allowed && !\w+\.tableMissing/g);
  check(`H2: ${name} stays fail-open (every tableMissing mention is a !allowed && !tableMissing guard)`,
    mentions > 0 && mentions === failOpenGuards);
}
check("H2: events GET keeps its fail-open guard",
  events.includes("if (!rl.allowed && !rl.tableMissing)"));
check("H2: H1 verify-email confirm/resend deliberately stay fail-open (H1-owned, out of H2 scope)",
  auth.includes("H2 deliberately leaves verify-email fail-OPEN") &&
  auth.includes("H2 deliberately leaves verification resend fail-OPEN"));

// --- 7: rate-limit-rpc.sql contents ---
check("H2: RPC SQL defines rate_limit_hit(text, int, bigint)",
  rpcSql.includes("create or replace function public.rate_limit_hit(p_key text, p_limit int, p_window_ms bigint)"));
check("H2: RPC SQL is SECURITY DEFINER and returns jsonb",
  rpcSql.includes("security definer") && rpcSql.includes("returns jsonb"));
check("H2: RPC SQL revokes from public and grants to service_role only",
  rpcSql.includes("revoke execute on function public.rate_limit_hit(text, int, bigint) from public;") &&
  rpcSql.includes("grant execute on function public.rate_limit_hit(text, int, bigint) to service_role;"));
check("H2: RPC SQL locks the row (FOR UPDATE) and retries on unique_violation",
  rpcSql.includes("for update") && rpcSql.includes("unique_violation"));
check("H2: RPC SQL creates the rate_limits table if missing",
  rpcSql.includes("create table if not exists public.rate_limits"));
check("H2: RPC SQL returns {allowed, retryAfter} like the TS fallback",
  rpcSql.includes("'allowed'") && rpcSql.includes("'retryAfter'"));
check("H2: shared module tries the RPC first and falls back on error",
  rateLimit.includes("/rest/v1/rpc/rate_limit_hit") && rateLimit.includes("Fall through to the upsert path"));

// --- 8: thresholds unchanged (spot-checks, exact call strings) ---
const thresholdChecks: [string, string, string][] = [
  ["login ip 30/1h", auth, "checkRateLimit(`login:ip:${getClientIp(req)}`, 30, 60 * 60 * 1000)"],
  ["login email 10/1h", auth, "checkRateLimit(`login:email:${email}`, 10, 60 * 60 * 1000)"],
  ["signup ip 20/1h", auth, "checkRateLimit(`signup:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000)"],
  ["signup email 5/1h", auth, "checkRateLimit(`signup:email:${email}`, 5, 60 * 60 * 1000)"],
  ["reset req ip 20/1h", auth, "checkRateLimit(`reset:req:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000)"],
  ["reset req email 5/1h", auth, "checkRateLimit(`reset:req:email:${email}`, 5, 60 * 60 * 1000)"],
  ["reset confirm ip 20/1h", auth, "checkRateLimit(`reset:confirm:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000)"],
  ["verify confirm ip 20/1h", auth, "checkRateLimit(`verify:confirm:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000)"],
  ["verify resend ip 20/1h", auth, "checkRateLimit(`verify:resend:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000)"],
  ["verify resend email 5/1h", auth, "checkRateLimit(`verify:resend:email:${email}`, 5, 60 * 60 * 1000)"],
  ["phoneotp send email 5/1h", phoneOtp, "checkRateLimit(`phoneotp:send:${session.email}`, 5, 60 * 60 * 1000)"],
  ["phoneotp send phone 5/1h", phoneOtp, "checkRateLimit(`phoneotp:send:phone:${ten}`, 5, 60 * 60 * 1000)"],
  ["events GET 600/10m", events, "checkRateLimit(`events:get:${getClientIp(req)}`, 600, 10 * 60 * 1000)"],
  ["events POST 20/1h", events, "checkRateLimit(`events:post:${session.email}`, 20, 60 * 60 * 1000)"],
  ["events PATCH 60/1h", events, "checkRateLimit(`events:patch:${session.email}`, 60, 60 * 60 * 1000)"],
  ["events DELETE 20/1h", events, "checkRateLimit(`events:delete:${session.email}`, 20, 60 * 60 * 1000)"],
  ["msg GET 300/10m", messages, "checkRateLimit(`msg:get:${getClientIp(req)}:${me}`, 300, 10 * 60 * 1000)"],
  ["msg send 60/1h", messages, "checkRateLimit(`msg:send:${me}`, 60, 60 * 60 * 1000)"],
  ["msg community send 60/1h", messages, "checkRateLimit(`msg:community-send:${me}`, 60, 60 * 60 * 1000)"],
  ["payments create-order 30/10m", payments, "checkRateLimit(`payments:create-order:${session.email}`, 30, 10 * 60 * 1000)"],
  ["payments verify 60/10m", payments, "checkRateLimit(`payments:verify:${session.email}`, 60, 10 * 60 * 1000)"],
  ["reg GET 300/10m", registrations, "checkRateLimit(`reg:get:${getClientIp(req)}:${me}`, 300, 10 * 60 * 1000)"],
  ["reg POST 30/1h", registrations, "checkRateLimit(`reg:post:${me}`, 30, 60 * 60 * 1000)"],
  ["orgacc request 10/1h", organizerAccess, "checkRateLimit(`orgacc:request:${email}`, 10, 60 * 60 * 1000)"],
  ["orgacc post 30/1h", organizerAccess, "checkRateLimit(`orgacc:post:${email}`, 30, 60 * 60 * 1000)"],
  ["notify cleanup 10/1h", notify, "checkRateLimit(`notify:cleanup:${session.email}`, 10, 60 * 60 * 1000)"],
];
for (const [name, src, needle] of thresholdChecks) {
  check(`H2: threshold unchanged — ${name}`, src.includes(needle));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
