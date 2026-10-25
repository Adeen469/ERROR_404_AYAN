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
    Prefer: "return=representation",
  };
}

function supabaseBase(): string {
  return getEnv("SUPABASE_URL").replace(/\/$/, "");
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
  if (query.neighborhood && query.neighborhood !== "All" && query.neighborhood !== "All Neighborhoods") {
    out = out.filter((e: any) => e.neighborhood === query.neighborhood);
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
      message:
        "Shared events database is not configured on the server. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel (Production) and redeploy. See SHARED_EVENTS_SETUP.md.",
    });
  }

  if (req.method === "GET") {
    try {
      const singleId = firstQuery(req.query, "id");
      if (singleId) {
        const event = await fetchEvent(singleId);
        if (!event) return sendJson(res, 404, { message: "Event not found" });
        return sendJson(res, 200, event);
      }
      const filtered = applyFilters(await fetchAllEvents(), req.query || {});
      const page = Math.max(1, parseInt(String(req.query?.page || "1"), 10) || 1);
      const pageSize = Math.max(1, parseInt(String(req.query?.pageSize || "12"), 10) || 12);
      const total = filtered.length;
      const totalPages = Math.ceil(total / pageSize) || 1;
      const offset = (page - 1) * pageSize;
      return sendJson(res, 200, {
        data: filtered.slice(offset, offset + pageSize),
        total,
        page,
        pageSize,
        totalPages,
      });
    } catch (err: any) {
      return sendJson(res, 502, { message: "Could not load shared events: " + (err?.message || "unknown error") });
    }
  }

  if (req.method === "POST") {
    try {
      const p = await readBody(req);
      const id = typeof p.id === "string" && p.id ? p.id : "evt-" + Date.now();
      const title = p.title || "Untitled Community Event";
      const event = {
        id,
        title,
        slug: p.slug || slugify(title),
        summary: p.summary || (p.description ? String(p.description).slice(0, 140) : "Local community gathering."),
        description: p.description || "",
        category: p.category || "Food & Community",
        coverImage: p.coverImage || "",
        startDate: p.startDate || new Date(Date.now() + 86400000 * 7).toISOString(),
        endDate: p.endDate || new Date(Date.now() + 86400000 * 7 + 7200000).toISOString(),
        venueName: p.venueName || "Community Hall",
        address: p.address || "100 Main Street",
        neighborhood: p.neighborhood || "Downtown Arts District",
        city: p.city || "Metro City",
        price: Number(p.price) || 0,
        capacity: Number(p.capacity) || 50,
        registeredCount: Number(p.registeredCount) || 0,
        status: p.status || "published",
        organizer:
          p.organizer || {
            id: "org-community",
            name: "Community Organizer",
            slug: "community-organizer",
            avatar: "",
            bio: "Community organizer.",
            email: "",
            location: "Metro City",
            eventsCount: 0,
            totalAttendeesServed: 0,
          },
        tags: Array.isArray(p.tags) && p.tags.length > 0 ? p.tags : ["Local", "Community"],
        isFeatured: false,
      };
      const supa = await fetch(supabaseBase() + "/rest/v1/events", {
        method: "POST",
        headers: supabaseHeaders(),
        body: JSON.stringify([{ id, data: event }]),
      });
      const rows = await supa.json().catch(() => null);
      if (!supa.ok) {
        const detail = rows && rows.message ? rows.message : "Supabase insert failed";
        return sendJson(res, 502, { message: "Could not save shared event: " + detail });
      }
      return sendJson(res, 201, event);
    } catch (err: any) {
      return sendJson(res, 502, { message: "Could not save shared event: " + (err?.message || "unknown error") });
    }
  }

  if (req.method === "PATCH") {
    try {
      const singleId = firstQuery(req.query, "id");
      if (!singleId) return sendJson(res, 400, { message: "Missing event id" });
      const existing = await fetchEvent(singleId);
      if (!existing) return sendJson(res, 404, { message: "Event not found" });
      const updates = await readBody(req);
      const merged = { ...existing, ...updates, id: existing.id };
      const supa = await fetch(
        supabaseBase() + "/rest/v1/events?id=eq." + encodeURIComponent(singleId),
        { method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: merged }) },
      );
      if (!supa.ok) {
        const rows = await supa.json().catch(() => null);
        const detail = rows && rows.message ? rows.message : "Supabase update failed";
        return sendJson(res, 502, { message: "Could not update shared event: " + detail });
      }
      return sendJson(res, 200, merged);
    } catch (err: any) {
      return sendJson(res, 502, { message: "Could not update shared event: " + (err?.message || "unknown error") });
    }
  }

  if (req.method === "DELETE") {
    try {
      const singleId = firstQuery(req.query, "id");
      if (!singleId) return sendJson(res, 400, { message: "Missing event id" });
      await fetch(supabaseBase() + "/rest/v1/events?id=eq." + encodeURIComponent(singleId), {
        method: "DELETE",
        headers: supabaseHeaders(),
      });
      return sendJson(res, 200, { success: true });
    } catch (err: any) {
      return sendJson(res, 502, { message: "Could not delete shared event: " + (err?.message || "unknown error") });
    }
  }

  res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ message: "Method not allowed" }));
}
