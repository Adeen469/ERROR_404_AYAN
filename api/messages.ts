// Private attendee <-> organizer messages for an event.
//
// One thread per (event, attendee, organizer). The attendee starts it
// from the event page's "Message organizer" button; both sides then talk
// in the Messages inbox. No phone numbers or email addresses are ever
// shown to the other side inside the app — each side only sees the
// other's display name.
//
// GET  /api/messages?userEmail=x
//      -> { messages: [...] } every message where x is sender or
//         recipient, oldest first. The frontend groups them into threads.
// GET  /api/messages?userEmail=x&unreadCount=1 -> { count } unread
//      messages addressed to x (the Navbar badge).
// POST /api/messages { eventId, senderEmail, senderName?, recipientEmail,
//                      text?, attachment? }
//      -> stores one message and emails the recipient (best-effort).
//         text max 2000 chars; at least one of text / attachment.
//         attachment is { name, size, type, path } — the public URL is
//         rebuilt here from path, never trusted from the caller.
// POST /api/messages { action: "upload-url", eventId, senderEmail,
//                      recipientEmail, fileName, fileSize, fileType }
//      -> { uploadUrl, publicUrl, path } for a direct browser -> Supabase
//         Storage upload. Files NEVER travel through this function:
//         Vercel serverless payloads cap around 4.5MB, far below the
//         20MB attachment limit, so the browser PUTs the file straight
//         to Storage with the signed URL and only the metadata comes here.
// PATCH /api/messages?id=x { recipientEmail }
//      -> marks that message read; only its recipient may do this.
//
// Authorization (same honesty note as registrations): there is no
// session auth, so senderEmail / recipientEmail are caller-sent and
// trusted the way the app's own UI sends them. The rules below still
// stop misuse through the API itself:
//   - an attendee may only message the event's organizer (taken from
//     the STORED event row, never the caller's claim);
//   - an organizer (or admin) may only reply inside a thread the
//     attendee already started — they cannot cold-message anyone;
//   - nobody may message themselves.
// A fake "sent" message would be worse than an error, so unlike other
// services this one has NO localStorage fallback: if the table is
// missing the endpoint fails closed (503) and the UI says so.
//
// Attachments: video, images, PDF, Word (.doc/.docx) and spreadsheets
// (.xls/.xlsx/.xlsm), each at most 20MB. The Storage bucket is
// "message-attachments" (public reads, uploads only via the signed URLs
// issued here). See MESSAGES_SETUP.md.
//
// This is a Vercel Serverless Function, self-contained (no imports).
// Supabase setup: table messages (id text primary key, data jsonb not
// null, created_at timestamptz default now()); env vars SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY (already set); GMAIL_USER / GMAIL_APP_PASSWORD
// for the new-message email (already set; best-effort, never blocks send).

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
const SITE_URL = "https://locora-hyperlocal.vercel.app";
const BUCKET = "message-attachments";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 2000;

// Extension -> expected MIME family. The server checks the extension
// (the client also checks File.type); a mismatch is rejected.
const ALLOWED_EXTENSIONS: Record<string, string[]> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  mp4: ["video/mp4"],
  webm: ["video/webm"],
  mov: ["video/quicktime"],
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  xls: ["application/vnd.ms-excel"],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  xlsm: ["application/vnd.ms-excel.sheet.macroEnabled.12"],
};

function norm(email: string): string {
  return (email || "").trim().toLowerCase();
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || "");
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

async function fetchJson(
  url: string,
  init?: any,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

function esc(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadEvent(eventId: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/events?id=eq.${encodeURIComponent(eventId)}&select=data`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data;
}

async function loadAllMessages(): Promise<any[]> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages?select=id,data`,
    { headers: supabaseHeaders() },
  );
  if (!ok) throw new Error("messages table read failed");
  return Array.isArray(body) ? body.map((row: any) => row.data) : [];
}

async function loadMessage(id: string): Promise<any | null> {
  const { ok, body } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages?id=eq.${encodeURIComponent(id)}&select=data`,
    { headers: supabaseHeaders() },
  );
  if (!ok || !Array.isArray(body) || body.length === 0) return null;
  return body[0].data;
}

async function storeMessage(msg: any): Promise<void> {
  const { ok } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages`,
    {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify({ id: msg.id, data: msg }),
    },
  );
  if (!ok) throw new Error("messages table write failed");
}

async function updateMessageData(msg: any): Promise<void> {
  const { ok } = await fetchJson(
    `${supabaseBase()}/rest/v1/messages?id=eq.${encodeURIComponent(msg.id)}`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({ data: msg }),
    },
  );
  if (!ok) throw new Error("messages table update failed");
}

// The organizer's email comes from the STORED event row only.
function organizerEmailOf(event: any): string {
  return norm(event?.createdByEmail || event?.organizer?.email || "");
}

function isOrganizerOrAdmin(sender: string, organizerEmail: string): boolean {
  return sender === organizerEmail || ADMIN_EMAILS.includes(sender);
}

// Shared rule for sending a message AND for issuing an upload URL:
// returns an error string, or null when the sender may contact the
// recipient about this event.
//
// The check keys on the RECIPIENT, not on the sender's role — the
// earlier version keyed on the sender and broke a real case: an admin
// writing to an organizer for the first time was treated as "an
// organizer cold-messaging" and blocked, when they were simply an
// attendee starting a conversation. Now:
//   - anyone may write TO the event's organizer (starting or continuing);
//   - anyone else may only be written to by the organizer/admin, and
//     only inside a thread the attendee already started.
function authorizeContact(
  event: any,
  sender: string,
  recipient: string,
  existing: any[],
): string | null {
  const organizerEmail = organizerEmailOf(event);
  if (!organizerEmail) return "This event has no organizer contact";
  if (sender === recipient) return "You cannot message yourself";
  if (recipient === organizerEmail) return null;
  if (!isOrganizerOrAdmin(sender, organizerEmail)) {
    return "You can only message this event's organizer";
  }
  // Organizers reply; they never cold-message. A thread exists when
  // either side has already written to the other about this event.
  const threadExists = existing.some(
    (m: any) =>
      m.eventId === event.id &&
      ((m.senderEmail === sender && m.recipientEmail === recipient) ||
        (m.senderEmail === recipient && m.recipientEmail === sender)),
  );
  return threadExists
    ? null
    : "Reply inside a conversation the attendee started";
}

function extensionOf(fileName: string): string {
  const parts = (fileName || "").split(".");
  if (parts.length < 2) return "";
  return (parts.pop() || "").toLowerCase();
}

function sanitizePathSegment(s: string): string {
  return (s || "").replace(/[^A-Za-z0-9_-]/g, "");
}

// --- New-message email (best-effort, never blocks the send) ---

function buildMessageEmail(
  msg: any,
  event: any,
): { to: string; subject: string; text: string; html: string } | null {
  const to = msg.recipientEmail;
  if (!to) return null;
  const title = event?.title || "an event";
  const senderName = msg.senderName || msg.senderEmail;
  const snippet =
    msg.text && msg.text.trim()
      ? msg.text.trim().slice(0, 200)
      : msg.attachment
        ? `Sent an attachment: ${msg.attachment.name}`
        : "Sent you a message";
  const subject = `New message about "${title}"`;
  const link = `${SITE_URL}/messages?eventId=${encodeURIComponent(msg.eventId)}&with=${encodeURIComponent(msg.senderEmail)}`;
  const text =
    `${senderName} sent you a message about "${title}":\n\n${snippet}\n\n` +
    `Reply in Locora: ${link}`;
  const html =
    `<div style="background:#FAF8F5;padding:24px;font-family:Georgia,serif;color:#1E2320;">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #E7E3DB;border-radius:16px;overflow:hidden;">` +
    `<div style="height:4px;background:#C25E00;"></div>` +
    `<div style="padding:24px;">` +
    `<div style="font-size:22px;font-weight:bold;color:#1E3F35;">Locora</div>` +
    `<h2 style="font-size:18px;color:#1E3F35;">New message about "${esc(title)}"</h2>` +
    `<p><strong>${esc(senderName)}</strong> wrote:</p>` +
    `<p style="background:#FAF8F5;border:1px solid #E7E3DB;border-radius:12px;padding:12px 16px;">${esc(snippet)}</p>` +
    `<a href="${link}" style="display:inline-block;background:#1E3F35;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:999px;font-size:14px;">Reply in Locora</a>` +
    `</div></div></div>`;
  return { to, subject, text, html };
}

async function sendMail(
  mail: { to: string; subject: string; text: string; html: string } | null,
): Promise<boolean> {
  const user = getEnv("GMAIL_USER");
  const pass = getEnv("GMAIL_APP_PASSWORD");
  if (!user || !pass || !mail) return false;
  try {
    // Dynamic import: nodemailer loads only when an email is actually
    // sent, so plain message reads never pay its load cost.
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass: pass.replace(/\s+/g, "") },
    });
    await transporter.sendMail({ from: user, ...mail });
    return true;
  } catch (err) {
    console.warn("Message email failed (message still stored):", err);
    return false;
  }
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "GET" && req.method !== "POST" && req.method !== "PATCH") {
      sendJson(res, 405, { message: "Method not allowed" });
      return;
    }
    if (!supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) {
      sendJson(res, 503, { message: "Messages are not set up yet" });
      return;
    }

    // ---- GET: list / unread count ----
    if (req.method === "GET") {
      const userEmail = norm(req.query?.userEmail || "");
      if (!isEmail(userEmail)) {
        sendJson(res, 400, { message: "A valid userEmail is required" });
        return;
      }
      let all: any[];
      try {
        all = await loadAllMessages();
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      const mine = all.filter(
        (m: any) => m.senderEmail === userEmail || m.recipientEmail === userEmail,
      );
      if (req.query?.unreadCount === "1") {
        sendJson(res, 200, {
          count: mine.filter((m: any) => m.recipientEmail === userEmail && !m.read)
            .length,
        });
        return;
      }
      mine.sort((a: any, b: any) =>
        (a.createdAt || "").localeCompare(b.createdAt || ""),
      );
      sendJson(res, 200, { messages: mine });
      return;
    }

    const body = await readBody(req);

    // ---- POST: signed upload URL ----
    if (req.method === "POST" && body.action === "upload-url") {
      const eventId = String(body.eventId || "");
      const sender = norm(body.senderEmail || "");
      const recipient = norm(body.recipientEmail || "");
      const fileName = String(body.fileName || "");
      const fileSize = Number(body.fileSize || 0);
      const fileType = String(body.fileType || "");
      if (!eventId || !isEmail(sender) || !isEmail(recipient) || !fileName) {
        sendJson(res, 400, { message: "eventId, senderEmail, recipientEmail and fileName are required" });
        return;
      }
      if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_ATTACHMENT_BYTES) {
        sendJson(res, 400, { message: "File must be larger than 0 and no bigger than 20MB" });
        return;
      }
      const ext = extensionOf(fileName);
      const allowed = ALLOWED_EXTENSIONS[ext];
      if (!allowed || (fileType && !allowed.includes(fileType))) {
        sendJson(res, 400, {
          message: "File type not allowed — video, image, PDF, Word or spreadsheet only",
        });
        return;
      }
      const event = await loadEvent(eventId);
      if (!event) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      let existing: any[] = [];
      try {
        existing = await loadAllMessages();
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      const denied = authorizeContact(event, sender, recipient, existing);
      if (denied) {
        sendJson(res, 403, { message: denied });
        return;
      }
      const path = `${sanitizePathSegment(eventId)}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
      // Upload signed URLs are a DIFFERENT endpoint from download
      // signed URLs, and mixing them up fails in confusing ways:
      //   - POST /object/sign/... signs a DOWNLOAD link, so it 404s
      //     "Object not found" for a path that does not exist yet;
      //   - POST /object/upload/sign/... signs an UPLOAD link for a
      //     new object, which is what this is. It returns a token; the
      //     browser PUTs the file to .../object/upload/sign/...?token=.
      // expiresIn (seconds) is REQUIRED — without it Storage answers
      // 400 "body must have required property 'expiresIn'". One hour
      // is plenty for picking and uploading a file.
      const { ok, status, body: signBody } = await fetchJson(
        `${supabaseBase()}/storage/v1/object/upload/sign/${BUCKET}/${path}`,
        {
          method: "POST",
          headers: supabaseHeaders(),
          body: JSON.stringify({ expiresIn: 3600 }),
        },
      );
      let uploadUrl = "";
      if (signBody?.token) {
        uploadUrl = `${supabaseBase()}/storage/v1/object/upload/sign/${BUCKET}/${path}?token=${signBody.token}`;
      } else if (signBody?.url) {
        uploadUrl = signBody.url.startsWith("http")
          ? signBody.url
          : `${supabaseBase()}/storage/v1${signBody.url}`;
      }
      if (!ok || !uploadUrl) {
        // Surface Storage's own reason instead of a generic guess: a
        // 404 here means the bucket is not in this project, a 401/403
        // means the key, and so on. No secret ever appears in these.
        const detail =
          signBody?.message || signBody?.error || `storage sign failed (${status})`;
        sendJson(res, 502, {
          message: `Message attachments are not set up yet (${detail})`,
        });
        return;
      }
      sendJson(res, 200, {
        uploadUrl,
        publicUrl: `${supabaseBase()}/storage/v1/object/public/${BUCKET}/${path}`,
        path,
      });
      return;
    }

    // ---- POST: send a message ----
    if (req.method === "POST") {
      const eventId = String(body.eventId || "");
      const sender = norm(body.senderEmail || "");
      const senderName = String(body.senderName || "");
      const recipient = norm(body.recipientEmail || "");
      const text = String(body.text || "").trim().slice(0, MAX_TEXT_CHARS);
      const attachment = body.attachment || null;
      if (!eventId || !isEmail(sender) || !isEmail(recipient)) {
        sendJson(res, 400, { message: "eventId, senderEmail and recipientEmail are required" });
        return;
      }
      if (!text && !attachment) {
        sendJson(res, 400, { message: "Write a message or attach a file" });
        return;
      }
      let cleanAttachment: any = null;
      if (attachment) {
        const name = String(attachment.name || "");
        const size = Number(attachment.size || 0);
        const type = String(attachment.type || "");
        const path = String(attachment.path || "");
        const ext = extensionOf(name);
        const allowed = ALLOWED_EXTENSIONS[ext];
        // The path must be one this endpoint could have issued for this
        // event; the public URL is rebuilt from it, never trusted.
        const pathOk =
          path.startsWith(`${sanitizePathSegment(eventId)}/`) &&
          /^[A-Za-z0-9_-]+\/[0-9]+-[a-z0-9]+\.[A-Za-z0-9]+$/.test(path) &&
          path.endsWith(`.${ext}`);
        if (
          !name || name.length > 200 || !Number.isFinite(size) ||
          size <= 0 || size > MAX_ATTACHMENT_BYTES ||
          !allowed || (type && !allowed.includes(type)) || !pathOk
        ) {
          sendJson(res, 400, {
            message: "Attachment not allowed — video, image, PDF, Word or spreadsheet, max 20MB",
          });
          return;
        }
        cleanAttachment = {
          name,
          size,
          type,
          path,
          url: `${supabaseBase()}/storage/v1/object/public/${BUCKET}/${path}`,
        };
      }
      const event = await loadEvent(eventId);
      if (!event) {
        sendJson(res, 404, { message: "Event not found" });
        return;
      }
      let existing: any[] = [];
      try {
        existing = await loadAllMessages();
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      const denied = authorizeContact(event, sender, recipient, existing);
      if (denied) {
        sendJson(res, 403, { message: denied });
        return;
      }
      const msg: any = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        eventId,
        eventTitle: event.title || "",
        senderEmail: sender,
        senderName: senderName || sender,
        recipientEmail: recipient,
        text: text || "",
        attachment: cleanAttachment,
        read: false,
        createdAt: new Date().toISOString(),
      };
      try {
        await storeMessage(msg);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      // Best-effort alert; a mail failure must never unsend the message.
      const mailed = await sendMail(buildMessageEmail(msg, event));
      sendJson(res, 200, { message: msg, mailed });
      return;
    }

    // ---- PATCH: mark read ----
    if (req.method === "PATCH") {
      const id = String(req.query?.id || "");
      const recipient = norm(body.recipientEmail || "");
      if (!id || !isEmail(recipient)) {
        sendJson(res, 400, { message: "id and recipientEmail are required" });
        return;
      }
      const msg = await loadMessage(id);
      if (!msg) {
        sendJson(res, 404, { message: "Message not found" });
        return;
      }
      if (msg.recipientEmail !== recipient) {
        sendJson(res, 403, { message: "Only the recipient can mark this read" });
        return;
      }
      msg.read = true;
      try {
        await updateMessageData(msg);
      } catch {
        sendJson(res, 503, { message: "Messages are not set up yet" });
        return;
      }
      sendJson(res, 200, { message: msg });
      return;
    }

    sendJson(res, 405, { message: "Method not allowed" });
  } catch (err) {
    console.warn("messages handler failed:", err);
    sendJson(res, 500, { message: "Something went wrong" });
  }
}
