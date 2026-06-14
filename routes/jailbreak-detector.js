/**
 * Phase 51.2: Jailbreak / prompt-injection detection routes.
 *
 * POST /api/v1/safety/detect               — body: { prompt, systemPrompt? } → risk
 * POST /api/v1/safety/apply-policy         — body: { prompt, workspaceId }
 * GET  /api/v1/safety/policies/:workspaceId
 * PUT  /api/v1/safety/policies/:workspaceId — admin
 * GET  /api/v1/safety/detections            — detection history
 * GET  /api/v1/safety/stats                 — aggregated detection stats
 */
import {
  classifyRisk,
  detectPromptInjection,
  applyPolicy,
  setWorkspacePolicy,
  getWorkspacePolicy,
  logDetection,
  getDetectionHistory,
  getDetectionStats,
} from "../lib/jailbreak-detector.js";

export function mountJailbreakDetectorRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/safety/detect
  apiRoute("post", "/safety/detect", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.prompt !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "prompt is required");
      }
      const risk = classifyRisk(body.prompt);
      const injection = detectPromptInjection(body.prompt, body.systemPrompt);
      return res.json({ _version: 1, risk, injection });
    } catch (err) {
      return apiError(
        res,
        500,
        "INTERNAL_ERROR",
        err?.message || "safety/detect error",
      );
    }
  });

  // POST /api/v1/safety/apply-policy
  apiRoute("post", "/safety/apply-policy", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.prompt !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "prompt is required");
      }
      const workspaceId = body.workspaceId || "default";
      const risk = classifyRisk(body.prompt);
      const result = await applyPolicy(body.prompt, risk, null, { workspaceId });

      // Persist any non-allow decision to the audit log.
      if (result.action && result.action !== "allow") {
        await logDetection({
          workspaceId,
          userId: req.userId || "anonymous",
          riskScore: risk.riskScore,
          categories: risk.categories,
          action: result.action,
          prompt: body.prompt,
          reason: result.reason,
        });
      }

      return res.json({ _version: 1, risk, result });
    } catch (err) {
      return apiError(
        res,
        500,
        "INTERNAL_ERROR",
        err?.message || "safety/apply-policy error",
      );
    }
  });

  // GET /api/v1/safety/policies/:workspaceId
  apiRoute("get", "/safety/policies/:workspaceId", log, auth, scope("read"), async (req, res) => {
    try {
      const policy = await getWorkspacePolicy(req.params.workspaceId);
      return res.json({ _version: 1, policy });
    } catch (err) {
      return apiError(
        res,
        500,
        "INTERNAL_ERROR",
        err?.message || "safety/policies get error",
      );
    }
  });

  // PUT /api/v1/safety/policies/:workspaceId  (admin)
  apiRoute(
    "put",
    "/safety/policies/:workspaceId",
    log,
    admin,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        const policy = await setWorkspacePolicy(req.params.workspaceId, body);
        return res.json({ _version: 1, policy });
      } catch (err) {
        const status = /required|must be|invalid/i.test(err?.message || "") ? 400 : 500;
        const code = status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
        return apiError(res, status, code, err?.message || "safety/policies put error");
      }
    },
  );

  // GET /api/v1/safety/detections
  apiRoute("get", "/safety/detections", log, auth, scope("read"), async (req, res) => {
    try {
      const filter = {
        workspaceId: req.query.workspaceId ? String(req.query.workspaceId) : undefined,
        since: req.query.since ? Number(req.query.since) : undefined,
        until: req.query.until ? Number(req.query.until) : undefined,
        minScore: req.query.minScore ? Number(req.query.minScore) : undefined,
        action: req.query.action ? String(req.query.action) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      };
      const entries = await getDetectionHistory(filter);
      return res.json({ _version: 1, entries, count: entries.length });
    } catch (err) {
      return apiError(
        res,
        500,
        "INTERNAL_ERROR",
        err?.message || "safety/detections error",
      );
    }
  });

  // GET /api/v1/safety/stats
  apiRoute("get", "/safety/stats", log, auth, scope("read"), async (req, res) => {
    try {
      const timeRange = {
        since: req.query.since ? Number(req.query.since) : undefined,
        until: req.query.until ? Number(req.query.until) : undefined,
        workspaceId: req.query.workspaceId ? String(req.query.workspaceId) : undefined,
      };
      const stats = await getDetectionStats(timeRange);
      return res.json({ _version: 1, stats });
    } catch (err) {
      return apiError(
        res,
        500,
        "INTERNAL_ERROR",
        err?.message || "safety/stats error",
      );
    }
  });
}

export default mountJailbreakDetectorRoutes;
