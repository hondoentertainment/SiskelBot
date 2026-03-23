/**
 * Phase 92: Resolve per-request agent/swarm tool-loop iteration cap.
 * Client may send agentOptions.maxIterations ≤ server ceiling unless AGENT_MAX_ITERATIONS_IGNORE_CLIENT=1.
 */

/**
 * @param {object} [agentOpts]
 * @param {string|number} [envMaxRaw] - typically process.env.MAX_AGENT_ITERATIONS
 * @returns {number} integer ≥ 1
 */
export function resolveAgentMaxIterations(agentOpts, envMaxRaw) {
  const serverMax = Math.max(1, Number(envMaxRaw) || 5);
  if (process.env.AGENT_MAX_ITERATIONS_IGNORE_CLIENT === "1") {
    return serverMax;
  }
  const raw = agentOpts?.maxIterations;
  if (raw == null || raw === "") return serverMax;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return serverMax;
  return Math.min(Math.floor(n), serverMax);
}
