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

## Community chat (one group chat per event)

- Shown as a "Community Chat" section on the EventDetailsPage, below
  the organizer card (the private "Message organizer" button is
  unchanged). No new Supabase table and no new Vercel function:
  community rows live in the same `messages` table with
  `type: "community"` and `recipientEmail: "community:<eventId>"`
  (that marker is not an email — `isEmail` is false for it — so it
  can never be a mail recipient or match a private thread pair).
- **Who can see/post:** confirmed registrants for that event, the
  event organizer, and admins. Guests, signed-in non-registered
  users, pending (unpaid Razorpay) and cancelled registrations get
  403 with `member: false` and see a locked placeholder ("Join this
  event to chat with attendees" / "Register to join the community
  chat"). Membership is checked server-side on every community call.
- **No cross-leak:** the private GET filters `type: "community"` out
  explicitly (a sender's own community rows would otherwise match
  `loadMessagesFor(sender)`), and the community GET returns only
  community rows for that event. Unread counts and thread grouping
  never see community rows.
- **No email alerts** for community messages, by design — one mail
  per message to every attendee would be spam.
- **Replies** work the same as private replies (same-event community
  quote only; a private message's `replyToId` is refused in the
  community chat, and vice versa). **Edits:** own message, within
  1 hour, and still a member. **Deletes:** own message within 24h,
  or ANY community message for the organizer/admin (moderation, no
  24h window). Deleted originals scrub quotes on both sides.
- **Attachments** reuse the private upload-url + magic-byte path
  (`community: true` on the upload-url call). Same 20MB / type
  limits, same verification at send time.
- **Realtime:** full-payload fan-out to every member's private
  channel (one batched server broadcast; rooms over 200 members
  fall back to a ping on `community:<eventId>`). The event id is
  public (Discover lists it), so the channel name leaks nothing
  new; a non-member subscriber learns only WHEN a message was
  posted — the refetch is membership-gated. Polling is 3s while
  the section is open, 30s once SUBSCRIBED; without
  `VITE_SUPABASE_*` it stays polling-only (same hard gate as above).
- **Privacy:** the chat shows sender NAMES only, never emails or
  phones. Rows go through the same `stripMessageForViewer`
  whitelist as private messages.

## Global community chat (one site-wide room)

- The **Community** page at `/community` (Navbar link, signed-in
  nav only — desktop and mobile drawer; never in the profile
  dropdown; guests never see the link) is one chat room for every
  signed-in Locora member. The route is guarded by
  `RequireSignedIn` in `App.tsx` (guests redirect to `/landing`),
  and the page is the shared `CommunityChat` component in
  `mode="global"` (`eventId "global"`, no `isRegistered`/`isOwner`
  props — they are event-only).
- No new Supabase table and no new Vercel function: global rows
  live in the same `messages` table with `type: "community"`,
  `eventId: "global"` and `recipientEmail: "community:global"`
  (same marker pattern as event rooms — not an email, never
  mailed). The global room is served by the same
  `?community=1&eventId=global` GET / `community: true` POST /
  upload-url branches in `api/messages.ts`, with a global early
  branch that skips the event lookup and registration check.
- **Who can see/post:** ANY signed-in user (`isGlobalMember` —
  a valid session email is a member). Guests get 401 from the
  server before any branch runs. No event registration is needed.
- **No cross-leak:** the private GET filters `type: "community"`
  out; the event-community GET loads only that event's rows
  (`loadCommunityMessages(eventId)`); the global GET loads only
  `loadCommunityMessages("global")`. Replies are room-scoped too:
  `communityReplyTargetError` refuses a quoted message whose
  `eventId` is not the room's — an event-community or private
  `replyToId` is refused in the global room (400), and vice versa.
- **Moderation:** admins and approved organizers
  (`isApprovedOrganizer`, which returns true for admins) may
  delete ANY global message (no 24h window); everyone else
  deletes only their own within 24h, and edits only their own
  within 1h (no membership to lose in the global room).
  `isOrganizer` in the global GET response is the moderator flag
  (it drives the client's delete-any buttons).
- **Realtime:** ping channel `community:global`, id-only pings —
  ping-only BY DESIGN for the global room (fan-out to "every
  signed-in user" is unbounded, so there is no member list to
  derive private channels from). Polling is 3s while open, 30s
  once SUBSCRIBED; without `VITE_SUPABASE_*` it stays
  polling-only (same hard gate as above).
- **Privacy / no email alerts:** same as event community — names
  only, never emails or phones, and no email alerts for global
  messages.

## Realtime (full-payload private channels — fixes DB-H1, 2026-11-06)

- Private + event-community chats now use **full-payload delivery on
  a private channel per user**: the channel name is
  `inbox:<hex(HMAC-SHA256(SESSION_SECRET, "locora-inbox:" + email))>`,
  computed server-side (`privateChannelName` in `api/messages.ts`);
  the client learns ONLY its own channel from GET
  `/api/messages?action=channel`. A client never learns another
  user's channel, so it cannot subscribe to anyone else's live
  messages — no new table, no token distribution. The server
  broadcasts the full message over Supabase Realtime's REST endpoint
  (POST `/realtime/v1/api/broadcast`, service-role key) after storing
  the row: private messages to the recipient's + sender's channels,
  event-community messages fanned out to every member's channel in
  one batched call (rooms over 200 members fall back to a ping).
  The receiver renders the payload immediately — no refetch.
  Payloads carry NAMES only (see `buildRealtimePayload`): no emails
  or phones, reply snapshots drop their senderEmail, readBy collapses
  to seenCount.
- **Global room stays ping-only** on the public `community:global`
  channel (a ping carries no content): fan-out to "every signed-in
  user" is unbounded, so there is no member list to derive channels
  from. Global delivery is ping + fast refetch via the paginated GET.
- Typing indicators are ephemeral broadcasts on the same private
  channels (name only); global typing is a name-only ping on
  `community:global`. Read receipts broadcast `{type:'read', id}` to
  the sender's channel (private) or update seenCount (community).
- The old ping-only layer (`broadcastPing`, `subscribeToInbox`,
  `subscribeToCommunity`, `broadcastToInbox`,
  `broadcastToCommunity`) is KEPT for the global room + fallback.
  If a full-payload event is missed, polling picks the message up.
- Wiring: pages subscribe on mount; while SUBSCRIBED, polling slows
  from 3s to a 30s safety net, and polls fetch only rows newer than
  the newest loaded (`since`) — the first page is the newest 50,
  "Load older messages" pages backwards (`before`). When
  `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are absent,
  `getRealtimeClient()` returns null and everything degrades
  silently to 3s polling.
- Old design (DO NOT restore): broadcasting the full message object
  on `inbox:<email>` let anyone who knew an email read that inbox
  live. The new channel name is unguessable without SESSION_SECRET;
  if the secret ever rotates, all channel names change at once and
  clients re-learn theirs from `?action=channel` (polling covers
  the gap).

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
