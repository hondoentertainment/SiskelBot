import {
  createSnapshot,
  listSnapshots,
  getSnapshot,
  deleteSnapshot,
  restoreSnapshot,
} from "../lib/machine-snapshots.js";

function mapErrorStatus(err) {
  const code = err?.code;
  if (code === "NOT_FOUND") return 404;
  if (code === "LIMIT_REACHED") return 409;
  const msg = String(err?.message || "");
  if (/not found/i.test(msg)) return 404;
  if (/required|invalid/i.test(msg)) return 400;
  return 500;
}

export function mountMachineSnapshotRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/workspaces/:workspaceId/snapshots
  apiRoute("post", "/workspaces/:workspaceId/snapshots", log, auth, scope("write"), async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const { sandboxId, name, description, metadata } = req.body || {};
      if (!sandboxId) return apiError(res, 400, "INVALID_INPUT", "sandboxId is required");
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      const result = await createSnapshot(workspaceId, sandboxId, name, description, metadata);
      if (result && result.ok === false) {
        return apiError(res, 503, "DOCKER_ERROR", result.error || "Failed to create snapshot");
      }
      return res.status(201).json({ _version: 1, snapshot: result });
    } catch (err) {
      const status = mapErrorStatus(err);
      const code = status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
      return apiError(res, status, code, err?.message || "machine-snapshots error");
    }
  });

  // GET /api/v1/workspaces/:workspaceId/snapshots
  apiRoute("get", "/workspaces/:workspaceId/snapshots", log, auth, scope("read"), async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const snapshots = await listSnapshots(workspaceId);
      return res.json({ _version: 1, snapshots, count: snapshots.length });
    } catch (err) {
      const status = mapErrorStatus(err);
      const code = status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
      return apiError(res, status, code, err?.message || "machine-snapshots error");
    }
  });

  // GET /api/v1/workspaces/:workspaceId/snapshots/:snapshotId
  apiRoute("get", "/workspaces/:workspaceId/snapshots/:snapshotId", log, auth, scope("read"), async (req, res) => {
    try {
      const { workspaceId, snapshotId } = req.params;
      const snapshot = await getSnapshot(workspaceId, snapshotId);
      if (!snapshot) return apiError(res, 404, "NOT_FOUND", `Snapshot ${snapshotId} not found`);
      return res.json({ _version: 1, snapshot });
    } catch (err) {
      const status = mapErrorStatus(err);
      const code = status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
      return apiError(res, status, code, err?.message || "machine-snapshots error");
    }
  });

  // DELETE /api/v1/workspaces/:workspaceId/snapshots/:snapshotId
  apiRoute("delete", "/workspaces/:workspaceId/snapshots/:snapshotId", log, auth, scope("write"), async (req, res) => {
    try {
      const { workspaceId, snapshotId } = req.params;
      const result = await deleteSnapshot(workspaceId, snapshotId);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      const status = mapErrorStatus(err);
      const code = status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
      return apiError(res, status, code, err?.message || "machine-snapshots error");
    }
  });

  // POST /api/v1/workspaces/:workspaceId/snapshots/:snapshotId/restore
  apiRoute("post", "/workspaces/:workspaceId/snapshots/:snapshotId/restore", log, auth, scope("write"), async (req, res) => {
    try {
      const { workspaceId, snapshotId } = req.params;
      const options = req.body && typeof req.body === "object" ? req.body : {};
      const result = await restoreSnapshot(workspaceId, snapshotId, options);
      if (!result.ok) {
        return apiError(res, 503, "DOCKER_ERROR", result.error || "Failed to restore snapshot");
      }
      return res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      const status = mapErrorStatus(err);
      const code = status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
      return apiError(res, status, code, err?.message || "machine-snapshots error");
    }
  });
}
