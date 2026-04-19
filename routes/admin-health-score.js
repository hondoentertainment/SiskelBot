/**
 * Admin routes for the composite agent health-budget score.
 *
 * Exposes a single rolled-up 0-1 score that blends benchmark pass rate,
 * safety pass rate, user-feedback up-vote rate, average tool reliability
 * minus chronic-failure and swarm-conflict penalties. Ops staff poll this
 * one endpoint instead of five dashboards.
 *
 *   GET  /api/admin/health-score?workspace=X          -> returns HealthScore
 *   POST /api/admin/health-score/refresh?workspace=X  -> compute + publish
 *                                                         Prometheus gauge +
 *                                                         webhook alert if
 *                                                         critical or dropped
 *
 * Mounted by routes/index.js via mountAdminHealthScoreRoutes (admin scope).
 */

import {
  computeHealthScore,
  emitHealthScoreMetric,
  checkAndAlertHealthScore,
} from "../lib/agent-health-score.js";

export default function mountAdminHealthScoreRoutes(app, deps) {
  const { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace } = deps;

  /** GET /api/admin/health-score?workspace=X */
  app.get(
    "/api/admin/health-score",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const hs = await computeHealthScore(workspace);
        return res.json(hs);
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /**
   * POST /api/admin/health-score/refresh?workspace=X
   *
   * Manual trigger: recomputes the score, publishes it to the Prometheus
   * gauge, and fires a webhook alert when the score is critical or has
   * dropped by more than the configured delta. Returns the fresh score and
   * the alert disposition so UIs can surface both.
   */
  app.post(
    "/api/admin/health-score/refresh",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const score = await emitHealthScoreMetric(workspace);
        const alertResult = await checkAndAlertHealthScore(workspace);
        const hs = await computeHealthScore(workspace);
        return res.json({ ok: true, score, alert: alertResult, healthScore: hs });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );
}

/**
 * Helper for ops staff to subscribe a workspace to health-score alerts via
 * the existing webhook system.
 *
 * Usage from code: `await subscribeWorkspaceHealthAlerts(workspaceId, url, secret)`.
 * This is intentionally a plain function (not a route) so scripts and
 * provisioning code can call it without going through HTTP.
 *
 * @param {string} workspaceId
 * @param {string} url - HTTPS webhook URL
 * @param {string} [secret] - HMAC signing secret
 * @returns {Promise<{id: string, url: string, events: string[]}>}
 */
export async function subscribeWorkspaceHealthAlerts(workspaceId, url, secret) {
  const { addWebhook } = await import("../lib/webhooks.js");
  return addWebhook({ url, events: ["health_score_alert"], secret }, workspaceId);
}
