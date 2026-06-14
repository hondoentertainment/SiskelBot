/**
 * Phase 46.2: SCIM 2.0 bearer token authentication.
 *
 * SCIM endpoints are called by the identity provider (Okta, Azure AD,
 * OneLogin, Google Workspace, etc.) using a long-lived bearer token that
 * was configured at provisioning setup time. The token is shared between
 * SiskelBot and the IdP and validated with a constant-time comparison.
 *
 * Configure with the env var SCIM_BEARER_TOKEN. SCIM_BEARER_TOKEN_PREVIOUS
 * is also accepted to enable zero-downtime token rotation, mirroring the
 * API_KEY_PREVIOUS pattern used elsewhere in the codebase.
 *
 * If neither token is configured, all SCIM endpoints respond with 503
 * Service Unavailable to avoid silently allowing anonymous access.
 *
 * @module scim-auth
 */
import { timingSafeEqual } from "crypto";
import { SCIM_SCHEMAS } from "./scim.js";

/**
 * Extract a bearer token from the Authorization header.
 * @param {import("express").Request} req
 * @returns {string|null}
 */
function extractBearerToken(req) {
  const auth = req.headers?.authorization;
  if (!auth || typeof auth !== "string") return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim() || null;
}

function safeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Validate the SCIM bearer token on a request. Pure function: returns
 * { ok: true } on success or { ok: false, status, code, detail } on failure.
 *
 * @param {import("express").Request} req
 * @returns {{ok: true, deprecated?: boolean} | {ok: false, status: number, code: string, detail: string}}
 */
export function validateSCIMToken(req) {
  const expected = process.env.SCIM_BEARER_TOKEN;
  const previous = process.env.SCIM_BEARER_TOKEN_PREVIOUS;

  if (!expected && !previous) {
    return {
      ok: false,
      status: 503,
      code: "SCIM_NOT_CONFIGURED",
      detail: "SCIM is not configured. Set SCIM_BEARER_TOKEN to enable.",
    };
  }

  const token = extractBearerToken(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: "AUTH_REQUIRED",
      detail: "Missing Authorization: Bearer <token> header",
    };
  }

  if (expected && safeEquals(token, expected)) {
    return { ok: true };
  }
  if (previous && safeEquals(token, previous)) {
    return { ok: true, deprecated: true };
  }

  return {
    ok: false,
    status: 401,
    code: "INVALID_TOKEN",
    detail: "Invalid SCIM bearer token",
  };
}

/**
 * Build a SCIM-compliant error response body. Identity providers expect the
 * urn:ietf:params:scim:api:messages:2.0:Error schema.
 * @param {number} status
 * @param {string} detail
 * @param {string} [scimType]
 */
export function scimErrorBody(status, detail, scimType) {
  const body = {
    schemas: [SCIM_SCHEMAS.error],
    status: String(status),
    detail,
  };
  if (scimType) body.scimType = scimType;
  return body;
}

/**
 * Express middleware that validates the SCIM bearer token. On failure,
 * responds with the SCIM-formatted error body and the right status code.
 * @returns {import("express").RequestHandler}
 */
export function scimAuthMiddleware() {
  return function scimAuth(req, res, next) {
    const result = validateSCIMToken(req);
    if (result.ok) {
      if (result.deprecated) {
        res.setHeader("X-SCIM-Token-Deprecated", "true");
        console.warn(
          "[scim-auth] Request authenticated with SCIM_BEARER_TOKEN_PREVIOUS. Rotate IdP token.",
        );
      }
      // Tag the request so downstream handlers know it came from an IdP.
      req.scimAuthenticated = true;
      return next();
    }
    res.status(result.status);
    res.setHeader("Content-Type", "application/scim+json");
    res.json(scimErrorBody(result.status, result.detail));
  };
}
