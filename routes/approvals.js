/**
 * Approval queue.
 * GET  /api/v1/approvals
 * POST /api/v1/approvals/:id/approve
 * POST /api/v1/approvals/:id/deny
 */
import { listApprovals, decideApproval } from "../lib/approval-queue.js";
import { sanitizeWorkspace } from "../lib/storage.js";

export function mountApprovalRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, logRequest } = deps;
  const auth = adminAuth || ((_req, res) => {
    res.status(401).json({ error: "Admin access required", code: "ADMIN_REQUIRED" });
  });
  const log = logRequest || ((_req, _res, next) => next());

  function workspaceOf(req) {
    return sanitizeWorkspace(req.query?.workspace || req.body?.workspace || "default");
  }

  apiRoute("get", "/approvals", log, auth, async (req, res) => {
    try {
      const items = await listApprovals(workspaceOf(req), {
        status: typeof req.query?.status === "string" ? req.query.status : undefined,
      });
      res.json({ items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  async function decide(req, res, status) {
    try {
      const row = await decideApproval(workspaceOf(req), req.params.id, {
        status,
        by: req.adminUserId || req.userId || "admin",
      });
      if (!row) return apiError(res, 404, "NOT_FOUND", "Approval not found");
      res.json({ approval: row });
    } catch (err) {
      const code = err.code === "INVALID_INPUT" ? 400 : 500;
      return apiError(res, code, err.code || "INTERNAL_ERROR", err.message);
    }
  }

  apiRoute("post", "/approvals/:id/approve", log, auth, (req, res) => decide(req, res, "approved"));
  apiRoute("post", "/approvals/:id/deny", log, auth, (req, res) => decide(req, res, "denied"));
}
