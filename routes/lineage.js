/**
 * Phase 57.4: Lineage tracking routes.
 *
 * POST   /api/v1/lineage/events        — emit a lineage event
 * GET    /api/v1/lineage/events        — query lineage events
 * GET    /api/v1/lineage/graph         — lineage graph (nodes + edges)
 */
import {
  EVENT_TYPES,
  emitLineage,
  queryLineage,
  getGraph,
} from "../lib/lineage.js";

export function mountLineageRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/lineage/event-types", adminAuth, logRequest, async (req, res) => {
    res.json({ eventTypes: EVENT_TYPES });
  });

  apiRoute("post", "/lineage/events", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await emitLineage(req.body || {});
      res.status(201).json(rec);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/lineage/events", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {
        jobName: req.query?.jobName,
        namespace: req.query?.namespace,
        runId: req.query?.runId,
        datasetName: req.query?.datasetName,
        since: req.query?.since,
        until: req.query?.until,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      };
      const result = await queryLineage(filter);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/lineage/graph", adminAuth, logRequest, async (req, res) => {
    try {
      const g = await getGraph({
        rootDataset: req.query?.rootDataset,
        namespace: req.query?.namespace,
        maxDepth: req.query?.maxDepth ? Number(req.query.maxDepth) : undefined,
      });
      res.json(g);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountLineageRoutes;
