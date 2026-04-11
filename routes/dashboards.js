/**
 * Phase 39.4: Custom dashboard routes.
 *
 * GET    /api/v1/dashboards?workspace=X       — list dashboards
 * POST   /api/v1/dashboards                   — create dashboard
 * GET    /api/v1/dashboards/widgets/types     — available widget types
 * GET    /api/v1/dashboards/:id               — get dashboard
 * PUT    /api/v1/dashboards/:id               — update dashboard
 * DELETE /api/v1/dashboards/:id               — delete dashboard
 * POST   /api/v1/dashboards/:id/clone         — clone dashboard
 * GET    /api/v1/dashboards/:id/data          — render all widget data
 * GET    /api/v1/dashboards/shared/:token     — public read-only view by share token
 * GET    /api/v1/dashboards/shared/:token/data — public widget data by share token
 */

import {
  createDashboard,
  updateDashboard,
  deleteDashboard,
  listDashboards,
  getDashboard,
  cloneDashboard,
  getDashboardData,
  getDashboardByShareToken,
  WIDGET_TYPES,
  DASHBOARD_LIMITS,
} from "../lib/dashboards.js";

export function mountDashboardRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, logRequest } = deps;

  // GET /api/v1/dashboards/widgets/types — public catalog
  apiRoute("get", "/dashboards/widgets/types", logRequest, async (_req, res) => {
    res.json({ types: WIDGET_TYPES, limits: DASHBOARD_LIMITS });
  });

  // GET /api/v1/dashboards?workspace=X
  apiRoute("get", "/dashboards", userAuth, logRequest, async (req, res) => {
    try {
      const workspace = String(req.query?.workspace || "default");
      const dashboards = await listDashboards(workspace);
      res.json({ dashboards, total: dashboards.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/dashboards
  apiRoute("post", "/dashboards", userAuth, logRequest, async (req, res) => {
    try {
      const { workspace, name, layout, description } = req.body || {};
      if (!workspace || typeof workspace !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "workspace is required");
      }
      if (!name || typeof name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      const dash = await createDashboard(workspace, name, layout || { widgets: [] }, {
        description,
        createdBy: req.userId || null,
      });
      res.status(201).json(dash);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // GET /api/v1/dashboards/shared/:token — public, no auth
  apiRoute("get", "/dashboards/shared/:token", logRequest, async (req, res) => {
    try {
      const { token } = req.params || {};
      const dash = await getDashboardByShareToken(token);
      if (!dash) return apiError(res, 404, "NOT_FOUND", "shared dashboard not found");
      // Strip share token from public payload — clients don't need it.
      const { shareToken: _omit, ...publicDash } = dash;
      res.json(publicDash);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/dashboards/shared/:token/data — public widget data
  apiRoute("get", "/dashboards/shared/:token/data", logRequest, async (req, res) => {
    try {
      const { token } = req.params || {};
      const dash = await getDashboardByShareToken(token);
      if (!dash) return apiError(res, 404, "NOT_FOUND", "shared dashboard not found");
      const data = await getDashboardData(dash.id);
      res.json(data);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/dashboards/:id/data
  apiRoute("get", "/dashboards/:id/data", userAuth, logRequest, async (req, res) => {
    try {
      const { id } = req.params || {};
      const data = await getDashboardData(id);
      res.json(data);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404 : 500;
      return apiError(res, status, "DASHBOARD_ERROR", err.message);
    }
  });

  // POST /api/v1/dashboards/:id/clone
  apiRoute("post", "/dashboards/:id/clone", userAuth, logRequest, async (req, res) => {
    try {
      const { id } = req.params || {};
      const { name } = req.body || {};
      const cloned = await cloneDashboard(id, name);
      res.status(201).json(cloned);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404 : 400;
      return apiError(res, status, "DASHBOARD_ERROR", err.message);
    }
  });

  // GET /api/v1/dashboards/:id
  apiRoute("get", "/dashboards/:id", userAuth, logRequest, async (req, res) => {
    try {
      const { id } = req.params || {};
      const dash = await getDashboard(id);
      if (!dash) return apiError(res, 404, "NOT_FOUND", "dashboard not found");
      res.json(dash);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/dashboards/:id
  apiRoute("put", "/dashboards/:id", userAuth, logRequest, async (req, res) => {
    try {
      const { id } = req.params || {};
      const updates = req.body || {};
      const updated = await updateDashboard(id, updates);
      res.json(updated);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404 : 400;
      return apiError(res, status, "DASHBOARD_ERROR", err.message);
    }
  });

  // DELETE /api/v1/dashboards/:id
  apiRoute("delete", "/dashboards/:id", userAuth, logRequest, async (req, res) => {
    try {
      const { id } = req.params || {};
      const result = await deleteDashboard(id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", result.error || "dashboard not found");
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountDashboardRoutes;
