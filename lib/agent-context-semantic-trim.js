/**
 * Relevance-aware context trimming. Instead of dropping the oldest tool
 * rounds first, score each round by similarity to the current user goal
 * and drop the least relevant rounds until the token budget is met.
 *
 * Enabled when AGENT_SEMANTIC_TRIM=1. Degrades gracefully to the
 * recency-based trimmer in agent-context-trim.js when disabled or when
 * scoring fails.
 */

import { estimateMessagesTokens } from "./token-counter.js";

const MIN_KEYWORD_LENGTH = 3;

export function semanticTrimEnabled() {
  return process.env.AGENT_SEMANTIC_TRIM === "1";
}

function extractKeywords(text) {
  if (typeof text !== "string") return [];
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= MIN_KEYWORD_LENGTH),
  )];
}

/**
 * Compute Jaccard-style similarity between the round text and the user goal.
 * Lightweight and deterministic; works without any embedding backend.
 *
 * @param {string} roundText
 * @param {string[]} goalKeywords
 * @returns {number} 0..1
 */
export function scoreRoundRelevance(roundText, goalKeywords) {
  if (!roundText || !Array.isArray(goalKeywords) || goalKeywords.length === 0) return 0;
  const text = String(roundText).toLowerCase();
  let hits = 0;
  for (const kw of goalKeywords) {
    if (text.includes(kw)) hits++;
  }
  return hits / goalKeywords.length;
}

function segmentMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const segments = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const assistant = m;
      i++;
      const tools = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        tools.push(messages[i]);
        i++;
      }
      segments.push({ type: "tool_round", assistant, tools, index: segments.length });
    } else {
      segments.push({ type: "simple", msg: m, index: segments.length });
      i++;
    }
  }
  return segments;
}

function flattenSegments(segments) {
  const out = [];
  for (const s of segments) {
    if (s.type === "simple") out.push(s.msg);
    else out.push(s.assistant, ...s.tools);
  }
  return out;
}

function roundTextForScoring(round) {
  const assistantText = Array.isArray(round.assistant?.tool_calls)
    ? round.assistant.tool_calls.map((tc) => `${tc?.function?.name || ""} ${tc?.function?.arguments || ""}`).join(" ")
    : String(round.assistant?.content || "");
  const toolText = round.tools.map((t) => String(t?.content || "")).join(" ");
  return `${assistantText} ${toolText}`;
}

/**
 * Trim messages to fit within a token budget by dropping the least relevant
 * tool rounds first. Preserves system messages and the latest user message.
 *
 * @param {object[]} messages
 * @param {{ budget: number, userGoal: string }} opts
 * @returns {{ trimmedMessages: object[], tokensBefore: number, tokensAfter: number, roundsRemoved: number }}
 */
export function trimBySemanticRelevance(messages, opts) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { trimmedMessages: messages || [], tokensBefore: 0, tokensAfter: 0, roundsRemoved: 0 };
  }
  const budget = Math.max(0, Math.floor(Number(opts?.budget) || 0));
  const userGoal = String(opts?.userGoal || "");
  const tokensBefore = estimateMessagesTokens(messages);

  if (budget <= 0 || tokensBefore <= budget) {
    return { trimmedMessages: [...messages], tokensBefore, tokensAfter: tokensBefore, roundsRemoved: 0 };
  }

  const segments = segmentMessages(messages);
  const goalKeywords = extractKeywords(userGoal);

  // Score each tool_round; simple segments (system/user/assistant-text) are
  // never candidates for removal in this pass.
  const scored = segments
    .filter((s) => s.type === "tool_round")
    .map((s) => ({
      index: s.index,
      relevance: scoreRoundRelevance(roundTextForScoring(s), goalKeywords),
    }))
    .sort((a, b) => a.relevance - b.relevance);

  const removedIndices = new Set();
  let roundsRemoved = 0;
  const segmentsByIndex = new Map(segments.map((s) => [s.index, s]));

  for (const candidate of scored) {
    const remaining = segments.filter((s) => !removedIndices.has(s.index));
    if (estimateMessagesTokens(flattenSegments(remaining)) <= budget) break;
    removedIndices.add(candidate.index);
    roundsRemoved++;
  }

  const finalSegments = segments.filter((s) => !removedIndices.has(s.index));
  const trimmed = flattenSegments(finalSegments);
  return { trimmedMessages: trimmed, tokensBefore, tokensAfter: estimateMessagesTokens(trimmed), roundsRemoved };
}
