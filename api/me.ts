// GET/PATCH /api/me — profile save endpoint (Phase 2 P2-5).
// The pentest's bio save timed out because authService.updateProfile
// calls PATCH /me and no api/me.ts existed on main, so the save could
// never succeed server-side. This endpoint is the missing path.
// Requires a valid locora_session JWT; identity is the JWT email only.
// GET returns the session user's profile (name, email, role, plus
// saved bio/phone/location/interests) without the password hash.
// PATCH updates ONLY profile fields (name, bio, phone, country, state,
// city, interests, avatar). It can never change id, email, role,
// authProvider or passwordHash — those keys are stripped from the body.
// Phone: 7-15 digits if present (same rule as the attendee gate).
// Profile fields live in locora_users data.profile so they survive
// re-login on any device (unlike the browser-only backup, which is
// still kept by the frontend for offline display).
// Bio rendering: React JSX escapes by default; this endpoint stores
// the bio as plain text and never returns it as HTML, so a <b> marker
// saved in a bio must render as literal text, not bold. Retest after
// deploy with the pentest's marker (see FIX_SUMMARY.md).
import { getEnv, norm, sendJson, supabaseHeaders, supabaseBase, fetchJson, readBody, loadUserByEmail, verifySession } from "./_lib/session";

const PROFILE_FIELDS = ["name", "bio", "phone", "country", "state", "city", "interests", "avatar"];

function publicProfile(row: any, sessionEmail: string, sessionRole: string): any {
  const d = row?.data || {};
  const profile = d.profile || {};
  return {
    id: row?.id || `usr-${sessionEmail}`,
    email: sessionEmail,
    name: d.name || profile.name || "Community Member",
    role: d.role || sessionRole,
    authProvider: d.authProvider || "local",
    avatar: profile.avatar || d.avatar || "",
    bio: profile.bio || d.bio || "",
    phone: profile.phone || "",
    phoneVerified: profile.phoneVerified || false,
    country: profile.country || "",
    state: profile.state || "",
    city: profile.city || "",
    interests: Array.isArray(profile.interests) ? profile.interests : (d.interests || []),
    createdAt: d.createdAt || "",
  };
}

export default async function handler(req: any, res: any): Promise<void> {
  try {
    if (req.method !== "GET" && req.method !== "PATCH") { sendJson(res, 405, { message: "Method not allowed" }); return; }
    const session = await verifySession(req);
    if (!session) { sendJson(res, 401, { message: "Sign in required" }); return; }
    if (!getEnv("SUPABASE_URL") || !getEnv("SUPABASE_SERVICE_ROLE_KEY")) { sendJson(res, 503, { message: "Profile storage is not configured yet" }); return; }
    const me = session.email;

    if (req.method === "GET") {
      const row = await loadUserByEmail(me);
      sendJson(res, 200, publicProfile(row, me, session.role));
      return;
    }

    // PATCH
    const body = await readBody(req);
    const updates: Record<string, any> = {};
    for (const key of PROFILE_FIELDS) if (body[key] !== undefined) updates[key] = body[key];
    if (typeof updates.bio === "string") updates.bio = updates.bio.slice(0, 1000);
    if (typeof updates.name === "string") updates.name = updates.name.trim().slice(0, 100) || undefined;
    if (typeof updates.phone === "string") {
      const digits = updates.phone.replace(/\D/g, "");
      if (updates.phone && (digits.length < 7 || digits.length > 15)) { sendJson(res, 400, { message: "Mobile number must be 7-15 digits" }); return; }
    }
    if (updates.interests !== undefined && !Array.isArray(updates.interests)) delete updates.interests;
    const row = await loadUserByEmail(me);
    if (!row) {
      // Google user (or a user created before locora_users existed):
      // create a profile row now, with no password, rather than failing.
      const data: any = { email: me, name: updates.name || "Community Member", role: session.role, authProvider: session.authProvider, profile: updates };
      const created = await fetchJson(`${supabaseBase()}/rest/v1/locora_users`, {
        method: "POST", headers: supabaseHeaders(), body: JSON.stringify({ id: `usr-${Date.now()}`, data }),
      });
      if (!created.ok) { sendJson(res, 500, { message: "Could not save profile" }); return; }
      sendJson(res, 200, publicProfile({ id: created.body?.[0]?.id, data }, me, session.role));
      return;
    }
    const d = row.data || {};
    const profile = { ...(d.profile || {}), ...updates };
    // Changing the number resets verification (same rule as before).
    if (updates.phone !== undefined && updates.phone !== (d.profile?.phone || d.phone || "")) profile.phoneVerified = false;
    const merged = { ...d, profile, name: updates.name || d.name, phone: undefined, bio: undefined };
    delete merged.phone; delete merged.bio;
    const up = await fetchJson(`${supabaseBase()}/rest/v1/locora_users?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH", headers: supabaseHeaders(), body: JSON.stringify({ data: merged }),
    });
    if (!up.ok) { sendJson(res, 500, { message: "Could not save profile" }); return; }
    sendJson(res, 200, publicProfile({ id: row.id, data: merged }, me, session.role));
  } catch {
    sendJson(res, 500, { message: "Profile update failed" });
  }
}
