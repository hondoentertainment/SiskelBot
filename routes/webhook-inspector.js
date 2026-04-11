/**
 * Phase 61.2: Webhook inspector routes.
 *
 * POST /api/v1/webhook-inspector/capture   -- body { url, event, body, headers, ... }
 * GET  /api/v1/webhook-inspector/deliveries
 * POST /api/v1/webhook-inspector/filter    -- body { event?, direction?, ... }
 * POST /api/v1/webhook-inspector/replay/:id -- body { overrideUrl? }
 * DELETE /api/v1/webhook-inspector/deliveries/:id -- admin only
 * DELETE /api/v1/webhook-inspector/deliveries     -- admin only (clear all)
 */
import {
  captureDelivery,
  listDeliveries,
  replayDelivery,
  filterDeliveries,
  clearCapture,
  listReplays,
} from "../lib/webhook-inspector.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "webhook-inspector error");
}

export function mountWebhookInspectorRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/webhook-inspector/capture", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const delivery = await captureDelivery(body);
      return res.status(201).json({ _version: 1, delivery });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/webhook-inspector/deliveries", log, auth, scope("read"), async (_req, res) => {
    try {
      const deliveries = await listDeliveries();
      return res.json({ _version: 1, deliveries, count: deliveries.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/webhook-inspector/filter", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const deliveries = await filterDeliveries(body);
      return res.json({ _version: 1, deliveries, count: deliveries.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/webhook-inspector/replay/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const replay = await replayDelivery(req.params.id, {
        overrideUrl: typeof body.overrideUrl === "string" ? body.overrideUrl : undefined,
      });
      return res.json({ _version: 1, replay });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/webhook-inspector/replays/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const replays = await listReplays(req.params.id);
      return res.json({ _version: 1, replays, count: replays.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/webhook-inspector/deliveries/:id", log, admin, async (req, res) => {
    try {
      const result = await clearCapture(req.params.id);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/webhook-inspector/deliveries", log, admin, async (_req, res) => {
    try {
      const result = await clearCapture();
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountWebhookInspectorRoutes;
