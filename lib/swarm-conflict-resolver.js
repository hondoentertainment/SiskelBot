/**
 * Swarm conflict resolver.
 *
 * Takes a list of specialist responses from a parallel swarm run and detects
 * where they disagree, categorizes the disagreement type, and produces a
 * structured reconciliation prompt that a judge LLM can use to pick a winner
 * or synthesize a merged answer.
 *
 * Pure functions + Node built-ins only; no storage, no LLM calls. Callers
 * integrate this into swarm aggregation and pass the reconciliation prompt
 * to their judge of choice.
 *
 * @module swarm-conflict-resolver
 */

/**
 * @typedef {object} SpecialistResponse
 * @property {string} specialist
 * @property {string} output
 * @property {boolean} [success]
 */

/**
 * @typedef {"none" | "polarity" | "numeric" | "divergent" | "partial"} ConflictType
 */

/**
 * @typedef {object} ConflictReport
 * @property {boolean} hasConflict
 * @property {ConflictType} conflictType
 * @property {number} similarity - pairwise Jaccard mean (0-1)
 * @property {string[]} polarityCamps - ["affirmative", "negative"] when polarity conflict
 * @property {number[]} numericValues - extracted numbers when numeric conflict
 * @property {string[]} specialists - names of specialists participating
 * @property {string} summary - one-line summary of the disagreement
 */

const TOKEN_RE = /[a-z0-9]+/gi;
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "for", "with", "by", "and", "or", "but",
  "it", "its", "this", "that", "these", "those", "as", "if", "then",
  "from", "not", "no", "do", "does", "did", "have", "has", "had", "will",
  "would", "can", "could", "should", "may", "might", "i", "you", "we",
  "they", "he", "she", "there", "here",
]);

/**
 * Tokenize into lowercase content words (stopwords filtered).
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  if (typeof text !== "string") return new Set();
  const out = new Set();
  const matches = text.match(TOKEN_RE) || [];
  for (const tok of matches) {
    const lower = tok.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (lower.length < 2) continue;
    out.add(lower);
  }
  return out;
}

/**
 * Jaccard similarity on tokenized sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

/**
 * Classify a response as affirmative / negative / unknown polarity.
 * Simple heuristic; deliberately conservative.
 * @param {string} text
 * @returns {"affirmative" | "negative" | "unknown"}
 */
export function classifyPolarity(text) {
  if (typeof text !== "string" || text.length === 0) return "unknown";
  const lower = text.toLowerCase();
  // Look at the first ~200 chars: polarity signals cluster at the start of
  // a decisive answer.
  const head = lower.slice(0, 200);
  const affirm = /\b(yes|correct|true|confirmed|indeed|agree|right)\b/.test(head);
  const negate = /\b(no|not|incorrect|false|disagree|wrong|cannot|can't|won't|shouldn't)\b/.test(head);
  if (affirm && !negate) return "affirmative";
  if (negate && !affirm) return "negative";
  return "unknown";
}

/**
 * Extract leading numeric answers (integers or decimals). Used to detect
 * numeric disagreement between specialists answering a quantitative question.
 * @param {string} text
 * @returns {number[]}
 */
export function extractNumbers(text) {
  if (typeof text !== "string") return [];
  const out = [];
  // Only look at the first ~400 chars so we don't pick up references deep
  // in a long response.
  const head = text.slice(0, 400);
  const re = /-?\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(head)) !== null) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) out.push(n);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Detect conflicts across a set of specialist responses.
 *
 * @param {SpecialistResponse[]} responses
 * @param {object} [opts]
 * @param {number} [opts.divergenceThreshold=0.25] - mean Jaccard below this triggers "divergent"
 * @param {number} [opts.partialThreshold=0.55] - below this but above divergenceThreshold triggers "partial"
 * @returns {ConflictReport}
 */
export function detectConflicts(responses, opts = {}) {
  const divergenceThreshold = typeof opts.divergenceThreshold === "number" ? opts.divergenceThreshold : 0.25;
  const partialThreshold = typeof opts.partialThreshold === "number" ? opts.partialThreshold : 0.55;

  const successful = Array.isArray(responses)
    ? responses.filter((r) => r && typeof r.output === "string" && r.output.length > 0)
    : [];
  const base = {
    hasConflict: false,
    conflictType: /** @type {ConflictType} */ ("none"),
    similarity: 1,
    polarityCamps: [],
    numericValues: [],
    specialists: successful.map((r) => r.specialist || "unknown"),
    summary: "",
  };

  if (successful.length < 2) return base;

  // Polarity disagreement: any two specialists with opposing polarity signals
  const polarities = successful.map((r) => classifyPolarity(r.output));
  const hasAffirm = polarities.includes("affirmative");
  const hasNegate = polarities.includes("negative");
  if (hasAffirm && hasNegate) {
    return {
      ...base,
      hasConflict: true,
      conflictType: "polarity",
      polarityCamps: ["affirmative", "negative"],
      similarity: meanPairwiseJaccard(successful),
      summary: `Specialists disagree on yes/no across ${successful.length} responses`,
    };
  }

  // Numeric disagreement: if multiple specialists produced a leading number
  // and the numbers differ
  const firstNumbers = successful.map((r) => extractNumbers(r.output)[0]).filter((n) => Number.isFinite(n));
  if (firstNumbers.length >= 2) {
    const uniq = new Set(firstNumbers);
    if (uniq.size >= 2) {
      return {
        ...base,
        hasConflict: true,
        conflictType: "numeric",
        numericValues: [...uniq],
        similarity: meanPairwiseJaccard(successful),
        summary: `Specialists returned ${uniq.size} different numeric answers: ${[...uniq].join(", ")}`,
      };
    }
  }

  // Otherwise use lexical similarity as a coarse divergence signal.
  const similarity = meanPairwiseJaccard(successful);
  if (similarity < divergenceThreshold) {
    return {
      ...base,
      hasConflict: true,
      conflictType: "divergent",
      similarity,
      summary: `Specialists produced divergent content (mean similarity ${similarity.toFixed(2)})`,
    };
  }
  if (similarity < partialThreshold) {
    return {
      ...base,
      hasConflict: true,
      conflictType: "partial",
      similarity,
      summary: `Specialists partially agree (mean similarity ${similarity.toFixed(2)})`,
    };
  }

  return { ...base, similarity };
}

/**
 * Build a prompt for a judge LLM that asks it to resolve the detected
 * conflict. Returns null when there's no conflict to resolve.
 *
 * @param {SpecialistResponse[]} responses
 * @param {ConflictReport} report
 * @param {object} [opts]
 * @param {number} [opts.maxChars=2000] - per-response truncation cap
 * @returns {string | null}
 */
export function buildReconciliationPrompt(responses, report, opts = {}) {
  if (!report || !report.hasConflict) return null;
  const maxChars = Number(opts.maxChars) || 2000;

  const lines = [];
  lines.push(
    "Multiple specialist agents produced conflicting answers. Review each response, explain which one is best supported by evidence, and either pick the strongest answer or synthesize a merged response that is well-supported.",
  );
  lines.push(`Conflict type: ${report.conflictType}.`);
  if (report.conflictType === "polarity") {
    lines.push("Some specialists are affirmative and others are negative on the core question. Decide the correct polarity first, then justify.");
  } else if (report.conflictType === "numeric") {
    lines.push(`Specialists returned different numbers: ${report.numericValues.join(", ")}. Pick the right one and explain how you verified it.`);
  } else if (report.conflictType === "divergent") {
    lines.push("The specialists answered different questions or used different framings. Reconcile what the user actually asked and pick the best-grounded response.");
  } else if (report.conflictType === "partial") {
    lines.push("Specialists broadly agree but differ on details. Merge the consistent parts and flag the differences.");
  }

  lines.push("");
  lines.push("Specialist responses:");

  const successful = responses.filter((r) => r && typeof r.output === "string");
  for (let i = 0; i < successful.length; i++) {
    const r = successful[i];
    const name = r.specialist || `specialist_${i + 1}`;
    const truncated = r.output.length > maxChars ? `${r.output.slice(0, maxChars)}…[truncated]` : r.output;
    lines.push(`--- ${name} ---`);
    lines.push(truncated);
    lines.push("");
  }

  lines.push("Respond with a concise reconciliation: 1) the winning / merged answer, 2) which specialists agree with it and which were wrong, 3) one sentence of justification.");
  return lines.join("\n");
}

/**
 * Convenience: detect + prompt in one call. Returns null when no conflict.
 *
 * @param {SpecialistResponse[]} responses
 * @param {object} [opts]
 * @returns {{ report: ConflictReport; prompt: string } | null}
 */
export function analyzeSwarmConflicts(responses, opts = {}) {
  const report = detectConflicts(responses, opts);
  if (!report.hasConflict) return null;
  const prompt = buildReconciliationPrompt(responses, report, opts);
  if (!prompt) return null;
  return { report, prompt };
}

/**
 * Call a judge function to resolve a detected conflict. Expects the judge to
 * return a string (typically LLM completion text). The judge is passed the
 * reconciliation prompt built from the responses + report.
 *
 * Behavior:
 *   - No conflict -> returns null (caller should keep original aggregation).
 *   - judgeFn throws or times out -> returns { error, prompt, report } so the
 *     caller can still surface the conflict metadata without a resolution.
 *   - judgeFn returns text -> returns { reconciled: text, prompt, report }.
 *
 * @param {object} params
 * @param {SpecialistResponse[]} params.responses
 * @param {(prompt: string) => (Promise<string> | string)} params.judgeFn
 * @param {object} [params.opts]
 * @param {number} [params.opts.timeoutMs=30000]
 * @returns {Promise<null | { reconciled?: string; error?: string; prompt: string; report: ConflictReport }>}
 */
export async function resolveConflictWithJudge({ responses, judgeFn, opts = {} }) {
  if (typeof judgeFn !== "function") return null;
  const analysis = analyzeSwarmConflicts(responses, opts);
  if (!analysis) return null;
  const timeoutMs = Number(opts.timeoutMs) || 30_000;

  try {
    const reconciled = await withTimeout(
      Promise.resolve().then(() => judgeFn(analysis.prompt)),
      timeoutMs,
    );
    const text = typeof reconciled === "string" ? reconciled.trim() : "";
    if (!text) {
      return { prompt: analysis.prompt, report: analysis.report, error: "judge returned empty output" };
    }
    return { reconciled: text, prompt: analysis.prompt, report: analysis.report };
  } catch (err) {
    return {
      prompt: analysis.prompt,
      report: analysis.report,
      error: String(err?.message || err),
    };
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`judge timeout after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/* -------------------------------------------------------------------------- */

function meanPairwiseJaccard(responses) {
  if (responses.length < 2) return 1;
  const tokens = responses.map((r) => tokenize(r.output));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      sum += jaccard(tokens[i], tokens[j]);
      count++;
    }
  }
  return count === 0 ? 1 : sum / count;
}
