// GET /api/auth/google-calendar — starts the Google Calendar connect flow.
//
// SECURITY (audit #4 C2): the caller is identified ONLY by the signed-in
// Locora session (locora_session cookie). Any client-supplied userId is
// ignored: the storage key baked into `state` is the locora_users row id
// for the session email. No session -> 401. The callback refuses a
// state.userId that does not match the signed-in session's user (403).
//
// This reuses the SAME Google OAuth client and the SAME Authorized
// redirect URI as sign-in (/api/auth/callback/google), so no new redirect
// URI has to be registered in Google Cloud Console. The difference from
// sign-in is in the consent requested here:
//   scope: openid email profile + calendar.events
//   access_type: offline (Google returns a refresh token)
//   prompt: consent (forces a fresh refresh token on every connect, so a
//           reconnect reliably replaces a revoked/expired one)
//
// The shared sign-in callback branches on state.purpose === "calendar":
// instead of signing the user in, it stores the (encrypted) refresh token
// in Supabase keyed by the Locora user id, then sends the user back to
// `returnTo`. No calendar data is ever read; Locora only inserts events
// the user registers for, and deletes the event it created if asked.
//
// Self-contained, same pattern as api/auth/google.ts. Requires the
// Calendar API to be enabled for this OAuth client in Google Cloud
// Console and the calendar.events scope to be added to the consent
// screen (see CALENDAR_SETUP.md). No new Vercel env vars are needed:
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are reused.

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

function randomToken(): string {
  const bytes = new Uint8Array(16);
  (globalThis as any).crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- Session verification (same HMAC scheme as api/phone-otp.ts) ----
// Self-contained on purpose: _lib imports have failed live with
// FUNCTION_INVOCATION_FAILED, so this file verifies the session itself.
function norm(email: string): string {
  return (email || "").trim().toLowerCase();
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || "");
}

function parseCookies(req: any): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers?.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlDecode(text: string): string {
  return new TextDecoder().decode(b64urlToBytes(text));
}
async function sha256Hex(text: string): Promise<string> {
  const digest = await (globalThis as any).crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}
async function hmacB64url(secret: string, data: string): Promise<string> {
  const key = await (globalThis as any).crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await (globalThis as any).crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
}
function supabaseBase(): string {
  return getEnv("SUPABASE_URL").replace(/\/$/, "");
}
async function fetchJson(url: string, init?: any): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

async function loadUserByEmail(email: string): Promise<{ id: string; data: any } | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/locora_users?select=id,data&data->>email=eq.${encodeURIComponent(norm(email))}`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0];
}

async function verifySession(req: any): Promise<{ email: string } | null> {
  try {
    const secret = getEnv("SESSION_SECRET");
    if (!secret) return null;
    const token = parseCookies(req).locora_session;
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const expected = await hmacB64url(secret, parts[0] + "." + parts[1]);
    if (!ctEqual(expected, parts[2])) return null;
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (!payload.email || !isEmail(payload.email) || !payload.exp || payload.exp * 1000 < Date.now()) return null;
    const email = norm(payload.email);
    try {
      const tokenHash = await sha256Hex(token);
      const rev = await fetchJson(`${supabaseBase()}/rest/v1/revoked_tokens?id=eq.${encodeURIComponent(tokenHash)}&select=data`, { headers: supabaseHeaders() });
      if (rev.ok && Array.isArray(rev.body) && rev.body.length > 0) {
        const exp = rev.body[0].data?.expiresAt;
        if (!exp || new Date(exp).getTime() > Date.now()) return null;
      }
    } catch {}
    try {
      const userRow = await loadUserByEmail(email);
      if (userRow && userRow.data && typeof userRow.data.sessionVersion === "number") {
        const stored = userRow.data.sessionVersion;
        if (payload.v === undefined) {
          if (stored > 0) return null;
        } else if (payload.v !== stored) {
          return null;
        }
      }
    } catch {}
    return { email };
  } catch {
    return null;
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
      "Google Calendar connect is not configured on the server. " +
        "Set GOOGLE_CLIENT_ID in Vercel (Production) and redeploy.",
    );
  }

  // C2: only a signed-in user may start the connect flow, and the user
  // id baked into `state` comes from that session — never from the
  // request. A client-supplied userId query param is ignored entirely.
  const session = await verifySession(req);
  if (!session) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Sign in required. Please sign in, then connect Google Calendar from your profile page.");
  }
  const userRow = await loadUserByEmail(session.email).catch(() => null);
  if (!userRow || !userRow.id) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Your account could not be verified. Please sign out and sign in again, then try connecting from your profile page.");
  }
  const userId = userRow.id;

  // Only allow same-site return paths, never an external URL.
  const rawReturnTo =
    typeof req.query?.returnTo === "string" ? req.query.returnTo : "";
  const returnTo =
    rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : "/profile";

  // CSRF protection: same pattern as sign-in — a random token in an
  // HttpOnly cookie, echoed back inside `state`.
  const csrf = randomToken();
  const state = base64urlEncode(
    JSON.stringify({ csrf, purpose: "calendar", userId, returnTo }),
  );

  const configured = getEnv("GOOGLE_REDIRECT_URI");
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "";
  const redirectUri = configured || `${proto}://${host}/api/auth/callback/google`;

  const secure = redirectUri.startsWith("https://") ? "; Secure" : "";
  const cookie = `locora_oauth_state=${csrf}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile https://www.googleapis.com/auth/calendar.events",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    "Set-Cookie": cookie,
  });
  return res.end();
}
