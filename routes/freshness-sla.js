/**
 * Phase 68.5: Freshness SLA routes.
 */
import {
  registerAsset,
  recordRefresh,
  computeAge,
  listStaleAssets,
  alertOnStale,
} from "../lib/freshness-sla.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "freshness-sla error");
}

export function mountFreshnessSlaRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/freshness/assets", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await registerAsset(req.body || {});
      return res.status(201).json({ _version: 1, asset: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/freshness/assets/:id/refresh", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await recordRefresh(req.params.id, req.body || {});
      return res.json({ _version: 1, asset: rec });
    } catch (err) {
      const status = String(err?.message || "").startsWith("unknown asset") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/freshness/assets/:id/age", log, auth, scope("read"), async (req, res) => {
    try {
      const r = await computeAge(req.params.id);
      return res.json({ _version: 1, age: r });
    } catch (err) {
      const status = String(err?.message || "").startsWith("unknown asset") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/freshness/stale", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listStaleAssets();
      return res.json({ _version: 1, stale: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/freshness/alerts", log, auth, scope("write"), async (_req, res) => {
    try {
      const alerts = await alertOnStale();
      return res.status(201).json({ _version: 1, alerts, count: alerts.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountFreshnessSlaRoutes;
