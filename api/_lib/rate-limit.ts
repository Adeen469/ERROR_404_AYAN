// Shared rate limiting for Locora (audit #4 HIGH H2).
//
// ONE canonical copy: every api/*.ts handler imports checkRateLimit and
// getClientIp from here. The ~14 copy-pasted checkRateLimit copies and
// ~14 getClientIp copies that used to live in each api file were deleted
// (H2). Thresholds (limit/window per endpoint key) are NOT defined here
// and were NOT retuned — each call site keeps its exact key, limit and
// window from before; this file only collapses the mechanism.
//
// -- Import safety (read before reverting to copies) --
// This module has ZERO static imports: no `import ... from "crypto"`,
// no relative imports, only globals (fetch, globalThis). That is the
// same style as the working self-contained api files. History: on
// 2026-10-28/29 the first shared helper (api/_lib/session.ts, imported
// relatively AND importing node:crypto) correlated with live
// FUNCTION_INVOCATION_FAILED on every function that used it, while the
// import-free functions kept working (local esbuild/Node tests passed
// throughout, so the failure was a Vercel bundling/runtime issue, never
// reproduced locally). The two causes were never separated — it may
// have been the node:crypto import, the relative _lib import, or both.
// This module removes the node:crypto confound entirely, but the
// relative-import risk is NOT proven gone. LIVE-TEST STEP (owner,
// after the next deploy shows Ready): POST /api/auth/login with a bad
// password and expect a 401 JSON body; a Vercel 500
// FUNCTION_INVOCATION_FAILED on /api/auth (or any api route) means the
// _lib import still breaks this runtime — roll back by inlining this
// file's two functions back into each api file (git revert of the H2
// commit) and re-checking the function logs. Do NOT "fix" it by
// re-adding a node:crypto import anywhere: that import is a known
// live failure in this project.
//
// -- getClientIp: LAST x-forwarded-for entry --
// Vercel's x-forwarded-for is `client, proxy1, proxy2, ...`. The FIRST
// entry is client-controlled and trivially spoofed to dodge per-IP
// limits; Vercel appends the real connecting IP last, so the LAST
// entry is used everywhere (this unifies the copies: 5 files already
// used LAST, 9 used FIRST — the FIRST copies were the spoofable ones).
// Falls back to x-real-ip, then "unknown".
//
// -- checkRateLimit: atomic RPC first, upsert fallback --
// Tries the SECURITY DEFINER `rate_limit_hit(text, int, bigint)` RPC
// (see rate-limit-rpc.sql — owner runs it once in Supabase) which does
// the read-check-increment in ONE locked statement, so two concurrent
// hits for the last allowed attempt cannot both pass. If the RPC is
// absent (404 from PostgREST) or errors, falls back to the previous
// read-modify-write upsert path — correct except for a perfectly
// simultaneous pair, exactly like the adjust_event_count precedent
// (SUPABASE_RPC_SETUP.md). No redeploy is needed after the owner runs
// the SQL: the RPC is picked up on the next call. No caching of
// "RPC missing": a cached miss would keep using the racy path after
// the owner runs the SQL until the function instance recycles.
//
// -- Fail-closed vs fail-open (H2) --
// checkRateLimit reports `tableMissing: true` when the rate_limits
// table (or Supabase env) is absent. Callers MUST branch on it:
//   * FAIL CLOSED (503): auth/OTP mutations — login, signup, OTP send,
//     OTP verify, password-reset request, password-reset confirm.
//     Without a counter table there is no brute-force protection, so
//     the mutation is refused rather than run unlimited.
//   * FAIL OPEN (proceed, limit ignored): everything else — all GETs
//     (events/messages/registrations/organizer-access reads) and the
//     non-auth mutations (event create/edit/delete, message send,
//     payments, registrations). A missing table must not brick reads
//     or ordinary use; the limit takes effect once the table exists.
//   * Email-verification confirm/resend (H1) intentionally stay
//     fail-open: they are owned by the H1 flow, not this fix.
// A transient Supabase error (non-404/400, network throw) is NOT
// tableMissing: it fails open, as before — only a provably absent
// table/env fails closed.
function getEnv(name: string): string {
  try {
    const env = (globalThis as any).process?.env;
    return (env && env[name]) || "";
  } catch {
    return "";
  }
}

function supabaseBase(): string {
  return getEnv("SUPABASE_URL").replace(/\/$/, "");
}

function supabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" };
}

async function fetchJson(url: string, init?: any): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}

export function getClientIp(req: any): string {
  // Last entry, not first: the first x-forwarded-for entry is
  // client-controlled and trivially spoofed to dodge per-IP limits;
  // Vercel appends the real connecting IP last.
  const fwd = req.headers?.["x-forwarded-for"] || "";
  if (typeof fwd === "string" && fwd.trim()) {
    const parts = fwd.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers?.["x-real-ip"] || "unknown";
}

export interface RateLimitResult { allowed: boolean; retryAfter: number; tableMissing: boolean; }

export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  try {
    if (!supabaseBase() || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) return { allowed: false, retryAfter: 0, tableMissing: true };
    // Atomic path first: rate_limit_hit RPC (rate-limit-rpc.sql).
    // Any failure (function missing, table missing inside the
    // function, transient error) falls through to the upsert path
    // below, which is the authority on whether the table exists.
    try {
      const rpc = await fetchJson(`${supabaseBase()}/rest/v1/rpc/rate_limit_hit`, {
        method: "POST",
        headers: supabaseHeaders(),
        body: JSON.stringify({ p_key: key, p_limit: limit, p_window_ms: windowMs }),
      });
      if (rpc.ok && rpc.body && typeof rpc.body === "object" && typeof rpc.body.allowed === "boolean") {
        return {
          allowed: rpc.body.allowed,
          retryAfter: typeof rpc.body.retryAfter === "number" ? rpc.body.retryAfter : 0,
          tableMissing: false,
        };
      }
    } catch {
      // Fall through to the upsert path.
    }
    // Fallback path (pre-H2 behaviour, unchanged): read-modify-write
    // upsert. Correct except a perfectly simultaneous pair at the
    // limit can both pass; the RPC above removes that race.
    const url = `${supabaseBase()}/rest/v1/rate_limits?id=eq.${encodeURIComponent(key)}&select=data`;
    const { ok, status, body } = await fetchJson(url, { headers: supabaseHeaders() });
    if (!ok) {
      if (status === 404 || status === 400) return { allowed: false, retryAfter: 0, tableMissing: true };
      return { allowed: true, retryAfter: 0, tableMissing: false };
    }
    const now = Date.now();
    const row = Array.isArray(body) && body.length > 0 ? body[0].data : null;
    const windowStart = row && typeof row.windowStart === "number" ? row.windowStart : 0;
    const count = row && typeof row.count === "number" ? row.count : 0;
    if (windowStart && now - windowStart < windowMs && count >= limit) {
      return { allowed: false, retryAfter: Math.ceil((windowStart + windowMs - now) / 1000), tableMissing: false };
    }
    const fresh = !windowStart || now - windowStart >= windowMs;
    const next = { count: fresh ? 1 : count + 1, windowStart: fresh ? now : windowStart };
    const up = await fetchJson(`${supabaseBase()}/rest/v1/rate_limits`, {
      method: "POST",
      headers: { ...supabaseHeaders(), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ id: key, data: next }),
    });
    if (!up.ok && (up.status === 404 || up.status === 400)) return { allowed: false, retryAfter: 0, tableMissing: true };
    return { allowed: true, retryAfter: 0, tableMissing: false };
  } catch {
    return { allowed: true, retryAfter: 0, tableMissing: false };
  }
}
