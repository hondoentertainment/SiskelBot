/**
 * Phase 65.4: Audit reports routes.
 *
 * POST   /api/v1/audit-reports/schedules        -- create schedule
 * GET    /api/v1/audit-reports/schedules        -- list schedules
 * DELETE /api/v1/audit-reports/schedules/:id    -- cancel (disable) schedule
 * POST   /api/v1/audit-reports/generate         -- generate a report from events
 * GET    /api/v1/audit-reports                  -- list generated reports
 * GET    /api/v1/audit-reports/:id              -- fetch one report
 * GET    /api/v1/audit-reports/:id/csv          -- export one report as CSV
 */
import {
  scheduleReport,
  generateReport,
  listReports,
  getReport,
  exportCsv,
  cancelSchedule,
  listSchedules,
} from "../lib/audit-reports.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "audit-reports error");
}

function classifyError(err) {
  const msg = err?.message || "";
  if (msg.includes("not found")) return 404;
  if (msg.includes("required") || msg.includes("must")) return 400;
  return 500;
}

export function mountAuditReportsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/audit-reports/schedules", log, admin, async (req, res) => {
    try {
      const s = await scheduleReport(req.body || {});
      return res.status(201).json({ _version: 1, schedule: s });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/audit-reports/schedules", log, admin, async (req, res) => {
    try {
      const enabledOnly = req.query.enabledOnly === "1" || req.query.enabledOnly === "true";
      const type = typeof req.query.type === "string" ? req.query.type : undefined;
      const items = await listSchedules({ enabledOnly, type });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/audit-reports/schedules/:id", log, admin, async (req, res) => {
    try {
      const rec = await cancelSchedule(req.params.id);
      return res.json({ _version: 1, schedule: rec });
    } catch (err) {
      return sendError(apiError, res, err, classifyError(err));
    }
  });

  apiRoute("post", "/audit-reports/generate", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.events)) {
        return apiError(res, 400, "INVALID_INPUT", "events array required");
      }
      const report = await generateReport(body);
      return res.status(201).json({ _version: 1, report });
    } catch (err) {
      return sendError(apiError, res, err, classifyError(err));
    }
  });

  apiRoute("get", "/audit-reports", log, admin, async (req, res) => {
    try {
      const scheduleId = typeof req.query.scheduleId === "string" ? req.query.scheduleId : undefined;
      const limit = Number(req.query.limit);
      const items = await listReports({ scheduleId, limit: Number.isFinite(limit) ? limit : undefined });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/audit-reports/:id", log, admin, async (req, res) => {
    try {
      const r = await getReport(req.params.id);
      if (!r) return apiError(res, 404, "NOT_FOUND", `report ${req.params.id} not found`);
      return res.json({ _version: 1, report: r });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/audit-reports/:id/csv", log, admin, async (req, res) => {
    try {
      const r = await getReport(req.params.id);
      if (!r) return apiError(res, 404, "NOT_FOUND", `report ${req.params.id} not found`);
      const csv = exportCsv(r);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="report-${r.id}.csv"`);
      return res.send(csv);
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountAuditReportsRoutes;
