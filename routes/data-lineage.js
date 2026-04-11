/**
 * Phase 57.4: Data lineage routes.
 *
 * POST /api/v1/data-lineage                   -- record a lineage event
 * GET  /api/v1/data-lineage/:node             -- both directions
 * GET  /api/v1/data-lineage/:node/upstream    -- upstream nodes
 * GET  /api/v1/data-lineage/:node/downstream  -- downstream nodes
 * GET  /api/v1/data-lineage/export/graph      -- full graph
 */
import {
  recordLineage,
  getLineage,
  findUpstream,
  findDownstream,
  exportGraph,
} from "../lib/data-lineage.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "data-lineage error");
}

export function mountDataLineageRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/data-lineage", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const evt = await recordLineage({
        job: body.job,
        inputs: body.inputs,
        outputs: body.outputs,
        metadata: body.metadata,
      });
      return res.status(201).json({ _version: 1, event: evt });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/data-lineage/export/graph", log, auth, scope("read"), async (_req, res) => {
    try {
      const g = await exportGraph();
      return res.json({ _version: 1, graph: g });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/data-lineage/:node", log, auth, scope("read"), async (req, res) => {
    try {
      const lineage = await getLineage(req.params.node);
      if (!lineage) return apiError(res, 404, "NOT_FOUND", `node "${req.params.node}" not found`);
      return res.json({ _version: 1, lineage });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/data-lineage/:node/upstream", log, auth, scope("read"), async (req, res) => {
    try {
      const up = await findUpstream(req.params.node);
      return res.json({ _version: 1, upstream: up, count: up.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/data-lineage/:node/downstream", log, auth, scope("read"), async (req, res) => {
    try {
      const down = await findDownstream(req.params.node);
      return res.json({ _version: 1, downstream: down, count: down.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountDataLineageRoutes;
