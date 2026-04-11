/**
 * Phase 70.2: High-contrast theme routes.
 */
import {
  computeContrast,
  suggestPairs,
  listThemes,
  createTheme,
  getTheme,
} from "../lib/high-contrast-themes.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "high-contrast-themes error");
}

export function mountHighContrastThemesRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/themes/contrast", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.fg || !body.bg) return apiError(res, 400, "INVALID_INPUT", "fg and bg are required");
      const ratio = computeContrast(body.fg, body.bg);
      return res.json({ _version: 1, ratio });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/themes/suggest-pairs", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const colors = Array.isArray(body.colors) ? body.colors : [];
      const minRatio = Number.isFinite(body.minRatio) ? body.minRatio : undefined;
      const pairs = suggestPairs(colors, { minRatio });
      return res.json({ _version: 1, pairs, count: pairs.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/themes", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await createTheme(req.body || {});
      return res.status(201).json({ _version: 1, theme: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/themes", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listThemes();
      return res.json({ _version: 1, themes: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/themes/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const rec = await getTheme(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "theme not found");
      return res.json({ _version: 1, theme: rec });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountHighContrastThemesRoutes;
