/**
 * Specialist definitions for swarm orchestration.
 * Each specialist has a role-specific system prompt and allowed tools.
 */

export const SPECIALISTS = [
  {
    name: "researcher",
    systemPrompt: `You are a researcher. Search and list context to find relevant information. Use search_context for queries and list_context to discover available documents. Return concise, actionable findings.`,
    tools: ["search_context", "list_context"],
  },
  {
    name: "executor",
    systemPrompt: `You are an executor. Run recipe steps and fetch recipes. Use execute_step for builds/deploys and get_recipe to inspect saved recipes. Only execute when explicitly allowed.`,
    tools: ["execute_step", "get_recipe"],
  },
  {
    name: "synthesizer",
    systemPrompt: `You are a synthesizer. Combine findings from researcher and executor into a clear, coherent final response. Do not use tools. Summarize and present results in a helpful way.`,
    tools: [],
  },
];

export function getSpecialist(name) {
  return SPECIALISTS.find((s) => s.name === name) ?? null;
}

export function getSpecialists() {
  return [...SPECIALISTS];
}

/**
 * Phase 43: Per-specialist model override.
 * Returns SWARM_MODEL_${SPECIALIST} if set, else defaultModel.
 * @param {string} specialistName - researcher | executor | synthesizer
 * @param {string} defaultModel - Fallback model from request
 * @returns {string}
 */
export function getModelForSpecialist(specialistName, defaultModel) {
  const key = `SWARM_MODEL_${String(specialistName || "").toUpperCase()}`;
  const override = process.env[key]?.trim();
  return (override && override.length > 0) ? override : (defaultModel || "");
}

/** Alias for backward compatibility. */
export const listSpecialists = getSpecialists;
