/**
 * Phase 63 usage metering: records billable operations to usage.json and eval-history.
 * Pricing rules can target modelId "pr-review" | "repo-rag" | "test-gen" with unit "call".
 */
import { recordUsage } from "./usage-tracker.js";
import { recordSample } from "./eval-history-store.js";
import { recordShadowSample } from "./eval-in-prod.js";
import { ensurePhase63PricingRules } from "./phase63-pricing.js";

export const PHASE63_FEATURES = Object.freeze(["pr-review", "repo-rag", "test-gen"]);

function hasQualitySignal(tags, metadata) {
  const merged = { ...(tags || {}), ...(metadata || {}) };
  return merged.qualitySignal != null;
}

function responsesFromQualitySignal(qualitySignal, fallback) {
  if (qualitySignal && typeof qualitySignal === "object" && !Array.isArray(qualitySignal)) {
    return {
      prodResponse: qualitySignal.prod ?? qualitySignal.prodResponse ?? fallback,
      candidateResponse: qualitySignal.candidate ?? qualitySignal.candidateResponse ?? fallback,
    };
  }
  return { prodResponse: qualitySignal ?? fallback, candidateResponse: qualitySignal ?? fallback };
}

/** Record an eval-in-prod shadow sample for Phase 63 regression tracking. */
export async function recordPhase63QualitySample({
  workspaceId,
  subject,
  prodResponse,
  candidateResponse,
  metadata = {},
} = {}) {
  return recordShadowSample({
    workspaceId,
    prodModel: subject,
    candidateModel: subject,
    prodResponse,
    candidateResponse,
    metadata: { subject, suite: "phase63", ...metadata },
  });
}

/**
 * @param {{ workspaceId?: string, feature: string, calls?: number, units?: number, tags?: Record<string, string>, metadata?: Record<string, unknown> }} input
 */
export async function meterPhase63Operation(input = {}) {
  const feature = String(input.feature || "").trim();
  if (!PHASE63_FEATURES.includes(feature)) return;

  const workspace = String(input.workspaceId || "default").trim() || "default";
  const calls = Math.max(1, Number(input.calls) || 1);
  const units = Math.max(0, Number(input.units) || 0);
  const tags = input.tags && typeof input.tags === "object" ? input.tags : {};
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const fallbackPayload = { calls, units };

  await ensurePhase63PricingRules(workspace).catch(() => {});

  await recordUsage({
    workspace,
    model: feature,
    backend: "phase63",
    inputTokens: units,
    outputTokens: 0,
    calls,
    feature,
  }).catch(() => {});

  await recordSample(workspace, {
    ts: Date.now(),
    kind: "custom",
    suite: "phase63",
    metrics: { calls, units },
    tags: { feature, ...tags },
  }).catch(() => {});

  if (hasQualitySignal(tags, metadata)) {
    const merged = { ...tags, ...metadata };
    const { prodResponse, candidateResponse } = responsesFromQualitySignal(
      merged.qualitySignal,
      fallbackPayload,
    );
    await recordPhase63QualitySample({
      workspaceId: workspace,
      subject: feature,
      prodResponse,
      candidateResponse,
      metadata: merged,
    }).catch(() => {});
  }
}
