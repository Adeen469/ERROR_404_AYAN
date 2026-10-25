// GET /api/auth/callback/google — finishes the custom Google OAuth flow.
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
//
// Calendar connect branch: /api/auth/google-calendar starts a flow with
// the same redirect URI but state.purpose === "calendar". After the same
// code exchange and ID-token verification as sign-in, this callback does
// NOT sign anyone in: it stores the (encrypted) refresh token in Supabase
// under the Locora user id from state, then sends the user back to
// state.returnTo. See CALENDAR_SETUP.md for the table + console steps.

// Self-contained: no imports from api/_lib, no Node-only modules.
// The callback path must match an Authorized redirect URI registered in
// Google Cloud Console: https://locora-hyperlocal.vercel.app/api/auth/callback/google

function getEnv(name: string): string {
  try {
    const env = (globalThis as any).process?.env;
    return (env && env[name]) || "";
  } catch {
    return "";
  }
}

function base64urlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function decodeState(value: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(base64urlDecode(value));
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

// --- Google Calendar storage helpers (used only by the calendar branch) ---
// The refresh token is encrypted with AES-GCM before it is stored. The
// key is derived from GOOGLE_CLIENT_SECRET, which never leaves the
// server, so a database read alone never yields a usable token. Only the
// refresh token is stored long-term; access tokens are minted on demand
// from it and never persisted.
function base64EncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function encryptRefreshToken(refreshToken: string): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable in this runtime");
  const secret = getEnv("GOOGLE_CLIENT_SECRET");
  const keyMaterial = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode("locora-calendar-v1:" + secret),
  );
  const key = await subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12);
  (globalThis as any).crypto.getRandomValues(iv);
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(refreshToken),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return base64EncodeBytes(combined);
}

function calendarSupabaseHeaders(): Record<string, string> {
  const key = getEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
    Prefer: "return=representation,resolution=merge-duplicates",
  };
}

function parseCookies(req: any): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers?.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function htmlPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #1E2320;">
${bodyHtml}
</body>
</html>`;
}

function escapeForScript(json: string): string {
  return json.replace(/</g, "\u003c").replace(/>/g, "\u003e");
}

function sendText(res: any, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function getRedirectUri(req: any): string {
  const configured = getEnv("GOOGLE_REDIRECT_URI");
  if (configured) return configured;
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "";
  return `${proto}://${host}/api/auth/callback/google`;
}

const FALLBACK_AVATAR =
  "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150&auto=format&fit=crop&q=80";

function errorPage(res: any, status: number, heading: string, detail: string) {
  return sendText(
    res,
    status,
    htmlPage(
      heading,
      `<h1>${heading}</h1><p>${detail}</p><p><a href="/login">Back to sign in</a></p>`,
    ),
    "text/html; charset=utf-8",
  );
}

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") {
    return sendText(res, 405, "Method not allowed");
  }

  const clientId = getEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getEnv("GOOGLE_CLIENT_SECRET");
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

  // Roles are NOT taken from the sign-in request anymore. A role chosen by
  // the visitor at sign-in used to let anyone become an organizer. Now the
  // role is assigned below, from the Google-verified email, after the
  // profile is fetched: admin emails become admins, everyone else becomes
  // an attendee. Organizer status comes only from an admin approval
  // (see api/organizer-access.ts), never from sign-in.
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

  // Calendar connect branch: same exchange + ID-token verification as
  // sign-in above, but no sign-in happens here. Store the refresh token
  // and send the user back to where they started.
  if (state.purpose === "calendar") {
    const calendarUserId =
      typeof state.userId === "string" ? state.userId : "";
    if (!calendarUserId || calendarUserId.length > 128) {
      return errorPage(
        res,
        400,
        "Google Calendar connection failed",
        "The connection request did not carry a valid user. Please connect again from your profile page while signed in.",
      );
    }
    if (!tokenData.refresh_token) {
      return errorPage(
        res,
        400,
        "Google Calendar connection incomplete",
        "Google did not return a long-term connection token. This can happen " +
          "if access was already granted without offline access. Remove Locora " +
          "from your Google Account permissions (myaccount.google.com/permissions) " +
          "and connect again from your profile page.",
      );
    }
    // The Google account that consented — shown back in the profile page.
    let calendarEmail = "";
    try {
      const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (userRes.ok) {
        const info = await userRes.json();
        calendarEmail = typeof info.email === "string" ? info.email : "";
      }
    } catch {
      calendarEmail = "";
    }
    if (!calendarEmail) {
      try {
        calendarEmail = JSON.parse(base64urlDecode(tokenData.id_token.split(".")[1])).email || "";
      } catch {
        calendarEmail = "";
      }
    }
    const supabaseUrl = getEnv("SUPABASE_URL");
    const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return errorPage(
        res,
        500,
        "Google Calendar storage is not configured",
        "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing on the server, " +
          "or the calendar_connections table has not been created yet. " +
          "See CALENDAR_SETUP.md, then try connecting again.",
      );
    }
    let encrypted: string;
    try {
      encrypted = await encryptRefreshToken(tokenData.refresh_token);
    } catch {
      return errorPage(
        res,
        502,
        "Google Calendar connection failed",
        "The connection token could not be secured for storage. Please try again.",
      );
    }
    try {
      const upsertRes = await fetch(
        supabaseUrl.replace(/\/$/, "") + "/rest/v1/calendar_connections",
        {
          method: "POST",
          headers: calendarSupabaseHeaders(),
          body: JSON.stringify([
            {
              user_id: calendarUserId,
              data: {
                refresh_token_enc: encrypted,
                google_email: calendarEmail,
                scope: "calendar.events",
                connected_at: new Date().toISOString(),
              },
            },
          ]),
        },
      );
      if (!upsertRes.ok) {
        const detail = await upsertRes.text().catch(() => "");
        return errorPage(
          res,
          502,
          "Google Calendar connection could not be saved",
          "The connection token could not be stored. " +
            "Make sure the calendar_connections table exists in Supabase (see CALENDAR_SETUP.md). " +
            (detail ? `Server said: ${detail.slice(0, 200)}` : ""),
        );
      }
    } catch {
      return errorPage(
        res,
        502,
        "Google Calendar connection could not be saved",
        "The connection token could not be stored due to a network error. Please try again.",
      );
    }
    const secureCal = redirectUri.startsWith("https://") ? "; Secure" : "";
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": `locora_oauth_state=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureCal}`,
    });
    return res.end(
      htmlPage(
        "Google Calendar connected",
        `<p id="status">Google Calendar connected${calendarEmail ? ` as ${calendarEmail}` : ""} — taking you back…</p>
        <p>Events you register for will now be added to your Google Calendar automatically.</p>
        <script>
          setTimeout(function () {
            window.location.replace(${escapeForScript(JSON.stringify(returnTo))});
          }, 900);
        </script>
        <noscript><p><a href="${returnTo}">Continue</a></p></noscript>`,
      ),
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
      const decoded = JSON.parse(base64urlDecode(payload));
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

  // Admin emails are identifiers, not secrets. This email comes from
  // Google's own userinfo response for the just-exchanged token, so it is
  // verified by Google, not self-asserted by the visitor.
  const ADMIN_EMAILS = ["mr.adeen946@gmail.com", "ayan.work937@gmail.com"];
  const profile = {
    id: googleUser.sub,
    name: googleUser.name || "Community Member",
    email: googleUser.email,
    avatar: googleUser.picture || FALLBACK_AVATAR,
    bio: "Active Locora community member.",
    neighborhood: "Downtown Arts District",
    interests: ["Food & Community", "Live Music & Culture"],
    role:
      ADMIN_EMAILS.indexOf(String(googleUser.email).trim().toLowerCase()) !== -1
        ? "admin"
        : "attendee",
    authProvider: "google",
    createdAt: new Date().toISOString(),
  };

  // 4. Hand the profile back to the SPA, in the same localStorage shape
  //    the app already uses, then send the user to their dashboard.
  const profileJson = escapeForScript(JSON.stringify(profile));
  const tokenJson = escapeForScript(JSON.stringify(tokenData.id_token));
  const secure = redirectUri.startsWith("https://") ? "; Secure" : "";
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Set-Cookie": `locora_oauth_state=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  });
  return res.end(
    htmlPage(
      "Signing you in…",
      `<p id="status">Signing you in…</p>
      <script>
        var profile = ${profileJson};
        var saved = false;
        try {
          localStorage.setItem('locora_current_user', JSON.stringify(profile));
          localStorage.setItem('locora_auth_token', ${tokenJson});
          saved = localStorage.getItem('locora_current_user') !== null;
        } catch (e) { saved = false; }
        var status = document.getElementById('status');
        if (saved) {
          status.textContent = 'Signed in as ' + (profile.name || 'you') + ' — taking you to your dashboard…';
          setTimeout(function () {
            window.location.replace(${escapeForScript(JSON.stringify(returnTo))});
          }, 900);
        } else {
          status.textContent = 'Could not save your sign-in in this browser (site storage appears blocked). Please allow storage for this site and try again, or use the demo profile on the sign-in page.';
        }
      </script>
      <noscript><p>JavaScript is required to complete sign-in. <a href="/login">Back to sign in</a></p></noscript>`,
    ),
  );
}
