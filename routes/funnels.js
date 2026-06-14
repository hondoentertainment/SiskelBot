/**
 * Route module: Conversion funnel tracking (Phase 39.2).
 *
 * GET    /api/v1/analytics/funnels                  - list funnels
 * POST   /api/v1/analytics/funnels                  - define a funnel
 * GET    /api/v1/analytics/funnels/:id              - get funnel definition
 * DELETE /api/v1/analytics/funnels/:id              - delete a funnel
 * GET    /api/v1/analytics/funnels/:id/stats        - aggregate funnel stats (?from=&to=)
 * GET    /api/v1/analytics/funnels/:id/dropoff      - dropoff users (?step=2)
 * POST   /api/v1/analytics/funnels/:id/event        - track a custom event for the funnel
 */

import {
  defineFunnel,
  trackFunnelEvent,
  getFunnelStats,
  getFunnelPathForUser,
  listFunnels,
  deleteFunnel,
  getDropoffUsers,
  getFunnel,
  seedPredefinedFunnels,
} from "../lib/funnel-tracker.js";

export function mountFunnelRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // GET /api/v1/analytics/funnels
  apiRoute(
    "get",
    "/analytics/funnels",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = req.query?.workspace || undefined;
        if (req.query?.seed === "1") {
          await seedPredefinedFunnels(workspace || "default");
        }
        const funnels = await listFunnels(workspace);
        res.json({ funnels, count: funnels.length });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // POST /api/v1/analytics/funnels
  apiRoute(
    "post",
    "/analytics/funnels",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const { name, steps, description, workspaceId, windowMs } = body;
        if (!name || typeof name !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "name is required");
        }
        if (!Array.isArray(steps) || steps.length === 0) {
          return apiError(res, 400, "INVALID_INPUT", "steps must be a non-empty array");
        }
        const result = await defineFunnel(name, steps, {
          description,
          workspaceId: workspaceId || req.query?.workspace || "default",
          windowMs,
        });
        if (result?.error) {
          return apiError(res, 400, result.code || "INVALID_INPUT", result.error);
        }
        res.status(201).json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // GET /api/v1/analytics/funnels/:id/stats  (declared before /:id so it matches first)
  apiRoute(
    "get",
    "/analytics/funnels/:id/stats",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const dateRange = {};
        if (req.query?.from) dateRange.from = req.query.from;
        if (req.query?.to) dateRange.to = req.query.to;
        const result = await getFunnelStats(
          req.params.id,
          Object.keys(dateRange).length ? dateRange : undefined
        );
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // GET /api/v1/analytics/funnels/:id/dropoff?step=2
  apiRoute(
    "get",
    "/analytics/funnels/:id/dropoff",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const stepRaw = Number(req.query?.step);
        const step = Number.isFinite(stepRaw) && stepRaw > 0 ? stepRaw : 1;
        const dateRange = {};
        if (req.query?.from) dateRange.from = req.query.from;
        if (req.query?.to) dateRange.to = req.query.to;
        const result = await getDropoffUsers(
          req.params.id,
          step,
          Object.keys(dateRange).length ? dateRange : undefined
        );
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // GET /api/v1/analytics/funnels/:id/path?userId=...
  apiRoute(
    "get",
    "/analytics/funnels/:id/path",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const userId = req.query?.userId;
        if (!userId) return apiError(res, 400, "INVALID_INPUT", "userId is required");
        const result = await getFunnelPathForUser(req.params.id, String(userId));
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // POST /api/v1/analytics/funnels/:id/event
  apiRoute(
    "post",
    "/analytics/funnels/:id/event",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const { userId, event, metadata } = body;
        if (!userId) return apiError(res, 400, "INVALID_INPUT", "userId is required");
        if (!event) return apiError(res, 400, "INVALID_INPUT", "event is required");
        // Verify funnel exists so the route is meaningful.
        const funnel = await getFunnel(req.params.id);
        if (funnel?.error) {
          return apiError(res, 404, funnel.code || "NOT_FOUND", funnel.error);
        }
        const result = await trackFunnelEvent(String(userId), String(event), metadata || {});
        if (result?.error) {
          return apiError(res, 400, result.code || "INVALID_INPUT", result.error);
        }
        res.status(201).json({ ...result, funnelId: req.params.id });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // GET /api/v1/analytics/funnels/:id  (must be after /:id/stats and /:id/dropoff)
  apiRoute(
    "get",
    "/analytics/funnels/:id",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const result = await getFunnel(req.params.id);
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // DELETE /api/v1/analytics/funnels/:id
  apiRoute(
    "delete",
    "/analytics/funnels/:id",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const result = await deleteFunnel(req.params.id);
        if (result?.error) {
          const status = result.code === "NOT_FOUND" ? 404 : 400;
          return apiError(res, status, result.code, result.error);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );
}

export default mountFunnelRoutes;
