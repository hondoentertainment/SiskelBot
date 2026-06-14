/**
 * Phase 47.4: Multi-agent consensus routes.
 *
 * POST /api/v1/consensus/execute        — run a consensus query
 * GET  /api/v1/consensus/runs            — list recent runs
 * GET  /api/v1/consensus/runs/:id        — fetch a specific run
 * GET  /api/v1/consensus/byzantine/:id   — Byzantine stats for a single agent
 */
import {
  executeConsensus,
  getConsensusRun,
  listConsensusRuns,
  getByzantineStats,
} from "../lib/agent-consensus.js";

const ALLOWED_STRATEGIES = new Set(["majority_vote", "weighted", "llm_judge", "ranked_choice"]);

export function mountAgentConsensusRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, backendFetch, buildProxyConfig } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/consensus/execute", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        return apiError(res, 400, "INVALID_INPUT", "prompt is required");
      }
      const agents = Array.isArray(body.agents) ? body.agents : [];
      if (agents.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "agents must be a non-empty array");
      }
      if (agents.length > 16) {
        return apiError(res, 400, "INVALID_INPUT", "no more than 16 agents per consensus run");
      }
      const strategy = typeof body.strategy === "string" ? body.strategy : "majority_vote";
      if (!ALLOWED_STRATEGIES.has(strategy)) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          `strategy must be one of: ${[...ALLOWED_STRATEGIES].join(", ")}`,
        );
      }
      const quorum = Number.isFinite(body.quorum) ? Math.max(1, Number(body.quorum)) : 2;
      if (quorum > agents.length) {
        return apiError(res, 400, "INVALID_INPUT", "quorum cannot exceed number of agents");
      }
      const timeout = Number.isFinite(body.timeout) ? Math.max(1, Number(body.timeout)) : undefined;

      const run = await executeConsensus(prompt, {
        agents,
        strategy,
        quorum,
        timeout,
        weights: body.weights,
        judgeModel: body.judgeModel,
        threshold: body.threshold,
        rankings: body.rankings,
        backendFetch,
        buildProxyConfig,
      });

      res.status(run.error ? 200 : 201).json({ _version: 1, ...run });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "consensus failed");
    }
  });

  apiRoute("get", "/consensus/runs", log, auth, scope("read"), async (req, res) => {
    try {
      const limit = req.query?.limit ? Number(req.query.limit) : 50;
      const runs = await listConsensusRuns({ limit });
      res.json({ _version: 1, runs, count: runs.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "list failed");
    }
  });

  apiRoute("get", "/consensus/runs/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const run = await getConsensusRun(req.params.id);
      if (!run) {
        return apiError(res, 404, "NOT_FOUND", `consensus run ${req.params.id} not found`);
      }
      res.json({ _version: 1, ...run });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "fetch failed");
    }
  });

  apiRoute("get", "/consensus/byzantine/:agentId", log, auth, scope("read"), async (req, res) => {
    try {
      const stats = await getByzantineStats(req.params.agentId);
      if (!stats) {
        return apiError(res, 404, "NOT_FOUND", `no consensus history for agent ${req.params.agentId}`);
      }
      res.json({ _version: 1, ...stats });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "fetch failed");
    }
  });
}

export default mountAgentConsensusRoutes;
