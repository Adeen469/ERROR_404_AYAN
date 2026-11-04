# Shared Registrations Setup (Razorpay-only payments)

Registrations used to live only in each browser's localStorage, so an
organizer could never see a registration submitted from another device.
The `api/registrations.ts` function stores them in Supabase instead,
using the same pattern as the shared events table.

## One-time setup (Supabase, ~2 minutes)

1. Open the **Locora** project in Supabase → **SQL Editor** → **New query**.
2. Run this (it creates the table the same way the events table was made):

```sql
create table if not exists registrations (
  id text primary key,
  data jsonb not null,
  created_at timestamptz default now()
);
```

3. At the RLS prompt, choose **Run and enable RLS** (same as events).
   The API uses the service-role key, which bypasses RLS, so no policies
   are needed. No new Vercel env vars: `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are already set.
4. Redeploy in Vercel (or wait for the next push to deploy).

## How it works after setup

- **Free events** — unchanged: instant confirmed pass with a ticket code.
- **Paid events** — Razorpay Standard Checkout ONLY. The attendee pays
  in the Razorpay checkout and gets a **pending** registration until
  Razorpay confirms a captured payment; then `api/payments.ts` issues
  the pass automatically. A pending payment holds NO spot. There is no
  manual UPI payment, no UTR, and no organizer approval anywhere:
  the organizer cannot approve or reject a payment, in the UI or by
  direct API call — the server refuses organizer status changes.
- **Organizer view** — the event's Attendees page shows an "Awaiting
  Razorpay payment" section (read-only: name, email, order id, date)
  and the organizer's event list shows a "N pending" badge per event.
  Nothing for the organizer to do; unpaid rows block no seats.
- **Attendee view** — My Registrations shows pending payments under
  Upcoming; the event page shows "Payment pending" with a Pay Now
  button that retries (or recovers an already-paid order) via
  Razorpay. Pending registrations can be withdrawn by the attendee,
  which releases nothing (they held no spot).
- **Legacy rows** — manual pending rows created before approval was
  removed stay pending. Their owners can convert them by pressing
  Pay Now (Razorpay create-order attaches an order to the existing
  row) or withdraw them. They can never be approved by an organizer.

## Before the table exists

`/api/registrations` returns a 503 "not configured" JSON and the app
falls back to per-browser local registrations — exactly like events did
before their table existed. Nothing breaks; cross-device registrations
just don't work until the table above is created.

## Security note

Identity comes from the verified session cookie, and organizer
management (check-in, roster) additionally requires the organizer to
still be approved. Payment fields, ticket codes, and holdsSpot are
server-only and never caller-writable.
