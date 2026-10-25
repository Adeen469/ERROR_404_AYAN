// GET /api/auth/google — starts the custom Google OAuth flow.
//
// This is a Vercel Serverless Function (api/ is deployed by Vercel
// alongside the static Vite build; it is not part of the Express server
// in server.ts, which Vercel does not run).
//
// Flow:
//   1. User clicks "Continue with Google" in the app.
//   2. The app redirects here (via authService.loginWithGoogle()).
//   3. This function redirects the user to Google's consent screen.
//   4. Google redirects back to /api/auth/google/callback, which finishes
//      the sign-in and hands the profile back to the app.

import {
  encodeState,
  getClientId,
  getRedirectUri,
  randomToken,
  stateCookieHeader,
} from "../_lib/google-oauth";

export default function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const clientId = getClientId();
  if (!clientId) {
    return res
      .status(500)
      .send(
        "Google sign-in is not configured on the server. " +
          "Set GOOGLE_CLIENT_ID in Vercel (Production) and redeploy.",
      );
  }

  // Role comes from the signup page's attendee/organizer choice. Anything
  // else falls back to attendee so a crafted URL cannot inject a role.
  const role = req.query?.role === "organizer" ? "organizer" : "attendee";

  // Only allow same-site return paths, never an external URL.
  const rawReturnTo =
    typeof req.query?.returnTo === "string" ? req.query.returnTo : "";
  const returnTo =
    rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : "/dashboard";

  // CSRF protection: a random token is stored in an HttpOnly cookie and
  // echoed back inside `state`. The callback only proceeds if they match.
  const csrf = randomToken();
  const state = encodeState({ csrf, role, returnTo });
  res.setHeader("Set-Cookie", stateCookieHeader(csrf, req));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state,
  });

  return res.redirect(
    302,
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
}
