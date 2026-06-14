/**
 * Phase 61.2: Webhook inspector routes.
 *
 * GET    /api/v1/webhook-inspector/deliveries    — list recent DLQ + probes
 * POST   /api/v1/webhook-inspector/probes        — record a probe
 * GET    /api/v1/webhook-inspector/probes        — list probes
 * DELETE /api/v1/webhook-inspector/probes        — clear probes
 * POST   /api/v1/webhook-inspector/replay        — replay (by id or url/payload)
 * GET    /api/v1/webhook-inspector/replays       — list replay history
 *
 * All routes require admin auth.
 */
import {
  listDeliveries,
  replayDelivery,
  recordProbe,
  listProbes,
  clearProbes,
  listReplays,
} from "../lib/webhook-inspector.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountWebhookInspectorRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // GET /webhook-inspector/deliveries
  apiRoute("get", "/webhook-inspector/deliveries", adminAuth, logRequest, async (req, res) => {
    try {
      const items = await listDeliveries({
        limit: Number(req.query?.limit) || 100,
        source: req.query?.source ? String(req.query.source) : "all",
        url: req.query?.url ? String(req.query.url) : undefined,
      });
      res.json({ items });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /webhook-inspector/probes
  apiRoute("post", "/webhook-inspector/probes", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.url) return apiError(res, 400, "INVALID_INPUT", "url is required");
      const probe = await recordProbe({
        url: body.url,
        payload: body.payload,
        result: body.result,
        source: body.source,
      });
      res.status(201).json(probe);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /webhook-inspector/probes
  apiRoute("get", "/webhook-inspector/probes", adminAuth, logRequest, async (req, res) => {
    try {
      const items = await listProbes(Number(req.query?.limit) || 50);
      res.json({ items });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // DELETE /webhook-inspector/probes
  apiRoute("delete", "/webhook-inspector/probes", adminAuth, logRequest, async (_req, res) => {
    try {
      await clearProbes();
      res.json({ ok: true });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /webhook-inspector/replay
  apiRoute("post", "/webhook-inspector/replay", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.id && !body.url) {
        return apiError(res, 400, "INVALID_INPUT", "either id or url is required");
      }
      const replay = await replayDelivery({
        id: body.id,
        url: body.url,
        payload: body.payload,
        secret: body.secret,
        retries: body.retries,
      });
      res.json(replay);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /webhook-inspector/replays
  apiRoute("get", "/webhook-inspector/replays", adminAuth, logRequest, async (req, res) => {
    try {
      const items = await listReplays(Number(req.query?.limit) || 50);
      res.json({ items });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountWebhookInspectorRoutes;
