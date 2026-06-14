/**
 * HSM management routes. Admin-only.
 */
import { getGlobalHSM, isHSMConfigured } from "../lib/hsm.js";

export function mountHSMRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, requireScope, logRequest } = deps;

  apiRoute("get", "/hsm/status", adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const hsm = getGlobalHSM();
      const keys = await hsm.listKeys().catch(() => []);
      res.json({
        provider: hsm.provider,
        configured: isHSMConfigured(),
        keyCount: keys.length,
        keys,
      });
    } catch (err) {
      return apiError(res, 500, "HSM_ERROR", err.message);
    }
  });

  apiRoute("post", "/hsm/keys", adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { keyId, keyType } = req.body || {};
      if (!keyId || typeof keyId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "keyId is required");
      }
      const hsm = getGlobalHSM();
      const result = await hsm.generateKey(keyId, keyType || "aes-256");
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "HSM_ERROR", err.message);
    }
  });

  apiRoute("get", "/hsm/keys/:keyId", adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const hsm = getGlobalHSM();
      const metadata = await hsm.getKeyMetadata(req.params.keyId);
      if (!metadata) {
        return apiError(res, 404, "NOT_FOUND", `Key not found: ${req.params.keyId}`);
      }
      res.json(metadata);
    } catch (err) {
      return apiError(res, 500, "HSM_ERROR", err.message);
    }
  });

  apiRoute("delete", "/hsm/keys/:keyId", adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const hsm = getGlobalHSM();
      const deleted = await hsm.deleteKey(req.params.keyId);
      if (!deleted) {
        return apiError(res, 404, "NOT_FOUND", `Key not found: ${req.params.keyId}`);
      }
      res.json({ ok: true, keyId: req.params.keyId });
    } catch (err) {
      return apiError(res, 500, "HSM_ERROR", err.message);
    }
  });
}

export default mountHSMRoutes;
