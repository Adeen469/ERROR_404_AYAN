// GET /api/auth/google — starts the custom Google OAuth flow.
//
// This is a Vercel Serverless Function (api/ is deployed by Vercel
// alongside the static Vite build; it is not part of the Express server
// in server.ts, which Vercel does not run).
//
// Flow:
//   1. User clicks "Continue with Google" in the app.
//   2. The app redirects here (via authService.loginWithGoogle()).
//   3. This function redirects the user to Google's consent screen.
//   4. Google redirects back to /api/auth/callback/google, which finishes
//      the sign-in and hands the profile back to the app.
//
// This file is deliberately self-contained: it imports nothing from
// api/_lib, uses no Node-only modules, and uses only plain Node
// writeHead/end responses. That way a bundling or runtime quirk in a
// shared helper cannot take the whole function down.
//
// The callback path here must match an Authorized redirect URI already
// registered in Google Cloud Console for this OAuth client:
//   https://locora-hyperlocal.vercel.app/api/auth/callback/google

function getEnv(name: string): string {
  try {
    const env = (globalThis as any).process?.env;
    return (env && env[name]) || "";
  } catch {
    return "";
  }
}

function base64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64url(text: string): Promise<string> {
  const digest = await (globalThis as any).crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return base64urlEncodeBytes(new Uint8Array(digest));
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  (globalThis as any).crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function getClientIp(req: any): string {
  const raw = req.headers?.["x-forwarded-for"] || "";
  const parts = String(raw).split(",").map((x: string) => x.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : (req.socket?.remoteAddress || "unknown");
}

function supabaseBase(): string {
  return getEnv("SUPABASE_URL").replace(/\/$/, "");
}

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" };
}

async function fetchJson(url: string, init?: any): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

// Rate limiting (Supabase-backed counter, table rate_limits). Prefers
// the atomic rate_limit_hit RPC (see SUPABASE_RPC_SETUP.md) and falls
// back to the read-modify-write path when the RPC has not been created
// yet. Mirrors the copy in api/auth.ts (import-free files cannot share
// code).
async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfter: number; tableMissing: boolean }> {
  try {
    // Bound the key: it embeds unauthenticated emails/IPs, so an
    // unbounded key is unbounded row size (distinct keys are still
    // pruned by the retention SQL in supabase-setup.sql §6).
    key = String(key || "").slice(0, 512);
    if (!supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) return { allowed: false, retryAfter: 0, tableMissing: true };
    try {
      const rpc = await fetchJson(`${supabaseBase()}/rest/v1/rpc/rate_limit_hit`, {
        method: "POST",
        headers: supabaseHeaders(),
        body: JSON.stringify({ p_key: key, p_limit: limit, p_window_ms: windowMs }),
      });
      if (rpc.ok) {
        const r = rpc.body;
        if (typeof r === "boolean") return { allowed: r, retryAfter: 0, tableMissing: false };
        if (r && typeof r === "object") return { allowed: r.allowed !== false, retryAfter: Number(r.retry_after || 0), tableMissing: false };
      }
    } catch { /* fall through to the legacy path */ }
    const url = `${supabaseBase()}/rest/v1/rate_limits?id=eq.${encodeURIComponent(key)}&select=data`;
    const { ok, status, body } = await fetchJson(url, { headers: supabaseHeaders() });
    if (!ok) {
      if (status === 404 || status === 400) return { allowed: false, retryAfter: 0, tableMissing: true };
      return { allowed: true, retryAfter: 0, tableMissing: false };
    }
    const now = Date.now();
    const row = Array.isArray(body) && body.length > 0 ? body[0].data : null;
    const windowStart = row && typeof row.windowStart === "number" ? row.windowStart : 0;
    const count = row && typeof row.count === "number" ? row.count : 0;
    if (windowStart && now - windowStart < windowMs && count >= limit) {
      return { allowed: false, retryAfter: Math.ceil((windowStart + windowMs - now) / 1000), tableMissing: false };
    }
    const fresh = !windowStart || now - windowStart >= windowMs;
    const next = { count: fresh ? 1 : count + 1, windowStart: fresh ? now : windowStart };
    const up = await fetchJson(`${supabaseBase()}/rest/v1/rate_limits`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ id: key, data: next }),
    });
    if (!up.ok && (up.status === 404 || up.status === 400)) return { allowed: false, retryAfter: 0, tableMissing: true };
    return { allowed: true, retryAfter: 0, tableMissing: false };
  } catch {
    return { allowed: true, retryAfter: 0, tableMissing: false };
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Method not allowed");
  }

  const clientId = getEnv("GOOGLE_CLIENT_ID");
  if (!clientId) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(
      "Google sign-in is not configured on the server. " +
        "Set GOOGLE_CLIENT_ID in Vercel (Production) and redeploy.",
    );
  }

  // The start was rate-limit-free. Fail CLOSED when the rate_limits
  // table is missing (see the setup SQL in the PR) instead of letting
  // sign-in starts run unthrottled.
  const rl = await checkRateLimit(`oauth:start:${getClientIp(req)}`, 30, 60 * 60 * 1000);
  if (rl.tableMissing) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(
      "Google sign-in is not available right now. " +
        "Rate limiting is not configured — ask the admin to run the rate_limits setup SQL.",
    );
  }
  if (!rl.allowed) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": String(rl.retryAfter) });
    return res.end("Too many sign-in attempts. Try again later.");
  }

  // No role parameter anymore: the callback assigns 'admin' to admin
  // emails and 'attendee' to everyone else, and the old ?role= value
  // was parsed into state and then ignored by the callback — a dead
  // parameter that only invited confusion. It is not read at all now.

  // Only allow same-site return paths, never an external URL.
  const rawReturnTo =
    typeof req.query?.returnTo === "string" ? req.query.returnTo : "";
  const returnTo =
    rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : "/dashboard";

  // CSRF protection: a random token is stored in an HttpOnly cookie and
  // echoed back inside `state`. The callback only proceeds if they match.
  const csrf = randomToken();
  const state = base64urlEncode(JSON.stringify({ csrf, returnTo }));

  // PKCE (RFC 7636): the verifier stays in the HttpOnly cookie (after
  // the csrf, separated by a dot); only the S256 challenge travels to
  // Google in the auth URL. The callback sends the verifier back with
  // the code, so an intercepted authorization code alone is useless.
  const verifierBytes = new Uint8Array(32);
  (globalThis as any).crypto.getRandomValues(verifierBytes);
  const codeVerifier = base64urlEncodeBytes(verifierBytes);
  const codeChallenge = await sha256Base64url(codeVerifier);

  const configured = getEnv("GOOGLE_REDIRECT_URI");
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "";
  const redirectUri = configured || `${proto}://${host}/api/auth/callback/google`;

  const secure = redirectUri.startsWith("https://") ? "; Secure" : "";
  const cookie = `locora_oauth_state=${csrf}.${codeVerifier}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    "Set-Cookie": cookie,
  });
  return res.end();
}
