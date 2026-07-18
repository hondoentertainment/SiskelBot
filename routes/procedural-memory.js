/** Phase 74.3 routes */
import { learnProcedureFromRun, listProcedures, matchProcedures } from "../lib/procedural-memory.js";

export function mountProceduralMemoryRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, sanitizeWorkspace, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((_r, _s, n) => n());

  apiRoute("get", "/procedural-memory", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const items = await listProcedures(workspace, { limit: Number(req.query?.limit) || 50 });
      res.json({ procedures: items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/procedural-memory/learn", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const result = await learnProcedureFromRun(workspace, req.body || {});
      res.status(result.ok ? 201 : 400).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/procedural-memory/match", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const matches = await matchProcedures(workspace, req.body?.goal || req.body?.q);
      res.json({ matches });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
