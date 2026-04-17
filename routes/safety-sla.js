/**
 * Phase 72.5: Safety SLA dashboard routes.
 */
import {
  recordClassification,
  setSlaTarget,
  getSlaTarget,
  computeMetrics,
  getSlaStatus,
  listClassifiers,
} from "../lib/safety-sla.js";

export function mountSafetySlaRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/safety-sla/classifications", adminAuth, logRequest, async (req, res) => {
    try {
      const { classifierId, prediction, actual, timestamp } = req.body || {};
      if (!classifierId) return apiError(res, 400, "INVALID_INPUT", "classifierId is required");
      const out = await recordClassification({ classifierId, prediction, actual, timestamp });
      res.status(201).json(out);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("put", "/safety-sla/:classifierId/target", adminAuth, logRequest, async (req, res) => {
    try {
      const { precisionTarget, recallTarget } = req.body || {};
      const out = await setSlaTarget({
        classifierId: req.params?.classifierId,
        precisionTarget,
        recallTarget,
      });
      res.json(out);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/safety-sla/:classifierId/target", adminAuth, logRequest, async (req, res) => {
    try {
      const target = await getSlaTarget(req.params?.classifierId);
      if (!target) return apiError(res, 404, "NOT_FOUND", "classifier not found");
      res.json(target);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/safety-sla/:classifierId/metrics", adminAuth, logRequest, async (req, res) => {
    try {
      const since = req.query?.since ? Number(req.query.since) : undefined;
      const until = req.query?.until ? Number(req.query.until) : undefined;
      const metrics = await computeMetrics({
        classifierId: req.params?.classifierId,
        since,
        until,
      });
      if (!metrics) return apiError(res, 404, "NOT_FOUND", "classifier not found");
      res.json(metrics);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/safety-sla/:classifierId/status", adminAuth, logRequest, async (req, res) => {
    try {
      const status = await getSlaStatus(req.params?.classifierId);
      if (!status) return apiError(res, 404, "NOT_FOUND", "classifier not found");
      res.json(status);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/safety-sla/classifiers", adminAuth, logRequest, async (req, res) => {
    try {
      const classifiers = await listClassifiers();
      res.json({ classifiers });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountSafetySlaRoutes;
