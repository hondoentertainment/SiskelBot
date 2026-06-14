/**
 * Runbook automation routes.
 *
 * GET  /api/v1/runbooks            — list all runbook templates
 * GET  /api/v1/runbooks/:name      — get a single runbook template
 * POST /api/v1/runbooks/generate   — generate runbook for an incident (enriched)
 * POST /api/v1/runbooks/report     — generate a post-mortem report
 */

import {
  listRunbooks,
  getRunbook,
  generateIncidentRunbook,
  generateIncidentReport,
} from "../lib/runbook.js";

export function mountRunbookRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // GET /api/v1/runbooks
  apiRoute("get", "/runbooks", chatAuth, requireScope("read"), logRequest, async (_req, res) => {
    try {
      const runbooks = listRunbooks();
      res.json({ _version: 1, runbooks });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to list runbooks.");
    }
  });

  // GET /api/v1/runbooks/:name
  apiRoute("get", "/runbooks/:name", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const name = req.params.name;
      const rb = getRunbook(name);
      if (!rb) {
        return apiError(res, 404, "NOT_FOUND", `Runbook not found: ${name}`);
      }
      res.json({ _version: 1, ...rb });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to load runbook.");
    }
  });

  // POST /api/v1/runbooks/generate
  apiRoute("post", "/runbooks/generate", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const incident = req.body?.incident || req.body || {};
      if (!incident.type || typeof incident.type !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "incident.type is required.", "Send { incident: { type, severity?, startTime?, metrics? } }.");
      }
      if (!getRunbook(incident.type)) {
        return apiError(res, 404, "NOT_FOUND", `Unknown runbook type: ${incident.type}`);
      }
      const generated = await generateIncidentRunbook(incident);
      res.json(generated);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to generate runbook.");
    }
  });

  // POST /api/v1/runbooks/report
  apiRoute("post", "/runbooks/report", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const incident = req.body?.incident;
      const resolution = req.body?.resolution;
      if (!incident || typeof incident !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "incident is required.", "Send { incident, resolution }.");
      }
      if (!resolution || typeof resolution !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "resolution is required.", "Send { incident, resolution }.");
      }
      const report = await generateIncidentReport(incident, resolution);
      res.json(report);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to generate report.");
    }
  });
}

export default mountRunbookRoutes;
