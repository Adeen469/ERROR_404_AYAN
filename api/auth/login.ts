// POST /api/auth/login — server password login (Phase 2 P2-2).
// Replaces the old client-side fallback that built a local session from
// DEFAULT_DEMO_USER ("Sarah Chen") for ANY email/password after
// /api/auth/login 404'd. That fallback is gone: there is no demo user,
// no localStorage session on failure, and no password acceptance
// without a stored scrypt hash. Unknown email and wrong password give
// the same generic 401 "Invalid credentials" (a dummy scrypt verify is
// run for unknown emails so timing does not leak existence).
// Rate limited per IP and per email; fail closed (503) if the
// rate_limits table is missing. On success, sets the locora_session
// HttpOnly cookie and returns the user (never the password hash).
import { getEnv, norm, isEmail, isAdmin, sendJson, supabaseHeaders, supabaseBase, fetchJson, readBody, loadUserByEmail, signSession, sessionCookie, verifyPassword, checkRateLimit, getClientIp } from "../_lib/session";

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) { sendJson(res, 503, { message: "Sign-in is not configured yet" }); return; }
    if (!getEnv("SESSION_SECRET")) { sendJson(res, 500, { message: "Sign-in is not configured yet" }); return; }
    const body = await readBody(req);
    const email = norm(body.email || "");
    const password = String(body.password || "");
    if (!isEmail(email) || !password) { sendJson(res, 401, { message: "Invalid credentials" }); return; }
    const rlIp = await checkRateLimit(`login:ip:${getClientIp(req)}`, 30, 60 * 60 * 1000);
    const rlEmail = await checkRateLimit(`login:email:${email}`, 10, 60 * 60 * 1000);
    if (rlIp.tableMissing || rlEmail.tableMissing) { sendJson(res, 503, { message: "Sign-in is temporarily unavailable — rate limiting is not configured yet. See SECURITY_FIX_SETUP.md." }); return; }
    if (!rlIp.allowed || !rlEmail.allowed) {
      sendJson(res, 429, { message: "Too many sign-in attempts. Try again later." }, { "Retry-After": String(Math.max(rlIp.retryAfter, rlEmail.retryAfter)) });
      return;
    }
    // Admin accounts sign in with Google only, never with a local password.
    if (isAdmin(email)) { sendJson(res, 401, { message: "Invalid credentials" }); return; }
    const userRow = await loadUserByEmail(email);
    // Dummy verify for unknown / Google accounts, to keep timing similar.
    const stored = userRow && userRow.data?.authProvider === "local" ? userRow.data.passwordHash : "scrypt$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    if (!userRow || userRow.data?.authProvider !== "local" || !verifyPassword(password, stored)) {
      sendJson(res, 401, { message: "Invalid credentials" });
      return;
    }
    const d = userRow.data;
    const role = isAdmin(email) ? "admin" : (d.role || "attendee");
    const jwt = signSession(email, role, "local", typeof d.sessionVersion === "number" ? d.sessionVersion : 0);
    sendJson(res, 200, {
      user: { id: userRow.id, email, name: d.name || "Community Member", role, authProvider: "local" },
    }, { "Set-Cookie": sessionCookie(jwt, req) });
  } catch {
    sendJson(res, 500, { message: "Sign-in failed" });
  }
}
