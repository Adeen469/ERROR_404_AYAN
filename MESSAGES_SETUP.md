# Private messages setup

One-time setup for attendee ↔ organizer messaging (`api/messages.ts`,
Messages inbox at `/messages`). No new Vercel environment variables are
needed — the Supabase and Gmail variables are already set.

## ⚠️ HARD GATE — Realtime / anon key (read before shipping)

Do **NOT** add `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` to Vercel
until **both** of these are done:

1. `supabase-setup.sql` (repo root, on the PR #4 branch) has been run
   in Supabase (RLS ON + zero policies on all 11 tables, exactly one
   public `SELECT` bucket policy on `message-attachments`), **and**
2. the V-1–V-11 verification queries in `db-rls-audit.md` pass
   (anon `curl` probes per table, bucket listability/writability).

Why: the anon key is **public the moment it ships to the browser**
(it is embedded in the frontend bundle). Until RLS is verified, that
key could read/write tables directly through PostgREST, bypassing
every API-layer check. PR #4 is parked (verification pending), so RLS
is currently **unverified** — shipping the anon key now would expose
PostgREST. Until the gate passes, Realtime stays **polling-only by
design**: `getRealtimeClient()` returns null without the two vars,
and the inbox works on 3s polling alone. Nothing else needs to change
when the vars are eventually added — Realtime activates and polling
drops to a 30s safety net automatically.

## 1. Create the `messages` table (Supabase → SQL Editor → New query)

```sql
create table if not exists messages (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table messages enable row level security;
```

(Enable RLS the way the other tables were created. The serverless
function uses the service-role key, which bypasses RLS, so reads/writes
from the app keep working.)

Until this table exists, the endpoint answers 503 "Messages are not set
up yet" and the inbox shows that instead of faking any messages.

## 2. Create the Storage bucket for attachments (Supabase → Storage)

- Create a bucket named exactly `message-attachments`.
- Make it **Public** (so a recipient can open a file from its link).
- No policies to write by hand: uploads go through signed URLs that
  `api/messages.ts` issues after checking the file type (video, image,
  PDF, Word, spreadsheet), the 20MB size limit, and that the sender is
  allowed to contact the recipient about that event.

Until the bucket exists, text messages work normally but any attachment
upload fails with a clear "attachments are not set up yet" error.

## 3. Deploy

Pushing to `main` redeploys on Vercel automatically. No env var changes,
no redeploy step beyond that. (The two `VITE_SUPABASE_*` vars are the
one exception — see the hard gate above. Do not add them yet.)

## Replies

- Reply from a bubble three ways: **swipe right** on mobile,
  **double-click / double-tap** on desktop, or the **Reply** option in
  the right-click / long-press menu. A quote bar appears above the
  composer (quoted sender + text, X cancels); sending clears it.
- A reply renders its quote above the text. Tapping the quote scrolls
  to the original message and highlights it for 2s; if the original
  is not loaded, the inbox reloads once and retries.
- Server rules (`api/messages.ts`, POST send, `replyToId` optional):
  the quoted message must exist, be in the **same event and the same
  thread pair** (either direction), and not be deleted — otherwise 400.
  A reply to a message in another thread or another event is rejected,
  and replying to a deleted message is refused (400) instead of storing
  a "deleted" quote. The snapshot (`replySnapshot`: id, senderEmail,
  senderName, text sliced to ~200 chars, attachment name if any,
  `deleted: false`) is **frozen at send time and rebuilt server-side**
  from the stored quoted row — a caller-supplied snapshot is never
  trusted. Edits to the original do not update existing quotes.
- If a quoted message is deleted for everyone **after** the reply was
  sent, the DELETE handler scrubs every quote pointing at it (both
  sides of the thread, via a targeted `replyToId` lookup) to
  `text: "", deleted: true`. The reply then shows "This message was
  deleted" in its quote and its tap-to-jump does nothing.

## Realtime (ping-only — fixes DB-H1)

- `src/services/realtime-service.ts` broadcasts **only a content-free
  ping** — `{ type: 'message' | 'edited' | 'deleted', id }` — on the
  recipient's `inbox:<email>` channel after a send/edit/delete
  succeeds. No text, sender, event, or attachment URL ever goes on
  the channel. The recipient refetches through the session-
  authenticated GET `/api/messages`, which enforces participant
  checks. If a ping is missed, polling picks the message up.
- Why a ping, not a per-user secret channel token: a token would need
  a new Supabase table/migration plus a server-issued distribution
  flow, and a client-minted token would be guessable/leakable the same
  way the old channel was. The ping needs no server change and cannot
  leak content even if a stranger subscribes to the channel.
- **Residual risk (honest):** the channel name is still derived from
  the email, so anyone who knows the email can subscribe and learn
  *when* a message event happened (activity timing) plus the opaque
  message id. The id is useless without a participant session. If
  timing metadata ever becomes unacceptable, the fix is a
  server-issued per-user channel token — not a client-side tweak.
- Wiring: `MessagesPage` subscribes on mount; while SUBSCRIBED,
  polling slows from 3s to a 30s safety net, and every ping triggers
  an immediate silent reload. When `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY` are absent, `getRealtimeClient()` returns
  null and everything degrades silently to 3s polling.
- Old design (DO NOT restore): broadcasting the full message object
  on `inbox:<email>` let anyone who knew an email read that inbox
  live. `broadcastToInbox` now builds its payload from the id alone
  and drops any `message` property a caller passes.

## How it works

- A thread is one (event, attendee, organizer) conversation. The
  attendee starts it from the event page's "Message organizer" button.
- An attendee may only message the event's organizer (taken from the
  stored event row, never from the caller's claim). An organizer may
  only reply inside a thread the attendee already started — organizers
  cannot cold-message anyone. Nobody can message themselves.
- A new message emails the recipient (existing Gmail setup,
  best-effort — a mail failure never unsends the message).
- Files never travel through Vercel (serverless payloads cap around
  4.5MB): the browser uploads straight to Storage with the signed URL,
  and only the file metadata reaches the API.
- Sending feels instant: the bubble appears immediately as a normal
  sent message (optimistic UI) — there is no "Sending…" state. When
  the post returns, the server copy swaps in during the same render,
  so there is no gap and no duplicate. A failed send stays visible
  with a Retry button instead of vanishing. The inbox refreshes every
  3 seconds while open (30s safety net once Realtime pings are live —
  see Realtime above). Edits also apply optimistically: the edited
  text shows at once and reverts only if the server patch fails.
- Message actions (right-click / long-press on a bubble): Delete for
  everyone (sender only, any time — removes the row and, best effort,
  its Storage object), Delete for me (either side, any time — hides it
  for that user only via a hiddenFor list), Edit (own text only,
  within 1 hour of sending; the bubble then shows "edited"). Deletes
  have no time limit; the 1-hour limit applies to edits only.
- Deletes are confirmed first (shared Modal dialog), then hidden
  locally at once with a "Message deleted" toast and an Undo button.
  The real server call only runs when the 3-second toast expires, so
  Undo needs no server-side restore; leaving the page inside the
  window flushes the pending deletes immediately. Dismissing the toast
  (X) only hides it — the delete still runs; only Undo cancels it.
  A full browser refresh inside the 3s window is the one exception:
  the timers die with the page and the message comes back.
- Honest limit, same as registrations: there is no session auth, so
  sender/recipient checks trust the signed-in email the app sends.
  They stop misuse through the API, but they are not proof of identity
  the way a signed session would be.
