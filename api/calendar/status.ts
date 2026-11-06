// GET /api/calendar/status — is this Locora user's Google Calendar
// connected? DELETE disconnects it.
//
// SECURITY (audit #4 C2): the caller is identified ONLY by the signed-in
// Locora session (locora_session cookie). Any client-supplied userId is
// ignored: the storage key is the locora_users row id for the session
// email. No session -> 401. No locora_users row -> connected:false
// (fail closed: a connection is always keyed by that row's id, so no row
// means no connection of this user's can exist). The calendar_connections
// table missing (PGRST205) -> 503, never a silent success.
//
// Self-contained Vercel Serverless Function (same pattern as
// api/events.ts). Connections live in Supabase, table
// calendar_connections (user_id text primary key, data jsonb), written
// only by the OAuth callback with the service-role key. Browsers never
// see a refresh token: this endpoint only reports connected + the
// Google account email used for display.

function getEnv(name: string): string {
  try {
    const env = (globalThis as any).process?.env;
    return (env && env[name]) || "";
  } catch {
    return "";
  }
}

function sendJson(res: any, status: number, obj: any): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
}

function supabaseBase(): string {
  return getEnv("SUPABASE_URL").replace(/\/$/, "");
}

function firstQuery(query: any, name: string): string {
  const v = query ? query[name] : undefined;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return typeof v === "string" ? v : "";
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

// The storage key for this caller's calendar connection: the
// locora_users row id for the session email. Never from the request.
async function resolveUserId(sessionEmail: string): Promise<string | null> {
  try {
    const row = await loadUserByEmail(sessionEmail);
    return row && typeof row.id === "string" && row.id ? row.id : null;
  } catch {
    return null;
  }
}

export default async function handler(req: any, res: any) {
  if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return sendJson(res, 503, {
      message:
        "Google Calendar storage is not configured on the server. See CALENDAR_SETUP.md.",
    });
  }

  // C2: a session is required on every route. A client-supplied userId
  // (query or body) is ignored entirely.
  const session = await verifySession(req);
  if (!session) {
    return sendJson(res, 401, { message: "Sign in required" });
  }
  const userId = await resolveUserId(session.email);
  if (!userId) {
    // No locora_users row for this session: no connection keyed by this
    // user can exist, so report disconnected / nothing to disconnect.
    if (req.method === "GET") return sendJson(res, 200, { connected: false, google_email: null });
    if (req.method === "DELETE") return sendJson(res, 200, { success: true, connected: false });
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ message: "Method not allowed" }));
  }

  if (req.method === "GET") {
    try {
      const rowRes = await fetch(
        supabaseBase() +
          "/rest/v1/calendar_connections?select=data&user_id=eq." +
          encodeURIComponent(userId),
        { headers: supabaseHeaders() },
      );
      const rows = await rowRes.json().catch(() => null);
      if (!rowRes.ok || !Array.isArray(rows)) {
        // Distinguish the one expected pre-setup failure from a real
        // backend error: Supabase answers PGRST205 when the
        // calendar_connections table has not been created yet (setup
        // step 3). Saying so beats a generic error when diagnosing.
        if (rows && (rows as any).code === "PGRST205") {
          return sendJson(res, 503, {
            connected: false,
            message:
              "calendar_connections table has not been created yet in Supabase. See CALENDAR_SETUP.md step 3.",
          });
        }
        return sendJson(res, 502, { message: "Could not check calendar connection" });
      }
      if (rows.length === 0) return sendJson(res, 200, { connected: false, google_email: null });
      return sendJson(res, 200, {
        connected: true,
        google_email: rows[0].data?.google_email || null,
      });
    } catch {
      return sendJson(res, 502, { message: "Could not check calendar connection" });
    }
  }

  if (req.method === "DELETE") {
    try {
      const delRes = await fetch(
        supabaseBase() +
          "/rest/v1/calendar_connections?user_id=eq." +
          encodeURIComponent(userId),
        { method: "DELETE", headers: supabaseHeaders() },
      );
      if (!delRes.ok) {
        // Fail closed when the table is absent: never report a
        // disconnect that did not happen.
        const detail = await delRes.json().catch(() => null);
        if (detail && (detail as any).code === "PGRST205") {
          return sendJson(res, 503, {
            connected: false,
            message:
              "calendar_connections table has not been created yet in Supabase. See CALENDAR_SETUP.md step 3.",
          });
        }
        return sendJson(res, 502, { message: "Could not disconnect Google Calendar" });
      }
      return sendJson(res, 200, { success: true, connected: false });
    } catch {
      return sendJson(res, 502, { message: "Could not disconnect Google Calendar" });
    }
  }

  res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ message: "Method not allowed" }));
}
