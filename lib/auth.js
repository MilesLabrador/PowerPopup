// Optional fallback auth: the user's own Entra app registration, driven
// through launchWebAuthFlow (auth-code + PKCE, silent SSO first).
//
// This is NOT the primary data path. By default PowerPopup reads Dataverse
// same-origin from an open, signed-in org tab (content/org.js) — no app
// registration, no tokens, no secrets. This module only activates when the
// user configures a Client ID on the options page, and is used for Global
// Discovery or for querying an environment with no open org tab.

import { resourceOrigin } from "./jwt.js";

const api = globalThis.browser ?? chrome;

const LOGIN_HOST = "https://login.microsoftonline.com";

async function readAll() {
  const { config = {}, auth = {}, tokens = {} } = await api.storage.local.get([
    "config", "auth", "tokens",
  ]);
  return { config, auth, tokens };
}

export async function getConfig() {
  const { config } = await readAll();
  return {
    clientId: config.clientId || "",
    tenantId: config.tenantId || "",
    pocketEnabled: config.pocketEnabled !== false,
    hasOwnApp: Boolean(config.clientId),
  };
}

export function getRedirectUrl() {
  return api.identity.getRedirectURL();
}

function authority(tenantId) {
  return `${LOGIN_HOST}/${tenantId || "organizations"}/oauth2/v2.0`;
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makePkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

async function writeToken(resource, tokenResponse) {
  const { auth, tokens } = await readAll();
  tokens[resource] = {
    accessToken: tokenResponse.access_token,
    expiresAt: Date.now() + (tokenResponse.expires_in - 120) * 1000, // refresh 2 min early
  };
  const patch = { tokens };
  if (tokenResponse.refresh_token) {
    auth.refreshToken = tokenResponse.refresh_token;
    patch.auth = auth;
  }
  await api.storage.local.set(patch);
  return tokens[resource].accessToken;
}

async function tokenRequest(tenantId, body) {
  const res = await fetch(`${authority(tenantId)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `Token request failed (${res.status})`);
    err.code = json.error;
    throw err;
  }
  return json;
}

// Runs an auth-code + PKCE flow through launchWebAuthFlow. With interactive
// = false and prompt = "none", it completes silently against the user's
// existing Microsoft session (SSO cookies) and only succeeds if no UI is
// needed.
async function webAuthFlow(config, resource, { interactive, prompt }) {
  const pkce = await makePkce();
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: getRedirectUrl(),
    response_mode: "query",
    scope: `${resource}/user_impersonation offline_access openid profile`,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  });
  if (prompt) params.set("prompt", prompt);

  const responseUrl = await api.identity.launchWebAuthFlow({
    url: `${authority(config.tenantId)}/authorize?${params}`,
    interactive,
  });
  const query = new URL(responseUrl).searchParams;
  if (query.get("error")) {
    const err = new Error(query.get("error_description") || query.get("error"));
    err.code = query.get("error");
    throw err;
  }
  const tokenResponse = await tokenRequest(config.tenantId, new URLSearchParams({
    client_id: config.clientId,
    grant_type: "authorization_code",
    code: query.get("code"),
    redirect_uri: getRedirectUrl(),
    code_verifier: pkce.verifier,
  }));
  return writeToken(resource, tokenResponse);
}

async function signInWithOwnApp(config, resource, interactive) {
  // Silent SSO first (no window); interactive window only if allowed.
  try {
    return await webAuthFlow(config, resource, { interactive: false, prompt: "none" });
  } catch {
    if (!interactive) {
      const err = new Error("Sign-in required — open the popup to continue.");
      err.code = "signin_required";
      throw err;
    }
  }
  return webAuthFlow(config, resource, { interactive: true, prompt: "select_account" });
}

/**
 * Returns a valid access token for `resource` (an origin such as
 * "https://org.crm.dynamics.com" or the global discovery host).
 * Only works when the user has configured their own Entra app.
 */
export async function getToken(resource, { interactive = false } = {}) {
  resource = resourceOrigin(resource);
  const cfg = await getConfig();
  const { auth, tokens } = await readAll();

  if (!cfg.hasOwnApp) {
    const err = new Error(
      "No token source — open a signed-in org tab, or configure an Entra app in Options."
    );
    err.code = "no_session";
    throw err;
  }

  const cached = tokens[resource];
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  if (auth.refreshToken) {
    try {
      const tokenResponse = await tokenRequest(cfg.tenantId, new URLSearchParams({
        client_id: cfg.clientId,
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        scope: `${resource}/user_impersonation offline_access openid profile`,
      }));
      return await writeToken(resource, tokenResponse);
    } catch {
      // fall through to a fresh sign-in
    }
  }

  return signInWithOwnApp(cfg, resource, interactive);
}

export async function getAuthStatus() {
  const { auth } = await readAll();
  return { signedIn: Boolean(auth.refreshToken) };
}

export async function signOut() {
  // Clears the fallback app's tokens. (Does not sign the user out of
  // Microsoft in their other tabs.)
  await api.storage.local.remove(["auth", "tokens", "harvested"]);
}
