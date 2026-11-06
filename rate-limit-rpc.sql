-- Locora H2 (audit #4): atomic rate-limit counter.
-- OWNER STEP — run once in the Supabase dashboard (SQL editor → Run).
-- No code change or redeploy is needed afterwards: api/_lib/rate-limit.ts
-- calls this RPC first and falls back to its read-modify-write upsert
-- path while the function is absent, so the site keeps working either
-- way; running this SQL only removes the last race (two simultaneous
-- hits at the limit both passing). Same pattern as adjust_event_count
-- in SUPABASE_RPC_SETUP.md.
--
-- Behaviour (mirrors the TypeScript fallback exactly):
--   * no row yet            → insert {count: 1, windowStart: now}, allowed
--   * window expired        → reset to {count: 1, windowStart: now}, allowed
--   * within window, count < limit → increment count, allowed
--   * within window, count >= limit → allowed = false, retryAfter =
--     seconds until the window ends; the counter is NOT incremented
--   * returns jsonb {allowed: boolean, retryAfter: integer seconds}
--
-- Atomicity: SELECT ... FOR UPDATE serialises concurrent callers on
-- the same key (the second waits, then reads the fresh count), and the
-- INSERT is retried on unique_violation in case two first-hits race.
-- SECURITY DEFINER so the service-role key can call it; REVOKE from
-- public so PostgREST does not expose it to anonymous keys.

create table if not exists public.rate_limits (
  id text primary key,
  data jsonb not null
);

create or replace function public.rate_limit_hit(p_key text, p_limit int, p_window_ms bigint)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_now bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_data jsonb;
  v_count int;
  v_window_start bigint;
  v_fresh boolean;
begin
  loop
    select data into v_data from public.rate_limits where id = p_key for update;
    if found then
      v_count := coalesce((v_data ->> 'count')::int, 0);
      v_window_start := coalesce((v_data ->> 'windowStart')::bigint, 0);
      v_fresh := v_window_start = 0 or (v_now - v_window_start) >= p_window_ms;
      if not v_fresh and v_count >= p_limit then
        return jsonb_build_object(
          'allowed', false,
          'retryAfter', ceil((v_window_start + p_window_ms - v_now) / 1000.0)::int
        );
      end if;
      update public.rate_limits
        set data = jsonb_build_object(
          'count', case when v_fresh then 1 else v_count + 1 end,
          'windowStart', case when v_fresh then v_now else v_window_start end
        )
        where id = p_key;
      return jsonb_build_object('allowed', true, 'retryAfter', 0);
    end if;
    begin
      insert into public.rate_limits (id, data)
        values (p_key, jsonb_build_object('count', 1, 'windowStart', v_now));
      return jsonb_build_object('allowed', true, 'retryAfter', 0);
    exception when unique_violation then
      -- Another caller inserted the row first; loop and take the
      -- locked row instead of failing.
      null;
    end;
  end loop;
end;
$$;

-- Only the service-role key (which the Vercel functions use) may call
-- it. Without the REVOKE, PostgREST would expose it to anonymous keys.
revoke execute on function public.rate_limit_hit(text, int, bigint) from public;
grant execute on function public.rate_limit_hit(text, int, bigint) to service_role;

-- Verify (expected: {"allowed": true, "retryAfter": 0} the first time,
-- then {"allowed": false, ...} after 3 hits within the hour):
--   select public.rate_limit_hit('smoke-test', 3, 3600000);
--   select public.rate_limit_hit('smoke-test', 3, 3600000);
--   select public.rate_limit_hit('smoke-test', 3, 3600000);
--   select public.rate_limit_hit('smoke-test', 3, 3600000);
--   delete from public.rate_limits where id = 'smoke-test';
