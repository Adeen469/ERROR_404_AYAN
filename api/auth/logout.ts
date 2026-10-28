// POST /api/auth/logout — true logout: the current token's SHA-256
// hash is written to revoked_tokens (best-effort, never fails logout)
// and the cookie is cleared. A copied token is then rejected by
// verifySession even before its 7-day expiry. If revoked_tokens is
// missing, revocation does not persist and logout falls back to
// cookie-clearing only (see SECURITY_FIX_SETUP.md).
import { sendJson, clearSessionCookie, verifySession, revokeSessionToken } from "../_lib/session";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "POST") { sendJson(res, 405, { message: "Method not allowed" }); return; }
  try {
    const session = await verifySession(req);
    if (session) await revokeSessionToken(req);
  } catch {}
  sendJson(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie(req) });
}
