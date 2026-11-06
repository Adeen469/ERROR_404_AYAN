// Audit #4 H1 tests — LINK-based email verification on signup.
// Runs with:
//   bun test_auditfix_h1.mts   (from ~/workspace/vecna-calendar-auditfix-h1)
// Marker checks (the handlers are not importable as modules — they are
// default-exported Vercel handlers) plus extracted-function logic checks,
// same pattern as test_auditfix_a.mts / test_replies.mts.
// No live calls: nothing here touches Supabase, Google, or Vercel.
import { readFileSync, existsSync, readdirSync } from "fs";

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
function extractConst(src: string, name: string): string {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`const ${name} not found`);
  const end = src.indexOf(";", start);
  return src.slice(start, end + 1);
}

const auth = readFileSync("api/auth.ts", "utf8");
const vercel = readFileSync("vercel.json", "utf8");
const vercelignore = readFileSync(".vercelignore", "utf8");
const authService = readFileSync("src/services/auth-service.ts", "utf8");
const signupPage = readFileSync("src/pages/SignupPage.tsx", "utf8");
const loginPage = readFileSync("src/pages/LoginPage.tsx", "utf8");
const verifyPage = readFileSync("src/pages/VerifyEmailPage.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");

// ---- Gate logic: isEmailVerificationRequired (extracted + run) ----
const gate: any = new Function(
  `${jsFn(auth, "isEmailVerificationRequired")}; return isEmailVerificationRequired;`,
)();
check("gate: local + emailVerified:false -> required", gate({ authProvider: "local", emailVerified: false }) === true);
check("gate: local + emailVerified:true -> not required", gate({ authProvider: "local", emailVerified: true }) === false);
check("gate: local + no emailVerified field (legacy) -> grandfathered, not required", gate({ authProvider: "local" }) === false);
check("gate: google + emailVerified:false -> NOT gated", gate({ authProvider: "google", emailVerified: false }) === false);
check("gate: google + no field -> NOT gated", gate({ authProvider: "google" }) === false);
check("gate: null/undefined data -> not required", gate(null) === false && gate(undefined) === false);

// ---- Verification link shape (extracted + run) ----
const linkFn: any = new Function(
  `${extractConst(auth, "SITE_URL")}\n${jsFn(auth, "verificationLink")}; return verificationLink;`,
)();
check("link: shape is /api/auth/verify-email?token=<raw> on the live domain",
  linkFn("abc123") === "https://locora-hyperlocal.vercel.app/api/auth/verify-email?token=abc123");
check("link: token is URL-encoded", linkFn("a+b/c=d").includes("token=a%2Bb%2Fc%3Dd"));
check("link: domain is derived from SITE_URL, not hardcoded per call", auth.includes("verificationLink(rawToken)") && (auth.replace(/\/\/ INLINED from api\/_lib\/[\s\S]*?\n\}\)\(\);\n/g, "").match(/locora-hyperlocal\.vercel\.app/g) || []).length === 1);

// ---- Token crypto: hashToken / randomTokenHex (extracted + run) ----
const cryptoFns = [
  jsFn(auth, "bytesToHex"),
  jsFn(auth, "hexToBytes"),
  jsFn(auth, "randomBytes"),
  jsFn(auth, "sha256Hex"),
  jsFn(auth, "hashToken"),
  jsFn(auth, "randomTokenHex"),
].join("\n");
const { hashToken, randomTokenHex }: any = new Function(
  `${cryptoFns}; return { hashToken, randomTokenHex };`,
)();
const raw = randomTokenHex(32);
check("token: 256-bit random token is 64 hex chars", /^[0-9a-f]{64}$/.test(raw));
check("token: two tokens differ", randomTokenHex(32) !== raw);
const hashed = await hashToken(raw);
check("token: hash is 64 hex chars, never the raw token", /^[0-9a-f]{64}$/.test(hashed) && hashed !== raw);
check("token: hash is deterministic (same raw -> same hash)", (await hashToken(raw)) === hashed);
check("token: hash of a wrong token differs", (await hashToken("deadbeef")) !== hashed);
check("TTL: verification link lives 24h", auth.includes("EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000"));

// ---- Signup: unverified, no session ----
const signupFn = extractFn(auth, "handleSignup");
check("signup: creates row with emailVerified:false", signupFn.includes("emailVerified: false"));
check("signup: stores ONLY the SHA-256 hash of the token on the row",
  signupFn.includes("emailVerificationTokenHash: await hashToken(rawVerificationToken)"));
check("signup: issues NO session (no signSession, no Set-Cookie)", !signupFn.includes("signSession(") && !signupFn.includes("Set-Cookie"));
check("signup: returns needsVerification:true", signupFn.includes("needsVerification: true"));
check("signup: 201 (not 200) with the user + email", signupFn.includes("sendJson(res, 201,"));
check("signup: generic 409 for an existing email", signupFn.includes("sendJson(res, 409,"));
check("signup: existing UNVERIFIED account quietly gets a fresh link (response stays 409)",
  signupFn.includes("isEmailVerificationRequired(existing.data)") && signupFn.includes("sendVerificationEmailForRow(existing)"));
check("signup: mailer missing does not brick sign-up (account still created, warn only)",
  signupFn.includes("emailSent = await sendVerificationMail") && signupFn.includes("console.warn(\"H1: verification email NOT sent"));

// ---- Login: refused until verified, Google unaffected ----
const loginFn = extractFn(auth, "handleLogin");
check("login: unverified local account refused with 403 + email_not_verified code",
  loginFn.includes('sendJson(res, 403,') && loginFn.includes('code: "email_not_verified"'));
check("login: gate runs through isEmailVerificationRequired (local-only, legacy grandfathered)",
  loginFn.includes("isEmailVerificationRequired(d)"));
check("login: gate is AFTER the password check (wrong password still gets generic 401)",
  loginFn.indexOf("verifyPassword(password, stored)") < loginFn.indexOf("isEmailVerificationRequired(d)"));
check("login: no session is issued to a refused account (gate returns before signSession)",
  loginFn.indexOf("isEmailVerificationRequired(d)") < loginFn.indexOf("signSession(email"));

// ---- Verify handler: once, expired, wrong token, no auto-sign-in ----
const verifyFn = extractFn(auth, "handleVerifyEmail");
check("verify: GET with ?token= verifies then 302-redirects to /verify-email?status=verified",
  verifyFn.includes('redirect("verified")') && verifyFn.includes("Location: `${SITE_URL}/verify-email?status="));
check("verify: looks the row up by token HASH only (never by raw token)",
  verifyFn.includes("data->>emailVerificationTokenHash=eq.") && verifyFn.includes("hashToken(token)"));
check("verify: unknown/wrong token -> invalid", verifyFn.includes('fail("invalid"'));
check("verify: expired token -> expired", verifyFn.includes('fail("expired"') && verifyFn.includes("Date.parse(d.emailVerificationExpiresAt) < Date.now()"));
check("verify: success clears the hash + expiry (single-use: reuse finds no row)",
  verifyFn.includes("emailVerificationTokenHash: _h, emailVerificationExpiresAt: _e") && verifyFn.includes("emailVerified: true"));
check("verify: NO auto-sign-in from the link click (no signSession)", !verifyFn.includes("signSession("));
check("verify: POST {token} also supported (JSON answer)", verifyFn.includes('req.method === "POST"') || verifyFn.includes("readBody(req)"));
check("verify: confirm attempts are rate-limited per IP", verifyFn.includes("verify:confirm:ip:"));

// ---- Resend: generic + rate-limited ----
const resendFn = extractFn(auth, "handleResendVerification");
check("resend: generic response whether the email exists or not",
  resendFn.includes("If an account exists for that email, a verification link has been sent"));
check("resend: unknown / already-verified email gets the SAME generic 200 (no enumeration)",
  resendFn.includes("if (!userRow || !isEmailVerificationRequired(userRow.data)) { sendJson(res, 200, generic); return; }"));
check("resend: rate-limited per email (5/hour) and per IP (20/hour)",
  resendFn.includes("verify:resend:email:") && resendFn.includes("verify:resend:ip:") && resendFn.includes(", 5, 60 * 60 * 1000"));
check("resend: regenerates the token (old link invalidated)", resendFn.includes("sendVerificationEmailForRow(userRow)"));

// ---- Raw token never stored or logged ----
check("secret: raw token is never stored on any row (only *TokenHash fields hold hashes)",
  !/emailVerificationTokenHash:\s*raw/.test(auth) && !auth.includes("emailVerificationToken: raw"));
check("secret: raw token is never logged",
  !auth.split("\n").some((l) => l.includes("console.") && /rawVerificationToken|rawToken/.test(l) && !l.includes("NOT sent")));
check("secret: mailer sends the raw token ONLY inside the link (verificationLink)",
  auth.includes("const link = verificationLink(rawToken);") && !/sendMail\(\{[^}]*rawToken/.test(auth));

// ---- Routing + function count: no new Vercel function ----
check("routing: vercel.json rewrites /api/auth/verify-email to the dispatcher",
  vercel.includes('"/api/auth/verify-email"') && vercel.includes('"/api/auth?endpoint=verify-email"'));
check("routing: vercel.json rewrites /api/auth/resend-verification to the dispatcher",
  vercel.includes('"/api/auth/resend-verification"') && vercel.includes('"/api/auth?endpoint=resend-verification"'));
check("routing: dispatcher resolves both new endpoints",
  auth.includes("if (p.endsWith('/auth/verify-email')) return 'verify-email';") &&
  auth.includes("if (p.endsWith('/auth/resend-verification')) return 'resend-verification';") &&
  auth.includes("if (endpoint === 'verify-email') return handleVerifyEmail(req, res);") &&
  auth.includes("if (endpoint === 'resend-verification') return handleResendVerification(req, res);"));
check("functions: no new api file was created for H1",
  !existsSync("api/auth/verify-email.ts") && !existsSync("api/verify-email.ts") && !existsSync("api/auth/resend-verification.ts"));
{
  const ignored = new Set(vercelignore.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  const deployed: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "_lib") walk(p); }
      else if (e.name.endsWith(".ts") && !ignored.has(p)) deployed.push(p);
    }
  };
  walk("api");
  check(`functions: deployed count stays 10/12 (got ${deployed.length}: ${deployed.join(", ")})`, deployed.length === 10);
}

// ---- Frontend ----
check("frontend: signup page shows check-email state (inbox + spam, 24h)",
  signupPage.includes("Check your email") && signupPage.includes("spam") && signupPage.includes("24 hours"));
check("frontend: signup page offers resend from the check-email state",
  signupPage.includes("Resend verification email") && signupPage.includes("handleResend"));
check("frontend: login page detects email_not_verified and offers resend",
  loginPage.includes("email_not_verified") && loginPage.includes("Resend verification email"));
check("frontend: verify page handles verified / expired / invalid + resend form",
  verifyPage.includes("Email verified") && verifyPage.includes("has expired") && verifyPage.includes("not valid") && verifyPage.includes("Send a new verification link"));
check("frontend: verify page does not auto-sign-in (links to /login instead)",
  verifyPage.includes('to="/login"') && !verifyPage.includes("authService.login("));
check("frontend: /verify-email route is public (no auth guard) in App.tsx",
  app.includes('<Route path="/verify-email" element={<VerifyEmailPage />} />'));
check("frontend: auth-service signup returns needsVerification and stores NOTHING while unverified",
  authService.includes("if (res.needsVerification)") && authService.indexOf("if (res.needsVerification)") < authService.indexOf("localStorage.setItem(USER_STORAGE_KEY", authService.indexOf("async signup")));
check("frontend: auth-service exposes resendVerification + verifyEmail",
  authService.includes("async resendVerification(email: string)") && authService.includes("async verifyEmail(token: string)"));

// ---- Google accounts untouched ----
check("google: callback file was not modified for H1 (no emailVerified stamp there — gate excludes google by authProvider)",
  !readFileSync("api/auth/callback/google.ts", "utf8").includes("emailVerified"));
check("scope: no H1 code in the files other agents own (messages, registrations, payments, events, phone-otp, calendar, realtime)",
  ["api/messages.ts", "api/registrations.ts", "api/payments.ts", "api/events.ts", "api/phone-otp.ts",
   "api/calendar/events.ts", "api/calendar/status.ts", "api/auth/google-calendar.ts",
   "api/auth/callback/google.ts", "api/auth/google.ts", "src/services/realtime-service.ts"]
    .every((f) => !readFileSync(f, "utf8").includes("emailVerification") && !readFileSync(f, "utf8").includes("email_not_verified")));

console.log(`\ntest_auditfix_h1: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
