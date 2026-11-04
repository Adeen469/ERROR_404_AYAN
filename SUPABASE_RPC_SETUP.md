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
  v_count := coalesce((v_data ->> 'registeredCount')::int, 0);
  v_capacity := coalesce((v_data ->> 'capacity')::int, 0);
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
