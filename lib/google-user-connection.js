/**
 * Per-user Google Workspace connection (Gmail + Calendar).
 * Tokens live in the secrets store under scope type "user".
 * The process env token remains a fallback for a single operator.
 */
import { randomBytes } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { setSecret, getSecretValue, deleteSecret } from "./secrets-store.js";

export const GOOGLE_USER_SECRET_NAME = "google_workspace_oauth";
const STATE_TTL_MS = 10 * 60 * 1000;

const READONLY_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
  "email",
];

const WRITE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];

export function googleOauthClientConfigured() {
  return Boolean(
    (process.env.GOOGLE_CLIENT_ID || "").trim() && (process.env.GOOGLE_CLIENT_SECRET || "").trim(),
  );
}

/** Write scopes stay off unless an operator opts in. */
export function googleWorkspaceScopes() {
  const scopes = [...READONLY_SCOPES];
  if (process.env.GOOGLE_WORKSPACE_WRITE_SCOPES === "1") scopes.push(...WRITE_SCOPES);
  return scopes;
}

export function googleWorkspaceToolsEnabled() {
  return (
    process.env.AGENT_GOOGLE_WORKSPACE === "1" ||
    Boolean((process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN || "").trim()) ||
    googleOauthClientConfigured()
  );
}

export function userScopeId(userId) {
  const id = String(userId || "").trim();
  if (!id || id === "anonymous") return null;
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || null;
}

function statePath() {
  return join(getDataDir(), "google-oauth-states.json");
}

export function googleWorkspaceCallbackUrl() {
  const explicit = (process.env.GOOGLE_WORKSPACE_CALLBACK_URL || "").trim();
  if (explicit) return explicit;
  const base = (process.env.BASE_URL || process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const path = "/api/v1/google/workspace/callback";
  if (base) return `${base}${path}`;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}${path}`;
}

export async function createConnectState(userId) {
  const scopeId = userScopeId(userId);
  if (!scopeId) {
    const err = new Error("Sign in before connecting Google Workspace");
    err.code = "AUTH_REQUIRED";
    throw err;
  }
  const state = randomBytes(24).toString("hex");
  const path = statePath();
  const now = Date.now();
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, { states: {} });
    const states = store.states && typeof store.states === "object" ? store.states : {};
    for (const [key, row] of Object.entries(states)) {
      if (!row || row.expiresAt < now) delete states[key];
    }
    states[state] = { userId: scopeId, expiresAt: now + STATE_TTL_MS };
    await writeJsonPath(path, { states });
  });
  return state;
}

export async function consumeConnectState(state) {
  if (!state || typeof state !== "string" || state.length > 200) return null;
  const path = statePath();
  let found = null;
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, { states: {} });
    const states = store.states && typeof store.states === "object" ? store.states : {};
    const row = states[state];
    delete states[state];
    await writeJsonPath(path, { states });
    if (row && row.expiresAt >= Date.now() && row.userId) found = row;
  });
  return found;
}

export function buildGoogleAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    redirect_uri: googleWorkspaceCallbackUrl(),
    response_type: "code",
    scope: googleWorkspaceScopes().join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeAuthorizationCode(code, fetchImpl = globalThis.fetch) {
  const body = new URLSearchParams({
    code: String(code || ""),
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    redirect_uri: googleWorkspaceCallbackUrl(),
    grant_type: "authorization_code",
  });
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const err = new Error(json.error_description || json.error || `Token exchange failed (${res.status})`);
    err.code = "GOOGLE_TOKEN_EXCHANGE_FAILED";
    throw err;
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || "",
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: json.scope || googleWorkspaceScopes().join(" "),
    email: "",
  };
}

async function fetchGoogleEmail(accessToken, fetchImpl) {
  try {
    const res = await fetchImpl("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return "";
    const json = await res.json();
    return typeof json.email === "string" ? json.email.slice(0, 200) : "";
  } catch {
    return "";
  }
}

export async function saveUserGoogleConnection(userId, connection) {
  const scopeId = userScopeId(userId);
  if (!scopeId) {
    const err = new Error("Sign in before connecting Google Workspace");
    err.code = "AUTH_REQUIRED";
    throw err;
  }
  const accessToken = String(connection?.accessToken || "").trim();
  if (!accessToken || accessToken.length > 4096) {
    const err = new Error("accessToken is required");
    err.code = "INVALID_INPUT";
    throw err;
  }
  const payload = {
    accessToken,
    refreshToken: String(connection.refreshToken || "").trim().slice(0, 4096),
    expiresAt: Number(connection.expiresAt) || 0,
    email: String(connection.email || "").slice(0, 200),
    scope: String(connection.scope || "").slice(0, 1000),
    updatedAt: Date.now(),
  };
  await setSecret("user", scopeId, GOOGLE_USER_SECRET_NAME, JSON.stringify(payload), "Google Workspace OAuth");
  return publicStatus(payload, "user");
}

export async function getUserGoogleConnection(userId) {
  const scopeId = userScopeId(userId);
  if (!scopeId) return null;
  const raw = await getSecretValue("user", scopeId, GOOGLE_USER_SECRET_NAME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.accessToken !== "string" || !parsed.accessToken.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function deleteUserGoogleConnection(userId) {
  const scopeId = userScopeId(userId);
  if (!scopeId) return { deleted: false };
  return deleteSecret("user", scopeId, GOOGLE_USER_SECRET_NAME);
}

function publicStatus(record, source) {
  return {
    connected: true,
    source,
    email: record?.email || null,
    expiresAt: record?.expiresAt || null,
    scope: record?.scope || "",
  };
}

async function refreshIfNeeded(userId, record, fetchImpl) {
  if (!record.refreshToken || !googleOauthClientConfigured()) return record;
  const skew = 60_000;
  if (record.expiresAt && record.expiresAt - skew > Date.now()) return record;
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: record.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) return record;
  const next = {
    ...record,
    accessToken: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: json.scope || record.scope,
  };
  await saveUserGoogleConnection(userId, next);
  return next;
}

/**
 * User secret first, then GOOGLE_WORKSPACE_ACCESS_TOKEN.
 * Never returns the refresh token.
 * @returns {Promise<{ token: string, source: "user"|"env", email: string|null, expiresAt: number|null, scope: string } | null>}
 */
export async function resolveGoogleAccessToken(userId, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (userId) {
    const record = await getUserGoogleConnection(userId);
    if (record?.accessToken) {
      const fresh = await refreshIfNeeded(userId, record, fetchImpl);
      return {
        token: fresh.accessToken,
        source: "user",
        email: fresh.email || null,
        expiresAt: fresh.expiresAt || null,
        scope: fresh.scope || "",
      };
    }
  }
  const env = (process.env.GOOGLE_WORKSPACE_ACCESS_TOKEN || "").trim();
  if (!env) return null;
  return { token: env, source: "env", email: null, expiresAt: null, scope: "" };
}

export async function googleConnectionStatus(userId, opts = {}) {
  const resolved = await resolveGoogleAccessToken(userId, opts);
  if (!resolved) {
    return {
      connected: false,
      source: null,
      email: null,
      expiresAt: null,
      oauthConfigured: googleOauthClientConfigured(),
      writeScopesEnabled: process.env.GOOGLE_WORKSPACE_WRITE_SCOPES === "1",
    };
  }
  const status = publicStatus(
    { email: resolved.email, expiresAt: resolved.expiresAt, scope: resolved.scope },
    resolved.source,
  );
  if (resolved.source !== "user") {
    status.email = null;
    status.expiresAt = null;
  }
  status.oauthConfigured = googleOauthClientConfigured();
  status.writeScopesEnabled = process.env.GOOGLE_WORKSPACE_WRITE_SCOPES === "1";
  return status;
}

export async function completeOauthCallback({ code, state, fetchImpl = globalThis.fetch }) {
  const row = await consumeConnectState(state);
  if (!row) {
    const err = new Error("OAuth state is missing or expired");
    err.code = "INVALID_STATE";
    throw err;
  }
  const tokens = await exchangeAuthorizationCode(code, fetchImpl);
  tokens.email = await fetchGoogleEmail(tokens.accessToken, fetchImpl);
  const saved = await saveUserGoogleConnection(row.userId, tokens);
  return { userId: row.userId, ...saved };
}
