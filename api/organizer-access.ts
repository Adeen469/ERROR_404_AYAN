import { createHmac, timingSafeEqual, scryptSync, randomBytes, createHash } from "crypto";
// Shared server helpers for Locora security fix (Phase 1 Finding 1+).
// Used by api/registrations.ts, api/events.ts, api/messages.ts,
// api/auth/* and api/me.ts. No secrets are hardcoded here: SESSION_SECRET,
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come only from Vercel env vars.
// If SESSION_SECRET is missing, session verification fails closed (null)
// and login/signup/Google callback must refuse to issue a session.

export function getEnv(name: string): string {
  try {
    const env = (globalThis as any).process?.env;
    return (env && env[name]) || "";
  } catch {
    return "";
  }
}

export function norm(email: string): string {
  return (email || "").trim().toLowerCase();
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || "");
}

export function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.indexOf(norm(email)) !== -1;
}

export function sendJson(res: any, status: number, obj: any, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cache-Control": "no-store",
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(obj));
}

export function parseCookies(req: any): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers?.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function getClientIp(req: any): string {
  const fwd = req.headers?.["x-forwarded-for"] || "";
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return req.headers?.["x-real-ip"] || "unknown";
}

function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}
function b64urlDecode(text: string): string {
  return Buffer.from(text, "base64url").toString("utf8");
}

export interface SessionUser { email: string; role: string; authProvider: string; sessionVersion?: number; }

export function signSession(email: string, role: string, authProvider: string, sessionVersion = 0): string {
  const secret = getEnv("SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(JSON.stringify({
    email: norm(email), role: role || "attendee", authProvider: authProvider || "local",
    v: sessionVersion || 0,
    iat: now, exp: now + 7 * 24 * 3600,
  }));
  const sig = createHmac("sha256", secret).update(header + "." + payload).digest("base64url");
  return header + "." + payload + "." + sig;
}

export function sessionToken(req: any): string | null {
  try { return parseCookies(req).locora_session || null; } catch { return null; }
}

// Async verifySession (revocation pass): signature + expiry, then
// (a) revoked_tokens — a row for this token's SHA-256 hash, not yet
// expired, rejects the token. If the table is missing/unreadable the
// check is SKIPPED (allow), so a missing table can never lock everyone
// out; logout revocation simply does not persist until the table
// exists (see SECURITY_FIX_SETUP.md). This is honest fail-open for
// revocation only — a missing SESSION_SECRET still fails closed.
// (b) session version — if a locora_users row exists with a numeric
// sessionVersion, the token's v must match it. A token with no v is
// rejected only when the stored version is > 0 (so pre-version tokens
// keep working until a password reset bumps the version). If no user
// row exists (e.g. locora_users missing, Google sign-in recorded
// best-effort), the version check is skipped, not failed.
export async function verifySession(req: any): Promise<SessionUser | null> {
  try {
    const secret = getEnv("SESSION_SECRET");
    if (!secret) return null;
    const token = sessionToken(req);
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const expected = createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest("base64url");
    const a = Buffer.from(expected);
    const b = Buffer.from(parts[2]);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (!payload.email || !isEmail(payload.email) || !payload.exp || payload.exp * 1000 < Date.now()) return null;
    const email = norm(payload.email);
    // (a) revocation check (best-effort, fail-open only on table errors).
    try {
      if (supabaseBase() && getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
        const tokenHash = hashToken(token);
        const { ok, body } = await fetchJson(
          `${supabaseBase()}/rest/v1/revoked_tokens?id=eq.${encodeURIComponent(tokenHash)}&select=data`,
          { headers: supabaseHeaders() },
        );
        if (ok && Array.isArray(body) && body.length > 0) {
          const d = body[0].data || {};
          if (!d.expiresAt || Date.parse(d.expiresAt) >= Date.now()) return null;
        }
      }
    } catch {}
    // (b) session-version check (skipped when no user row is found).
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
    return { email, role: payload.role || "attendee", authProvider: payload.authProvider || "local", sessionVersion: typeof payload.v === "number" ? payload.v : undefined };
  } catch {
    return null;
  }
}

// Insert the caller's current token into revoked_tokens (best-effort).
// Returns true only if the row was written; a missing table / error
// returns false and must never fail logout (the cookie is still cleared).
export async function revokeSessionToken(req: any): Promise<boolean> {
  try {
    const token = sessionToken(req);
    if (!token || !supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) return false;
    const parts = token.split(".");
    let expMs = Date.now() + 7 * 24 * 3600 * 1000;
    let email = "";
    try {
      const payload = JSON.parse(b64urlDecode(parts[1]));
      if (payload.exp) expMs = payload.exp * 1000;
      if (payload.email) email = norm(payload.email);
    } catch {}
    const tokenHash = hashToken(token);
    const { ok } = await fetchJson(`${supabaseBase()}/rest/v1/revoked_tokens`, {
      method: "POST", headers: supabaseHeaders(),
      body: JSON.stringify({ id: tokenHash, data: { tokenHash, email, expiresAt: new Date(expMs).toISOString() } }),
    });
    return ok;
  } catch { return false; }
}

function isSecureReq(req: any): boolean {
  const proto = req.headers?.["x-forwarded-proto"];
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "";
  return proto === "https" || (host !== "" && !host.includes("localhost") && !host.startsWith("127."));
}

export function sessionCookie(jwt: string, req: any): string {
  return `locora_session=${jwt}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${isSecureReq(req) ? "; Secure" : ""}`;
}
export function clearSessionCookie(req: any): string {
  return `locora_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecureReq(req) ? "; Secure" : ""}`;
}

// ---- Supabase ----
export function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" };
}
export function supabaseBase(): string {
  return getEnv("SUPABASE_URL").replace(/\/$/, "");
}
export async function fetchJson(url: string, init?: any): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}
export function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const b = (req as any).body;
      if (b && typeof b === "object") return resolve(b);
      if (typeof b === "string" && b.length > 0) {
        try { return resolve(JSON.parse(b)); } catch { return resolve({}); }
      }
      let data = "";
      const timer = setTimeout(() => resolve({}), 3000);
      req.on("data", (chunk: any) => { data += chunk; });
      req.on("end", () => { clearTimeout(timer); try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
      req.on("error", () => { clearTimeout(timer); resolve({}); });
    } catch { resolve({}); }
  });
}

// ---- Passwords (scrypt, per-user salt, timing-safe compare) ----
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = (stored || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const hash = scryptSync(password, parts[1], 64);
    const expected = Buffer.from(parts[2], "hex");
    return hash.length === expected.length && timingSafeEqual(hash, expected);
  } catch { return false; }
}
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
export function randomTokenHex(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

// ---- Rate limiting (Supabase-backed counter, table rate_limits) ----
// Returns { allowed, retryAfter, tableMissing }.
// Auth callers must fail closed (503) when tableMissing is true.
// Read (GET) callers may allow when tableMissing is true, because the
// data itself is already protected by the session check; the table
// must still be created (see SECURITY_FIX_SETUP.md).
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfter: number; tableMissing: boolean }> {
  try {
    if (!supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) return { allowed: false, retryAfter: 0, tableMissing: true };
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

// ---- Events / organiser helpers ----
export function organizerEmailOf(event: any): string {
  return norm(event?.createdByEmail || event?.organizer?.email || "");
}
export function isEventOwner(event: any, email: string): boolean {
  if (!event || !email) return false;
  const e = norm(email);
  if (event.createdByEmail) return norm(event.createdByEmail) === e;
  return (event.organizer?.email || "") !== "" && norm(event.organizer.email) === e;
}
export function mayManageEvent(event: any, email: string): boolean {
  if (!event || !email) return false;
  if (isAdmin(email)) return true;
  return isEventOwner(event, email);
}
export function stripEventPublic(event: any): any {
  if (!event) return event;
  const { createdByEmail: _c, upiId: _u, organizer, ...rest } = event;
  let org = organizer;
  if (organizer && typeof organizer === "object") {
    const { email: _e, ...orgRest } = organizer;
    org = orgRest;
  }
  return { ...rest, organizer: org };
}
export async function loadEvent(eventId: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/events?id=eq.${encodeURIComponent(eventId)}&select=data`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data;
}
export async function loadAllEvents(): Promise<any[]> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/events?select=data&order=created_at.desc&limit=1000`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body)) return [];
  return body.map((r: any) => r.data).filter(Boolean);
}
export async function isApprovedOrganizer(email: string): Promise<boolean> {
  if (isAdmin(email)) return true;
  try {
    const { ok, body } = await fetchJson(
      `${supabaseBase()}/rest/v1/organizer_access?email=eq.${encodeURIComponent(norm(email))}&select=data`,
      { headers: supabaseHeaders() },
    );
    if (!ok || !Array.isArray(body) || body.length === 0) return false;
    return body[0].data?.status === "approved";
  } catch { return false; }
}
export async function loadUserByEmail(email: string): Promise<{ id: string; data: any } | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/locora_users?select=id,data&data->>email=eq.${encodeURIComponent(norm(email))}`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0];
}
export function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// SECURITY FIX — session-gated: identity is the locora_session JWT.
// GET ?email=, POST request ?email, and POST approve/reject/revoke
// ?adminEmail are all IGNORED as identity; the session email is used.
// Admin lists and decisions require a session admin.

// Organizer access API — who may post events, and admin approval.
//
// GET  /api/organizer-access?email=x
//   -> { email, role: 'admin' | 'organizer' | 'pending' | 'attendee',
//        status: 'admin' | 'approved' | 'pending' | 'rejected' | 'none' }
// POST /api/organizer-access { action: 'request', email, name }
//   -> creates (or keeps) a pending organizer request for that email.
// POST /api/organizer-access { action: 'approve' | 'reject',
//                               adminEmail, targetEmail }
//   -> admin-only. Sets the target's status to approved/rejected.
// POST /api/organizer-access { action: 'revoke',
//                               adminEmail, targetEmail }
//   -> admin-only. Removes an approved organizer: the target's status
//     becomes 'revoked' and they go back to being an attendee. They may
//     request access again afterwards.
// GET  /api/organizer-access?pending=1&adminEmail=x
//   -> admin-only. Lists pending requests.
// GET  /api/organizer-access?organizers=1&adminEmail=x
//   -> admin-only. Lists approved organizers (for the remove list).
//
// This is a Vercel Serverless Function, self-contained (no imports).
// Access rows live in Supabase, not in any one browser's localStorage, so
// an approval made by an admin on one device applies to the requester on
// any device.
//
// Supabase setup (see ORGANIZER_ACCESS_SETUP.md):
//   Table: organizer_access (email text primary key, data jsonb not null,
//                            created_at timestamptz default now())
//   Vercel env vars (Production, Sensitive, already set for events):
//     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// The service-role key is server-only: the frontend never calls Supabase
// directly, it only calls this function, so the key never reaches a browser.
//
// Admins are identified by email only. These are identifiers, not secrets,
// and the check runs here on the server, not just in the browser. Never put
// a password in this file.
//   Admin emails: mr.adeen946@gmail.com, ayan.work937@gmail.com
//
// If the env vars are missing, this returns 503 JSON. The frontend treats
// any API failure as "access not verified" and fails closed: nobody is
// treated as an approved organizer from local data alone, except an admin
// signed in with Google (see OrganizerGuard).

const ADMIN_EMAILS = ["mr.adeen946@gmail.com", "ayan.work937@gmail.com"];

async function fetchRow(email: string): Promise<any | null> {
  const url =
    supabaseBase() +
    "/rest/v1/organizer_access?email=eq." +
    encodeURIComponent(email) +
    "&select=email,data";
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) {
    const err: any = new Error("Supabase query failed: " + res.status);
    err.status = res.status;
    throw err;
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

async function upsertRow(email: string, data: any): Promise<void> {
  const url = supabaseBase() + "/rest/v1/organizer_access";
  const res = await fetch(url, {
    method: "POST",
    headers: Object.assign({}, supabaseHeaders(), {
      Prefer: "resolution=merge-duplicates,return=representation",
    }),
    body: JSON.stringify({ email: email, data: data }),
  });
  if (!res.ok) {
    const err: any = new Error("Supabase upsert failed: " + res.status);
    err.status = res.status;
    throw err;
  }
}

function roleFor(email: string, row: any): any {
  if (isAdmin(email)) {
    return { email: email, role: "admin", status: "admin" };
  }
  if (!row) {
    return { email: email, role: "attendee", status: "none" };
  }
  const status = row.data && row.data.status;
  if (status === "approved") {
    return { email: email, role: "organizer", status: "approved" };
  }
  if (status === "pending") {
    return { email: email, role: "pending", status: "pending" };
  }
  return { email: email, role: "attendee", status: status || "none" };
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, {
        message:
          "Shared organizer access is not configured. See ORGANIZER_ACCESS_SETUP.md.",
      });
      return;
    }

    const session = await verifySession(req);
    if (!session) { sendJson(res, 401, { message: "Sign in required" }); return; }
    const url = new URL(req.url || "/api/organizer-access", "http://localhost");
    const email = session.email;

    if (
      req.method === "GET" &&
      (url.searchParams.get("pending") === "1" ||
        url.searchParams.get("organizers") === "1")
    ) {
      const adminEmail = session.email;
      if (!isAdmin(adminEmail)) {
        sendJson(res, 403, { message: "Only admins can list organizer requests." });
        return;
      }
      const listUrl =
        supabaseBase() +
        "/rest/v1/organizer_access?select=email,data&order=created_at.asc";
      const listRes = await fetch(listUrl, { headers: supabaseHeaders() });
      if (!listRes.ok) {
        if (listRes.status === 404 || (listRes as any).status === 400) {
          // Table may not exist yet; surface the setup message distinctly.
          sendJson(res, 503, {
            message:
              "organizer_access table has not been created yet in Supabase. See ORGANIZER_ACCESS_SETUP.md step 2.",
          });
          return;
        }
        throw new Error("Supabase list failed: " + listRes.status);
      }
      const rows = await listRes.json();
      if (url.searchParams.get("organizers") === "1") {
        const organizers = (Array.isArray(rows) ? rows : [])
          .filter((r: any) => r.data && r.data.status === "approved")
          .map((r: any) => ({
            email: r.email,
            name: r.data.name || "",
            approvedAt: r.data.decidedAt || r.created_at || "",
          }));
        sendJson(res, 200, { organizers: organizers });
        return;
      }
      const pending = (Array.isArray(rows) ? rows : [])
        .filter((r: any) => r.data && r.data.status === "pending")
        .map((r: any) => ({
          email: r.email,
          name: r.data.name || "",
          requestedAt: r.data.requestedAt || r.created_at || "",
        }));
      sendJson(res, 200, { pending: pending });
      return;
    }

    if (req.method === "GET") {
      // email is the session email; the query param is ignored.
      let row: any = null;
      try {
        row = await fetchRow(email);
      } catch (e: any) {
        if (e && (e.status === 404 || e.status === 400)) {
          // Table missing: admins still resolve as admins; everyone else
          // resolves as attendee so the app fails closed, not broken.
          sendJson(res, 200, roleFor(email, null));
          return;
        }
        throw e;
      }
      sendJson(res, 200, roleFor(email, row));
      return;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const action = body.action;

      if (action === "request") {
        const reqEmail = session.email;
        if (isAdmin(reqEmail)) {
          sendJson(res, 200, roleFor(reqEmail, null));
          return;
        }
        let row: any = null;
        try {
          row = await fetchRow(reqEmail);
        } catch (e: any) {
          if (e && (e.status === 404 || e.status === 400)) {
            sendJson(res, 503, {
              message:
                "organizer_access table has not been created yet in Supabase. See ORGANIZER_ACCESS_SETUP.md step 2.",
            });
            return;
          }
          throw e;
        }
        if (row && row.data && row.data.status === "approved") {
          sendJson(res, 200, roleFor(reqEmail, row));
          return;
        }
        const now = new Date().toISOString();
        await upsertRow(reqEmail, {
          status: "pending",
          name: body.name || "",
          requestedAt: (row && row.data && row.data.requestedAt) || now,
        });
        sendJson(res, 200, {
          email: reqEmail,
          role: "pending",
          status: "pending",
        });
        return;
      }

      if (action === "approve" || action === "reject" || action === "revoke") {
        const adminEmail = session.email;
        const targetEmail = norm(body.targetEmail || "");
        if (!isAdmin(adminEmail)) {
          sendJson(res, 403, {
            message: "Only admins can approve, reject, or remove organizers.",
          });
          return;
        }
        if (!targetEmail || isAdmin(targetEmail)) {
          sendJson(res, 400, { message: "Invalid target email." });
          return;
        }
        const status =
          action === "approve"
            ? "approved"
            : action === "revoke"
              ? "revoked"
              : "rejected";
        await upsertRow(targetEmail, {
          status: status,
          decidedBy: adminEmail,
          decidedAt: new Date().toISOString(),
        });
        sendJson(res, 200, {
          email: targetEmail,
          role: action === "approve" ? "organizer" : "attendee",
          status: status,
        });
        return;
      }

      sendJson(res, 400, { message: "Unknown action." });
      return;
    }

    sendJson(res, 405, { message: "Method not allowed." });
  } catch (e: any) {
    console.error("organizer-access failed:", e);
    sendJson(res, 502, { message: "Could not check organizer access." });
  }
}
