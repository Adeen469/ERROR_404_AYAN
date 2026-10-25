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
// GET  /api/organizer-access?pending=1&adminEmail=x
//   -> admin-only. Lists pending requests.
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

    const url = new URL(req.url || "/api/organizer-access", "http://localhost");
    const email = norm(url.searchParams.get("email") || "");

    if (req.method === "GET" && url.searchParams.get("pending") === "1") {
      const adminEmail = norm(url.searchParams.get("adminEmail") || "");
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
      if (!email) {
        sendJson(res, 400, { message: "email is required." });
        return;
      }
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
        const reqEmail = norm(body.email || "");
        if (!reqEmail) {
          sendJson(res, 400, { message: "email is required." });
          return;
        }
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

      if (action === "approve" || action === "reject") {
        const adminEmail = norm(body.adminEmail || "");
        const targetEmail = norm(body.targetEmail || "");
        if (!isAdmin(adminEmail)) {
          sendJson(res, 403, {
            message: "Only admins can approve or reject organizer requests.",
          });
          return;
        }
        if (!targetEmail || isAdmin(targetEmail)) {
          sendJson(res, 400, { message: "Invalid target email." });
          return;
        }
        await upsertRow(targetEmail, {
          status: action === "approve" ? "approved" : "rejected",
          decidedBy: adminEmail,
          decidedAt: new Date().toISOString(),
        });
        sendJson(res, 200, {
          email: targetEmail,
          role: action === "approve" ? "organizer" : "attendee",
          status: action === "approve" ? "approved" : "rejected",
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
