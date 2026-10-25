// POST /api/notify — account emails: welcome + new sign-in alerts.
//
//   POST /api/notify { action: "welcome", email, name? }
//     -> welcome email, sent at most ONCE per email address, ever.
//   POST /api/notify { action: "login", email }
//     -> "new sign-in" email with device + location, at most 5 per
//        email per hour.
//
// Callers (the app after a local sign-in/sign-up, and the Google
// callback page after a Google sign-in) fire this and ignore failures:
// account emails must never break sign-in or sign-up, so this always
// answers 200 JSON { mailed: boolean, reason?: string } for a
// well-formed request, and only 400/405 for a malformed one.
//
// Abuse guard: local accounts live only in the browser, so the server
// cannot independently verify that a sign-in really happened. The caps
// above (enforced in Supabase, see ACCOUNT_EMAILS_SETUP.md) bound what
// an unauthenticated caller can trigger, and every template is fixed
// (the only caller-controlled text is the display name, HTML-escaped
// and length-limited). Without the email_log table this fails CLOSED:
// no mail is sent, so a missing table can never become an open relay.
//
// Location is best-effort: the sign-in IP is looked up via ip-api
// (server-side, 3s timeout, private IPs skipped). If the lookup fails,
// the email says "Unknown location" rather than guessing.
//
// This is a Vercel Serverless Function, self-contained (no imports
// from api/_lib), following the same shape as api/registrations.ts.
// Sending uses Gmail SMTP via nodemailer, dynamically imported only
// when a send actually happens, gated on GMAIL_USER / GMAIL_APP_PASSWORD.

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

function norm(email: string): string {
  return (email || "").trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanName(name: string): string {
  return (name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 100);
}

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
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

// Best-effort "Browser on OS" from a User-Agent string. Unknown agents
// stay "Unknown device" rather than a guessed value.
export function parseDevice(ua: string): string {
  const u = ua || "";
  let browser = "Unknown browser";
  if (/Edg\//.test(u)) browser = "Edge";
  else if (/OPR\//.test(u)) browser = "Opera";
  else if (/SamsungBrowser\//.test(u)) browser = "Samsung Internet";
  else if (/CriOS/.test(u)) browser = "Chrome (iOS)";
  else if (/FxiOS/.test(u)) browser = "Firefox (iOS)";
  else if (/Chrome\//.test(u)) browser = "Chrome";
  else if (/Firefox\//.test(u)) browser = "Firefox";
  else if (/Safari\//.test(u) && /Version\//.test(u)) browser = "Safari";
  let os = "Unknown device";
  if (/Windows NT/.test(u)) os = "Windows";
  else if (/Android/.test(u)) os = "Android";
  else if (/iPhone|iPad/.test(u)) os = "iOS";
  else if (/Mac OS X/.test(u)) os = "macOS";
  else if (/Linux/.test(u)) os = "Linux";
  if (browser === "Unknown browser" && os === "Unknown device") return "Unknown device";
  return `${browser} on ${os}`;
}

async function getLocation(ip: string): Promise<string> {
  if (!ip) return "";
  if (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80:)/.test(ip)) return "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName,country`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    if (!res.ok) return "";
    const body: any = await res.json();
    if (body?.status !== "success") return "";
    return [body.city, body.regionName, body.country].filter(Boolean).join(", ");
  } catch {
    return "";
  }
}

function istNow(): string {
  try {
    return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date().toISOString();
  }
}

export function buildWelcomeEmail(name: string, email: string): { to: string; subject: string; text: string; html: string } {
  const display = esc(cleanName(name) || "there");
  const text = [
    `Hi ${cleanName(name) || "there"},`,
    `Welcome to Locora! Your account (${email}) is ready.`,
    `Discover events near you: https://locora-hyperlocal.vercel.app/discover`,
  ].join("\n\n");
  const html = `<p>Hi ${display},</p><p>Welcome to Locora! Your account (${esc(email)}) is ready.</p><p><a href="https://locora-hyperlocal.vercel.app/discover">Discover events near you</a></p>`;
  return { to: email, subject: "Welcome to Locora", text, html };
}

export function buildLoginEmail(email: string, device: string, location: string, ip: string): { to: string; subject: string; text: string; html: string } {
  const lines = [
    `There was a new sign-in to your Locora account (${email}).`,
    `When: ${istNow()} (IST)`,
    `Device: ${device}`,
    `Location: ${location || "Unknown location"}`,
    ip ? `IP address: ${ip}` : "",
    `If this wasn't you, change your password right away.`,
  ].filter(Boolean);
  const text = lines.join("\n\n");
  const html = lines.map((l) => `<p>${esc(l)}</p>`).join("\n");
  return { to: email, subject: "New sign-in to your Locora account", text, html };
}

async function sendMail(mail: { to: string; subject: string; text: string; html: string } | null): Promise<boolean> {
  const user = getEnv("GMAIL_USER");
  const pass = getEnv("GMAIL_APP_PASSWORD");
  if (!user || !pass || !mail) return false;
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: pass.replace(/\s+/g, "") },
    });
    await transporter.sendMail({ from: user, ...mail });
    return true;
  } catch (err) {
    console.warn("Account email failed:", err);
    return false;
  }
}

// email_log lookups. Returns null when the table cannot be read
// (missing table, bad response), which the handler treats as
// fail-closed: no mail without a working cap check.
async function hasWelcome(email: string): Promise<boolean | null> {
  const url =
    `${supabaseBase()}/rest/v1/email_log?select=created_at` +
    `&email=eq.${encodeURIComponent(email)}&kind=eq.welcome&limit=1`;
  const { ok, body } = await fetchJson(url, { headers: supabaseHeaders() });
  if (!ok || !Array.isArray(body)) return null;
  return body.length > 0;
}

async function loginCountLastHour(email: string): Promise<number | null> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const url =
    `${supabaseBase()}/rest/v1/email_log?select=created_at` +
    `&email=eq.${encodeURIComponent(email)}&kind=eq.login&created_at=gte.${encodeURIComponent(since)}`;
  const { ok, body } = await fetchJson(url, { headers: supabaseHeaders() });
  if (!ok || !Array.isArray(body)) return null;
  return body.length;
}

async function logSend(email: string, kind: string): Promise<void> {
  try {
    await fetchJson(`${supabaseBase()}/rest/v1/email_log`, {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ email, kind }),
    });
  } catch {
    // A missed log row only risks a duplicate mail later, never a
    // failed sign-in; the caller already succeeded.
  }
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "POST") {
      sendJson(res, 405, { message: "POST only" });
      return;
    }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, { message: "Shared email log is not configured. See ACCOUNT_EMAILS_SETUP.md." });
      return;
    }
    const body = await readBody(req);
    const action = body?.action;
    const email = norm(body?.email || "");
    if ((action !== "welcome" && action !== "login") || !validEmail(email)) {
      sendJson(res, 400, { message: "Pass action 'welcome' or 'login' and a valid email." });
      return;
    }

    if (action === "welcome") {
      const already = await hasWelcome(email);
      if (already === null) {
        sendJson(res, 200, { mailed: false, reason: "email-log-unavailable" });
        return;
      }
      if (already) {
        sendJson(res, 200, { mailed: false, reason: "already-welcomed" });
        return;
      }
      const sent = await sendMail(buildWelcomeEmail(body?.name || "", email));
      if (sent) await logSend(email, "welcome");
      sendJson(res, 200, { mailed: sent, reason: sent ? undefined : "not-configured" });
      return;
    }

    // action === "login"
    const count = await loginCountLastHour(email);
    if (count === null) {
      sendJson(res, 200, { mailed: false, reason: "email-log-unavailable" });
      return;
    }
    if (count >= 5) {
      sendJson(res, 200, { mailed: false, reason: "rate-limited" });
      return;
    }
    const forwarded = req.headers?.["x-forwarded-for"] || req.headers?.["X-Forwarded-For"] || "";
    const ip = String(forwarded).split(",")[0].trim();
    const ua = req.headers?.["user-agent"] || req.headers?.["User-Agent"] || "";
    const device = parseDevice(String(ua));
    const location = await getLocation(ip);
    const sent = await sendMail(buildLoginEmail(email, device, location, ip));
    if (sent) await logSend(email, "login");
    sendJson(res, 200, { mailed: sent, reason: sent ? undefined : "not-configured" });
    return;
  } catch (err) {
    console.warn("notify handler failed:", err);
    sendJson(res, 200, { mailed: false, reason: "error" });
  }
}
