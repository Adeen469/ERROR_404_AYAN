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
//
// Email notifications (see ORGANIZER_NOTIFICATIONS_SETUP.md):
// when a PENDING registration is stored (a paid event's payment awaiting
// approval), the organizer gets an email with the attendee, amount, UTR
// and a link to the Attendees page; and when a registration is CONFIRMED
// with a ticket code (a free instant registration, or an organizer's
// approval), the attendee gets a confirmation email with that code.
// Sending is best-effort and gated on GMAIL_USER / GMAIL_APP_PASSWORD:
// without them nothing is sent and the registration still succeeds, and
// the in-app pass / "N pending" badge remain the fallback signals. Sends
// are awaited before responding (serverless work after a response is not
// guaranteed to run), but any mail failure is swallowed so it can never
// fail a registration. Rejected payments mail nobody; the attendee sees
// "Payment not approved" in the app.

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
    Authorization: `Bearer ${key}`,
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

// Email content for a pending payment. Exported so it can be unit-tested
// without sending. The recipient is the STORED event's organizer email
// (loaded server-side above), never an address the caller supplied, so
// this cannot be used to relay mail to arbitrary addresses.
// Locora email theme: the website's own palette — warm parchment page,
// white card, deep forest headings, terracotta accent, serif wordmark.
// Plain-text versions stay unchanged; only the HTML part is themed.
// All styles are inline (email clients strip <style> blocks). The logo
// loads from the live site; if an inbox blocks images, the "Locora"
// wordmark beside it still reads.
const SITE_URL = "https://locora-hyperlocal.vercel.app";

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailLayout(title: string, inner: string): string {
  return (
    `<div style="background:#FAF8F5;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">` +
    `<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #E7E3DB;border-radius:16px;overflow:hidden;">` +
    `<div style="height:4px;background:#C25E00;"></div>` +
    `<div style="padding:32px;">` +
    `<div style="margin-bottom:24px;">` +
    `<img src="${SITE_URL}/locora-logo.png" alt="Locora" width="36" height="36" style="vertical-align:middle;border-radius:8px;" />` +
    `<span style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;color:#1E3F35;vertical-align:middle;margin-left:10px;">Locora</span>` +
    `</div>` +
    `<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.3;color:#1E3F35;margin:0 0 16px;">${title}</h1>` +
    inner +
    `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #E7E3DB;font-size:12px;line-height:1.5;color:#5F635D;">Locora · Hyperlocal Event Discovery &amp; Community Engagement<br />This is an automated email — please don't reply.</div>` +
    `</div></div></div>`
  );
}

function bodyText(s: string): string {
  return `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#1E2320;">${s}</p>`;
}

function detailRow(label: string, value: string): string {
  return `<p style="margin:0 0 10px;font-size:15px;line-height:1.6;color:#1E2320;"><span style="color:#5F635D;">${label}:</span> ${value}</p>`;
}

function primaryButton(label: string, href: string): string {
  return `<p style="margin:20px 0 0;"><a href="${href}" style="display:inline-block;background:#1E3F35;color:#ffffff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px;">${label}</a></p>`;
}

function ticketBox(code: string): string {
  return `<div style="background:#FAF8F5;border:1px solid #E7E3DB;border-radius:12px;padding:16px;text-align:center;margin:20px 0;"><div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#5F635D;margin-bottom:6px;">Your ticket code</div><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;letter-spacing:2px;font-weight:700;color:#1E3F35;">${code}</div></div>`;
}

export function buildApprovalEmail(reg: any, event: any): { to: string; subject: string; text: string; html: string } | null {
  const to = event?.organizer?.email || event?.createdByEmail || '';
  if (!to) return null;
  const title = event?.title || 'your event';
  const amount = typeof event?.price === 'number' ? `₹${event.price}` : 'the ticket price';
  const link = `https://locora-hyperlocal.vercel.app/organizer/events/${reg.eventId}/attendees`;
  const subject = `New payment approval needed: ${title}`;
  const text = [
    `${reg.userName || 'An attendee'} (${reg.userEmail || ''}) paid ${amount} for "${title}" and submitted a payment for approval.`,
    `UTR: ${reg.utr || '—'}`,
    `Submitted: ${reg.registeredAt || ''}`,
    `Verify the payment in your UPI app, then approve to issue their pass (or reject to release the spot): ${link}`,
  ].join('\n\n');
  const html = emailLayout(
    "New payment approval needed",
    bodyText(`<strong>${esc(reg.userName || 'An attendee')}</strong> (${esc(reg.userEmail || '')}) paid <strong>${esc(amount)}</strong> for "${esc(title)}" and submitted a payment for approval.`) +
      detailRow("UTR", `<strong>${esc(reg.utr || '—')}</strong>`) +
      detailRow("Submitted", esc(reg.registeredAt || '')) +
      bodyText(`Verify the payment in your UPI app, then approve to issue their pass — or reject to release the spot.`) +
      primaryButton("Review in Attendees", link),
  );
  return { to, subject, text, html };
}

// Confirmation email for the attendee. Sent when a registration is
// confirmed with a ticket code: a free instant registration, or an
// organizer's approval of a paid one. Returns null without a recipient
// or without a ticket code, so a confirmation without a pass is never
// mailed. Exported for unit tests, like buildApprovalEmail.
export function buildAttendeeConfirmationEmail(reg: any, event: any): { to: string; subject: string; text: string; html: string } | null {
  const to = reg?.userEmail || '';
  if (!to || !reg?.ticketCode) return null;
  const title = event?.title || 'the event';
  const venue = [event?.venueName, event?.city, event?.state].filter(Boolean).join(', ');
  let when = '';
  try {
    if (event?.startDate) {
      when = new Date(event.startDate).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    }
  } catch {
    when = '';
  }
  const link = `https://locora-hyperlocal.vercel.app/events/${reg.eventId}`;
  const subject = `You're registered: ${title}`;
  const lines = [
    `You're registered for "${title}".`,
    `Your ticket code: ${reg.ticketCode}`,
    venue ? `Venue: ${venue}` : '',
    when ? `When: ${when}` : '',
    `Show this code at the event. View the event here: ${link}`,
  ].filter(Boolean);
  const text = lines.join('\n\n');
  const html = emailLayout(
    "You're registered",
    bodyText(`You're registered for "${esc(title)}".`) +
      ticketBox(esc(reg.ticketCode)) +
      (venue ? detailRow("Venue", esc(venue)) : '') +
      (when ? detailRow("When", esc(when)) : '') +
      bodyText(`Show this code at the event.`) +
      primaryButton("View event", link),
  );
  return { to, subject, text, html };
}

// "Payment received" email for the attendee of a PENDING paid
// registration: the organizer has not approved yet, so this carries no
// ticket code — it only confirms the payment arrived and is awaiting
// approval. Exported for unit tests, like the other builders.
export function buildAttendeePendingEmail(reg: any, event: any): { to: string; subject: string; text: string; html: string } | null {
  const to = reg?.userEmail || '';
  if (!to) return null;
  const title = event?.title || 'the event';
  const amount = typeof event?.price === 'number' ? `₹${event.price}` : 'the ticket price';
  const link = `https://locora-hyperlocal.vercel.app/events/${reg.eventId}`;
  const subject = `Payment received: ${title} — awaiting approval`;
  const lines = [
    `We received your payment of ${amount} for "${title}".`,
    reg?.utr ? `UTR: ${reg.utr}` : '',
    `The organizer will verify the payment and approve it, then your ticket code will arrive by email. You can also check the status on the event page: ${link}`,
  ].filter(Boolean);
  const text = lines.join('\n\n');
  const html = emailLayout(
    "Payment received",
    bodyText(`We received your payment of <strong>${esc(amount)}</strong> for "${esc(title)}".`) +
      (reg?.utr ? detailRow("UTR", `<strong>${esc(reg.utr)}</strong>`) : '') +
      bodyText(`The organizer will verify the payment and approve it, then your ticket code will arrive by email.`) +
      primaryButton("View event", link),
  );
  return { to, subject, text, html };
}

async function sendMail(mail: { to: string; subject: string; text: string; html: string } | null): Promise<boolean> {
  const user = getEnv('GMAIL_USER');
  const pass = getEnv('GMAIL_APP_PASSWORD');
  if (!user || !pass || !mail) return false;
  try {
    // Dynamic import: nodemailer loads only when an email is actually
    // sent, so plain registration reads never pay its load cost.
    const nodemailer = (await import('nodemailer')).default;
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass: pass.replace(/\s+/g, '') },
    });
    await transporter.sendMail({ from: user, ...mail });
    return true;
  } catch (err) {
    console.warn('Email failed (registration still stored):', err);
    return false;
  }
}

async function sendApprovalEmail(reg: any, event: any): Promise<boolean> {
  return sendMail(buildApprovalEmail(reg, event));
}

async function sendAttendeeConfirmationEmail(reg: any, event: any): Promise<boolean> {
  return sendMail(buildAttendeeConfirmationEmail(reg, event));
}

async function sendAttendeePendingEmail(reg: any, event: any): Promise<boolean> {
  return sendMail(buildAttendeePendingEmail(reg, event));
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
      // Pending payment? Notify the organizer AND tell the attendee
      // their payment was received and is awaiting approval. Confirmed
      // with a ticket code (a free instant registration)? Confirm to
      // the attendee. Awaited for reliability (see header), but any
      // failure is swallowed: email must never fail a registration.
      if (stored) {
        try {
          const event = await loadEvent(stored.eventId);
          if (event) {
            if (stored.status === 'pending') {
              await sendApprovalEmail(stored, event);
              await sendAttendeePendingEmail(stored, event);
            } else if (stored.status === 'confirmed') await sendAttendeeConfirmationEmail(stored, event);
          }
        } catch {
          // Best-effort only.
        }
      }
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
      // Approval: a pending registration just became confirmed with a
      // pass — tell the attendee. Only the pending -> confirmed
      // transition mails, so check-ins and re-saves stay silent.
      if (existing.status === 'pending' && merged.status === 'confirmed' && merged.ticketCode) {
        try {
          const event = await loadEvent(merged.eventId);
          if (event) await sendAttendeeConfirmationEmail(merged, event);
        } catch {
          // Best-effort only.
        }
      }
      sendJson(res, 200, merged);
      return;
    }

    sendJson(res, 405, { message: "Method not allowed" });
  } catch (err) {
    sendJson(res, 500, { message: err instanceof Error ? err.message : "Registration API failed" });
  }
}
