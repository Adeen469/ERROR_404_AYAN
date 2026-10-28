// POST /api/auth/reset — real password reset for local accounts.
// Phase 1 Finding 4: this replaces the old "Trouble signing in?" page
// that said Locora does not send reset emails, while /login still had
// a password field. Local accounts now DO have server passwords
// (scrypt hashes in locora_users, see api/auth/signup.ts), so a reset
// flow is real, not faked.
//
// Request:  { action: "request", email }
//   -> always answers the same generic message, whether or not an
//      account exists, so it cannot be used to enumerate accounts.
//      If a local account exists AND the Gmail mailer is configured,
//      a 1-hour, single-use reset link is emailed. If the mailer is
//      not configured at all, every request gets 503 (not a fake
//      success) so a missing mailer can never look like a sent email.
// Confirm:  { action: "confirm", token, newPassword }
//   -> token is stored only as its SHA-256 hash, expires in 1 hour,
//      and is marked used after one successful reset. Google accounts
//      have no local password row, so they get the same generic
//      request answer and must reset via Google (the page says so).
// Rate limited per IP and per email; auth-style fail-closed: if the
// rate_limits table is missing, request/confirm get 503, not unlimited
// attempts. Tables: locora_users, password_resets (see SECURITY_FIX_SETUP.md).
import { getEnv, norm, isEmail, sendJson, supabaseHeaders, supabaseBase, fetchJson, readBody, loadUserByEmail, hashPassword, hashToken, randomTokenHex, checkRateLimit, getClientIp } from "../_lib/session";

const SITE_URL = "https://locora-hyperlocal.vercel.app";

async function sendResetMail(to: string, rawToken: string): Promise<boolean> {
  const user = getEnv("GMAIL_USER");
  const pass = getEnv("GMAIL_APP_PASSWORD");
  if (!user || !pass) return false;
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass: pass.replace(/\s+/g, "") } });
    const link = `${SITE_URL}/reset-password?token=${encodeURIComponent(rawToken)}`;
    await transporter.sendMail({
      from: user, to,
      subject: "Reset your Locora password",
      text: `You asked to reset your Locora password. Use this link within 1 hour (it can only be used once):\n\n${link}\n\nIf you did not ask for this, ignore this email — your password has not changed.`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;"><h2 style="color:#1E3F35;">Reset your Locora password</h2><p>Use this link within 1 hour (it can only be used once):</p><p><a href="${link}" style="display:inline-block;background:#1E3F35;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;">Reset password</a></p><p>If you did not ask for this, ignore this email — your password has not changed.</p></div>`,
    });
    return true;
  } catch { return false; }
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) { sendJson(res, 503, { message: "Password reset is not configured yet" }); return; }
    const body = await readBody(req);
    const action = body.action;

    if (action === "request") {
      const email = norm(body.email || "");
      if (!isEmail(email)) { sendJson(res, 400, { message: "A valid email is required" }); return; }
      const rlIp = await checkRateLimit(`reset:req:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000);
      const rlEmail = await checkRateLimit(`reset:req:email:${email}`, 5, 60 * 60 * 1000);
      if (rlIp.tableMissing || rlEmail.tableMissing) { sendJson(res, 503, { message: "Password reset is temporarily unavailable — rate limiting is not configured yet. See SECURITY_FIX_SETUP.md." }); return; }
      if (!rlIp.allowed || !rlEmail.allowed) {
        sendJson(res, 429, { message: "Too many reset requests. Try again later." }, { "Retry-After": String(Math.max(rlIp.retryAfter, rlEmail.retryAfter)) });
        return;
      }
      // Mailer missing for everyone -> honest 503, not a fake success.
      if (!getEnv("GMAIL_USER") || !getEnv("GMAIL_APP_PASSWORD")) { sendJson(res, 503, { message: "Password reset email is not configured yet" }); return; }
      const generic = { ok: true, message: "If an account exists for that email, a reset link has been sent. It expires in 1 hour." };
      const userRow = await loadUserByEmail(email);
      if (!userRow || userRow.data?.authProvider !== "local" || !userRow.data?.passwordHash) { sendJson(res, 200, generic); return; }
      const raw = randomTokenHex(32);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await fetchJson(`${supabaseBase()}/rest/v1/password_resets`, {
        method: "POST", headers: supabaseHeaders(),
        body: JSON.stringify({ id: `rst-${Date.now()}-${randomTokenHex(4)}`, data: { email, tokenHash: hashToken(raw), expiresAt, used: false, createdAt: new Date().toISOString() } }),
      });
      await sendResetMail(email, raw);
      sendJson(res, 200, generic);
      return;
    }

    if (action === "confirm") {
      const token = String(body.token || "");
      const newPassword = String(body.newPassword || "");
      if (!token || newPassword.length < 6 || newPassword.length > 128) { sendJson(res, 400, { message: "A valid reset token and a password of at least 6 characters are required" }); return; }
      const rl = await checkRateLimit(`reset:confirm:ip:${getClientIp(req)}`, 20, 60 * 60 * 1000);
      if (rl.tableMissing) { sendJson(res, 503, { message: "Password reset is temporarily unavailable — rate limiting is not configured yet." }); return; }
      if (!rl.allowed) { sendJson(res, 429, { message: "Too many attempts. Try again later." }, { "Retry-After": String(rl.retryAfter) }); return; }
      const tokenHash = hashToken(token);
      const { ok, body: rows } = await fetchJson(
        `${supabaseBase()}/rest/v1/password_resets?select=id,data&data->>tokenHash=eq.${encodeURIComponent(tokenHash)}`,
        { headers: supabaseHeaders() },
      );
      if (!ok || !Array.isArray(rows) || rows.length === 0) { sendJson(res, 400, { message: "This reset link is invalid or has expired" }); return; }
      const resetRow = rows[0];
      const d = resetRow.data || {};
      if (d.used || !d.expiresAt || Date.parse(d.expiresAt) < Date.now()) { sendJson(res, 400, { message: "This reset link is invalid or has expired" }); return; }
      const userRow = await loadUserByEmail(d.email);
      if (!userRow || userRow.data?.authProvider !== "local") { sendJson(res, 400, { message: "This reset link is invalid or has expired" }); return; }
      const updated = { ...userRow.data, passwordHash: hashPassword(newPassword), sessionVersion: typeof userRow.data.sessionVersion === "number" ? userRow.data.sessionVersion + 1 : 1 };
      const up = await fetchJson(`${supabaseBase()}/rest/v1/locora_users?id=eq.${encodeURIComponent(userRow.id)}`, {
        method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: updated }),
      });
      if (!up.ok) { sendJson(res, 500, { message: "Could not reset the password" }); return; }
      await fetchJson(`${supabaseBase()}/rest/v1/password_resets?id=eq.${encodeURIComponent(resetRow.id)}`, {
        method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: { ...d, used: true } }),
      });
      sendJson(res, 200, { ok: true, message: "Your password has been reset. You can now sign in." });
      return;
    }

    sendJson(res, 400, { message: "Unknown action" });
  } catch {
    sendJson(res, 500, { message: "Password reset failed" });
  }
}
