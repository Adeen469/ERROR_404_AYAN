# Supabase RPC setup — atomic event seat counts

## Why this exists

Seat counts used to be read-modify-write in application code: two
simultaneous confirmations for the last seat could both read
"1 seat left", both confirm, and overbook the event. The
`adjust_event_count` function below moves the check-and-increment into
a single locked database statement, so the last seat can only be taken
once.

## Setup (one-time, Supabase dashboard → SQL editor → Run)

```sql
create or replace function public.adjust_event_count(p_event_id text, p_delta int)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_data jsonb;
  v_count int;
  v_capacity int;
begin
  -- FOR UPDATE serialises concurrent callers: the second transaction
  -- waits, then reads the fresh count, so a seat cannot be double-sold.
  select data into v_data from public.events where id = p_event_id for update;
  if v_data is null then
    return false;
  end if;
  -- Defensive casts: a stored non-numeric string ("0x32", "1e3", true)
  -- would make a plain ::int throw and the whole call 500, silently
  -- degrading callers to the racy read-modify-write fallback (see the
  -- events PATCH coercion in api/events.ts). Only plain integer text
  -- is cast; anything else reads as 0.
  v_count := case when (v_data ->> 'registeredCount') ~ '^-?[0-9]+$' then (v_data ->> 'registeredCount')::int else 0 end;
  v_capacity := case when (v_data ->> 'capacity') ~ '^-?[0-9]+$' then (v_data ->> 'capacity')::int else 0 end;
  if p_delta > 0 then
    -- A missing/zero capacity is treated as unlimited (legacy rows);
    -- otherwise a full event refuses the increment.
    if v_capacity > 0 and v_count >= v_capacity then
      return false;
    end if;
    v_count := v_count + p_delta;
    if v_capacity > 0 and v_count > v_capacity then
      v_count := v_capacity;
    end if;
  else
    v_count := greatest(0, v_count + p_delta);
  end if;
  update public.events
    set data = jsonb_set(v_data, '{registeredCount}', to_jsonb(v_count))
    where id = p_event_id;
  return true;
end;
$$;

-- Only the service-role key (which the Vercel functions use) may call
-- it. Without the REVOKE, PostgREST would expose it to anonymous keys.
revoke execute on function public.adjust_event_count(text, int) from public;
grant execute on function public.adjust_event_count(text, int) to service_role;
```

## Behaviour until this is run

`api/payments.ts` and `api/registrations.ts` already call the RPC
first and fall back to a capped read-modify-write when it is missing
(the count can then never exceed capacity or drop below zero, but a
perfectly simultaneous pair of confirms can still oversell by one
pass). Running the SQL above removes that last race. No code change
or redeploy is needed after running it — the functions pick the RPC
up on their next call.

## Verify

In the SQL editor:

```sql
select public.adjust_event_count('evt-nonexistent', 1); -- false
```

Then confirm a real registration still bumps the event's
`registeredCount` by exactly one.

---

# Rate limiting — `rate_limits` table + `rate_limit_hit` RPC

## Why this exists

Every API rate limiter used to be read-modify-write in application
code: two simultaneous calls could both read the same count and both
pass, so a parallel burst slipped under the limit. Worse, when the
`rate_limits` table did not exist, every limiter silently failed open
and mutations ran with no limit at all. The code now fails closed for
mutations (503 with this setup pointer) when the table is missing, and
prefers the `rate_limit_hit` function below, which counts each hit in
a single atomic upsert — no race, no extra round trip.

## Setup (one-time, Supabase dashboard → SQL editor → Run)

Run the table first, then the function — both in one paste:

```sql
create table if not exists public.rate_limits (
  id text primary key,
  data jsonb not null
);

create or replace function public.rate_limit_hit(p_key text, p_limit int, p_window_ms bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_data jsonb;
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  -- One atomic upsert: the row lock serialises concurrent callers for
  -- the same key, so a parallel burst cannot all read the same count.
  -- A hit inside the current window increments the count; a hit past
  -- the window starts a fresh one. An over-limit hit still increments
  -- (past the limit), which is how the caller tells "denied" from
  -- "allowed at exactly the limit" on the returned row.
  insert into public.rate_limits as r (id, data)
  values (p_key, jsonb_build_object('count', 1, 'windowStart', v_now))
  on conflict (id) do update set data = case
    when coalesce((r.data ->> 'windowStart')::bigint, 0) <> 0
      and v_now - coalesce((r.data ->> 'windowStart')::bigint, 0) < p_window_ms
    then jsonb_set(r.data, '{count}', to_jsonb(coalesce((r.data ->> 'count')::int, 0) + 1))
    else jsonb_build_object('count', 1, 'windowStart', v_now)
  end
  returning data into v_data;
  return jsonb_build_object(
    'allowed', (v_data ->> 'count')::int <= p_limit,
    'retry_after', case
      when (v_data ->> 'count')::int <= p_limit then 0
      else ceil(((v_data ->> 'windowStart')::bigint + p_window_ms - v_now) / 1000.0)::int
    end
  );
end;
$$;

-- Only the service-role key (which the Vercel functions use) may call
-- it. Without the REVOKE, PostgREST would expose it to anonymous keys.
revoke execute on function public.rate_limit_hit(text, int, bigint) from public;
grant execute on function public.rate_limit_hit(text, int, bigint) to service_role;
```

## Behaviour until this is run

- **Table missing:** every mutation (sign-in, sign-up, event create /
  edit / delete, registrations, payments, messages, Telegram start,
  profile edits, organizer actions, OAuth start / callback) returns
  **503 "Rate limiting is not configured…"** instead of running
  unprotected. Public reads (event lists, message GETs) keep working.
  Run the table SQL above and the 503s stop.
- **Table present, RPC missing:** the code falls back to the old
  read-modify-write counter (correct except for a perfectly
  simultaneous burst, which can overshoot by a few hits). Run the
  function SQL above to close that last race. No code change or
  redeploy is needed after running it — the functions pick the RPC up
  on their next call.

## Verify

In the SQL editor:

```sql
select public.rate_limit_hit('test-key', 5, 3600000);
-- {"allowed": true, "retry_after": 0} (count 1 of 5)

select public.rate_limit_hit('test-key', 5, 3600000);
-- {"allowed": true, "retry_after": 0} (count 2 of 5)

## Retention — run periodically (e.g. a monthly SQL-editor run)

`rate_limits` keys are minted from unauthenticated emails/IPs, so
distinct-key growth is unbounded: every new email an attacker tries
is a permanent row, and the RPC only resets `count`/`windowStart` in
place — it never deletes expired windows. The same applies to the
mail log and to expired revocation/reset rows. None of these rows is
read after expiry, so pruning is safe:

```sql
-- Windows older than 24h (all windows in the app are <= 1h, so 24h is
-- a generous margin — never delete a live window).
delete from public.rate_limits
  where ((data ->> 'windowStart')::bigint) < (extract(epoch from now()) * 1000)::bigint - 86400000;

-- Mail log older than 90 days (email + activity timestamps are PII).
delete from public.email_log
  where created_at < now() - interval '90 days';

-- Expired revocations and used/expired reset rows.
delete from public.revoked_tokens
  where ((data ->> 'expiresAt')::bigint) < (extract(epoch from now()) * 1000)::bigint;
delete from public.password_resets
  where ((data ->> 'expiresAt')::bigint) < (extract(epoch from now()) * 1000)::bigint
     or (data ->> 'used')::boolean is true;
```

The same statements live in the canonical `supabase-setup.sql` (§6).
```
