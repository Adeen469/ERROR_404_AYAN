// GET /api/auth/google/callback — finishes the custom Google OAuth flow.
//
// Google redirects here with ?code=...&state=... after the user consents.
// This function:
//   1. Verifies the `state` token against the HttpOnly cookie set by
//      /api/auth/google (CSRF protection).
//   2. Exchanges the code for tokens, server-to-server, using
//      GOOGLE_CLIENT_SECRET (never exposed to the browser).
//   3. Verifies the ID token's audience via Google's tokeninfo endpoint.
//   4. Fetches the user's profile and hands it back to the single-page
//      app, which stores it in localStorage exactly like the previous
//      Firebase Google sign-in did (keys: locora_current_user,
//      locora_auth_token), then redirects to /dashboard (or the
//      returnTo path encoded in `state`).
//
// If anything fails, this returns a plain HTML page explaining the most
// likely cause instead of a blank screen or a raw JSON error.

// Buffer is available in the Vercel Node runtime; declared here so
// `tsc --noEmit` (vite/client types only) does not fail.
declare const Buffer: any;

import {
  clearStateCookieHeader,
  decodeState,
  escapeForScript,
  getClientId,
  getClientSecret,
  getRedirectUri,
  htmlPage,
  parseCookies,
} from "../../_lib/google-oauth";

const FALLBACK_AVATAR =
  "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80";

function errorPage(res: any, status: number, heading: string, detail: string) {
  return res.status(status).send(
    htmlPage(
      heading,
      `<h1>${heading}</h1><p>${detail}</p><p><a href="/login">Back to sign in</a></p>`,
    ),
  );
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return res.status(405).send("Method not allowed");
  }

  const clientId = getClientId();
  const clientSecret = getClientSecret();
  if (!clientId || !clientSecret) {
    return errorPage(
      res,
      500,
      "Google sign-in is not configured",
      "GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing on the server. " +
        "Set both in Vercel (Production, sensitive) and redeploy. " +
        "Do not put the secret in code or in a VITE_ variable.",
    );
  }

  // Google sends ?error=access_denied when the user cancels.
  if (typeof req.query?.error === "string") {
    return errorPage(
      res,
      400,
      "Google sign-in was not completed",
      "Google returned an error for this sign-in attempt. " +
        "Please try again from the sign-in page, and make sure you allow the consent screen to complete.",
    );
  }

  const code = req.query?.code;
  const stateRaw = req.query?.state;
  if (typeof code !== "string" || typeof stateRaw !== "string") {
    return errorPage(
      res,
      400,
      "Invalid sign-in response",
      "Google did not return a sign-in code. Please start again from the sign-in page.",
    );
  }

  const state = decodeState(stateRaw);
  const cookies = parseCookies(req);
  if (!state || !state.csrf || cookies.locora_oauth_state !== state.csrf) {
    return errorPage(
      res,
      400,
      "Sign-in request expired or invalid",
      "The sign-in request could not be verified (state mismatch). " +
        "This can happen if cookies are blocked or the request expired. " +
        "Please try again from the sign-in page.",
    );
  }

  const role = state.role === "organizer" ? "organizer" : "attendee";
  const returnTo =
    state.returnTo && state.returnTo.startsWith("/") && !state.returnTo.startsWith("//")
      ? state.returnTo
      : "/dashboard";
  const redirectUri = getRedirectUri(req);

  // 1. Exchange the authorisation code for tokens.
  let tokenData: any;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token || !tokenData.id_token) {
      const detail = tokenData?.error_description || tokenData?.error || "Unknown token error";
      return errorPage(
        res,
        400,
        "Google sign-in failed while exchanging the code",
        `Google said: ${detail}. ` +
          `Most often this is a redirect URI mismatch: make sure ` +
          `${redirectUri} is registered exactly as an Authorized redirect URI ` +
          `in Google Cloud Console for this OAuth client, and that ` +
          `GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in Vercel belong to that same client, then redeploy.`,
      );
    }
  } catch {
    return errorPage(
      res,
      502,
      "Could not reach Google",
      "The token exchange failed due to a network error. Please try again.",
    );
  }

  // 2. Verify the ID token belongs to this OAuth client.
  try {
    const infoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`,
    );
    const info = await infoRes.json();
    if (!infoRes.ok || info.aud !== clientId) {
      return errorPage(
        res,
        400,
        "Google sign-in could not be verified",
        "The ID token returned by Google did not match this OAuth client. " +
          "Check that GOOGLE_CLIENT_ID in Vercel matches the client used to start the sign-in.",
      );
    }
  } catch {
    return errorPage(
      res,
      502,
      "Could not verify the Google sign-in",
      "Token verification failed due to a network error. Please try again.",
    );
  }

  // 3. Fetch the user's profile.
  let googleUser: any = null;
  try {
    const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (userRes.ok) googleUser = await userRes.json();
  } catch {
    googleUser = null;
  }
  if (!googleUser) {
    // Fallback: the ID token payload itself carries sub/name/email/picture.
    try {
      const payload = tokenData.id_token.split(".")[1];
      const decoded = JSON.parse(
        Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
      );
      googleUser = decoded;
    } catch {
      return errorPage(
        res,
        502,
        "Could not load your Google profile",
        "Google authenticated you, but the profile could not be loaded. Please try again.",
      );
    }
  }

  if (!googleUser.email) {
    return errorPage(
      res,
      400,
      "Google account has no email address",
      "This Google account did not provide an email address, so an account cannot be created. Please try a different Google account.",
    );
  }

  const profile = {
    id: googleUser.sub,
    name: googleUser.name || "Community Member",
    email: googleUser.email,
    avatar: googleUser.picture || FALLBACK_AVATAR,
    bio: "Active Locora community member.",
    neighborhood: "Downtown Arts District",
    interests: ["Food & Community", "Live Music & Culture"],
    role,
    createdAt: new Date().toISOString(),
  };

  // 4. Hand the profile back to the SPA, in the same localStorage shape
  //    the app already uses, then send the user to their dashboard.
  res.setHeader("Set-Cookie", clearStateCookieHeader(req));
  const profileJson = escapeForScript(JSON.stringify(profile));
  const tokenJson = escapeForScript(JSON.stringify(tokenData.id_token));
  return res.status(200).send(
    htmlPage(
      "Signing you in…",
      `<p>Signing you in…</p>
      <script>
        try {
          localStorage.setItem('locora_current_user', ${profileJson});
          localStorage.setItem('locora_auth_token', ${tokenJson});
        } catch (e) {}
        window.location.replace(${escapeForScript(JSON.stringify(returnTo))});
      </script>
      <noscript><p>JavaScript is required to complete sign-in. <a href="/login">Back to sign in</a></p></noscript>`,
    ),
  );
}
