/**
 * Flush per-run token totals from the cost accumulator into workspace billing
 * (and optional Stripe metering via billing.recordUsage). Best-effort only.
 */
import { getRunCostAccumulator } from "./agent-cost-emitter.js";

/**
 * @param {{ runId?: string, workspace?: string, model?: string }} args
 * @returns {Promise<{ flushed: boolean, totalTokens?: number }>}
 */
export async function flushRunBilling({ runId, workspace, model }) {
  try {
    const rid = String(runId || "").trim();
    if (!rid) return { flushed: false };
    const acc = getRunCostAccumulator(rid);
    if (!acc || acc.total <= 0) return { flushed: false };
    const { createBillingManager } = await import("./billing.js");
    await createBillingManager().recordUsage(
      workspace || "default",
      { inputTokens: acc.prompt, outputTokens: acc.completion },
      model || "unknown"
    );
    return { flushed: true, totalTokens: acc.total };
  } catch {
    return { flushed: false };
  }
}
