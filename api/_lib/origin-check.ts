// L3 (audit #4): Origin/Referer check for state-changing API calls.
//
// Rule: a mutation (POST/PATCH/PUT/DELETE) that carries an Origin or a
// Referer must come from this site — the production origin, a Vercel
// preview deployment of this repo (*.vercel.app), or local dev
// (http://localhost:* / 127.0.0.1:*). A mismatched Origin/Referer is
// refused 403: the session cookie is SameSite=Lax, but a top-level
// navigation or a same-site fetch from an attacker page could still
// carry the cookie, so the Origin check is the CSRF backstop.
//
// A request with NEITHER header is allowed through: non-browser
// callers (curl, server-to-server) send none, and the Razorpay webhook
// is one of them — it authenticates with X-Razorpay-Signature instead,
// so api/payments.ts explicitly exempts ?action=webhook from this
// check (see its handler). GETs are exempt everywhere: they are reads,
// except the email-link GETs (verify-email, Google callback) which
// carry no Origin by construction.
//
// Shared module under api/_lib (same as rate-limit.ts): it is NOT a
// Vercel function file, so the 12-function Hobby cap is unaffected.
export const LOCORA_SITE_ORIGIN = "https://locora-hyperlocal.vercel.app";

function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isTrustedOrigin(origin: string): boolean {
  if (origin === LOCORA_SITE_ORIGIN) return true;
  // Vercel preview deployments of this repo (e.g. locora-*.vercel.app).
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;
  // Local dev servers (Vite on :5173, `bun run` / server.ts on :3000, …).
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  return false;
}

// True when the request is allowed to mutate: no Origin/Referer at
// all (non-browser caller), or the carried Origin — Referer when
// there is no Origin — is a trusted site origin.
export function originAllowed(req: any): boolean {
  const headers = req?.headers || {};
  const origin = typeof headers.origin === "string" ? headers.origin : "";
  const referer = typeof headers.referer === "string" ? headers.referer : "";
  const carried = origin || referer;
  if (!carried) return true;
  // "null" is what sandboxed iframes / opaque origins send: never trusted.
  if (carried === "null") return false;
  const parsed = originOf(carried);
  if (!parsed) return false;
  return isTrustedOrigin(parsed);
}

// True for state-changing methods (the ones the check applies to).
export function isMutationMethod(req: any): boolean {
  const m = String(req?.method || "").toUpperCase();
  return m === "POST" || m === "PATCH" || m === "PUT" || m === "DELETE";
}
