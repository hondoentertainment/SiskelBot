/**
 * Phase 73.5: Post-mortem generator from trajectory + optional log lines.
 */
import { trajectorySignature } from "./trajectory-anomaly.js";

/**
 * @param {{
 *   runId?: string,
 *   workspace?: string,
 *   stopReason?: string,
 *   iteration?: number,
 *   toolCalls?: Array<{ name?: string, ok?: boolean, error?: string }>,
 *   content?: string,
 *   logs?: string[],
 * }} input
 */
export function generatePostMortem(input = {}) {
  const tools = Array.isArray(input.toolCalls) ? input.toolCalls : [];
  const failed = tools.filter((t) => t.ok === false);
  const names = [...new Set(tools.map((t) => t.name).filter(Boolean))];
  const sig = trajectorySignature(input);
  const logs = Array.isArray(input.logs) ? input.logs.slice(-20) : [];

  const timeline = tools.slice(0, 40).map((t, i) => ({
    step: i + 1,
    tool: t.name || "unknown",
    ok: t.ok !== false,
    error: t.error || null,
  }));

  const rootCauses = [];
  if (input.stopReason === "stagnation") rootCauses.push("Repeated identical tool calls with no progress");
  if (input.stopReason === "tool_budget" || input.stopReason === "budget_exceeded") {
    rootCauses.push("Tool or cost budget exhausted");
  }
  if (failed.length) rootCauses.push(`${failed.length} tool call(s) failed`);
  if (!rootCauses.length && input.stopReason && input.stopReason !== "complete") {
    rootCauses.push(`Stopped with reason: ${input.stopReason}`);
  }
  if (!rootCauses.length) rootCauses.push("Run completed without an explicit failure signal");

  const recommendations = [];
  if (failed.length) recommendations.push("Inspect failing tool arguments and workspace policy denials");
  if (input.stopReason === "stagnation") {
    recommendations.push("Enable stagnation recovery or narrow the tool allowlist");
  }
  if ((input.iteration || 0) > 8) recommendations.push("Add an upfront plan or reduce max iterations");
  if (!recommendations.length) recommendations.push("Capture a golden trace for regression coverage");

  return {
    runId: input.runId || null,
    workspace: input.workspace || "default",
    signature: sig,
    summary: `Run ${input.runId || "(anonymous)"} stopped (${input.stopReason || "unknown"}) after ${input.iteration || 0} iteration(s); ${tools.length} tool call(s), ${failed.length} failed.`,
    rootCauses,
    recommendations,
    toolsUsed: names,
    timeline,
    recentLogs: logs,
    generatedAt: new Date().toISOString(),
  };
}
