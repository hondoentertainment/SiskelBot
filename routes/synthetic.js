/**
 * Phase 31.3: Synthetic monitoring routes.
 *
 * GET    /api/v1/synthetic/checks                   — list all checks
 * POST   /api/v1/synthetic/checks                   — register a check
 * DELETE /api/v1/synthetic/checks/:id               — unregister a check
 * POST   /api/v1/synthetic/checks/:id/run           — manual run
 * GET    /api/v1/synthetic/checks/:id/history       — recent results
 * GET    /api/v1/synthetic/checks/:id/stats         — uptime/latency stats
 */

import { getSyntheticMonitor } from "../lib/synthetic-monitor.js";

export function mountSyntheticRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;
  const monitor = getSyntheticMonitor();

  // GET /api/v1/synthetic/checks
  apiRoute("get", "/synthetic/checks", adminAuth, logRequest, (req, res) => {
    try {
      const checks = monitor.listChecks().map((c) => {
        const stats = monitor.getCheckStats(c.id, "24h");
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          interval: c.interval,
          timeout: c.timeout,
          regions: c.regions,
          createdAt: c.createdAt,
          lastStatus: stats.lastStatus,
          lastCheckedAt: stats.lastCheckedAt,
          uptime24h: stats.uptime,
          avgDurationMs24h: stats.avgDurationMs,
        };
      });
      res.json({ checks, running: monitor.isRunning() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/synthetic/checks
  apiRoute("post", "/synthetic/checks", adminAuth, logRequest, (req, res) => {
    try {
      const body = req.body || {};
      if (!body.id || typeof body.id !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "id is required.");
      }
      if (!body.type || !["http", "tcp", "dns", "script"].includes(body.type)) {
        return apiError(res, 400, "INVALID_INPUT", "type must be http|tcp|dns|script.");
      }
      if (body.type === "script") {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "script checks can only be registered programmatically, not via HTTP.",
        );
      }
      const entry = monitor.registerCheck({
        id: body.id,
        name: body.name || body.id,
        type: body.type,
        target: body.target,
        expected: body.expected,
        interval: Number(body.interval),
        timeout: Number(body.timeout),
        regions: body.regions,
      });
      res.status(201).json(entry);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // DELETE /api/v1/synthetic/checks/:id
  apiRoute("delete", "/synthetic/checks/:id", adminAuth, logRequest, (req, res) => {
    try {
      const id = req.params.id;
      const removed = monitor.unregisterCheck(id);
      if (!removed) {
        return apiError(res, 404, "NOT_FOUND", `check "${id}" not found.`);
      }
      res.json({ ok: true, id });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/synthetic/checks/:id/run
  apiRoute("post", "/synthetic/checks/:id/run", adminAuth, logRequest, async (req, res) => {
    try {
      const id = req.params.id;
      if (!monitor.getCheck(id)) {
        return apiError(res, 404, "NOT_FOUND", `check "${id}" not found.`);
      }
      const result = await monitor.runCheck(id);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/synthetic/checks/:id/history?limit=100
  apiRoute("get", "/synthetic/checks/:id/history", adminAuth, logRequest, (req, res) => {
    try {
      const id = req.params.id;
      if (!monitor.getCheck(id)) {
        return apiError(res, 404, "NOT_FOUND", `check "${id}" not found.`);
      }
      const limit = Number(req.query?.limit) || 100;
      const history = monitor.getCheckHistory(id, limit);
      res.json({ id, limit, history });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/synthetic/checks/:id/stats?period=24h
  apiRoute("get", "/synthetic/checks/:id/stats", adminAuth, logRequest, (req, res) => {
    try {
      const id = req.params.id;
      if (!monitor.getCheck(id)) {
        return apiError(res, 404, "NOT_FOUND", `check "${id}" not found.`);
      }
      const period = req.query?.period || "24h";
      const stats = monitor.getCheckStats(id, period);
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}

export default mountSyntheticRoutes;
