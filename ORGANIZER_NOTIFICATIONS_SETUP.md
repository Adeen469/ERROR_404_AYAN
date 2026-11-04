# Attendee confirmation emails

When a registration is confirmed with a ticket code, the attendee gets
a confirmation email with that code. There is no organizer approval
email anymore — organizer approval was removed in full, and paid
passes are issued automatically by Razorpay on verified payment, so
there is nothing for an organizer to be notified to approve.

The organizer is still told about pending payments in the app: the
organizer's event list shows a "N pending" badge, and the event's
Attendees page has a read-only "Awaiting Razorpay payment" section
(no action buttons).

Email is sent from the confirmation code in `api/registrations.ts`
(for free instant passes) and `api/payments.ts` (for verified
Razorpay payments). It is best-effort: if email is not configured,
or sending fails, the registration still succeeds.

## Setup (about 5 minutes, one time)

Email goes out through a Gmail account using an app password. Any Gmail
account works, and it can send to any attendee's email address — no
custom domain is needed.

1. On the Gmail account you want to send from, turn on 2-Step
   Verification (Google Account → Security → 2-Step Verification).
2. Create an app password: Google Account → Security → App passwords →
   create one (name it "Locora"). Google shows a 16-character code.
   **This is not your Gmail password — never share it in chat.**
3. In Vercel → your project → Settings → Environment Variables, add
   (Production, Sensitive):
   - `GMAIL_USER` — the full Gmail address from step 1.
   - `GMAIL_APP_PASSWORD` — the 16-character code from step 2
     (spaces don't matter; they are stripped).
4. Redeploy (or wait for the next push to deploy).

## What is emailed

- A **free** registration issues its pass instantly and emails the
  attendee a confirmation with the ticket code.
- A **verified Razorpay** payment emails the attendee their pass
  (ticket code) at confirmation time.
- The recipient is the registration's own email address, and the email
  links back to the event page.

## Requirements and limits

- Email requires the shared `registrations` table (see
  `REGISTRATIONS_SETUP.md`). Without it, registrations only live in the
  attendee's browser, the server never sees them, and no email is sent.
- The recipient is always the registration's own email address (read
  server-side from the stored row), never an address from the request,
  so the endpoint cannot be used to send mail to arbitrary addresses.
- Gmail allows roughly 500 sent emails per day on a free account, which
  is far above this app's volume.
- If you later verify a custom domain and prefer Resend, the send step
  in `api/registrations.ts` is the only place that changes.
