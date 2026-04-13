/**
 * Route module: hash-based detection (Phase 67.1 — interface stub).
 *
 * The routes only expose provider registration metadata and check dispatch.
 * No actual hash lists are stored or transmitted by this module.
 *
 * POST   /api/v1/hash-detection/providers    — registerProvider metadata
 * GET    /api/v1/hash-detection/providers    — listProviders
 * POST   /api/v1/hash-detection/check        — checkHash against providers
 */
import {
  registerProvider,
  listProviders,
  checkHash,
} from "../lib/hash-detection.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (err?.code === "INVALID_INPUT") return { status: 400, code: "INVALID_INPUT" };
  if (/required/i.test(err?.message || "") || /invalid/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountHashDetectionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // Registration via HTTP is metadata only — operators provide the check() impl
  // programmatically at server bootstrap. The route records metadata so the
  // registry can be listed.
  apiRoute("post", "/hash-detection/providers", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.id) return apiError(res, 400, "INVALID_INPUT", "id is required");
      // No-op check fn — HTTP path cannot register executable code safely.
      const stubCheck = async () => ({ match: false, reason: "http_registered_without_impl" });
      const rec = await registerProvider(body.id, { check: stubCheck }, {
        name: body.name,
        description: body.description,
        kinds: body.kinds,
        algorithms: body.algorithms,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/hash-detection/providers", adminAuth, logRequest, async (req, res) => {
    try {
      const providers = await listProviders();
      res.json({ providers });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/hash-detection/check", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await checkHash(body.hash, body.kind, {
        providerId: body.providerId,
        algorithm: body.algorithm,
        metadata: body.metadata,
      });
      res.json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountHashDetectionRoutes;
