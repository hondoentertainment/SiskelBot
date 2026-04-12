/**
 * Route module: audit reports (Phase 65.4).
 *
 * POST   /api/v1/audit-reports                    — defineReport
 * GET    /api/v1/audit-reports                    — listReports
 * GET    /api/v1/audit-reports/:id                — getReport
 * POST   /api/v1/audit-reports/:id/schedule       — scheduleReport
 * POST   /api/v1/audit-reports/:id/generate       — generateReport
 * GET    /api/v1/audit-reports/:id/runs           — listRuns for definition
 * GET    /api/v1/audit-reports/runs/:runId        — getRun
 */
import {
  defineReport,
  getReport,
  listReports,
  scheduleReport,
  generateReport,
  getRun,
  listRuns,
} from "../lib/audit-reports.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountAuditReportsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/audit-reports", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await defineReport({
        name: body.name,
        template: body.template,
        filter: body.filter,
        schedule: body.schedule,
        description: body.description,
        createdBy: body.createdBy,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/audit-reports", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.template) filter.template = String(req.query.template);
      if (req.query?.name) filter.name = String(req.query.name);
      const reports = await listReports(filter);
      res.json({ reports });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/audit-reports/runs/:runId", adminAuth, logRequest, async (req, res) => {
    try {
      const run = await getRun(req.params.runId);
      if (!run) return apiError(res, 404, "NOT_FOUND", "run not found");
      res.json(run);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/audit-reports/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getReport(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "report not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/audit-reports/:id/schedule", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await scheduleReport(req.params.id, {
        schedule: body.schedule,
        nextRunAt: body.nextRunAt,
      });
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/audit-reports/:id/generate", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const run = await generateReport(req.params.id, {
        events: body.events,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        actor: body.actor,
      });
      res.status(201).json(run);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/audit-reports/:id/runs", adminAuth, logRequest, async (req, res) => {
    try {
      const runs = await listRuns({ definitionId: req.params.id });
      res.json({ runs });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountAuditReportsRoutes;
