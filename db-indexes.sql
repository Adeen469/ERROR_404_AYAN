-- Locora database indexes (audit #4 H8) + unique email index (M6).
--
-- OWNER-RUN ONLY: run this in the Supabase dashboard -> SQL editor ->
-- Run, against the same project as the events table. It is safe to
-- re-run (every statement is IF NOT EXISTS). NO code change or
-- redeploy is needed after running it: the API already filters on
-- these data->> expressions, so the queries just get faster.
--
-- WHY: Locora stores rows as { id, data jsonb }. The API filters on
-- data->>'field' expressions (e.g. messages by senderEmail /
-- recipientEmail / eventId, registrations by eventId / userEmail).
-- Without an index on the expression, Postgres scans the whole table
-- for every chat poll, inbox load and roster read, and the scan grows
-- with total usage. These are expression indexes on exactly the
-- filters the API relies on, so the hot reads become index lookups.
--
-- The RPCs (adjust_event_count, see SUPABASE_RPC_SETUP.md) are NOT
-- assumed to exist: this file only creates indexes, and every index
-- below is independent of them.
--
-- Retention cleanup for the tables below is NOT done here: it lives
-- in POST /api/notify { action: "cleanup" } (admin-only, audit #4
-- M5) and in the SQL equivalents documented in its code comment.

-- messages: private inbox (sender/recipient), community rooms
-- (type + eventId), idempotency lookups, reply chains, attachment
-- ownership checks (delete-upload), pagination order.
CREATE INDEX IF NOT EXISTS idx_messages_sender
  ON public.messages ((data->>'senderEmail'));
CREATE INDEX IF NOT EXISTS idx_messages_recipient
  ON public.messages ((data->>'recipientEmail'));
CREATE INDEX IF NOT EXISTS idx_messages_event
  ON public.messages ((data->>'eventId'));
CREATE INDEX IF NOT EXISTS idx_messages_community
  ON public.messages ((data->>'type'), (data->>'eventId'));
CREATE INDEX IF NOT EXISTS idx_messages_idempotency
  ON public.messages ((data->>'idempotencyKey'));
CREATE INDEX IF NOT EXISTS idx_messages_reply_to
  ON public.messages ((data->>'replyToId'));
CREATE INDEX IF NOT EXISTS idx_messages_attachment_path
  ON public.messages ((data->'attachment'->>'path'));
CREATE INDEX IF NOT EXISTS idx_messages_created
  ON public.messages ((data->>'createdAt'));

-- registrations: per-event rosters, per-user lists, team codes,
-- idempotency/dedupe (event + user) and status counts.
CREATE INDEX IF NOT EXISTS idx_registrations_event
  ON public.registrations ((data->>'eventId'));
CREATE INDEX IF NOT EXISTS idx_registrations_user
  ON public.registrations ((data->>'userEmail'));
CREATE INDEX IF NOT EXISTS idx_registrations_event_user
  ON public.registrations ((data->>'eventId'), (data->>'userEmail'));
CREATE INDEX IF NOT EXISTS idx_registrations_status
  ON public.registrations ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_registrations_team_code
  ON public.registrations ((data->>'teamCode'));

-- events: status/category filters used by list + admin views.
CREATE INDEX IF NOT EXISTS idx_events_status
  ON public.events ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_events_category
  ON public.events ((data->>'category'));
CREATE INDEX IF NOT EXISTS idx_events_owner
  ON public.events ((data->>'createdByEmail'));

-- locora_users: login / profile / session-version lookups by email.
-- M6: one row per email — the unique index makes a duplicate-email
-- insert fail instead of silently creating a second account row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_locora_users_email_unique
  ON public.locora_users ((data->>'email'));

-- rate_limits: per-key counter reads (id is already the primary key;
-- windowStart supports the 24h retention cleanup).
CREATE INDEX IF NOT EXISTS idx_rate_limits_window
  ON public.rate_limits ((data->>'windowStart'));

-- phone_verifications: OTP-verified phone lookups by email (+phone).
CREATE INDEX IF NOT EXISTS idx_phone_verifications_email
  ON public.phone_verifications ((data->>'email'));
CREATE INDEX IF NOT EXISTS idx_phone_verifications_email_status
  ON public.phone_verifications ((data->>'email'), (data->>'status'));

-- email_log: real columns (email, kind, created_at — not jsonb).
-- Supports the welcome/rate-limit lookups and the 90-day cleanup.
CREATE INDEX IF NOT EXISTS idx_email_log_email_created
  ON public.email_log (email, created_at);
CREATE INDEX IF NOT EXISTS idx_email_log_kind_created
  ON public.email_log (kind, created_at);

-- revoked_tokens / password_resets: expiry-based retention cleanup
-- (data->>'expiresAt' is ISO text) and reset lookups by email/hash.
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires
  ON public.revoked_tokens ((data->>'expiresAt'));
CREATE INDEX IF NOT EXISTS idx_password_resets_email
  ON public.password_resets ((data->>'email'));
CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash
  ON public.password_resets ((data->>'tokenHash'));
CREATE INDEX IF NOT EXISTS idx_password_resets_expires
  ON public.password_resets ((data->>'expiresAt'));

-- Verify (optional, after running): expect one row per index above.
--   select indexname from pg_indexes
--   where schemaname = 'public'
--   and indexname like 'idx_%'
--   order by indexname;
