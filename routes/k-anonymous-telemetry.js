/**
 * Phase 72.4: k-anonymous telemetry routes.
 */
import {
  recordEvent,
  aggregate,
  setKThreshold,
  getKThreshold,
  listBuckets,
} from "../lib/k-anonymous-telemetry.js";

export function mountKTelemetryRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/k-telemetry/events", adminAuth, logRequest, async (req, res) => {
    try {
      const { eventName, dimensions, userId } = req.body || {};
      if (!eventName) return apiError(res, 400, "INVALID_INPUT", "eventName is required");
      if (!userId) return apiError(res, 400, "INVALID_INPUT", "userId is required");
      const out = await recordEvent({ eventName, dimensions, userId });
      res.status(201).json(out);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/k-telemetry/aggregate", adminAuth, logRequest, async (req, res) => {
    try {
      const { eventName, dimensions, k } = req.body || {};
      if (!eventName) return apiError(res, 400, "INVALID_INPUT", "eventName is required");
      const out = await aggregate({ eventName, dimensions, k });
      res.json(out);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/k-telemetry/config", adminAuth, logRequest, async (req, res) => {
    try {
      const k = await getKThreshold();
      res.json({ k });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/k-telemetry/config", adminAuth, logRequest, async (req, res) => {
    try {
      const { k } = req.body || {};
      if (k == null) return apiError(res, 400, "INVALID_INPUT", "k is required");
      const saved = await setKThreshold(k);
      res.json({ k: saved });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/k-telemetry/buckets", adminAuth, logRequest, async (req, res) => {
    try {
      const eventName = req.query?.eventName;
      if (!eventName) return apiError(res, 400, "INVALID_INPUT", "eventName is required");
      const buckets = await listBuckets(eventName);
      res.json({ buckets });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountKTelemetryRoutes;
