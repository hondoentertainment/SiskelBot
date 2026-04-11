// @ts-check
/**
 * Phase 63.2: PR review agent.
 *
 * Analyzes a unified diff and emits inline comment suggestions. Supports:
 *   - `reviewDiff(diff, opts)` — parse diff, run rules, persist suggestions
 *   - `listSuggestions(reviewId)` — fetch suggestions
 *   - `applySuggestion(id)` / `dismissSuggestion(id)` — lifecycle
 *   - `listRules()` — list built-in rules
 *
 * Rule-based checks: TODO detection, magic numbers, `console.log` leftovers,
 * trailing whitespace, long lines, empty catch blocks, var usage.
 *
 * @module pr-review
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function reviewsPath() {
  return join(getDataDir(), "pr-reviews.json");
}

async function loadReviews() {
  const data = await readJsonPath(reviewsPath(), { version: STORE_VERSION, reviews: {} });
  if (!data.reviews || typeof data.reviews !== "object") data.reviews = {};
  return data;
}

async function saveReviews(data) {
  await writeJsonPath(reviewsPath(), { version: STORE_VERSION, reviews: data.reviews || {} });
}

/* -------------------------------------------------------------------------- */
/* Diff parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Parse a unified diff into a list of added-line records.
 *
 * @param {string} diff
 * @returns {Array<{ file: string, line: number, content: string }>}
 */
export function parseDiff(diff) {
  if (typeof diff !== "string" || !diff) return [];
  const out = [];
  const lines = diff.split(/\r?\n/);
  let currentFile = "";
  let newLine = 0;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const m = line.match(/^\+\+\+ [ab]\/(.+)$/) || line.match(/^\+\+\+ (.+)$/);
      if (m) currentFile = m[1];
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      inHunk = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || !currentFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      out.push({ file: currentFile, line: newLine, content: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // removed line: don't increment newLine
    } else {
      newLine += 1;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

const RULES = [
  {
    id: "todo",
    name: "TODO / FIXME marker",
    severity: "info",
    check(line) {
      if (/\b(TODO|FIXME|XXX|HACK)\b/.test(line.content)) {
        return { message: "Tracking marker found — consider linking an issue." };
      }
      return null;
    },
  },
  {
    id: "magic_number",
    name: "Magic number",
    severity: "warning",
    check(line) {
      // ignore 0, 1, -1, 2 (common indices), look for bare numeric literal
      const m = line.content.match(/[^a-zA-Z0-9_.]([2-9]\d{2,}|\d{4,})\b/);
      if (m) return { message: `Magic number "${m[1]}" — consider a named constant.` };
      return null;
    },
  },
  {
    id: "console_log",
    name: "console.log leftover",
    severity: "warning",
    check(line) {
      if (/\bconsole\.log\b/.test(line.content)) {
        return { message: "Avoid committing console.log statements." };
      }
      return null;
    },
  },
  {
    id: "trailing_ws",
    name: "Trailing whitespace",
    severity: "info",
    check(line) {
      if (/\s+$/.test(line.content)) {
        return { message: "Trailing whitespace." };
      }
      return null;
    },
  },
  {
    id: "long_line",
    name: "Line too long",
    severity: "info",
    check(line) {
      if (line.content.length > 120) {
        return { message: `Line length ${line.content.length} > 120 chars.` };
      }
      return null;
    },
  },
  {
    id: "empty_catch",
    name: "Empty catch block",
    severity: "warning",
    check(line) {
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line.content)) {
        return { message: "Empty catch block — consider logging or rethrowing." };
      }
      return null;
    },
  },
  {
    id: "var_usage",
    name: "var used instead of let/const",
    severity: "info",
    check(line) {
      if (/^\s*var\s+/.test(line.content)) {
        return { message: "Prefer const/let over var." };
      }
      return null;
    },
  },
];

/** List built-in rules. */
export function listRules() {
  return RULES.map((r) => ({ id: r.id, name: r.name, severity: r.severity }));
}

/* -------------------------------------------------------------------------- */
/* Review                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Review a diff by running rules against each added line.
 *
 * @param {string} diff
 * @param {object} [opts]
 * @returns {Promise<{ reviewId: string, suggestions: Array<object> }>}
 */
export async function reviewDiff(diff, opts = {}) {
  if (typeof diff !== "string") throw new Error("diff must be a string");
  const parsed = parseDiff(diff);
  const enabled = Array.isArray(opts.rules) ? new Set(opts.rules) : null;
  const suggestions = [];
  for (const line of parsed) {
    for (const rule of RULES) {
      if (enabled && !enabled.has(rule.id)) continue;
      const hit = rule.check(line);
      if (hit) {
        suggestions.push({
          id: `sug_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}_${rule.id}`,
          ruleId: rule.id,
          severity: rule.severity,
          file: line.file,
          line: line.line,
          message: hit.message,
          content: line.content,
          status: "open",
        });
      }
    }
  }
  const reviewId = opts.reviewId || `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await withPathLock(reviewsPath(), async () => {
    const data = await loadReviews();
    data.reviews[reviewId] = {
      id: reviewId,
      title: opts.title || "",
      author: opts.author || "",
      diff: opts.keepDiff === false ? "" : diff,
      suggestions,
      createdAt: now,
      updatedAt: now,
    };
    await saveReviews(data);
  });
  return { reviewId, suggestions };
}

/**
 * List all suggestions for a given review.
 *
 * @param {string} reviewId
 * @returns {Promise<Array<object>>}
 */
export async function listSuggestions(reviewId) {
  if (!reviewId) return [];
  const data = await loadReviews();
  const r = data.reviews[reviewId];
  if (!r) return [];
  return r.suggestions || [];
}

async function updateSuggestionStatus(id, status) {
  const path = reviewsPath();
  return withPathLock(path, async () => {
    const data = await loadReviews();
    for (const review of Object.values(data.reviews)) {
      const rv = /** @type {any} */ (review);
      if (!Array.isArray(rv.suggestions)) continue;
      const sug = rv.suggestions.find((s) => s.id === id);
      if (sug) {
        sug.status = status;
        sug.updatedAt = new Date().toISOString();
        await saveReviews(data);
        return sug;
      }
    }
    return null;
  });
}

/**
 * Mark a suggestion as applied.
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function applySuggestion(id) {
  if (!id) throw new Error("id is required");
  return updateSuggestionStatus(id, "applied");
}

/**
 * Mark a suggestion as dismissed.
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function dismissSuggestion(id) {
  if (!id) throw new Error("id is required");
  return updateSuggestionStatus(id, "dismissed");
}

/** List all reviews (metadata only). */
export async function listReviews() {
  const data = await loadReviews();
  return Object.values(data.reviews).map((r) => ({
    id: /** @type {any} */ (r).id,
    title: /** @type {any} */ (r).title,
    author: /** @type {any} */ (r).author,
    createdAt: /** @type {any} */ (r).createdAt,
    suggestionCount: /** @type {any} */ (r).suggestions?.length || 0,
  }));
}
