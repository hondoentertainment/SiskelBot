import { verifyChain, getChainHead } from "../lib/audit-chain.js";
import { readJsonPath } from "../lib/json-path-store.js";
import { join } from "node:path";
import { getDataDir } from "../lib/json-path-store.js";

function auditLogPath() {
  return join(getDataDir(), "execution-audit.json");
}

async function listWorkspaceIds() {
  const loaded = await readJsonPath(auditLogPath(), []);
  const entries = Array.isArray(loaded) ? loaded : [];
  const ids = new Set();
  for (const e of entries) {
    if (e.workspaceId) ids.add(e.workspaceId);
  }
  return [...ids];
}

export function mountAuditVerifyRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, logRequest } = deps;

  const admin = typeof adminAuth === "function" ? adminAuth : (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();

  apiRoute("get", "/admin/audit/chain/verify", admin, log, async (req, res) => {
    try {
      const workspaceId =
        req.query.workspaceId ||
        req.user?.workspaceId ||
        "default";
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 100), 10000);
      const result = await verifyChain(workspaceId, { limit });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message || "verifyChain failed", null);
    }
  });

  apiRoute("get", "/admin/audit/chain/head", admin, log, async (req, res) => {
    try {
      const workspaceId =
        req.query.workspaceId ||
        req.user?.workspaceId ||
        "default";
      const head = await getChainHead(workspaceId);
      if (!head) {
        return res.json({ _version: 1, workspaceId, head: null });
      }
      return res.json({ _version: 1, workspaceId, head });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message || "getChainHead failed", null);
    }
  });

  apiRoute("post", "/admin/audit/chain/verify-all", admin, log, async (req, res) => {
    try {
      const limit = Math.min(Math.max(1, Number(req.body?.limit) || 100), 10000);
      const workspaceIds = await listWorkspaceIds();
      const results = await Promise.all(
        workspaceIds.map((wsId) => verifyChain(wsId, { limit }))
      );
      const invalidWorkspaces = results
        .filter((r) => !r.valid)
        .map((r) => ({
          workspaceId: r.workspaceId,
          firstBadSequence: r.firstBadSequence,
          entriesChecked: r.entriesChecked,
        }));
      return res.json({
        _version: 1,
        workspacesChecked: workspaceIds.length,
        allValid: invalidWorkspaces.length === 0,
        invalidWorkspaces,
        verifiedAt: new Date().toISOString(),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message || "verify-all failed", null);
    }
  });
}

export default mountAuditVerifyRoutes;
