/**
 * GET /api/v1/audit/search?q=&action=&workspace=
 * GET /api/v1/audit/replay/:runId
 */
import { queryAudit } from "../lib/audit-query.js";
import { searchAuditEntries, replaySteps } from "../lib/audit-redaction.js";
import { loadTrajectory } from "../lib/agent-trajectory.js";
import { sanitizeWorkspace } from "../lib/storage.js";

export function mountAuditReplayRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, logRequest } = deps;
  const auth = adminAuth || ((_req, res) => {
    res.status(401).json({ error: "Admin access required", code: "ADMIN_REQUIRED" });
  });
  const log = logRequest || ((_req, _res, next) => next());

  apiRoute("get", "/audit/search", log, auth, async (req, res) => {
    try {
      const workspaceId = req.query?.workspace ? sanitizeWorkspace(req.query.workspace) : undefined;
      const action = typeof req.query?.action === "string" ? req.query.action : undefined;
      const result = await queryAudit({
        workspaceId,
        action,
        limit: 200,
      });
      const entries = searchAuditEntries(result.entries || [], {
        q: req.query?.q,
        action,
      });
      res.json({ entries });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/audit/replay/:runId", log, auth, async (req, res) => {
    try {
      const trajectory = await loadTrajectory(req.params.runId);
      if (!trajectory) return apiError(res, 404, "NOT_FOUND", "Run not found");
      res.json({ runId: req.params.runId, steps: replaySteps(trajectory) });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
