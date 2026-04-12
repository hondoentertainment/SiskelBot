/**
 * Route module: public status page (Phase 60.5).
 *
 * Public (no auth):
 *   GET    /api/v1/status                    — overall status + components + history
 *   GET    /api/v1/status/incidents          — list incidents (newest first)
 *   GET    /api/v1/status/incidents/:id      — one incident
 *
 * Admin:
 *   POST   /api/v1/status/incidents                  — record new incident
 *   PUT    /api/v1/status/incidents/:id              — update incident
 *   POST   /api/v1/status/components/override        — set manual override
 *   DELETE /api/v1/status/components/override/:name  — clear override
 */

import {
  getStatus,
  listIncidents,
  recordIncident,
  updateIncident,
  getIncident,
  setComponentOverride,
  clearComponentOverride,
  INCIDENT_STATUS,
  INCIDENT_IMPACT,
} from "../lib/status-page.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountStatusPageRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // GET /api/v1/status — public
  apiRoute("get", "/status", logRequest, async (req, res) => {
    try {
      const status = await getStatus();
      res.json(status);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/status/incidents — public
  apiRoute("get", "/status/incidents", logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.resolved === "true") filter.resolved = true;
      else if (req.query?.resolved === "false") filter.resolved = false;
      if (typeof req.query?.component === "string") filter.component = req.query.component;
      if (Number.isFinite(Number(req.query?.sinceMs))) {
        filter.sinceMs = Number(req.query.sinceMs);
      }
      const incidents = await listIncidents(filter);
      res.json({ incidents });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/status/incidents/:id — public
  apiRoute("get", "/status/incidents/:id", logRequest, async (req, res) => {
    try {
      const incident = await getIncident(req.params.id);
      if (!incident) return apiError(res, 404, "NOT_FOUND", "incident not found");
      res.json(incident);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/status/incidents — admin
  apiRoute("post", "/status/incidents", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await recordIncident(body);
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // PUT /api/v1/status/incidents/:id — admin
  apiRoute("put", "/status/incidents/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const incident = await updateIncident(req.params.id, req.body || {});
      res.json(incident);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/status/components/override — admin
  apiRoute("post", "/status/components/override", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const list = await setComponentOverride(body);
      res.status(201).json({ components: list });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // DELETE /api/v1/status/components/override/:name — admin
  apiRoute("delete", "/status/components/override/:name", adminAuth, logRequest, async (req, res) => {
    try {
      const list = await clearComponentOverride(req.params.name);
      res.json({ components: list });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/status/enums — public, for UI to build dropdowns
  apiRoute("get", "/status/enums", logRequest, async (req, res) => {
    res.json({ statuses: INCIDENT_STATUS, impacts: INCIDENT_IMPACT });
  });
}

export default mountStatusPageRoutes;
