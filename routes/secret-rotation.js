/**
 * Phase 36.2: Secret rotation admin routes.
 *
 * All routes are admin-only. Mounted under /api/v1 (with legacy /api mirror)
 * via the standard apiRoute() helper from server.js.
 *
 *   POST   /secrets/:id/rotate     - manually rotate a secret now
 *   GET    /secrets/rotations      - list scheduled rotations
 *   POST   /secrets/rotations      - schedule a new rotation
 *   DELETE /secrets/rotations/:id  - unschedule a rotation
 *   GET    /secrets/:id/history    - rotation history for a secret
 */
import {
  rotateSecret,
  scheduleRotation,
  unscheduleRotation,
  listPendingRotations,
  getRotationHistory,
} from "../lib/secret-rotation-auto.js";

const VALID_PROVIDERS = new Set(["vault", "aws", "local"]);
const VALID_STRATEGIES = new Set(["dual-key", "cutover"]);

export function mountSecretRotationRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, logRequest } = deps;

  apiRoute("post", "/secrets/:id/rotate", adminAuth, logRequest, async (req, res) => {
    try {
      const secretId = String(req.params.id || "").trim();
      if (!secretId) {
        return apiError(res, 400, "INVALID_INPUT", "secret id required", null);
      }
      const body = req.body || {};
      const provider = body.provider || "local";
      const strategy = body.strategy || "dual-key";
      if (!VALID_PROVIDERS.has(provider)) {
        return apiError(res, 400, "INVALID_INPUT", `Invalid provider "${provider}"`, "Use vault, aws, or local.");
      }
      if (!VALID_STRATEGIES.has(strategy)) {
        return apiError(res, 400, "INVALID_INPUT", `Invalid strategy "${strategy}"`, "Use dual-key or cutover.");
      }
      const result = await rotateSecret(secretId, {
        provider,
        strategy,
        graceMs: body.graceMs,
        notify: Array.isArray(body.notify) ? body.notify : undefined,
      });
      // Do NOT return the raw secret value in the API response — only metadata.
      const { newValue, ...safe } = result;
      res.json(safe);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/secrets/rotations", adminAuth, logRequest, async (req, res) => {
    try {
      const items = await listPendingRotations();
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/secrets/rotations", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const secretId = String(body.secretId || "").trim();
      const cron = String(body.cron || "").trim();
      if (!secretId) {
        return apiError(res, 400, "INVALID_INPUT", "secretId required", null);
      }
      if (!cron) {
        return apiError(res, 400, "INVALID_INPUT", "cron required", null);
      }
      const provider = body.provider || "local";
      const strategy = body.strategy || "dual-key";
      if (!VALID_PROVIDERS.has(provider)) {
        return apiError(res, 400, "INVALID_INPUT", `Invalid provider "${provider}"`, null);
      }
      if (!VALID_STRATEGIES.has(strategy)) {
        return apiError(res, 400, "INVALID_INPUT", `Invalid strategy "${strategy}"`, null);
      }
      const entry = await scheduleRotation(secretId, cron, {
        provider,
        strategy,
        graceMs: body.graceMs,
        notify: Array.isArray(body.notify) ? body.notify : undefined,
        enabled: body.enabled,
      });
      res.status(201).json(entry);
    } catch (err) {
      if (/required|invalid/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message, null);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/secrets/rotations/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const secretId = String(req.params.id || "").trim();
      if (!secretId) {
        return apiError(res, 400, "INVALID_INPUT", "secret id required", null);
      }
      const removed = await unscheduleRotation(secretId);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Rotation schedule not found", null);
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/secrets/:id/history", adminAuth, logRequest, async (req, res) => {
    try {
      const secretId = String(req.params.id || "").trim();
      if (!secretId) {
        return apiError(res, 400, "INVALID_INPUT", "secret id required", null);
      }
      const items = await getRotationHistory(secretId);
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}

export default mountSecretRotationRoutes;
