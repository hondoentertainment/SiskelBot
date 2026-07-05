/**
 * Microsoft Teams bot integration — Bot Framework webhook (no SDK dependency).
 *
 * Inbound: receives Bot Framework activities on the messaging endpoint,
 *          verifies the connector JWT (RS256 via the Bot Framework JWKS),
 *          forwards message text to chat completions, replies via the
 *          activity's serviceUrl.
 * Outbound: sendTeamsReply posts to {serviceUrl}/v3/conversations/... using a
 *          client-credentials token from Microsoft Entra.
 *
 * Config: TEAMS_APP_ID, TEAMS_APP_PASSWORD (Azure bot registration).
 */
import { createPublicKey, verify as cryptoVerify } from "crypto";

const TEAMS_APP_ID = process.env.TEAMS_APP_ID || "";
const TEAMS_APP_PASSWORD = process.env.TEAMS_APP_PASSWORD || "";
const OPENID_CONFIG_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const TOKEN_URL = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const EXPECTED_ISSUER = "https://api.botframework.com";
const JWKS_TTL_MS = 60 * 60 * 1000;

let _jwksCache = { keys: null, fetchedAt: 0 };
let _connectorToken = { token: null, expiresAt: 0 };

export function isTeamsConfigured() {
  return Boolean(process.env.TEAMS_APP_ID && process.env.TEAMS_APP_PASSWORD);
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function getJwks() {
  if (_jwksCache.keys && Date.now() - _jwksCache.fetchedAt < JWKS_TTL_MS) {
    return _jwksCache.keys;
  }
  const cfgRes = await fetch(OPENID_CONFIG_URL, { signal: AbortSignal.timeout(10000) });
  const cfg = await cfgRes.json();
  const jwksRes = await fetch(cfg.jwks_uri, { signal: AbortSignal.timeout(10000) });
  const jwks = await jwksRes.json();
  _jwksCache = { keys: jwks.keys || [], fetchedAt: Date.now() };
  return _jwksCache.keys;
}

/**
 * Verify a Bot Framework connector JWT (Authorization: Bearer <jwt>).
 * Checks signature (RS256 against the Bot Framework JWKS), issuer, audience
 * (must equal the bot's app id), and expiry.
 * @param {string} authHeader
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function verifyTeamsToken(authHeader) {
  const appId = process.env.TEAMS_APP_ID || TEAMS_APP_ID;
  if (!appId) return { valid: false, reason: "TEAMS_APP_ID not configured" };
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { valid: false, reason: "Missing bearer token" };
  }
  const token = authHeader.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, reason: "Malformed token" };

  let header, payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    return { valid: false, reason: "Malformed token" };
  }

  if (payload.iss !== EXPECTED_ISSUER) return { valid: false, reason: "Invalid issuer" };
  if (payload.aud !== appId) return { valid: false, reason: "Invalid audience" };
  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp + 300) {
    return { valid: false, reason: "Token expired" };
  }

  try {
    const keys = await getJwks();
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return { valid: false, reason: "Unknown signing key" };
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const ok = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], "base64url")
    );
    return ok ? { valid: true } : { valid: false, reason: "Invalid signature" };
  } catch (err) {
    return { valid: false, reason: `Verification error: ${err.message}` };
  }
}

/** Client-credentials token for calling the connector API (cached). */
async function getConnectorToken() {
  if (_connectorToken.token && Date.now() < _connectorToken.expiresAt - 60_000) {
    return _connectorToken.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.TEAMS_APP_ID || TEAMS_APP_ID,
    client_secret: process.env.TEAMS_APP_PASSWORD || TEAMS_APP_PASSWORD,
    scope: "https://api.botframework.com/.default",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Teams token error: ${data.error_description || res.status}`);
  }
  _connectorToken = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return _connectorToken.token;
}

/**
 * Reply to an activity via its serviceUrl.
 */
export async function sendTeamsReply(activity, text) {
  const serviceUrl = String(activity.serviceUrl || "").replace(/\/+$/, "");
  const conversationId = activity.conversation?.id;
  if (!serviceUrl || !conversationId) throw new Error("Activity missing serviceUrl/conversation");

  const token = await getConnectorToken();
  const url = `${serviceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activity.id || "")}`;
  const reply = {
    type: "message",
    from: activity.recipient,
    recipient: activity.from,
    conversation: activity.conversation,
    replyToId: activity.id,
    text,
    textFormat: "markdown",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(reply),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Teams reply failed: HTTP ${res.status} ${errText.slice(0, 200)}`);
  }
  return { ok: true };
}

/** Strip <at>…</at> mention tags Teams embeds in message text. */
export function stripTeamsMentions(text) {
  return String(text || "").replace(/<at>.*?<\/at>/gi, "").trim();
}

/** Forward a user message to the internal chat completions endpoint. */
async function forwardToChat(text, teamsUserId) {
  const port = process.env.PORT || 3000;
  const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  const apiKey = process.env.API_KEY || "";
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages: [{ role: "user", content: text }],
      stream: false,
      metadata: { source: "msteams", teamsUserId },
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Chat API error: HTTP ${res.status} ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "(no response)";
}

/**
 * Handle an incoming Bot Framework activity. Returns { status, body }.
 * Message activities are answered asynchronously (Teams expects a fast 200);
 * everything else is acknowledged and ignored.
 * @param {object} activity
 * @param {{ reply?: Function, forward?: Function }} [hooks] - injectable for tests
 */
export async function handleTeamsActivity(activity, hooks = {}) {
  if (!activity || typeof activity !== "object") {
    return { status: 400, body: { error: "Invalid activity" } };
  }
  if (activity.type !== "message") {
    return { status: 200, body: { ok: true, ignored: activity.type || "unknown" } };
  }

  const text = stripTeamsMentions(activity.text);
  if (!text) return { status: 200, body: { ok: true } };

  const reply = hooks.reply || sendTeamsReply;
  const forward = hooks.forward || forwardToChat;

  setImmediate(async () => {
    try {
      const answer = await forward(text, activity.from?.id);
      await reply(activity, answer);
    } catch (err) {
      console.error("[msteams-bot] Error processing activity:", err.message);
      try {
        await reply(activity, `Sorry, I encountered an error: ${err.message}`);
      } catch (_) { /* ignore */ }
    }
  });

  return { status: 200, body: { ok: true } };
}

/** Test helper — reset caches. */
export function __resetTeamsCachesForTests() {
  _jwksCache = { keys: null, fetchedAt: 0 };
  _connectorToken = { token: null, expiresAt: 0 };
}
