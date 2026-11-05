-- ============================================================
-- Locora canonical Supabase hardening — run ONCE in the Supabase
-- SQL editor, then verify with the queries at the end of this file.
--
-- POSTURE (read this before changing anything):
--   * Locora uses NO Supabase Auth. Sessions are custom HMAC JWTs
--     verified server-side, so no auth.uid() policy can ever work.
--   * The only safe posture is: RLS ENABLED + ZERO POLICIES on every
--     table (deny-all for anon/authenticated; the service-role key
--     bypasses RLS by design and is the ONLY accessor, via the Vercel
--     API). NEVER create a policy on these tables. If a future feature
--     needs direct browser reads, it must go through a signed-URL or
--     API route, not a policy. A single "public read" policy publishes
--     the whole table (organizer emails, attendee phones, password
--     hashes) to PostgREST, bypassing every API-layer strip.
--   * Both RPCs are SECURITY DEFINER and bypass RLS, so the REVOKEs in
--     §3 are their ONLY access control. Run them with the functions,
--     never separately.
--   * This file is the single canonical source. The per-table setup
--     docs (MESSAGES_SETUP.md, REGISTRATIONS_SETUP.md, etc.) point
--     here; do not hand-edit RLS state from the dashboard fragments
--     in those docs — they contradict each other (SHARED_EVENTS_SETUP
--     said "leave RLS as it is" while every later doc says "same as
--     events").
-- ============================================================

-- §1. RLS on for every table (idempotent)
alter table public.events                enable row level security;
alter table public.registrations        enable row level security;
alter table public.organizer_access     enable row level security;
alter table public.email_log            enable row level security;
alter table public.phone_verifications  enable row level security;
alter table public.messages             enable row level security;
alter table public.locora_users         enable row level security;
alter table public.rate_limits          enable row level security;
alter table public.password_resets      enable row level security;
alter table public.revoked_tokens       enable row level security;
alter table public.calendar_connections enable row level security;

-- §2. Belt-and-braces: revoke table privileges from anon/authenticated.
--    (With RLS on + no policies this is redundant, but it also protects
--    the tables if RLS is ever accidentally disabled. service_role is
--    unaffected — do NOT revoke from service_role.)
revoke all on public.events, public.registrations, public.organizer_access,
  public.email_log, public.phone_verifications, public.messages,
  public.locora_users, public.rate_limits, public.password_resets,
  public.revoked_tokens, public.calendar_connections
  from anon, authenticated;

-- §3. RPCs: only service_role may execute.
revoke execute on function public.adjust_event_count(text, int) from public;
grant  execute on function public.adjust_event_count(text, int) to service_role;
revoke execute on function public.rate_limit_hit(text, int, bigint) from public;
grant  execute on function public.rate_limit_hit(text, int, bigint) to service_role;

-- §4. Storage bucket message-attachments: EXACTLY ONE policy — public
--    SELECT on this bucket only. No INSERT / UPDATE / DELETE policy for
--    anon or authenticated (uploads go only through service-role-signed
--    URLs issued by api/messages.ts; deletes go only through the API).
--    If a policy named e.g. "public upload" exists, drop it:
--      drop policy "<name>" on storage.objects;
create policy "public read message-attachments"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'message-attachments');

-- §5. Indexes for the jsonb filters the API relies on (perf; also avoids
--    full-table scans on per-user reads).
create index if not exists idx_locora_users_email
  on public.locora_users ((data ->> 'email'));
create index if not exists idx_messages_sender
  on public.messages ((data ->> 'senderEmail'));
create index if not exists idx_messages_recipient
  on public.messages ((data ->> 'recipientEmail'));
create index if not exists idx_messages_event
  on public.messages ((data ->> 'eventId'));
create index if not exists idx_registrations_event_user
  on public.registrations ((data ->> 'eventId'), (data ->> 'userEmail'));
create index if not exists idx_phone_verifications_email
  on public.phone_verifications ((data ->> 'email'));
create index if not exists idx_email_log_email_created
  on public.email_log (email, created_at);

-- §6. Retention — run periodically (e.g. a monthly SQL-editor run; there
--    is no scheduler in the app). Rows are inert after expiry, but they
--    accumulate forever without this. rate_limits keys are minted from
--    unauthenticated emails/IPs, so distinct-key growth is unbounded.
delete from public.rate_limits
  where ((data ->> 'windowStart')::bigint) < (extract(epoch from now()) * 1000)::bigint - 86400000;
delete from public.email_log
  where created_at < now() - interval '90 days';
delete from public.revoked_tokens
  where ((data ->> 'expiresAt')::bigint) < (extract(epoch from now()) * 1000)::bigint;
delete from public.password_resets
  where ((data ->> 'expiresAt')::bigint) < (extract(epoch from now()) * 1000)::bigint
     or (data ->> 'used')::boolean is true;

-- ============================================================
-- VERIFY (run after the SQL above; every check must pass before the
-- anon key ships to the browser — i.e. before the message-replies +
-- Realtime push lands, and before VITE_SUPABASE_* is set in Vercel).
-- ============================================================
-- V-1  RLS on for all 11 tables (rowsecurity must be true for all):
--   select tablename, rowsecurity from pg_tables where schemaname = 'public'
--     and tablename in ('events','registrations','organizer_access','email_log',
--     'phone_verifications','messages','locora_users','rate_limits',
--     'password_resets','revoked_tokens','calendar_connections');
-- V-2  Zero policies on all tables (must return 0 rows):
--   select * from pg_policies where schemaname = 'public';
-- V-3  Anon cannot read any table (curl per table, expect [] or 401):
--   curl -s "https://<project>.supabase.co/rest/v1/events?select=id&limit=1"
--     -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
-- V-4  Anon cannot call the RPCs (must return false, false):
--   select has_function_privilege('anon','public.adjust_event_count(text,int)','execute'),
--          has_function_privilege('anon','public.rate_limit_hit(text,int,bigint)','execute');
-- V-5  Exactly one SELECT policy on the bucket, no other policy:
--   select policyname, cmd, roles from pg_policies
--     where schemaname = 'storage' and tablename = 'objects';
-- V-6  Bucket not listable / not directly writable with the anon key
--   (expect 401/403, not listings or 200s):
--   curl -s -X POST "https://<project>.supabase.co/storage/v1/object/list/message-attachments"
--     -H "apikey: <ANON_KEY>" -H "Authorization: Bearer <ANON_KEY>"
--     -H "Content-Type: application/json" -d '{"prefix":""}'
