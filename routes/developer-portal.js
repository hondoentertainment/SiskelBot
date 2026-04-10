/**
 * Phase 34.4: Developer portal routes.
 *
 * Self-service developer signup, verification, API key management, usage,
 * and tier upgrades. Register/verify endpoints are intentionally public
 * (no auth required). All other endpoints require the developer to supply
 * an "x-developer-id" header (issued at registration) and will return 404
 * for unknown developers.
 *
 * Endpoints:
 *   POST   /api/v1/developer/register       — register a new developer
 *   POST   /api/v1/developer/verify         — verify email with token
 *   GET    /api/v1/developer/me             — current developer profile
 *   GET    /api/v1/developer/keys           — list keys (masked)
 *   POST   /api/v1/developer/keys           — create key
 *   DELETE /api/v1/developer/keys/:keyId    — revoke key
 *   GET    /api/v1/developer/usage          — usage stats
 *   POST   /api/v1/developer/upgrade        — upgrade tier
 */

import {
  DEVELOPER_TIERS,
  registerDeveloper,
  verifyDeveloper,
  getDeveloper,
  createDeveloperKey,
  listDeveloperKeys,
  revokeDeveloperKey,
  getDeveloperUsage,
  upgradeDeveloperTier,
} from "../lib/developer-keys.js";

function extractDeveloperId(req) {
  return (
    req.headers["x-developer-id"] ||
    req.query?.developerId ||
    req.body?.developerId ||
    null
  );
}

export function mountDeveloperPortalRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;

  // Public: POST /api/v1/developer/register
  apiRoute("post", "/developer/register", logRequest, async (req, res) => {
    try {
      const { email, name } = req.body || {};
      const result = await registerDeveloper(email, name);
      if (!result.ok) {
        return apiError(res, 400, "REGISTRATION_FAILED", result.error);
      }
      return res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // Public: POST /api/v1/developer/verify
  apiRoute("post", "/developer/verify", logRequest, async (req, res) => {
    try {
      const { developerId, token } = req.body || {};
      const result = await verifyDeveloper(developerId, token);
      if (!result.ok) {
        return apiError(res, 400, "VERIFICATION_FAILED", result.error);
      }
      return res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/developer/me
  apiRoute("get", "/developer/me", logRequest, async (req, res) => {
    try {
      const developerId = extractDeveloperId(req);
      if (!developerId) return apiError(res, 401, "AUTH_REQUIRED", "Provide x-developer-id header.");
      const dev = await getDeveloper(developerId);
      if (!dev) return apiError(res, 404, "NOT_FOUND", "Developer not found.");
      const tierConfig = DEVELOPER_TIERS[dev.tier] || DEVELOPER_TIERS.free;
      return res.json({ developer: dev, tier: { id: dev.tier, ...tierConfig } });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/developer/keys
  apiRoute("get", "/developer/keys", logRequest, async (req, res) => {
    try {
      const developerId = extractDeveloperId(req);
      if (!developerId) return apiError(res, 401, "AUTH_REQUIRED", "Provide x-developer-id header.");
      const result = await listDeveloperKeys(developerId);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", result.error);
      return res.json({ keys: result.keys });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/developer/keys
  apiRoute("post", "/developer/keys", logRequest, async (req, res) => {
    try {
      const developerId = extractDeveloperId(req);
      if (!developerId) return apiError(res, 401, "AUTH_REQUIRED", "Provide x-developer-id header.");
      const { label, tier } = req.body || {};
      const result = await createDeveloperKey(developerId, label, tier);
      if (!result.ok) {
        const status = /limit reached/i.test(result.error || "") ? 429 : 400;
        return apiError(res, status, "CREATE_KEY_FAILED", result.error);
      }
      return res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/developer/keys/:keyId
  apiRoute("delete", "/developer/keys/:keyId", logRequest, async (req, res) => {
    try {
      const developerId = extractDeveloperId(req);
      if (!developerId) return apiError(res, 401, "AUTH_REQUIRED", "Provide x-developer-id header.");
      const { keyId } = req.params;
      const result = await revokeDeveloperKey(developerId, keyId);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", result.error);
      return res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/developer/usage
  apiRoute("get", "/developer/usage", logRequest, async (req, res) => {
    try {
      const developerId = extractDeveloperId(req);
      if (!developerId) return apiError(res, 401, "AUTH_REQUIRED", "Provide x-developer-id header.");
      const period = req.query?.period || undefined;
      const result = await getDeveloperUsage(developerId, period);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", result.error);
      return res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/developer/upgrade
  apiRoute("post", "/developer/upgrade", logRequest, async (req, res) => {
    try {
      const developerId = extractDeveloperId(req);
      if (!developerId) return apiError(res, 401, "AUTH_REQUIRED", "Provide x-developer-id header.");
      const { tier } = req.body || {};
      if (!tier) return apiError(res, 400, "INVALID_INPUT", "tier is required.");
      const result = await upgradeDeveloperTier(developerId, tier);
      if (!result.ok) return apiError(res, 400, "UPGRADE_FAILED", result.error);
      return res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // Public: GET /api/v1/developer/tiers — surface available tiers for the portal UI
  apiRoute("get", "/developer/tiers", logRequest, (req, res) => {
    const tiers = Object.entries(DEVELOPER_TIERS).map(([id, cfg]) => ({
      id,
      ...cfg,
      monthlyRequests: cfg.monthlyRequests === Infinity ? null : cfg.monthlyRequests,
      maxKeysPerDeveloper: cfg.maxKeysPerDeveloper === Infinity ? null : cfg.maxKeysPerDeveloper,
    }));
    res.json({ tiers });
  });
}

export default mountDeveloperPortalRoutes;
