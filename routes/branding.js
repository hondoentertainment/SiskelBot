/**
 * Branding / white-label routes.
 *
 * GET  /api/v1/workspaces/:id/branding  — get workspace branding
 * PUT  /api/v1/workspaces/:id/branding  — set workspace branding
 */
import { getBranding, setBranding } from "../lib/white-label.js";
import { validate } from "../lib/validate.js";

export function mountBrandingRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    storageRateLimiter,
    userAuth,
    requireScope,
  } = deps;

  apiRoute("get", "/workspaces/:id/branding", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const branding = await getBranding(workspaceId);
      res.json({ _version: 1, ...branding });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to load branding.");
    }
  });

  const validateBranding = validate({
    body: { appName: "string?" },
  });

  apiRoute("put", "/workspaces/:id/branding", storageRateLimiter, userAuth, requireScope("write"), logRequest, validateBranding, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const branding = await setBranding(workspaceId, req.body || {});
      res.json({ _version: 1, ...branding });
    } catch (err) {
      if (err.message?.includes("required")) {
        return apiError(res, 400, "INVALID_INPUT", err.message, "Send { appName, primaryColor, logoUrl, faviconUrl, customCss }.");
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to save branding.");
    }
  });
}
