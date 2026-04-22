/**
 * Wave-2: Retrieval-augmented planning. Looks up past successful task
 * trajectories that resemble the current user message by Jaccard keyword
 * overlap, then formats the top-K as few-shot examples for the planner.
 *
 * Off by default. Enable via AGENT_PLAN_RAG=1. Works alongside AGENT_UPFRONT_PLAN.
 */
import { listTrajectories, loadTrajectory } from "./agent-trajectory.js";

const MAX_EXAMPLES = 3;
const MIN_JACCARD = 0.1;
const MAX_CANDIDATES = 50;

export function planRetrievalEnabled() {
  return process.env.AGENT_PLAN_RAG === "1";
}

function tokenize(s) {
  if (typeof s !== "string") return new Set();
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Pull the user message and tool-call sequence out of a trajectory snapshot.
 * Returns null when the trajectory is malformed or has no tool calls.
 */
function extractSummary(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const steps = Array.isArray(snapshot.steps) ? snapshot.steps : [];
  if (steps.length === 0) return null;

  let userMessage = "";
  const tools = [];
  let succeeded = false;

  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    if (s.type === "user_message" && typeof s.content === "string") {
      userMessage = userMessage || s.content;
    }
    if (s.type === "tool_call" && typeof s.name === "string") {
      tools.push(s.name);
    }
    if (s.type === "final_answer" || s.type === "complete" || s.type === "done") {
      succeeded = true;
    }
  }

  if (!userMessage || tools.length === 0) return null;
  return { userMessage, tools, succeeded };
}

/**
 * Find up to MAX_EXAMPLES past trajectories that resemble the current request.
 * Returns an array sorted by descending similarity; may be empty.
 *
 * @param {{ userMessage: string, workspace?: string, limit?: number, minJaccard?: number }} opts
 * @returns {Promise<Array<{ userMessage: string, tools: string[], score: number }>>}
 */
export async function findSimilarTrajectories(opts) {
  if (!opts || typeof opts.userMessage !== "string" || !opts.userMessage.trim()) return [];
  const workspace = opts.workspace || "default";
  const limit = Math.min(MAX_CANDIDATES, Math.max(5, Number(opts.limit) || 30));
  const minJ = typeof opts.minJaccard === "number" ? opts.minJaccard : MIN_JACCARD;

  try {
    const { items } = await listTrajectories({ workspace, limit });
    if (!Array.isArray(items) || items.length === 0) return [];
    const queryTokens = tokenize(opts.userMessage);
    if (queryTokens.size === 0) return [];

    const rows = [];
    for (const item of items) {
      const snapshot = await loadTrajectory(item.runId);
      const sum = extractSummary(snapshot);
      if (!sum || !sum.succeeded) continue;
      const score = jaccard(queryTokens, tokenize(sum.userMessage));
      if (score < minJ) continue;
      rows.push({ userMessage: sum.userMessage, tools: sum.tools, score });
    }

    rows.sort((a, b) => b.score - a.score);
    return rows.slice(0, MAX_EXAMPLES);
  } catch {
    return [];
  }
}

/**
 * Format similar trajectories as few-shot examples for injection into the
 * planner prompt. Returns empty string when there are no examples.
 */
export function formatExamplesForPrompt(examples) {
  if (!Array.isArray(examples) || examples.length === 0) return "";
  const lines = ["## Past similar tasks (for reference)"];
  for (const ex of examples) {
    const tools = ex.tools.slice(0, 8).join(" → ");
    const req = String(ex.userMessage).slice(0, 200);
    lines.push(`- Request: ${req}\n  Tool sequence: ${tools}`);
  }
  return lines.join("\n");
}
