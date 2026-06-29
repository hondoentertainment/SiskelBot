/**
 * Freemium trials — self-serve trial of a higher plan.
 * GET  /api/v1/trials          — trial status for a workspace
 * POST /api/v1/trials/start    — start a trial (one per workspace)
 */
import { getTrial, startTrial } from "../lib/trials.js";

export function mountTrialRoutes(app, deps) {
  const { apiRoute, apiError, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());

  function workspaceOf(req) {
    return req.headers["x-workspace-id"] || req.query?.workspace || req.body?.workspaceId || "default";
  }

  apiRoute("get", "/trials", limiter, async (req, res) => {
    try {
      const trial = await getTrial(workspaceOf(req));
      res.json({ ok: true, trial });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/trials/start", limiter, async (req, res) => {
    try {
      const result = await startTrial(workspaceOf(req), {
        plan: req.body?.plan,
        days: req.body?.days,
      });
      if (!result.ok) {
        return apiError(res, 409, "TRIAL_UNAVAILABLE", result.error, JSON.stringify(result.trial || null));
      }
      res.status(201).json({ ok: true, trial: result.trial });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
