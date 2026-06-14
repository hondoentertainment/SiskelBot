/**
 * OIDC (OpenID Connect) integration using undici for HTTP requests.
 * Implements OIDC Discovery, token exchange, and userinfo fetching.
 * No heavy dependencies — uses undici (already in deps) for all HTTP.
 *
 * Env vars:
 *   OIDC_ISSUER         — OIDC discovery URL (e.g. https://accounts.google.com)
 *   OIDC_CLIENT_ID      — Client ID
 *   OIDC_CLIENT_SECRET   — Client secret
 *   OIDC_REDIRECT_URI   — Callback URL (e.g. https://myapp.com/auth/oidc/callback)
 *   OIDC_SCOPES          — Space-separated scopes (default: openid profile email)
 */
import { request as undiciRequest } from "undici";
import { randomBytes } from "crypto";
import { Strategy as CustomStrategy } from "passport-strategy";

/** @typedef {{ issuer: string, authorization_endpoint: string, token_endpoint: string, userinfo_endpoint: string, jwks_uri: string }} OIDCDiscoveryDoc */

let _discoveryCache = null;
let _discoveryCacheIssuer = null;

/**
 * Fetch OIDC discovery document from issuer.
 * @param {string} issuer
 * @returns {Promise<OIDCDiscoveryDoc>}
 */
export async function discoverOIDC(issuer) {
  if (_discoveryCache && _discoveryCacheIssuer === issuer) return _discoveryCache;

  const url = issuer.replace(/\/$/, "") + "/.well-known/openid-configuration";
  const { statusCode, body } = await undiciRequest(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (statusCode !== 200) {
    const text = await body.text();
    throw new Error(`OIDC discovery failed (${statusCode}): ${text.slice(0, 200)}`);
  }
  const doc = await body.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error("OIDC discovery document missing required endpoints");
  }
  _discoveryCache = doc;
  _discoveryCacheIssuer = issuer;
  return doc;
}

/**
 * Exchange authorization code for tokens.
 * @param {OIDCDiscoveryDoc} discovery
 * @param {{ clientId: string, clientSecret: string, redirectUri: string, code: string }} opts
 * @returns {Promise<{ access_token: string, id_token?: string, token_type: string }>}
 */
export async function exchangeCode(discovery, { clientId, clientSecret, redirectUri, code }) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const { statusCode, body } = await undiciRequest(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params.toString(),
  });
  if (statusCode !== 200) {
    const text = await body.text();
    throw new Error(`OIDC token exchange failed (${statusCode}): ${text.slice(0, 200)}`);
  }
  return body.json();
}

/**
 * Fetch userinfo from OIDC provider.
 * @param {OIDCDiscoveryDoc} discovery
 * @param {string} accessToken
 * @returns {Promise<Record<string,any>>}
 */
export async function fetchUserinfo(discovery, accessToken) {
  if (!discovery.userinfo_endpoint) throw new Error("OIDC provider has no userinfo_endpoint");
  const { statusCode, body } = await undiciRequest(discovery.userinfo_endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (statusCode !== 200) {
    const text = await body.text();
    throw new Error(`OIDC userinfo failed (${statusCode}): ${text.slice(0, 200)}`);
  }
  return body.json();
}

/**
 * Decode JWT payload without verification (for extracting claims from id_token).
 * For production, you should verify the signature against JWKS.
 * @param {string} jwt
 * @returns {Record<string,any>}
 */
export function decodeJwtPayload(jwt) {
  if (!jwt || typeof jwt !== "string") throw new Error("Invalid JWT");
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT structure");
  const payload = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(payload);
}

/**
 * Map OIDC claims (from id_token or userinfo) to internal user model.
 * @param {Record<string,any>} claims
 * @returns {{ id: string, displayName: string, email: string|null, provider: 'oidc' }}
 */
export function mapOIDCClaimsToUser(claims) {
  const id = claims.sub || claims.id;
  if (!id) throw new Error("OIDC claims missing sub/id");
  return {
    id: String(id),
    displayName: claims.name || claims.preferred_username || claims.email || String(id),
    email: claims.email || null,
    provider: "oidc",
  };
}

/**
 * Parse and validate OIDC configuration from env or explicit options.
 * @param {Record<string,string>} [opts] — override env
 * @returns {{ issuer: string, clientId: string, clientSecret: string, redirectUri: string, scopes: string } | null}
 */
export function configureOIDC(opts = {}) {
  const issuer = opts.issuer || process.env.OIDC_ISSUER;
  const clientId = opts.clientId || process.env.OIDC_CLIENT_ID;
  const clientSecret = opts.clientSecret || process.env.OIDC_CLIENT_SECRET;
  const redirectUri = opts.redirectUri || process.env.OIDC_REDIRECT_URI;
  const scopes = opts.scopes || process.env.OIDC_SCOPES || "openid profile email";

  if (!issuer || !clientId || !clientSecret) return null;

  return { issuer, clientId, clientSecret, redirectUri: redirectUri || "/auth/oidc/callback", scopes };
}

/**
 * Check if OIDC is configured via env vars.
 */
export function isOIDCConfigured() {
  return Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET);
}

/**
 * Create a Passport-compatible strategy for OIDC.
 * Uses custom strategy that redirects to authorization_endpoint and handles callback.
 * @param {ReturnType<typeof configureOIDC>} config
 * @returns {CustomStrategy}
 */
export function createOIDCStrategy(config) {
  if (!config) throw new Error("OIDC config required");

  const strategy = new CustomStrategy();
  strategy.name = "oidc";

  strategy.authenticate = async function (req, _options) {
    try {
      const discovery = await discoverOIDC(config.issuer);

      // If callback with code, exchange it
      if (req.query?.code) {
        const tokens = await exchangeCode(discovery, {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri: config.redirectUri,
          code: req.query.code,
        });

        let claims = {};
        // Try id_token first, then userinfo
        if (tokens.id_token) {
          try {
            claims = decodeJwtPayload(tokens.id_token);
          } catch {
            // fallback to userinfo
          }
        }
        if (!claims.sub && tokens.access_token && discovery.userinfo_endpoint) {
          claims = await fetchUserinfo(discovery, tokens.access_token);
        }

        const user = mapOIDCClaimsToUser(claims);
        return this.success(user);
      }

      // Initial request — redirect to authorization endpoint
      const state = randomBytes(16).toString("hex");
      if (req.session) req.session._oidcState = state;

      const params = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scopes,
        state,
      });
      return this.redirect(`${discovery.authorization_endpoint}?${params.toString()}`);
    } catch (err) {
      return this.error(err);
    }
  };

  return strategy;
}

/**
 * Reset discovery cache (for tests).
 */
export function _resetDiscoveryCache() {
  _discoveryCache = null;
  _discoveryCacheIssuer = null;
}
