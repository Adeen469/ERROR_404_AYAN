// POST /api/calendar/events — add a shared Locora event to the user's
// own Google Calendar. DELETE removes an event this integration created.
//
// Body (POST): { eventId }
// Query (DELETE): ?eventId=... and/or ?calendarEventId=...
//
// SECURITY (audit #4 C2): the caller is identified ONLY by the signed-in
// Locora session (locora_session cookie). Any client-supplied userId is
// ignored: the storage key is the locora_users row id for the session
// email. No session -> 401. DELETE only removes a Google event this
// integration recorded as its own creation (data.created_event_ids in
// the connection row): an arbitrary calendar event id is refused 403,
// so one user can never delete another user's — or any unrelated —
// calendar event. The calendar_connections table missing (PGRST205)
// -> 503, never a silent "not connected".
//
// Flow: look up the user's encrypted refresh token in Supabase
// (calendar_connections), mint a fresh access token from it, fetch the
// event from the shared events table, and insert it into the user's
// primary calendar. Locora never lists or reads the user's other
// calendar events — it only inserts the events the user registers for
// and deletes the ones it created.
//
// Self-contained Vercel Serverless Function (same pattern as
// api/events.ts). If no connection exists, POST returns
// { connected: false } (HTTP 200) instead of an error, so the frontend
// can offer the Connect button. If Google rejects the refresh token
// (user revoked access), the stored connection is deleted and the same
// { connected: false, revoked: true } shape is returned.

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

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const b = req.body;
      if (b && typeof b === "object") return resolve(b);
      if (typeof b === "string" && b.length > 0) {
        try {
          return resolve(JSON.parse(b));
        } catch {
          return resolve({});
        }
      }
      let data = "";
      const timer = setTimeout(() => resolve({}), 3000);
      req.on("data", (chunk: any) => {
        data += chunk;
      });
      req.on("end", () => {
        clearTimeout(timer);
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
      req.on("error", () => {
        clearTimeout(timer);
        resolve({});
      });
    } catch {
      resolve({});
    }
  });
}

function base64urlDecodeToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function decryptRefreshToken(encrypted: string): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable in this runtime");
  const secret = getEnv("GOOGLE_CLIENT_SECRET");
  const keyMaterial = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode("locora-calendar-v1:" + secret),
  );
  const key = await subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["decrypt"]);
  const combined = base64urlDecodeToBytes(encrypted);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

async function fetchConnection(userId: string): Promise<{ tableMissing: boolean; error: boolean; data: any | null }> {
  const rowRes = await fetch(
    supabaseBase() +
      "/rest/v1/calendar_connections?select=data&user_id=eq." +
      encodeURIComponent(userId),
    { headers: supabaseHeaders() },
  );
  const rows = await rowRes.json().catch(() => null);
  if (!rowRes.ok || !Array.isArray(rows)) {
    // PGRST205 = the calendar_connections table has not been created yet.
    // That must fail closed (503), never masquerade as "not connected".
    if (rows && (rows as any).code === "PGRST205") return { tableMissing: true, error: false, data: null };
    return { tableMissing: false, error: true, data: null };
  }
  if (rows.length === 0) return { tableMissing: false, error: false, data: null };
  return { tableMissing: false, error: false, data: rows[0].data || null };
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

// ---- Created-event ledger ----
// Every Google event this integration inserts is recorded in the
// connection row (data.created_event_ids: { locoraEventId: googleId }).
// DELETE only ever removes an id from this ledger, so a caller cannot
// delete an arbitrary event from the victim's calendar.
function recordedIds(data: any): Record<string, string> {
  const map = data?.created_event_ids;
  if (!map || typeof map !== "object" || Array.isArray(map)) return {};
  const out: Record<string, string> = {};
  for (const k of Object.keys(map)) {
    if (typeof map[k] === "string" && map[k]) out[k] = map[k];
  }
  return out;
}

async function saveConnectionData(userId: string, patch: Record<string, any>): Promise<boolean> {
  try {
    const current = await fetchConnection(userId);
    if (current.tableMissing || current.error) return false;
    const merged = { ...(current.data || {}), ...patch };
    const res = await fetchJson(
      `${supabaseBase()}/rest/v1/calendar_connections?user_id=eq.${encodeURIComponent(userId)}`,
      { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: merged }) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function recordCreatedEvent(userId: string, locoraEventId: string, googleEventId: string): Promise<void> {
  try {
    const current = await fetchConnection(userId);
    if (current.tableMissing || current.error) return;
    const map = recordedIds(current.data);
    map[locoraEventId] = googleEventId;
    await saveConnectionData(userId, { created_event_ids: map });
  } catch {
    // Best-effort: the calendar event already exists; a missed ledger
    // entry only means DELETE will refuse it later (fail closed).
  }
}

async function forgetCreatedEvent(userId: string, locoraEventId: string): Promise<void> {
  try {
    if (!locoraEventId) return;
    const current = await fetchConnection(userId);
    if (current.tableMissing || current.error) return;
    const map = recordedIds(current.data);
    if (!(locoraEventId in map)) return;
    delete map[locoraEventId];
    await saveConnectionData(userId, { created_event_ids: map });
  } catch {
    // Best-effort cleanup only.
  }
}

async function deleteConnection(userId: string): Promise<void> {
  try {
    await fetch(
      supabaseBase() +
        "/rest/v1/calendar_connections?user_id=eq." +
        encodeURIComponent(userId),
      { method: "DELETE", headers: supabaseHeaders() },
    );
  } catch {
    // Best effort: a stale row just means status keeps saying connected
    // until the next check, which re-validates on use.
  }
}

async function fetchEvent(eventId: string): Promise<any | null> {
  const rowRes = await fetch(
    supabaseBase() +
      "/rest/v1/events?select=data&id=eq." +
      encodeURIComponent(eventId),
    { headers: supabaseHeaders() },
  );
  const rows = await rowRes.json().catch(() => null);
  if (!rowRes.ok || !Array.isArray(rows) || rows.length === 0) return null;
  return rows[0].data || null;
}

async function mintAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: getEnv("GOOGLE_CLIENT_ID"),
        client_secret: getEnv("GOOGLE_CLIENT_SECRET"),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const tokenData = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokenData?.access_token) return null;
    return tokenData.access_token;
  } catch {
    return null;
  }
}

function calendarEventBody(event: any): any {
  const start = new Date(event.startDate);
  const end = event.endDate ? new Date(event.endDate) : new Date(start.getTime() + 2 * 3600 * 1000);
  const location = [event.venueName, event.address, event.city]
    .filter((part) => typeof part === "string" && part.trim())
    .join(", ");
  const descriptionParts = [event.summary, event.description].filter(
    (part) => typeof part === "string" && part.trim(),
  );
  return {
    summary: event.title || "Locora event",
    description: descriptionParts.join("\n\n") || undefined,
    location: location || undefined,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };
}

export default async function handler(req: any, res: any) {
  if (
    !getEnv("SUPABASE_URL") ||
    !getEnv("SUPABASE_SERVICE_ROLE_KEY") ||
    !getEnv("GOOGLE_CLIENT_ID") ||
    !getEnv("GOOGLE_CLIENT_SECRET")
  ) {
    return sendJson(res, 503, {
      message:
        "Google Calendar is not configured on the server. See CALENDAR_SETUP.md.",
    });
  }

  // C2: a session is required on every route. A client-supplied userId
  // (body or query) is ignored entirely; the storage key comes from the
  // session email -> locora_users row.
  const session = await verifySession(req);
  if (!session) {
    return sendJson(res, 401, { message: "Sign in required" });
  }
  const userId = await resolveUserId(session.email);
  if (!userId) {
    // No locora_users row for this session: no connection keyed by this
    // user can exist, so report not-connected (fail closed).
    return sendJson(res, 200, {
      connected: false,
      message: "Google Calendar is not connected for this user.",
    });
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    const eventId = typeof body.eventId === "string" ? body.eventId : "";
    if (!eventId) {
      return sendJson(res, 400, { message: "Missing or invalid eventId" });
    }

    const conn = await fetchConnection(userId);
    if (conn.tableMissing) {
      return sendJson(res, 503, {
        connected: false,
        message:
          "calendar_connections table has not been created yet in Supabase. See CALENDAR_SETUP.md step 3.",
      });
    }
    if (conn.error) {
      return sendJson(res, 502, { message: "Could not check calendar connection" });
    }
    const connection = conn.data;
    if (!connection?.refresh_token_enc) {
      return sendJson(res, 200, {
        connected: false,
        message: "Google Calendar is not connected for this user.",
      });
    }

    const event = await fetchEvent(eventId);
    if (!event) return sendJson(res, 404, { message: "Event not found" });

    let refreshToken: string;
    try {
      refreshToken = await decryptRefreshToken(connection.refresh_token_enc);
    } catch {
      return sendJson(res, 502, { message: "Could not unlock the calendar connection. Please reconnect." });
    }

    const accessToken = await mintAccessToken(refreshToken);
    if (!accessToken) {
      await deleteConnection(userId);
      return sendJson(res, 200, {
        connected: false,
        revoked: true,
        message: "Google Calendar access was revoked or expired. Please reconnect.",
      });
    }

    try {
      const insertRes = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(calendarEventBody(event)),
        },
      );
      const inserted = await insertRes.json().catch(() => null);
      if (insertRes.status === 401) {
        await deleteConnection(userId);
        return sendJson(res, 200, {
          connected: false,
          revoked: true,
          message: "Google Calendar access was revoked. Please reconnect.",
        });
      }
      if (!insertRes.ok || !inserted?.id) {
        const detail = inserted?.error?.message || "Google Calendar insert failed";
        return sendJson(res, 502, { message: "Could not add event to Google Calendar: " + String(detail).slice(0, 200) });
      }
      // Record the created id so DELETE can only ever remove ids this
      // integration created for this user.
      await recordCreatedEvent(userId, eventId, inserted.id);
      return sendJson(res, 200, {
        connected: true,
        calendarEventId: inserted.id,
        htmlLink: inserted.htmlLink || null,
      });
    } catch {
      return sendJson(res, 502, { message: "Could not reach Google Calendar" });
    }
  }

  if (req.method === "DELETE") {
    const eventId = firstQuery(req.query, "eventId");
    const calendarEventId = firstQuery(req.query, "calendarEventId");
    if (!eventId && !calendarEventId) {
      return sendJson(res, 400, { message: "Missing eventId/calendarEventId" });
    }
    const conn = await fetchConnection(userId);
    if (conn.tableMissing) {
      return sendJson(res, 503, {
        connected: false,
        message:
          "calendar_connections table has not been created yet in Supabase. See CALENDAR_SETUP.md step 3.",
      });
    }
    if (conn.error) {
      return sendJson(res, 502, { message: "Could not check calendar connection" });
    }
    const connection = conn.data;
    if (!connection?.refresh_token_enc) {
      return sendJson(res, 200, { connected: false });
    }
    // Only a Google event id this integration recorded for this user
    // may be deleted — never an arbitrary id handed in by the caller.
    const recorded = recordedIds(connection);
    let googleEventId = "";
    let locoraEventId = "";
    if (eventId && typeof recorded[eventId] === "string") {
      googleEventId = recorded[eventId];
      locoraEventId = eventId;
    } else if (calendarEventId) {
      const found = Object.keys(recorded).find((k) => recorded[k] === calendarEventId);
      if (found) {
        googleEventId = calendarEventId;
        locoraEventId = found;
      }
    }
    if (!googleEventId) {
      return sendJson(res, 403, {
        message: "That calendar event was not created by Locora for this account, so it cannot be removed here.",
      });
    }
    let refreshToken: string;
    try {
      refreshToken = await decryptRefreshToken(connection.refresh_token_enc);
    } catch {
      return sendJson(res, 502, { message: "Could not unlock the calendar connection. Please reconnect." });
    }
    const accessToken = await mintAccessToken(refreshToken);
    if (!accessToken) {
      await deleteConnection(userId);
      return sendJson(res, 200, { connected: false, revoked: true });
    }
    try {
      await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events/" +
          encodeURIComponent(googleEventId),
        { method: "DELETE", headers: { Authorization: "Bearer " + accessToken } },
      );
      // 404/410 from Google just means it is already gone — success either way.
      await forgetCreatedEvent(userId, locoraEventId);
      return sendJson(res, 200, { success: true, connected: true });
    } catch {
      return sendJson(res, 502, { message: "Could not reach Google Calendar" });
    }
  }

  res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ message: "Method not allowed" }));
}
