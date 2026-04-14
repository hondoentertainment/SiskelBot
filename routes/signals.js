/**
 * Route module: live signals for the chat composer.
 *
 * GET /api/v1/signals/composer — read-only aggregator that surfaces
 * backend, model, rolling cost estimate, p50 latency, quality score,
 * and circuit-breaker state in a single payload for the client-side
 * "signal strip" UI rendered under the chat composer.
 *
 * This is a pure aggregator — no new storage, no new computation.
 * Data sources:
 *   - BACKEND + default model from deps/env
 *   - lib/model-quality.js for latency p50 + quality score
 *   - lib/smart-router.js `getModelCost` for per-model cost config
 *   - lib/usage-tracker.js `getSummary` for rolling token usage
 *   - lib/circuit-breaker.js `isOpen` for breaker state
 *
 * TODO: when a first-class per-request cost field lands in
 * usage-tracker entries, replace the (tokens * cost-per-1K) estimate
 * with the recorded costUsd average.
 */

import { getModelQuality } from "../lib/model-quality.js";
import { getModelCost } from "../lib/smart-router.js";
import { getSummary } from "../lib/usage-tracker.js";
import { isOpen } from "../lib/circuit-breaker.js";

const QUALITY_SCORE_MAX = 100;

function resolveDefaultModel(deps) {
  if (typeof deps?.getDefaultModel === "function") {
    try {
      const m = deps.getDefaultModel();
      if (m) return String(m);
    } catch (_) {}
  }
  const envModel =
    process.env.DEFAULT_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.MODEL;
  if (envModel) return String(envModel);

  const backend = (deps?.BACKEND || process.env.BACKEND || "ollama").toLowerCase();
  const presets = deps?.MODEL_PRESETS || {};
  const candidates = presets[backend];
  if (Array.isArray(candidates) && candidates.length > 0) return candidates[0];

  // Backend-aware fallback.
  if (backend === "openai") return "gpt-4o-mini";
  if (backend === "vllm") return "meta-llama/Llama-3-8B-Instruct";
  return "llama3.2";
}

/**
 * Estimate per-request cost in USD using rolling token average * cost-per-1K.
 * Returns 0 when neither tokens nor costs are known (TODO above).
 */
async function computeEstCostUsd(model) {
  let summary;
  try {
    summary = await getSummary(1); // last 24h rolling window
  } catch (_) {
    return 0;
  }
  const totalReq = summary?.totalRequests || 0;
  if (!totalReq) return 0;
  const totalTokens =
    (summary?.totalInputTokens || 0) + (summary?.totalOutputTokens || 0);
  if (!totalTokens) return 0;
  const avgTokensPerRequest = totalTokens / totalReq;
  const costPer1K = getModelCost(model) || 0;
  if (!costPer1K) return 0;
  return Math.round((avgTokensPerRequest / 1000) * costPer1K * 1_000_000) / 1_000_000;
}

function normalizedQualityScore(model) {
  const q = getModelQuality(model);
  if (!q || !q.sampleCount) return 0;
  const score = Number(q.score) || 0;
  return Math.max(0, Math.min(1, score / QUALITY_SCORE_MAX));
}

function p50LatencyMs(model) {
  const q = getModelQuality(model);
  if (!q || !q.sampleCount) return 0;
  return Math.max(0, Math.round(Number(q.latencyP50) || 0));
}

function breakerState(backend) {
  try {
    const s = isOpen(backend);
    if (s?.open) return "open";
    // lib/circuit-breaker.js does not currently expose half-open transitions;
    // we report "closed" when not open. TODO: expose retryAfterMs / half-open
    // if circuit-breaker.js gains a tri-state API.
    return "closed";
  } catch (_) {
    return "closed";
  }
}

export function mountSignalsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;

  apiRoute("get", "/signals/composer", logRequest, async (req, res) => {
    try {
      const backend = String(
        deps?.BACKEND || process.env.BACKEND || "ollama"
      ).toLowerCase();
      const model = resolveDefaultModel(deps);

      const [estCostUsd] = await Promise.all([computeEstCostUsd(model)]);

      res.json({
        backend,
        model,
        estCostUsd,
        p50LatencyMs: p50LatencyMs(model),
        qualityScore: normalizedQualityScore(model),
        breakerState: breakerState(backend),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      return apiError(
        res,
        500,
        "INTERNAL_ERROR",
        err.message,
        "See docs/RUNBOOK.md."
      );
    }
  });
}

export default mountSignalsRoutes;
