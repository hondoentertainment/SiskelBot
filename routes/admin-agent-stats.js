/**
 * Admin routes for agent failure + genealogy observability.
 *
 * Surfaces the data accumulated by:
 *   - lib/agent-failure-store.js  (per-workspace failure-category counts)
 *   - lib/agent-genealogy.js      (per-workspace per-tool success rates)
 *
 * Requires admin auth. Mounted at /api/admin/agent-stats/*.
 */

import {
  loadFailureStats,
  rankChronicFailures,
  resetFailureStats,
} from "../lib/agent-failure-store.js";
import {
  loadToolOutcomes,
  rankByReliability,
  buildReliabilityHint,
  resetGenealogy,
} from "../lib/agent-genealogy.js";
import {
  listConflicts,
  clearConflicts,
} from "../lib/swarm-conflict-store.js";

export default function mountAgentStatsAdminRoutes(app, deps) {
  const { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace } = deps;

  /** GET /api/admin/agent-stats/failures?workspace=X&limit=20 */
  app.get(
    "/api/admin/agent-stats/failures",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 20));
        const [stats, ranked] = await Promise.all([
          loadFailureStats(workspace),
          rankChronicFailures(workspace, limit),
        ]);
        return res.json({
          workspace,
          updatedAt: stats.updatedAt,
          totals: {
            tools: Object.keys(stats.tools || {}).length,
            failures: Object.values(stats.tools || {}).reduce((s, t) => s + (t.total || 0), 0),
          },
          chronic: ranked,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** DELETE /api/admin/agent-stats/failures?workspace=X - reset workspace failures */
  app.delete(
    "/api/admin/agent-stats/failures",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        await resetFailureStats(workspace);
        return res.json({ ok: true, workspace });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/admin/agent-stats/reliability?workspace=X&minSamples=3 */
  app.get(
    "/api/admin/agent-stats/reliability",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const minSamples = Math.max(1, Number(req.query?.minSamples) || 1);
        const stats = await loadToolOutcomes(workspace);
        const ranked = rankByReliability(stats, { minSamples });
        const hint = await buildReliabilityHint(workspace);
        return res.json({
          workspace,
          updatedAt: stats.updatedAt,
          totals: {
            tools: Object.keys(stats.tools || {}).length,
            samples: Object.values(stats.tools || {}).reduce(
              (s, t) => s + (t.successes || 0) + (t.failures || 0),
              0,
            ),
          },
          ranked,
          hint,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** DELETE /api/admin/agent-stats/reliability?workspace=X - reset genealogy */
  app.delete(
    "/api/admin/agent-stats/reliability",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        await resetGenealogy(workspace);
        return res.json({ ok: true, workspace });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/admin/agent-stats/swarm-conflicts?workspace=X&limit=20 */
  app.get(
    "/api/admin/agent-stats/swarm-conflicts",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        const limit = Math.max(1, Math.min(200, Number(req.query?.limit) || 20));
        const events = await listConflicts(workspace, { limit });
        return res.json({ workspace, total: events.length, events });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** DELETE /api/admin/agent-stats/swarm-conflicts?workspace=X - clear log */
  app.delete(
    "/api/admin/agent-stats/swarm-conflicts",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = sanitizeWorkspace(req.query?.workspace || "default");
        await clearConflicts(workspace);
        return res.json({ ok: true, workspace });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );
}
