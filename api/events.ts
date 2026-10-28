import { createHmac, timingSafeEqual, scryptSync, randomBytes, createHash } from "crypto";
// Shared server helpers for Locora security fix (Phase 1 Finding 1+).
// Used by api/registrations.ts, api/events.ts, api/messages.ts,
// api/auth/* and api/me.ts. No secrets are hardcoded here: SESSION_SECRET,
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come only from Vercel env vars.
// If SESSION_SECRET is missing, session verification fails closed (null)
// and login/signup/Google callback must refuse to issue a session.

export const ADMIN_EMAILS = ["mr.adeen946@gmail.com", "ayan.work937@gmail.com"];

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

// SECURITY FIX — Phase 1 Finding 2: public /api/events responses never
// include organiser.email, createdByEmail or upiId (list or single).
// UPI is only available via the session-only ?payment=1&id= endpoint,
// to a signed-in user, for that one event. Writes require a session and
// server-side ownership (POST: approved organiser/admin; PATCH details:
// owner only; PATCH status / DELETE: owner or admin).

// GET /api/events — shared event list (all users, all devices).
// POST /api/events — create a shared event.
//
// This is a Vercel Serverless Function, self-contained (no imports).
// Events live in Supabase, not in any one browser's localStorage, so an
// event posted by User A is visible to User B on another device.
//
// Supabase setup (see SHARED_EVENTS_SETUP.md):
//   Table: events (id text primary key, data jsonb not null,
//                  created_at timestamptz default now())
//   Vercel env vars (Production, Sensitive):
//     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// The service-role key is server-only: the frontend never calls Supabase
// directly, it only calls this function, so the key never reaches a browser.
//
// If the env vars are missing, this returns 503 JSON. The frontend's
// events-service treats any API failure as "fall back to local storage",
// so the site keeps working locally until setup is finished — it just
// isn't shared yet.

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

// Single-event operations use ?id= on this same endpoint instead of
// /api/events/:id. The dynamic api/events/[id].ts route was never reached
// on Vercel: requests to /api/events/<id> came back as the SPA's HTML
// 404 page (the catch-all vercel.json rewrite), while /api/events itself
// worked fine. So GET/PATCH/DELETE for one event go through here, where
// the id arrives as a query parameter and the route is proven to deploy.
function firstQuery(query: any, name: string): string {
  const v = query ? query[name] : undefined;
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return typeof v === "string" ? v : "";
}

async function fetchEvent(id: string): Promise<any | null> {
  const res = await fetch(
    supabaseBase() + "/rest/v1/events?select=data&id=eq." + encodeURIComponent(id),
    { headers: supabaseHeaders() },
  );
  const rows = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(rows)) return null;
  return rows.length > 0 ? rows[0].data : null;
}

async function fetchAllEvents(): Promise<any[]> {
  const res = await fetch(
    supabaseBase() + "/rest/v1/events?select=data&order=created_at.desc&limit=1000",
    { headers: supabaseHeaders() },
  );
  const rows = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(rows)) {
    const detail = rows && rows.message ? rows.message : "Supabase query failed";
    throw new Error(detail);
  }
  return rows.map((r: any) => r.data).filter(Boolean);
}

function applyFilters(events: any[], query: any): any[] {
  let out = events.slice();
  const q = typeof query.query === "string" ? query.query.trim().toLowerCase() : "";
  if (q) {
    out = out.filter((e: any) => {
      const hay = [
        e.title || "",
        e.summary || "",
        e.description || "",
        e.venueName || "",
        ((e.tags || []) as string[]).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }
  if (query.category && query.category !== "All" && query.category !== "All Categories") {
    out = out.filter((e: any) => e.category === query.category);
  }
  // Worldwide location filter (Country -> State -> City). Same rule as the
  // frontend's local filter: a set filter matches only events that actually
  // carry that value, case-insensitively.
  const locEq = (eventValue: any, filterValue: any) =>
    typeof filterValue === "string" &&
    filterValue.trim() !== "" &&
    typeof eventValue === "string" &&
    eventValue.trim().toLowerCase() === filterValue.trim().toLowerCase();
  if (typeof query.country === "string" && query.country.trim() !== "") {
    out = out.filter((e: any) => locEq(e.country, query.country));
  }
  if (typeof query.state === "string" && query.state.trim() !== "") {
    out = out.filter((e: any) => locEq(e.state, query.state));
  }
  if (typeof query.city === "string" && query.city.trim() !== "") {
    out = out.filter((e: any) => locEq(e.city, query.city));
  }
  if (query.priceType === "free") {
    out = out.filter((e: any) => Number(e.price) === 0);
  } else if (query.priceType === "paid") {
    out = out.filter((e: any) => Number(e.price) > 0);
  }
  if (query.dateRange && query.dateRange !== "all") {
    const now = new Date();
    out = out.filter((e: any) => {
      const d = new Date(e.startDate);
      if (query.dateRange === "today") {
        return (
          d.getDate() === now.getDate() &&
          d.getMonth() === now.getMonth() &&
          d.getFullYear() === now.getFullYear()
        );
      }
      if (query.dateRange === "this_weekend") {
        const day = d.getDay();
        return day === 0 || day === 6;
      }
      if (query.dateRange === "this_month") {
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      }
      if (query.dateRange === "custom") {
        // Calendar range from the Discover picker (YYYY-MM-DD, local
        // days, same "viewer day" as the presets above). An incomplete
        // range filters nothing rather than hiding everything.
        if (!query.startDate || !query.endDate) return true;
        const pad = (n: number) => String(n).padStart(2, "0");
        const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        return day >= query.startDate && day <= query.endDate;
      }
      return true;
    });
  }
  if (query.sortBy === "soonest") {
    out.sort((a: any, b: any) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  } else if (query.sortBy === "capacity") {
    out.sort(
      (a: any, b: any) =>
        (Number(b.capacity) - Number(b.registeredCount)) - (Number(a.capacity) - Number(a.registeredCount)),
    );
  } else {
    out.sort((a: any, b: any) => {
      if (a.isFeatured && !b.isFeatured) return -1;
      if (!a.isFeatured && b.isFeatured) return 1;
      return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
    });
  }
  return out;
}

export default async function handler(req: any, res: any) {
  if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return sendJson(res, 503, {
      message: "Shared events database is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel (Production) and redeploy. See SHARED_EVENTS_SETUP.md.",
    });
  }

  if (req.method === "GET") {
    try {
      // Finding 3: per-IP rate limit on the public list/single reads.
      // If the rate_limits table is missing, allow (public data is
      // already stripped) rather than breaking Discover; the limit
      // takes effect once the table exists (see SECURITY_FIX_SETUP.md).
      const rl = await checkRateLimit(`events:get:${getClientIp(req)}`, 600, 10 * 60 * 1000);
      if (!rl.allowed && !rl.tableMissing) {
        return sendJson(res, 429, { message: "Too many requests. Try again shortly." }, { "Retry-After": String(rl.retryAfter) });
      }
      const singleId = firstQuery(req.query, "id");
      // Session-only payment endpoint: the ONLY place a UPI ID leaves
      // the server. Any signed-in user may fetch it for the event they
      // are about to pay for; guests get 401 and no UPI, never a fallback.
      if (singleId && firstQuery(req.query, "payment") === "1") {
        const session = await verifySession(req);
        if (!session) return sendJson(res, 401, { message: "Sign in required" });
        const event = await fetchEvent(singleId);
        if (!event) return sendJson(res, 404, { message: "Event not found" });
        return sendJson(res, 200, { id: event.id, title: event.title, price: Number(event.price) || 0, upiId: event.upiId || null });
      }
      if (singleId) {
        const event = await fetchEvent(singleId);
        if (!event) return sendJson(res, 404, { message: "Event not found" });
        return sendJson(res, 200, stripEventPublic(event));
      }
      const filtered = applyFilters(await fetchAllEvents(), req.query || {});
      const page = Math.max(1, parseInt(String(req.query?.page || "1"), 10) || 1);
      const pageSize = Math.max(1, parseInt(String(req.query?.pageSize || "12"), 10) || 12);
      const total = filtered.length;
      const totalPages = Math.ceil(total / pageSize) || 1;
      const offset = (page - 1) * pageSize;
      return sendJson(res, 200, {
        data: filtered.slice(offset, offset + pageSize).map((e: any) => stripEventPublic(e)),
        total, page, pageSize, totalPages,
      });
    } catch (err: any) {
      return sendJson(res, 502, { message: "Could not load shared events: " + (err?.message || "unknown error") });
    }
  }

  if (req.method === "POST") {
    try {
      const session = await verifySession(req);
      if (!session) return sendJson(res, 401, { message: "Sign in required" });
      if (!(await isApprovedOrganizer(session.email))) {
        return sendJson(res, 403, { message: "Only approved organizers and admins can post events." });
      }
      const p = await readBody(req);
      const id = typeof p.id === "string" && p.id ? p.id : "evt-" + Date.now();
      const title = p.title || "Untitled Community Event";
      const event = {
        id, title, slug: p.slug || slugify(title),
        summary: p.summary || (p.description ? String(p.description).slice(0, 140) : "Local community gathering."),
        description: p.description || "", category: p.category || "Food & Community",
        coverImage: p.coverImage || "", startDate: p.startDate || new Date(Date.now() + 86400000 * 7).toISOString(),
        endDate: p.endDate || new Date(Date.now() + 86400000 * 7 + 7200000).toISOString(),
        venueName: p.venueName || "Community Hall", address: p.address || "100 Main Street",
        neighborhood: p.state ? (p.city || "") : "", city: p.city || "Metro City",
        state: p.state || undefined, country: p.country || undefined,
        // Ownership is forced from the session, never from the body.
        createdByEmail: session.email,
        price: Number(p.price) || 0, upiId: p.upiId || undefined,
        requireAttendeeDetails: p.requireAttendeeDetails ?? true,
        capacity: Number(p.capacity) || 50, registeredCount: 0, status: "published",
        organizer: {
          ...(p.organizer || { id: "org-community", name: "Community Organizer", slug: "community-organizer", avatar: "", bio: "Community organizer.", location: "Metro City", eventsCount: 0, totalAttendeesServed: 0 }),
          email: session.email,
        },
        tags: Array.isArray(p.tags) && p.tags.length > 0 ? p.tags : ["Local", "Community"],
        isFeatured: false,
      };
      const supa = await fetch(supabaseBase() + "/rest/v1/events", {
        method: "POST", headers: supabaseHeaders(), body: JSON.stringify([{ id, data: event }]),
      });
      const rows = await supa.json().catch(() => null);
      if (!supa.ok) {
        const detail = rows && rows.message ? rows.message : "Supabase insert failed";
        return sendJson(res, 502, { message: "Could not save shared event: " + detail });
      }
      return sendJson(res, 201, stripEventPublic(event));
    } catch (err: any) {
      return sendJson(res, 502, { message: "Could not save shared event: " + (err?.message || "unknown error") });
    }
  }

  if (req.method === "PATCH") {
    try {
      const session = await verifySession(req);
      if (!session) return sendJson(res, 401, { message: "Sign in required" });
      const singleId = firstQuery(req.query, "id");
      if (!singleId) return sendJson(res, 400, { message: "Missing event id" });
      const existing = await fetchEvent(singleId);
      if (!existing) return sendJson(res, 404, { message: "Event not found" });
      const updates = await readBody(req);
      const keys = Object.keys(updates || {});
      // Counts are now owned by the registrations server (see
      // api/registrations.ts bumpEventCount). A direct count PATCH from
      // any caller, even an owner, is refused so counts cannot be forged.
      if (keys.length > 0 && keys.every((k) => k === "registeredCount")) {
        return sendJson(res, 403, { message: "Event counts are updated by the server, not by direct edits." });
      }
      const statusOnly = keys.length > 0 && keys.every((k) => k === "status");
      if (statusOnly) {
        if (!mayManageEvent(existing, session.email)) return sendJson(res, 403, { message: "Only the event owner or an admin can change status." });
      } else {
        // Detail edits: owner only (admins explicitly cannot edit
        // another organiser's details, per the original matrix).
        if (!isEventOwner(existing, session.email)) return sendJson(res, 403, { message: "You can only edit your own events." });
      }
      const { createdByEmail: _c, registeredCount: _r, isFeatured: _f, ...safeUpdates } = updates;
      if (safeUpdates.organizer && typeof safeUpdates.organizer === "object") {
        safeUpdates.organizer = { ...safeUpdates.organizer, email: existing.organizer?.email || existing.createdByEmail };
      }
      const merged = { ...existing, ...safeUpdates, id: existing.id, createdByEmail: existing.createdByEmail, registeredCount: existing.registeredCount, isFeatured: existing.isFeatured };
      const supa = await fetch(
        supabaseBase() + "/rest/v1/events?id=eq." + encodeURIComponent(singleId),
        { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: merged }) },
      );
      if (!supa.ok) {
        const rows = await supa.json().catch(() => null);
        const detail = rows && rows.message ? rows.message : "Supabase update failed";
        return sendJson(res, 502, { message: "Could not update shared event: " + detail });
      }
      return sendJson(res, 200, stripEventPublic(merged));
    } catch (err: any) {
      return sendJson(res, 502, { message: "Could not update shared event: " + (err?.message || "unknown error") });
    }
  }

  if (req.method === "DELETE") {
    try {
      const session = await verifySession(req);
      if (!session) return sendJson(res, 401, { message: "Sign in required" });
      const singleId = firstQuery(req.query, "id");
      if (!singleId) return sendJson(res, 400, { message: "Missing event id" });
      const existing = await fetchEvent(singleId);
      if (!existing) return sendJson(res, 404, { message: "Event not found" });
      if (!mayManageEvent(existing, session.email)) return sendJson(res, 403, { message: "Only the event owner or an admin can delete an event." });
      await fetch(supabaseBase() + "/rest/v1/events?id=eq." + encodeURIComponent(singleId), {
        method: "DELETE", headers: supabaseHeaders(),
      });
      return sendJson(res, 200, { success: true });
    } catch (err: any) {
      return sendJson(res, 502, { message: "Could not delete shared event: " + (err?.message || "unknown error") });
    }
  }

  res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "Cache-Control": "no-store" });
  return res.end(JSON.stringify({ message: "Method not allowed" }));
}
