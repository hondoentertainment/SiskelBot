/**
 * Subagent result quality ranking.
 *
 * When multiple agents produce results for similar goals, these utilities
 * score and rank them so the best result can be selected.
 *
 * Exports:
 *  - heuristicScore(result)          -> number 0..1  (pure, no LLM)
 *  - judgeScore(results, goal, ...)  -> [{result, score}]  (LLM judge, falls back to heuristic)
 *  - rankResults(results, opts?)     -> { ranked: [{result, score, rank}], best: result }
 */

// ---------------------------------------------------------------------------
// Heuristic helpers
// ---------------------------------------------------------------------------

/** Penalty phrases indicating the agent gave up or had no answer. */
const PENALTY_PHRASES = [
  "i don't know",
  "i do not know",
  "unable to",
  "i cannot",
  "i can't",
  "not sure",
  "no information",
  "unfortunately, i",
  "i'm not able",
  "i am not able",
];

/** Regex patterns that indicate specificity (numbers, dates, proper nouns). */
const SPECIFICITY_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,          // ISO dates
  /\b\d+(\.\d+)?%/,                  // percentages
  /\b\d{2,}\b/,                      // numbers with 2+ digits
  /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)+\b/, // proper noun sequences (e.g. "New York")
];

/** Regex patterns that indicate structured content (headings, lists). */
const STRUCTURE_PATTERNS = [
  /^#{1,6}\s/m,                       // markdown headings
  /^\s*[-*]\s/m,                      // unordered list items
  /^\s*\d+\.\s/m,                     // ordered list items
  /^>\s/m,                            // blockquotes
  /```[\s\S]*?```/,                   // code blocks
];

/**
 * Score a single result string using heuristics (no LLM).
 *
 * Dimensions (each 0..1, weighted):
 *  - length       (0.30): longer is more thorough, capped at 2000 chars
 *  - structure    (0.25): headings, lists, code blocks indicate organization
 *  - specificity  (0.25): numbers, dates, proper nouns indicate depth
 *  - error-free   (0.20): absence of "I don't know" / "unable to" phrases
 *
 * @param {string} result
 * @returns {number} score in [0, 1]
 */
export function heuristicScore(result) {
  const text = typeof result === "string" ? result : String(result ?? "");
  if (!text.trim()) return 0;

  // Length score: linear ramp 0..1 capped at 2000 chars
  const LENGTH_CAP = 2000;
  const lengthScore = Math.min(text.length / LENGTH_CAP, 1);

  // Structure score: proportion of structure patterns matched
  let structureHits = 0;
  for (const pat of STRUCTURE_PATTERNS) {
    if (pat.test(text)) structureHits++;
  }
  const structureScore = Math.min(structureHits / STRUCTURE_PATTERNS.length, 1);

  // Specificity score: proportion of specificity patterns matched
  let specificityHits = 0;
  for (const pat of SPECIFICITY_PATTERNS) {
    if (pat.test(text)) specificityHits++;
  }
  const specificityScore = Math.min(specificityHits / SPECIFICITY_PATTERNS.length, 1);

  // Error-free score: 1 if no penalty phrases, decreases with each match
  const lower = text.toLowerCase();
  let penaltyCount = 0;
  for (const phrase of PENALTY_PHRASES) {
    if (lower.includes(phrase)) penaltyCount++;
  }
  const errorFreeScore = Math.max(0, 1 - penaltyCount * 0.25);

  // Weighted sum
  const score =
    lengthScore * 0.30 +
    structureScore * 0.25 +
    specificityScore * 0.25 +
    errorFreeScore * 0.20;

  // Clamp to [0, 1]
  return Math.min(Math.max(score, 0), 1);
}

// ---------------------------------------------------------------------------
// LLM judge
// ---------------------------------------------------------------------------

/**
 * Build the judge prompt for ranking multiple results against a goal.
 * @param {string[]} results
 * @param {string} goal
 * @returns {{ role: string, content: string }[]}
 */
function buildJudgeMessages(results, goal) {
  const numberedResults = results
    .map((r, i) => `--- Result ${i} ---\n${String(r ?? "").slice(0, 6000)}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You are a quality judge. Given a goal and multiple candidate results, " +
        "rank them by quality, correctness, and completeness. " +
        "Reply with ONLY a JSON array: [{\"index\": <number>, \"score\": <0-1 float>, \"reason\": \"<short>\"}]. " +
        "Every index from 0 to N-1 must appear exactly once. Higher score = better result.",
    },
    {
      role: "user",
      content: `Goal: ${String(goal ?? "").slice(0, 2000)}\n\nCandidate results (${results.length} total):\n\n${numberedResults}`,
    },
  ];
}

/**
 * Score results using an LLM judge. Falls back to heuristic on failure.
 *
 * @param {string[]} results - Array of result strings to rank
 * @param {string} goal - The goal/query the results are answering
 * @param {Function} [backendFetch] - fetch-like function for LLM calls
 * @param {{ url?: string, headers?: Record<string, string>, model?: string }} [config]
 * @returns {Promise<{ result: string, score: number }[]>}
 */
export async function judgeScore(results, goal, backendFetch, config) {
  if (!Array.isArray(results) || results.length === 0) return [];

  const fetchFn = backendFetch || globalThis.fetch;
  const cfg = config || {};
  const url = cfg.url || "http://localhost:11434/v1/chat/completions";
  const headers = {
    "Content-Type": "application/json",
    ...(cfg.headers || {}),
  };
  const model = cfg.model || "gpt-4o-mini";

  try {
    const messages = buildJudgeMessages(results, goal);
    const body = {
      model,
      stream: false,
      messages,
    };

    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Judge HTTP ${response.status}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const raw = typeof content === "string" ? content.trim() : "";

    // Extract JSON array from response
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (!arrayMatch) throw new Error("No JSON array in judge response");

    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) throw new Error("Judge response not an array");

    // Validate and normalize scores
    const scoreMap = new Map();
    for (const entry of parsed) {
      const idx = Number(entry.index);
      const score = Number(entry.score);
      if (Number.isFinite(idx) && idx >= 0 && idx < results.length && Number.isFinite(score)) {
        scoreMap.set(idx, Math.min(Math.max(score, 0), 1));
      }
    }

    // Build output, falling back to heuristic for any missing indices
    return results.map((result, i) => ({
      result,
      score: scoreMap.has(i) ? scoreMap.get(i) : heuristicScore(result),
    }));
  } catch {
    // Fall back to heuristic scoring on any failure
    return results.map((result) => ({
      result,
      score: heuristicScore(result),
    }));
  }
}

// ---------------------------------------------------------------------------
// Top-level ranking
// ---------------------------------------------------------------------------

/**
 * Rank an array of results by quality.
 *
 * When `opts.judge` is true and `opts.backendFetch` is provided, uses LLM
 * judge scoring; otherwise falls back to heuristic scoring.
 *
 * @param {string[]} results - Array of result strings
 * @param {{ judge?: boolean, goal?: string, backendFetch?: Function, judgeConfig?: object }} [opts]
 * @returns {Promise<{ ranked: { result: string, score: number, rank: number }[], best: string }>}
 */
export async function rankResults(results, opts) {
  if (!Array.isArray(results) || results.length === 0) {
    return { ranked: [], best: "" };
  }

  const options = opts || {};
  let scored;

  if (options.judge && options.backendFetch) {
    scored = await judgeScore(
      results,
      options.goal || "",
      options.backendFetch,
      options.judgeConfig
    );
  } else {
    scored = results.map((result) => ({
      result,
      score: heuristicScore(result),
    }));
  }

  // Sort descending by score
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  const ranked = sorted.map((entry, i) => ({
    result: entry.result,
    score: entry.score,
    rank: i + 1,
  }));

  return {
    ranked,
    best: ranked[0]?.result ?? "",
  };
}
