/**
 * Phase 34.1: Plugin certification routes.
 *
 *   GET    /api/v1/plugins/certifications                 — list certified plugins
 *   GET    /api/v1/plugins/:packId/certification          — get a certification
 *   POST   /api/v1/plugins/:packId/certify                — certify a plugin (admin)
 *   DELETE /api/v1/plugins/:packId/certification          — revoke a certification (admin)
 *   POST   /api/v1/plugins/:packId/scan                   — run security scan
 *   GET    /api/v1/publishers                             — list publishers
 *   POST   /api/v1/publishers                             — register a publisher (admin)
 */
import {
  certifyPlugin,
  revokeCertification,
  getCertification,
  listCertifiedPlugins,
  scanPluginSecurity,
  CERT_LEVELS,
} from "../lib/plugin-certification.js";
import {
  registerPublisher,
  listPublishers,
} from "../lib/plugin-publishers.js";

export function mountPluginCertificationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    adminAuth,
    logRequest,
    marketplaceRateLimiter,
    marketplaceRegistry,
  } = deps;

  const limiter = marketplaceRateLimiter || ((req, res, next) => next());

  // GET /api/v1/plugins/certifications
  apiRoute("get", "/plugins/certifications", limiter, logRequest, async (req, res) => {
    try {
      const level = req.query?.level ? String(req.query.level) : null;
      const list = await listCertifiedPlugins(level);
      res.json({ _version: 1, certifications: list, levels: CERT_LEVELS });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  // GET /api/v1/plugins/:packId/certification
  apiRoute("get", "/plugins/:packId/certification", limiter, logRequest, async (req, res) => {
    try {
      const packId = req.params.packId;
      const cert = await getCertification(packId);
      if (!cert) {
        return apiError(res, 404, "NOT_FOUND", `No certification for pack: ${packId}`, "Certify the pack via POST /api/v1/plugins/:packId/certify.");
      }
      res.json({ _version: 1, certification: cert });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  // POST /api/v1/plugins/:packId/certify (admin)
  apiRoute("post", "/plugins/:packId/certify", limiter, adminAuth, logRequest, async (req, res) => {
    try {
      const packId = req.params.packId;
      const { level, publisher, auditUrl, certifiedBy, expiresAt } = req.body || {};
      if (!level || typeof level !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "level is required", "Send { level: 'signed'|'verified'|'certified' }.");
      }
      const result = await certifyPlugin(packId, level, { publisher, auditUrl, certifiedBy, expiresAt });
      if (!result.ok) {
        const status = result.code === "INVALID_LEVEL" || result.code === "INVALID_INPUT" ? 400 : 500;
        return apiError(res, status, result.code || "CERTIFY_FAILED", result.error, "See docs/PLUGINS.md.");
      }
      res.json({ ok: true, certification: result.certification });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  // DELETE /api/v1/plugins/:packId/certification (admin)
  apiRoute("delete", "/plugins/:packId/certification", limiter, adminAuth, logRequest, async (req, res) => {
    try {
      const packId = req.params.packId;
      const reason = req.body?.reason || req.query?.reason || null;
      const result = await revokeCertification(packId, reason);
      if (!result.ok) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code || "REVOKE_FAILED", result.error, "See docs/PLUGINS.md.");
      }
      res.json({ ok: true, certification: result.certification });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  // POST /api/v1/plugins/:packId/scan
  apiRoute("post", "/plugins/:packId/scan", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const packId = req.params.packId;
      // Allow client-supplied manifest for scanning; otherwise look up via registry
      let manifest = req.body?.manifest;
      if (!manifest || typeof manifest !== "object") {
        if (marketplaceRegistry && typeof marketplaceRegistry.get === "function") {
          manifest = marketplaceRegistry.get(packId);
        }
      }
      if (!manifest || typeof manifest !== "object") {
        return apiError(res, 404, "NOT_FOUND", `Pack not found: ${packId}`, "Provide a manifest in the body or install the pack.");
      }
      const result = await scanPluginSecurity(manifest);
      res.json({ _version: 1, packId, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  // GET /api/v1/publishers
  apiRoute("get", "/publishers", limiter, logRequest, async (req, res) => {
    try {
      const verifiedOnly = req.query?.verifiedOnly === "1" || req.query?.verifiedOnly === "true";
      const publishers = await listPublishers(verifiedOnly);
      // Strip publicKeyPEM from listings to keep payload small; full record available on detail
      const redacted = publishers.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        verified: p.verified,
        verifiedAt: p.verifiedAt,
        verificationMethod: p.verificationMethod,
        verifiedDomains: p.verifiedDomains,
        contactUrl: p.contactUrl,
        registeredAt: p.registeredAt,
      }));
      res.json({ _version: 1, publishers: redacted });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  // POST /api/v1/publishers (admin)
  apiRoute("post", "/publishers", limiter, adminAuth, logRequest, async (req, res) => {
    try {
      const result = await registerPublisher(req.body || {});
      if (!result.ok) {
        const status = result.code && result.code.startsWith("INVALID") ? 400 : 500;
        return apiError(res, status, result.code || "REGISTER_FAILED", result.error, "See docs/PLUGINS.md.");
      }
      res.json({ ok: true, publisher: result.publisher });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });
}

export default mountPluginCertificationRoutes;
