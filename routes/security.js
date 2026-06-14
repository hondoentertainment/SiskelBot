/**
 * Phase 25: Enterprise security routes.
 * Data retention policy CRUD, enforcement, and per-workspace IP policies.
 */
import {
  getRetentionPolicy,
  setRetentionPolicy,
  enforceRetention,
} from "../lib/data-retention.js";
import {
  getWorkspaceIpPolicy,
  setWorkspaceIpPolicy,
} from "../lib/ip-policy.js";

export function mountSecurityRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    requireScope,
    storageRateLimiter,
    sanitizeWorkspace,
  } = deps;

  // --- Data retention ---

  apiRoute(
    "get",
    "/workspaces/:id/retention",
    storageRateLimiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const policy = await getRetentionPolicy(workspaceId);
        res.json(policy);
      } catch (err) {
        console.error("Retention GET error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  apiRoute(
    "put",
    "/workspaces/:id/retention",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const policy = await setRetentionPolicy(workspaceId, req.body || {});
        res.json(policy);
      } catch (err) {
        if (err.message.includes("must be a non-negative")) {
          return apiError(res, 400, "VALIDATION_ERROR", err.message, null);
        }
        console.error("Retention PUT error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  apiRoute(
    "post",
    "/workspaces/:id/retention/enforce",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const result = await enforceRetention(workspaceId, req.userId || "anonymous");
        res.json(result);
      } catch (err) {
        console.error("Retention enforce error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  // --- IP policy ---

  apiRoute(
    "get",
    "/workspaces/:id/ip-policy",
    storageRateLimiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const policy = await getWorkspaceIpPolicy(workspaceId);
        res.json(policy);
      } catch (err) {
        console.error("IP policy GET error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  apiRoute(
    "put",
    "/workspaces/:id/ip-policy",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const policy = await setWorkspaceIpPolicy(workspaceId, req.body?.allowedIPs || []);
        res.json(policy);
      } catch (err) {
        if (err.message.includes("Invalid IP") || err.message.includes("Invalid CIDR") || err.message.includes("must be an array")) {
          return apiError(res, 400, "VALIDATION_ERROR", err.message, null);
        }
        console.error("IP policy PUT error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );
}
