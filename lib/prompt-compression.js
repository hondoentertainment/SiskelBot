/**
 * Phase 58.3: Prompt compression.
 *
 * Heuristic LLMLingua-style compressor: drops stopwords, collapses
 * whitespace, and prunes low-importance sentences until the estimated token
 * budget is met. Disabled unless PROMPT_COMPRESSION=1 (or caller opts in
 * explicitly).
 *
 * No ML dependencies. Token estimation uses a conservative chars/4 rule.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "so", "if", "then", "because", "for",
  "of", "in", "on", "at", "by", "to", "from", "with", "without", "into", "onto",
  "up", "down", "over", "under", "about", "as", "is", "am", "are", "was", "were",
  "be", "been", "being", "do", "does", "did", "doing", "have", "has", "had",
  "having", "will", "would", "should", "could", "may", "might", "must", "shall",
  "this", "that", "these", "those", "it", "its", "i", "you", "he", "she", "we",
  "they", "them", "us", "me", "him", "her", "my", "your", "our", "their",
  "there", "here", "what", "which", "who", "whom", "whose", "where", "when",
  "how", "why", "not", "no", "yes", "also", "just", "only", "very", "much",
  "many", "some", "any", "all", "each", "every", "few", "more", "most", "less",
]);

/**
 * Estimate the number of tokens in a string. Uses the chars/4 heuristic which
 * is roughly accurate for English text with BPE tokenizers.
 */
export function estimateTokens(text) {
  if (typeof text !== "string") return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Compression modes (lightest → most aggressive):
 *   "whitespace" — collapse multi-space and blank lines only
 *   "stopwords"  — also drop English stopwords
 *   "sentences"  — additionally prune low-importance sentences by length and keyword density
 *   "auto"       — pick mode to meet `targetTokens`
 */
export const COMPRESSION_MODES = Object.freeze(["whitespace", "stopwords", "sentences", "auto"]);

function compressWhitespace(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function dropStopwords(text) {
  return text
    .split(/(\s+)/)
    .filter((tok) => {
      if (/^\s+$/.test(tok)) return true;
      const clean = tok.toLowerCase().replace(/[^a-z']/g, "");
      if (clean && STOPWORDS.has(clean)) return false;
      return true;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scoreSentence(s, keywords) {
  // Higher = more important.
  let score = 0;
  const words = s.split(/\s+/);
  score += Math.min(40, words.length); // longer sentences up to a cap
  // Boost for explicit keywords.
  for (const k of keywords) {
    if (s.toLowerCase().includes(k.toLowerCase())) score += 20;
  }
  // Boost for numbers / code / identifiers (usually semantically loaded).
  if (/\d/.test(s)) score += 5;
  if (/`[^`]+`/.test(s)) score += 10;
  if (/[A-Z][a-zA-Z]{3,}/.test(s)) score += 2;
  return score;
}

function pruneSentences(text, targetTokens, keywords) {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return text;
  const scored = sentences.map((s, i) => ({ s, i, score: scoreSentence(s, keywords) }));
  scored.sort((a, b) => a.score - b.score);
  let currentTokens = estimateTokens(text);
  const dropped = new Set();
  let idx = 0;
  while (currentTokens > targetTokens && idx < scored.length - 1) {
    dropped.add(scored[idx].i);
    currentTokens -= estimateTokens(scored[idx].s);
    idx += 1;
  }
  return sentences.filter((_, i) => !dropped.has(i)).join(" ");
}

/**
 * Compress a prompt.
 *
 * @param {string} text
 * @param {{ mode?: string, targetTokens?: number, model?: string, keywords?: string[] }} [options]
 * @returns {{ text: string, mode: string, originalTokens: number, compressedTokens: number, ratio: number, droppedTokens: number }}
 */
export function compressPrompt(text, options = {}) {
  if (typeof text !== "string") throw new Error("text must be a string");
  const enabled = options.force || process.env.PROMPT_COMPRESSION === "1";
  const originalTokens = estimateTokens(text);
  if (!enabled) {
    return {
      text,
      mode: "disabled",
      originalTokens,
      compressedTokens: originalTokens,
      ratio: 1,
      droppedTokens: 0,
    };
  }
  const mode = COMPRESSION_MODES.includes(options.mode) ? options.mode : "auto";
  const keywords = Array.isArray(options.keywords) ? options.keywords : [];
  const target = Number(options.targetTokens) || 0;

  let out = compressWhitespace(text);
  let effectiveMode = "whitespace";

  if (mode === "stopwords" || mode === "sentences" || (mode === "auto" && (target === 0 || estimateTokens(out) > target))) {
    out = dropStopwords(out);
    effectiveMode = "stopwords";
  }

  if (mode === "sentences" || (mode === "auto" && target > 0 && estimateTokens(out) > target)) {
    out = pruneSentences(out, target, keywords);
    effectiveMode = "sentences";
  }

  const compressedTokens = estimateTokens(out);
  return {
    text: out,
    mode: effectiveMode,
    originalTokens,
    compressedTokens,
    ratio: originalTokens ? compressedTokens / originalTokens : 1,
    droppedTokens: Math.max(0, originalTokens - compressedTokens),
  };
}

/**
 * Estimate savings without mutating the caller's input. Returns the same
 * report shape as compressPrompt but always evaluates.
 */
export function estimateSavings(text, options = {}) {
  return compressPrompt(text, { ...options, force: true });
}

export const _internals = { compressWhitespace, dropStopwords, splitSentences, pruneSentences, scoreSentence, STOPWORDS };
