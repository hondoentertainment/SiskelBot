/**
 * Phase 60.5: Status page routes.
 *
 * GET  /api/v1/status                    -- public
 * POST /api/v1/status/incidents          -- admin (create incident)
 * POST /api/v1/status/incidents/:id/update
 * POST /api/v1/status/incidents/:id/resolve
 * POST /api/v1/status/components/:id     -- admin (set status)
 * GET  /api/v1/status/incidents
 */
import {
  getStatusPage,
  postIncident,
  updateIncident,
  resolveIncident,
  setComponentStatus,
  listIncidents,
} from "../lib/status-page.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "status-page error");
}

export function mountStatusPageRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("get", "/status", log, async (req, res) => {
    try {
      const days = Number.isFinite(Number(req.query?.days)) ? Number(req.query.days) : undefined;
      const page = await getStatusPage({ days });
      return res.json(page);
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/status/incidents", log, auth, scope("read"), async (req, res) => {
    try {
      const filter = {
        status: typeof req.query?.status === "string" ? req.query.status : undefined,
        componentId: typeof req.query?.componentId === "string" ? req.query.componentId : undefined,
        sinceDays: Number.isFinite(Number(req.query?.sinceDays)) ? Number(req.query.sinceDays) : undefined,
      };
      const incidents = await listIncidents(filter);
      return res.json({ _version: 1, incidents, count: incidents.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/status/incidents", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const incident = await postIncident(body);
      return res.status(201).json({ _version: 1, incident });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/status/incidents/:id/update", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const incident = await updateIncident(req.params.id, body);
      return res.json({ _version: 1, incident });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/status/incidents/:id/resolve", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const incident = await resolveIncident(req.params.id, typeof body.note === "string" ? body.note : undefined);
      return res.json({ _version: 1, incident });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/status/components/:id", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.status || typeof body.status !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "status is required");
      }
      const component = await setComponentStatus(
        req.params.id,
        body.status,
        typeof body.message === "string" ? body.message : undefined,
      );
      return res.json({ _version: 1, component });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountStatusPageRoutes;
