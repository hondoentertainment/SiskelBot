/**
 * Phase 39.5: Data warehouse export admin routes.
 *
 * Mounted under /api/v1 (with legacy /api mirror) via the standard
 * apiRoute() helper from server.js. All routes are admin-only.
 *
 *   GET    /warehouse/exports           - list all exports
 *   POST   /warehouse/exports           - create a new export config
 *   GET    /warehouse/exports/:id       - load a single export
 *   PUT    /warehouse/exports/:id       - update an export config
 *   DELETE /warehouse/exports/:id       - delete an export
 *   POST   /warehouse/exports/:id/run   - trigger an export now
 *   GET    /warehouse/exports/:id/history - list past run results
 */

import {
  createExport,
  updateExport,
  listExports,
  getExport,
  deleteExport,
  runExport,
  getExportHistory,
} from "../lib/data-warehouse.js";
import { TABLE_SCHEMAS } from "../lib/warehouse-schemas.js";

const VALID_DESTINATIONS = new Set(["snowflake", "bigquery", "redshift", "s3"]);

function sanitize(entry) {
  if (!entry) return entry;
  // Strip credentials from API responses; surface only key names so admins
  // can confirm what was configured without exposing secrets.
  const { credentials, ...rest } = entry;
  return {
    ...rest,
    credentialKeys: credentials && typeof credentials === "object" ? Object.keys(credentials) : [],
  };
}

export function mountDataWarehouseRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, logRequest } = deps;

  apiRoute("get", "/warehouse/exports", adminAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = req.query?.workspaceId ? String(req.query.workspaceId) : undefined;
      const items = await listExports(workspaceId);
      res.json({ _version: 1, items: items.map(sanitize) });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/warehouse/exports", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name required", null);
      }
      if (!VALID_DESTINATIONS.has(body.destination)) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          `Invalid destination "${body.destination}"`,
          "Use snowflake, bigquery, redshift, or s3."
        );
      }
      if (!Array.isArray(body.tables) || body.tables.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "tables required (non-empty array)", null);
      }
      for (const t of body.tables) {
        if (!TABLE_SCHEMAS[t]) {
          return apiError(res, 400, "INVALID_INPUT", `Unknown table "${t}"`, `Known tables: ${Object.keys(TABLE_SCHEMAS).join(", ")}`);
        }
      }
      if (body.incremental && !body.dateColumn) {
        return apiError(res, 400, "INVALID_INPUT", "incremental exports require dateColumn", null);
      }
      const entry = await createExport({
        name: body.name,
        destination: body.destination,
        credentials: body.credentials || {},
        tables: body.tables,
        schedule: body.schedule || null,
        incremental: !!body.incremental,
        dateColumn: body.dateColumn || null,
        workspaceId: body.workspaceId || "default",
        enabled: body.enabled !== false,
      });
      res.status(201).json(sanitize(entry));
    } catch (err) {
      if (/required|invalid|unknown/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message, null);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/warehouse/exports/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return apiError(res, 400, "INVALID_INPUT", "id required", null);
      const entry = await getExport(id);
      if (!entry) return apiError(res, 404, "NOT_FOUND", "Export not found", null);
      res.json(sanitize(entry));
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("put", "/warehouse/exports/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return apiError(res, 400, "INVALID_INPUT", "id required", null);
      const patch = req.body || {};
      const updated = await updateExport(id, patch);
      if (!updated) return apiError(res, 404, "NOT_FOUND", "Export not found", null);
      res.json(sanitize(updated));
    } catch (err) {
      if (/required|invalid|unknown/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message, null);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/warehouse/exports/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return apiError(res, 400, "INVALID_INPUT", "id required", null);
      const removed = await deleteExport(id);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Export not found", null);
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/warehouse/exports/:id/run", adminAuth, logRequest, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return apiError(res, 400, "INVALID_INPUT", "id required", null);
      const entry = await getExport(id);
      if (!entry) return apiError(res, 404, "NOT_FOUND", "Export not found", null);
      const result = await runExport(id);
      const httpStatus = result.status === "failed" ? 500 : 200;
      res.status(httpStatus).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/warehouse/exports/:id/history", adminAuth, logRequest, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return apiError(res, 400, "INVALID_INPUT", "id required", null);
      const entry = await getExport(id);
      if (!entry) return apiError(res, 404, "NOT_FOUND", "Export not found", null);
      const items = await getExportHistory(id);
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}

export default mountDataWarehouseRoutes;
