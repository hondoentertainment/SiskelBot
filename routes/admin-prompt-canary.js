/**
 * Admin routes for prompt-patch canary rollouts.
 *
 * Exposes the state + controls of lib/agent-prompt-canary.js so operators
 * can launch a canary, inspect progress, manually trigger evaluation, and
 * promote or rollback. Auto-evaluation is expected to be wired separately
 * (e.g. via the scheduler) — these routes support the manual path.
 *
 * Requires admin auth. Mounted at /api/admin/prompt-canary/*.
 */

import {
  startCanary,
  getActiveCanary,
  listCanaries,
  evaluateCanary,
  promoteCanary,
  rollbackCanary,
} from "../lib/agent-prompt-canary.js";

export default function mountAdminPromptCanaryRoutes(app, deps) {
  const { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace } = deps;

  /** GET /api/admin/prompt-canary?workspace=X&limit=20 */
  app.get(
    "/api/admin/prompt-canary",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 50));
        const [active, history] = await Promise.all([
          getActiveCanary(workspace),
          listCanaries(workspace, { limit }),
        ]);
        // history already includes active; filter it out so callers see them separately
        const historyOnly = history.filter((d) => d.status !== "active");
        return res.json({ workspace, active: active || null, history: historyOnly });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** POST /api/admin/prompt-canary?workspace=X
   *  body: {candidateVersion, trafficSplit?, durationHours?, metrics?, thresholds?, minSamplesPerArm?}
   */
  app.post(
    "/api/admin/prompt-canary",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const body = req.body || {};
        if (typeof body.candidateVersion !== "string" || body.candidateVersion.length === 0) {
          return apiError(res, 400, "BAD_REQUEST", "candidateVersion required");
        }
        const canary = await startCanary(workspace, {
          candidateVersion: body.candidateVersion,
          trafficSplit: body.trafficSplit,
          durationHours: body.durationHours,
          metrics: body.metrics,
          thresholds: body.thresholds,
          minSamplesPerArm: body.minSamplesPerArm,
        });
        return res.json({ canary });
      } catch (err) {
        const msg = String(err?.message || err);
        if (/already active/i.test(msg)) {
          return apiError(res, 409, "CONFLICT", msg);
        }
        if (/not found|required|rejected/i.test(msg)) {
          return apiError(res, 400, "BAD_REQUEST", msg);
        }
        return apiError(res, 500, "INTERNAL", msg);
      }
    },
  );

  /** POST /api/admin/prompt-canary/promote?workspace=X */
  app.post(
    "/api/admin/prompt-canary/promote",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const canary = await promoteCanary(workspace);
        return res.json({ canary });
      } catch (err) {
        const msg = String(err?.message || err);
        if (/no active canary/i.test(msg)) {
          return apiError(res, 404, "NOT_FOUND", msg);
        }
        return apiError(res, 500, "INTERNAL", msg);
      }
    },
  );

  /** POST /api/admin/prompt-canary/rollback?workspace=X
   *  body: {reason?}
   */
  app.post(
    "/api/admin/prompt-canary/rollback",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
        const canary = await rollbackCanary(workspace, reason);
        return res.json({ canary });
      } catch (err) {
        const msg = String(err?.message || err);
        if (/no active canary/i.test(msg)) {
          return apiError(res, 404, "NOT_FOUND", msg);
        }
        return apiError(res, 500, "INTERNAL", msg);
      }
    },
  );

  /** POST /api/admin/prompt-canary/evaluate?workspace=X */
  app.post(
    "/api/admin/prompt-canary/evaluate",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const decision = await evaluateCanary(workspace);
        return res.json({ workspace, ...decision });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );
}
