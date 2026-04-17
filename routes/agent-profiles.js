/**
 * Agent profiles CRUD routes.
 * Workspace-scoped subagent persona management with built-in defaults.
 */
import {
  listProfiles,
  getProfile,
  upsertProfile,
  deleteProfile,
} from "../lib/agent-profiles.js";

export function mountAgentProfileRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest, sanitizeWorkspace } = deps;

  // GET /agent/profiles — list all profiles for the workspace
  apiRoute("get", "/agent/profiles", logRequest, userAuth, requireScope("read"), async (req, res) => {
    const workspace = sanitizeWorkspace(req.query.workspace || "default");
    try {
      const profiles = await listProfiles(workspace);
      res.json({ profiles });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List failed", "See server logs.");
    }
  });

  // GET /agent/profiles/:id — get a single profile
  apiRoute("get", "/agent/profiles/:id", logRequest, userAuth, requireScope("read"), async (req, res) => {
    const workspace = sanitizeWorkspace(req.query.workspace || "default");
    const id = String(req.params.id || "").trim();
    if (!id) {
      return apiError(res, 400, "INVALID_INPUT", "Profile id is required", "Provide an id path parameter.");
    }
    try {
      const profile = await getProfile(workspace, id);
      if (!profile) {
        return apiError(res, 404, "NOT_FOUND", "Profile not found", "Check the id or create the profile first.");
      }
      res.json(profile);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Get failed", "See server logs.");
    }
  });

  // PUT /agent/profiles/:id — create or update a profile
  apiRoute("put", "/agent/profiles/:id", logRequest, userAuth, requireScope("write"), async (req, res) => {
    const workspace = sanitizeWorkspace(req.query.workspace || "default");
    const id = String(req.params.id || "").trim();
    const body = req.body || {};
    const profile = { ...body, id };
    try {
      const saved = await upsertProfile(workspace, profile);
      res.json(saved);
    } catch (err) {
      if (err.code === "VALIDATION_ERROR") {
        return apiError(res, 400, "VALIDATION_ERROR", err.message, "Fix the input and retry.");
      }
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Upsert failed", "See server logs.");
    }
  });

  // DELETE /agent/profiles/:id — delete a workspace profile (or workspace override of a built-in)
  apiRoute("delete", "/agent/profiles/:id", logRequest, userAuth, requireScope("write"), async (req, res) => {
    const workspace = sanitizeWorkspace(req.query.workspace || "default");
    const id = String(req.params.id || "").trim();
    if (!id) {
      return apiError(res, 400, "INVALID_INPUT", "Profile id is required", "Provide an id path parameter.");
    }
    try {
      const deleted = await deleteProfile(workspace, id);
      if (!deleted) {
        return apiError(res, 404, "NOT_FOUND", "Profile not found", "Nothing to delete.");
      }
      res.json({ ok: true, id });
    } catch (err) {
      if (err.code === "BUILTIN_DELETE") {
        return apiError(res, 400, "BUILTIN_DELETE", err.message, "Built-in profiles can only be overridden, not deleted.");
      }
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Delete failed", "See server logs.");
    }
  });
}
