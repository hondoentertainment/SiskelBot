/**
 * Phase 63 usage metering: records billable operations to usage.json and eval-history.
 * Pricing rules can target modelId "pr-review" | "repo-rag" | "test-gen" with unit "call".
 */
import { recordUsage } from "./usage-tracker.js";
import { recordSample } from "./eval-history-store.js";

export const PHASE63_FEATURES = Object.freeze(["pr-review", "repo-rag", "test-gen"]);

/**
 * @param {{ workspaceId?: string, feature: string, calls?: number, units?: number, tags?: Record<string, string> }} input
 */
export async function meterPhase63Operation(input = {}) {
  const feature = String(input.feature || "").trim();
  if (!PHASE63_FEATURES.includes(feature)) return;

  const workspace = String(input.workspaceId || "default").trim() || "default";
  const calls = Math.max(1, Number(input.calls) || 1);
  const units = Math.max(0, Number(input.units) || 0);
  const tags = input.tags && typeof input.tags === "object" ? input.tags : {};

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
}
