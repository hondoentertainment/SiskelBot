/**
 * Phase 73: Swarm intent routing v2 — embedding similarity vs keyword (rollback via SWARM_INTENT_MODE).
 * Keyword baseline (Phase 15) lives here to avoid circular imports with swarm.js.
 */
import { embed } from "./embeddings.js";

const MODE = (process.env.SWARM_INTENT_MODE || "keyword").trim().toLowerCase();

const RESEARCH_KEYWORDS = [
  "search", "find", "look up", "list", "context", "document", "knowledge",
  "index", "what is", "where is", "how to", "info", "information", "explain",
  "semantic", "similar", "meaning", "related to", "summarize", "sources",
];
const EXECUTE_KEYWORDS = [
  "run", "execute", "build", "deploy", "recipe", "step", "command", "do",
  "run recipe", "execute step", "npm", "vercel", "recipes", "pipeline", "cron",
];

/** @returns {{ researcher: boolean, executor: boolean }} */
export function detectIntentKeyword(message) {
  const text = (message || "").toLowerCase();
  const researcher = RESEARCH_KEYWORDS.some((k) => text.includes(k));
  const executor = EXECUTE_KEYWORDS.some((k) => text.includes(k));
  return {
    researcher: researcher || (!researcher && !executor),
    executor,
  };
}

const ANCHOR_RESEARCH =
  "Search find list documents knowledge context index explain summarize semantic information sources what where how";
const ANCHOR_EXECUTE =
  "Run execute build deploy recipe step command pipeline npm vercel cron do automation";

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

/**
 * @param {string} message
 * @returns {Promise<{ researcher: boolean, executor: boolean, mode: string }>}
 */
async function detectIntentEmbedding(message) {
  const text = (message || "").trim();
  if (!text) {
    return { researcher: true, executor: false, mode: "embedding" };
  }
  const [qVec, rVec, eVec] = await Promise.all([embed(text.slice(0, 2000)), embed(ANCHOR_RESEARCH), embed(ANCHOR_EXECUTE)]);
  if (!qVec || !rVec || !eVec) {
    const k = detectIntentKeyword(message);
    return { ...k, mode: "keyword_fallback" };
  }
  const sr = cosineSim(qVec, rVec);
  const se = cosineSim(qVec, eVec);
  const margin = Number(process.env.SWARM_INTENT_EMBEDDING_MARGIN) || 0.02;
  const researcher = sr >= se - margin || se < sr;
  const executor = se >= sr - margin || sr < se;
  if (!researcher && !executor) {
    return { researcher: true, executor: false, mode: "embedding" };
  }
  return { researcher, executor, mode: "embedding" };
}

/**
 * @param {string} message
 */
export async function detectIntentForSwarm(message) {
  if (MODE === "embedding") {
    return detectIntentEmbedding(message);
  }
  return { ...detectIntentKeyword(message), mode: "keyword" };
}
