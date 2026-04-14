/**
 * Phase 75.4: Regression bisection routes.
 *
 * POST /bisection/sessions              — create a bisect session
 * POST /bisection/sessions/:id/advance  — advance with a test result
 * GET  /bisection/sessions/:id          — fetch a session
 * GET  /bisection/sessions              — list sessions for a workspace
 */
import {
  createBisectSession,
  advanceBisect,
  getBisectSession,
  listSessions,
} from "../lib/regression-bisection.js";

export function mountBisectionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/bisection/sessions", adminAuth, logRequest, async (req, res) => {
    try {
      const session = await createBisectSession(req.body || {});
      res.status(201).json(session);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/bisection/sessions/:id/advance", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const session = await advanceBisect({ sessionId: req.params.id, result: body.result });
      res.json(session);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/bisection/sessions/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const session = await getBisectSession(req.params.id);
      if (!session) return apiError(res, 404, "NOT_FOUND", "session not found");
      res.json(session);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/bisection/sessions", adminAuth, logRequest, async (req, res) => {
    try {
      const list = await listSessions(req.query?.workspaceId);
      res.json({ sessions: list });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountBisectionRoutes;
