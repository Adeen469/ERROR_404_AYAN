// Shared registrations API — manual-approval payments.
//
// Registrations used to live only in each browser's localStorage, so an
// organizer on another device could never see (let alone approve) an
// attendee's payment. This function stores them in Supabase instead, so
// a pending payment submitted on one device appears in the organizer's
// Attendees page on any device.
//
// GET  /api/registrations?userId=x      -> that user's registrations
// GET  /api/registrations?eventId=x     -> that event's registrations
// GET  /api/registrations?id=x          -> one registration
// GET  /api/registrations?pendingCounts=1 -> { counts: { eventId: n } }
//                                            for pending registrations
// POST /api/registrations { ...registration }
//      -> stores a registration (status 'pending' for paid, 'confirmed'
//         for free). The ticket code for a pending registration is issued
//         at approval time, not here.
// PATCH /api/registrations?id=x { status?, ticketCode?, checkedIn?,
//                                  approverEmail?, userId? }
//      -> approve ('confirmed') / reject ('rejected') / check-in: only the
//         event's owner or an admin may do these, verified here against
//         the stored event row (approverEmail must match the event's
//         createdByEmail / organizer email, or be an admin email).
//         cancel ('cancelled'): only the registration's own user
//         (body.userId must match the stored userId).
//
// This is a Vercel Serverless Function, self-contained (no imports).
//
// Supabase setup (see REGISTRATIONS_SETUP.md):
//   Table: registrations (id text primary key, data jsonb not null,
//                          created_at timestamptz default now())
//   Vercel env vars (Production, Sensitive, already set for events):
//     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// The service-role key is server-only: the frontend never calls Supabase
// directly, it only calls this function, so the key never reaches a browser.
//
// Honest limit, same as the events API: there is no session auth, so the
// approverEmail / userId checks above trust what the caller sends. They
// stop casual misuse from the app's own UI (which only ever sends the
// signed-in user's email), but they are not proof of identity the way a
// signed session would be. In-app ownership gating is the real control
// until server-side session auth exists.
//
// If the env vars are missing, this returns 503 JSON and the frontend
// falls back to per-browser local registrations.

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

const ADMIN_EMAILS = ["mr.adeen946@gmail.com", "ayan.work937@gmail.com"];

function norm(email: string): string {
  return (email || "").trim().toLowerCase();
}

function isAdmin(email: string): boolean {
  return ADMIN_EMAILS.indexOf(norm(email)) !== -1;
}

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: <redacted>
Authorization: <redacted>
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

function supabaseBase(): string {
  return getEnv("SUPABASE_URL").replace(/\/$/, "");
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const b = (req as any).body;
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

async function fetchJson(url: string, init?: any): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

async function loadAllRegistrations(): Promise<any[]> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/registrations?select=id,data`,
    { headers: supabaseHeaders() },
  );
  if (!ok) throw new Error("registrations table read failed");
  return Array.isArray(body) ? body.map((row: any) => row.data) : [];
}

async function loadEvent(eventId: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/events?id=eq.${encodeURIComponent(eventId)}&select=data`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data;
}

function mayManageEvent(event: any, approverEmail: string): boolean {
  if (!event) return false;
  if (isAdmin(approverEmail)) return true;
  const email = norm(approverEmail);
  if (!email) return false;
  if (event.createdByEmail && norm(event.createdByEmail) === email) return true;
  if (event.organizer && event.organizer.email && norm(event.organizer.email) === email) return true;
  return false;
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, { message: "Shared registrations database is not configured" });
      return;
    }

    const url = new URL(req.url || "/api/registrations", "http://localhost");
    const q = url.searchParams;

    if (req.method === "GET") {
      const all = await loadAllRegistrations();
      if (q.get("pendingCounts") === "1") {
        const counts: Record<string, number> = {};
        for (const r of all) {
          if (r && r.status === "pending") {
            counts[r.eventId] = (counts[r.eventId] || 0) + 1;
          }
        }
        sendJson(res, 200, { counts });
        return;
      }
      if (q.get("id")) {
        const reg = all.find((r: any) => r.id === q.get("id"));
        if (!reg) {
          sendJson(res, 404, { message: "Registration not found" });
          return;
        }
        sendJson(res, 200, reg);
        return;
      }
      if (q.get("userId")) {
        sendJson(res, 200, all.filter((r: any) => r.userId === q.get("userId")));
        return;
      }
      if (q.get("eventId")) {
        sendJson(res, 200, all.filter((r: any) => r.eventId === q.get("eventId")));
        return;
      }
      sendJson(res, 400, { message: "Pass userId, eventId, id, or pendingCounts=1" });
      return;
    }

    if (req.method === "POST") {
      const reg = await readBody(req);
      if (!reg || !reg.id || !reg.eventId || !reg.userId) {
        sendJson(res, 400, { message: "Registration needs id, eventId and userId" });
        return;
      }
      const { ok, body } = await fetchJson(`${supabaseBase()}/rest/v1/registrations`, {
        method: "POST",
        headers: supabaseHeaders(),
        body: JSON.stringify({ id: reg.id, data: reg }),
      });
      if (!ok) {
        sendJson(res, 500, { message: "Failed to store registration" });
        return;
      }
      const stored = Array.isArray(body) && body.length > 0 ? body[0].data : reg;
      sendJson(res, 200, stored);
      return;
    }

    if (req.method === "PATCH") {
      const id = q.get("id");
      if (!id) {
        sendJson(res, 400, { message: "Pass id" });
        return;
      }
      const updates = await readBody(req);
      const all = await loadAllRegistrations();
      const existing = all.find((r: any) => r.id === id);
      if (!existing) {
        sendJson(res, 404, { message: "Registration not found" });
        return;
      }
      const nextStatus = updates.status;
      if (nextStatus === "confirmed" || nextStatus === "rejected" || updates.checkedIn !== undefined) {
        // Approve / reject / check-in: event owner or admin only.
        const event = await loadEvent(existing.eventId);
        if (!mayManageEvent(event, updates.approverEmail || "")) {
          sendJson(res, 403, { message: "Only the event owner or an admin can do this" });
          return;
        }
      } else if (nextStatus === "cancelled") {
        // Attendee cancelling their own registration.
        if (!updates.userId || updates.userId !== existing.userId) {
          sendJson(res, 403, { message: "Only the registration owner can cancel it" });
          return;
        }
      }
      const { approverEmail: _a, userId: _u, ...storedUpdates } = updates;
      const merged = { ...existing, ...storedUpdates, id: existing.id };
      const { ok } = await fetchJson(
        `${supabaseBase()}/rest/v1/registrations?id=eq.${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: supabaseHeaders(),
          body: JSON.stringify({ data: merged }),
        },
      );
      if (!ok) {
        sendJson(res, 500, { message: "Failed to update registration" });
        return;
      }
      sendJson(res, 200, merged);
      return;
    }

    sendJson(res, 405, { message: "Method not allowed" });
  } catch (err) {
    sendJson(res, 500, { message: err instanceof Error ? err.message : "Registration API failed" });
  }
}
