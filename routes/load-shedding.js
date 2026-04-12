/**
 * Route module: load shedding (Phase 59.2).
 *
 * GET    /api/v1/load-shedding/stats        — current in-flight + shed stats
 * GET    /api/v1/load-shedding/config       — current policy
 * POST   /api/v1/load-shedding/config       — update policy
 * GET    /api/v1/load-shedding/events       — recent shed events
 * POST   /api/v1/load-shedding/simulate     — dry-run admission decision
 * POST   /api/v1/load-shedding/reset        — reset counters (admin tests)
 *
 * All routes require an admin-scoped API key.
 */

import {
  admit,
  configureShedding,
  getConfig,
  getShedStats,
  getShedEvents,
  resetShedding,
  PRIORITY_LABELS,
} from "../lib/load-shedding.js";

export function mountLoadSheddingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // GET /api/v1/load-shedding/stats
  apiRoute("get", "/load-shedding/stats", adminAuth, logRequest, async (req, res) => {
    try {
      const stats = getShedStats();
      res.json({
        ...stats,
        priorityLabels: PRIORITY_LABELS,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/load-shedding/config
  apiRoute("get", "/load-shedding/config", adminAuth, logRequest, async (req, res) => {
    try {
      res.json(getConfig());
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/load-shedding/config
  apiRoute("post", "/load-shedding/config", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const updated = configureShedding(body);
      res.json(updated);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // GET /api/v1/load-shedding/events
  apiRoute("get", "/load-shedding/events", adminAuth, logRequest, async (req, res) => {
    try {
      const limit = Number(req.query?.limit) || 100;
      const events = await getShedEvents(limit);
      res.json({ events });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/load-shedding/simulate
  apiRoute("post", "/load-shedding/simulate", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const priority = body.priority != null ? Number(body.priority) : 2;
      const decision = admit(priority, body.context || {});
      // Immediately release so simulate doesn't leak counters.
      if (decision.admitted && typeof decision.release === "function") {
        decision.release();
      }
      res.json({
        admitted: decision.admitted,
        priority: decision.priority,
        label: decision.label,
        reason: decision.reason || null,
        event: decision.event || null,
      });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/load-shedding/reset
  apiRoute("post", "/load-shedding/reset", adminAuth, logRequest, async (req, res) => {
    try {
      resetShedding();
      res.json({ reset: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountLoadSheddingRoutes;
