// POST /api/auth/signup — server password signup (Phase 2 P2-2).
// Creates a locora_users row with a scrypt hash + per-user salt
// (never a plaintext password, never a demo user). Admin emails cannot
// be created locally — admins sign in with Google. New accounts start
// as attendees; organizer status comes only from an admin approval.
// Rate limited per IP; fail closed (503) if rate_limits is missing.
// On success, sets the locora_session HttpOnly cookie.
import { getEnv, norm, isEmail, isAdmin, sendJson, supabaseHeaders, supabaseBase, fetchJson, readBody, loadUserByEmail, signSession, sessionCookie, hashPassword, checkRateLimit, getClientIp } from "../_lib/session";

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) { sendJson(res, 503, { message: "Sign-up is not configured yet" }); return; }
    if (!getEnv("SESSION_SECRET")) { sendJson(res, 500, { message: "Sign-up is not configured yet" }); return; }
    const body = await readBody(req);
    const email = norm(body.email || "");
    const name = String(body.name || "").trim().slice(0, 100) || "Community Member";
    const password = String(body.password || "");
    if (!isEmail(email)) { sendJson(res, 400, { message: "A valid email is required" }); return; }
    if (password.length < 6 || password.length > 128) { sendJson(res, 400, { message: "Password must be at least 6 characters" }); return; }
    if (isAdmin(email)) { sendJson(res, 403, { message: "Admin accounts sign in with Google, not with a local password." }); return; }
    const rl = await checkRateLimit(`signup:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000);
    if (rl.tableMissing) { sendJson(res, 503, { message: "Sign-up is temporarily unavailable — rate limiting is not configured yet. See SECURITY_FIX_SETUP.md." }); return; }
    if (!rl.allowed) { sendJson(res, 429, { message: "Too many sign-ups. Try again later." }, { "Retry-After": String(rl.retryAfter) }); return; }
    const existing = await loadUserByEmail(email);
    if (existing) { sendJson(res, 409, { message: "An account with this email already exists. Sign in instead." }); return; }
    const id = `usr-${Date.now()}`;
    const row = { id, data: { email, name, role: "attendee", authProvider: "local", passwordHash: hashPassword(password), sessionVersion: 0, createdAt: new Date().toISOString() } };
    const { ok } = await fetchJson(`${supabaseBase()}/rest/v1/locora_users`, {
      method: "POST", headers: supabaseHeaders(), body: JSON.stringify(row),
    });
    if (!ok) { sendJson(res, 500, { message: "Could not create the account" }); return; }
    const jwt = signSession(email, "attendee", "local", 0);
    sendJson(res, 201, { user: { id, email, name, role: "attendee", authProvider: "local" } }, { "Set-Cookie": sessionCookie(jwt, req) });
  } catch {
    sendJson(res, 500, { message: "Sign-up failed" });
  }
}
