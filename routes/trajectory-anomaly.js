/** Phase 73.4 routes */
import { clusterTrajectories, trajectorySignature } from "../lib/trajectory-anomaly.js";

export function mountTrajectoryAnomalyRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/trajectory-anomaly/cluster", adminAuth, logRequest, async (req, res) => {
    try {
      const trajectories = Array.isArray(req.body?.trajectories) ? req.body.trajectories : [];
      res.json(clusterTrajectories(trajectories, { rareThreshold: req.body?.rareThreshold }));
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/trajectory-anomaly/signature", adminAuth, logRequest, async (req, res) => {
    try {
      res.json({ signature: trajectorySignature(req.body || {}) });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });
}
