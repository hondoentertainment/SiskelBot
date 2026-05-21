/**
 * Default Phase 63 pricing rules (idempotent).
 */
import { createPricingRule, listPricingRules } from "./pricing-engine.js";

const DEFAULT_RATE = 0.01;
const FEATURES = Object.freeze(["pr-review", "repo-rag", "test-gen"]);
const DEFAULT_DESCRIPTION = "Phase 63 default";

export async function ensurePhase63PricingRules(workspaceId = "default") {
  const existing = await listPricingRules(workspaceId);
  for (const modelId of FEATURES) {
    const has = existing.some(
      (r) => r.modelId === modelId && r.unit === "call",
    );
    if (has) continue;
    await createPricingRule({
      workspaceId,
      unit: "call",
      rate: DEFAULT_RATE,
      modelId,
      description: DEFAULT_DESCRIPTION,
    });
  }
}
