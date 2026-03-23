/**
 * Specialist definitions for swarm orchestration.
 * Phase 84: Optional extra specialists from data/specialists-extra.json or SPECIALISTS_EXTRA_PATH.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const BASE_SPECIALISTS = [
  {
    name: "researcher",
    systemPrompt: `You are a researcher. Gather evidence from the workspace knowledge index.
- Start with list_context when the user is exploring or you need document titles.
- Use search_context for exact phrases and keywords; use semantic_search_context for concepts, paraphrases, or when keyword search is thin (needs embedded documents + server embeddings).
- Use get_context_document with a document id when snippets are not enough.
Return concise, actionable findings and cite document ids or titles when grounding matters.`,
    tools: ["search_context", "semantic_search_context", "list_context", "get_context_document"],
  },
  {
    name: "executor",
    systemPrompt: `You are an executor. Run recipe steps and inspect automation.
- Use list_recipes to discover names when the user is vague; then get_recipe for full steps.
- Use execute_step only for builds/deploys/copy when execution is allowed.
Prefer reading recipes before executing.`,
    tools: ["list_recipes", "get_recipe", "execute_step"],
  },
  {
    name: "synthesizer",
    systemPrompt: `You are a synthesizer. Combine researcher and executor outputs into one clear answer. Specialist outputs may include JSON from tools—translate into natural language for the user. Resolve conflicts explicitly. Do not use tools.`,
    tools: [],
  },
];

function loadExtraSpecialists() {
  const p = process.env.SPECIALISTS_EXTRA_PATH?.trim() || join(process.cwd(), "data", "specialists-extra.json");
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const arr = Array.isArray(j?.specialists) ? j.specialists : Array.isArray(j) ? j : [];
    return arr
      .filter((s) => s && typeof s.name === "string" && typeof s.systemPrompt === "string" && Array.isArray(s.tools))
      .map((s) => ({
        name: String(s.name).trim().slice(0, 64),
        systemPrompt: String(s.systemPrompt),
        tools: s.tools.map((t) => String(t)).filter(Boolean),
      }));
  } catch (e) {
    console.warn("[specialists] Failed to load extras:", e.message);
    return [];
  }
}

const _extras = loadExtraSpecialists();
const _merged = [...BASE_SPECIALISTS];
for (const e of _extras) {
  const idx = _merged.findIndex((s) => s.name === e.name);
  if (idx >= 0) _merged[idx] = e;
  else _merged.push(e);
}
export const SPECIALISTS = _merged;

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
  return override && override.length > 0 ? override : defaultModel || "";
}

/** Alias for backward compatibility. */
export const listSpecialists = getSpecialists;
