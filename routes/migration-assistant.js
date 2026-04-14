/**
 * Phase 63.5: Migration assistant routes.
 */
import {
  registerPlaybook,
  listPlaybooks,
  startMigration,
  getMigrationStatus,
  advanceMigration,
  listMigrations,
} from "../lib/migration-assistant.js";

export function mountMigrationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/migration/playbooks", adminAuth, logRequest, async (_req, res) => {
    try {
      const out = await listPlaybooks();
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/migration/playbooks", adminAuth, logRequest, async (req, res) => {
    try {
      const playbook = req.body || {};
      const clean = await registerPlaybook(playbook);
      res.status(201).json(clean);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/migration/start", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, playbookName, repoId } = req.body || {};
      if (!playbookName) return apiError(res, 400, "INVALID_INPUT", "playbookName is required");
      const migration = await startMigration({ workspaceId, playbookName, repoId });
      res.status(201).json(migration);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/migration/migrations/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const migration = await getMigrationStatus(req.params?.id, req.query?.workspaceId);
      if (!migration) return apiError(res, 404, "NOT_FOUND", "migration not found");
      res.json(migration);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/migration/migrations/:id/advance", adminAuth, logRequest, async (req, res) => {
    try {
      const { stepOutcome, workspaceId } = req.body || {};
      const out = await advanceMigration({
        migrationId: req.params?.id,
        stepOutcome,
        workspaceId: workspaceId || req.query?.workspaceId,
      });
      if (!out) return apiError(res, 404, "NOT_FOUND", "migration not found");
      res.json(out);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/migration/migrations", adminAuth, logRequest, async (req, res) => {
    try {
      const out = await listMigrations(req.query?.workspaceId);
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountMigrationRoutes;
