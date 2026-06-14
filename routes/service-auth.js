/**
 * Phase 36.1: Service-to-service auth routes.
 *
 * POST /api/v1/auth/service/token      — issue a service token (admin only)
 * POST /api/v1/auth/service/exchange   — exchange a user token for a service token
 * GET  /api/v1/auth/service/introspect — validate and decode a service token
 */
import {
  issueServiceToken,
  verifyServiceToken,
  exchangeUserTokenForServiceToken,
} from "../lib/service-tokens.js";

export function mountServiceAuthRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth, chatAuth } = deps;

  // ── POST /api/v1/auth/service/token ─ issue a service token (admin only) ──
  apiRoute("post", "/auth/service/token", adminAuth, logRequest, async (req, res) => {
    try {
      const { serviceId, scopes, ttlSeconds, audience } = req.body || {};
      if (!serviceId || typeof serviceId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "serviceId is required.");
      }
      if (!Array.isArray(scopes) || scopes.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "scopes must be a non-empty array.");
      }
      const extra = audience ? { aud: String(audience) } : {};
      const { token, payload } = issueServiceToken(serviceId, scopes, ttlSeconds, extra);
      return res.status(201).json({
        token,
        serviceId: payload.sub,
        scopes: payload.scopes,
        iat: payload.iat,
        exp: payload.exp,
        audience: payload.aud || null,
      });
    } catch (err) {
      if (/SERVICE_TOKEN_SECRET/.test(err.message)) {
        return apiError(
          res,
          503,
          "SERVICE_TOKEN_NOT_CONFIGURED",
          err.message,
          "Set SERVICE_TOKEN_SECRET to enable service tokens."
        );
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── POST /api/v1/auth/service/exchange ─ exchange a user token ────────────
  apiRoute("post", "/auth/service/exchange", chatAuth, logRequest, async (req, res) => {
    try {
      const { targetService, ttlSeconds } = req.body || {};
      if (!targetService || typeof targetService !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "targetService is required.");
      }
      const userId = req.userId || req.session?.userId || null;
      if (!userId) {
        return apiError(res, 401, "AUTH_REQUIRED", "User identity is required for token exchange.");
      }
      const scopes = req.apiKeyScopes || ["read"];
      const { token, payload } = exchangeUserTokenForServiceToken(
        { userId, scopes },
        targetService,
        ttlSeconds
      );
      return res.status(201).json({
        token,
        serviceId: payload.sub,
        scopes: payload.scopes,
        iat: payload.iat,
        exp: payload.exp,
        audience: payload.aud,
        onBehalfOf: payload.on_behalf_of || null,
      });
    } catch (err) {
      if (/SERVICE_TOKEN_SECRET/.test(err.message)) {
        return apiError(
          res,
          503,
          "SERVICE_TOKEN_NOT_CONFIGURED",
          err.message,
          "Set SERVICE_TOKEN_SECRET to enable service tokens."
        );
      }
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // ── GET /api/v1/auth/service/introspect ─ validate and decode a token ────
  apiRoute("get", "/auth/service/introspect", logRequest, async (req, res) => {
    try {
      const auth = req.headers.authorization || "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
      const headerToken = req.headers["x-service-token"];
      const token = bearer || headerToken || req.query?.token || null;
      if (!token) {
        return apiError(res, 400, "INVALID_INPUT", "token is required (Authorization: Bearer <token> or ?token=).");
      }
      const result = verifyServiceToken(String(token));
      if (!result.valid) {
        return res.status(200).json({
          active: false,
          reason: result.reason,
        });
      }
      return res.json({
        active: true,
        serviceId: result.serviceId,
        scopes: result.scopes,
        iat: result.payload.iat,
        exp: result.payload.exp,
        audience: result.payload.aud || null,
        onBehalfOf: result.payload.on_behalf_of || null,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountServiceAuthRoutes;
