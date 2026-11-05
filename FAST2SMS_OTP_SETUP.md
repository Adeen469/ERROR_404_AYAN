# SMS OTP Phone Verification Setup (Fast2SMS)

Locora verifies a profile's mobile number with a 6-digit SMS OTP sent
through [Fast2SMS](https://www.fast2sms.com). This replaced the older
Telegram contact-share verification (`api/telegram-verify.ts`,
`TELEGRAM_VERIFICATION_SETUP.md` — both removed).

## How it works

1. Profile page → `POST /api/phone-otp { action: "send", email, phone }`
   (signed-in session required, session email must match).
2. The endpoint generates the OTP, stores **only its SHA-256 hash** in
   the Supabase `phone_verifications` table (status `pending_otp`,
   10-minute expiry), and asks Fast2SMS to deliver the code
   (`bulkV2` API, route `otp` — Fast2SMS's own pre-approved OTP
   template, so no DLT template of ours is needed to start).
3. The user types the code → `POST /api/phone-otp { action: "verify",
   token, otp }`. Max 5 attempts; on a match the row becomes
   `verified` and keeps the same `{ email, phone, status, verifiedAt }`
   shape the Telegram flow wrote, so `api/registrations.ts` stamps the
   `phoneVerified` badge exactly as before.
4. Sends are rate-limited to 5/hour per email and 5/hour per phone
   (the shared `rate_limits` table).

Indian numbers only (Fast2SMS is an Indian gateway): the endpoint
accepts `9876543210`, `+91 98765 43210`, `919876543210`, `09876543210`.

## Step 1 — Fast2SMS account + API key

1. Sign up at fast2sms.com — **no company email or domain needed**;
   signup is with a mobile number and comes with ₹50 test credit.
2. In the panel open **Dev API** and copy the API key.
3. Recharge as needed (OTP route costs roughly ₹0.16–0.25/SMS at
   small volumes, + GST).

## Step 2 — Environment variables

| Variable | Where | Notes |
| --- | --- | --- |
| `FAST2SMS_API_KEY` | Vercel → Settings → Environment Variables (Production) | Type: **Sensitive**. Server-only — never `VITE_`-prefixed, never committed. |
| `SUPABASE_URL` | Vercel (already set for shared events) | Same project as the other Locora tables. |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel (already set) | Sensitive. |
| `SESSION_SECRET` | Vercel (already set for auth) | Used to verify the caller's session. |

For local dev, put `FAST2SMS_API_KEY` in `.env` (gitignored) next to
the others. Redeploy after changing Vercel env vars.

## Step 3 — Supabase table

Nothing new: the flow reuses the `phone_verifications` table created
for Telegram verification. On a fresh Supabase project, create it with:

```sql
create table if not exists phone_verifications (
  token text primary key,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

(The `rate_limits` table used by the other `api/` handlers must also
exist; OTP sends degrade gracefully if it doesn't, like the other
flows.)

## Step 4 — Test it

1. Deploy (or run the API locally with the env vars set).
2. Sign in → Profile → save your mobile number → **Verify via SMS OTP**.
3. You should receive "Your OTP is …" by SMS within seconds; enter it
   → the profile shows the number as verified.
4. Register for an event that requires attendee details → the
   registration carries the server-stamped `phoneVerified` badge.

## Removing the Telegram leftovers (production)

- Delete the Vercel env vars `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`.
- Optional: remove the bot's webhook so Telegram stops calling the
  (now deleted) endpoint:
  `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook`
- Old `phone_verifications` rows with Telegram-era statuses
  (`pending`, `awaiting_contact`) are inert — the OTP flow and the
  registration check only read `pending_otp`/`verified` rows — and can
  be deleted whenever.

## Going further (optional, later)

- **Your own sender ID** (e.g. `LOCORA` instead of the shared OTP
  route): register on a TRAI DLT portal as a Principal Entity
  (PAN-based; proprietors/individuals can register), approve a header
  + OTP template, then switch the endpoint's `route`/`sender_id`/
  `template_id` accordingly. Fast2SMS offers free DLT support.
- **WhatsApp OTP** is available from the same Fast2SMS account and
  needs no DLT (Meta template approval instead).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "SMS verification is not set up yet (Fast2SMS key missing)" | `FAST2SMS_API_KEY` not set, or no redeploy after setting it |
| "Verification table is not set up yet" | `phone_verifications` table missing in Supabase (step 3) |
| "Could not send the SMS: …" | Fast2SMS rejected the request — the gateway's message follows the colon (common: wallet balance exhausted, invalid key) |
| "Enter a valid Indian mobile number (10 digits)" | Number isn't a 10-digit Indian mobile (landlines and non-Indian numbers can't receive Fast2SMS OTPs) |
| OTP never arrives | Check the Fast2SMS panel's delivery report for the number; DND/operator delays show there first |
| "Too many OTP requests" | Rate limit: 5 sends/hour per email and per phone number |
