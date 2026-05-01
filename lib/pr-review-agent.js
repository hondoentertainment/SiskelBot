/**
 * Phase 63.2: PR review agent.
 *
 * Parses a unified diff and runs heuristic rules over newly added lines to
 * produce a list of review comments. Deterministic, no LLM required — intended
 * as a first-pass linter that a human reviewer then augments.
 *
 * Storage layout:
 *   data/pr-review/{workspaceId}.json
 *     { reviews: [{ reviewId, createdAt, comments: [...] }] }
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_REVIEWS_PER_WORKSPACE = 500;

export const BUILTIN_RULES = Object.freeze([
  { id: "no-console-log", severity: "warn", description: "Added console.log call in diff" },
  { id: "todo-fixme", severity: "info", description: "Added TODO/FIXME comment" },
  { id: "long-function", severity: "warn", description: "Added function body longer than 50 lines" },
  { id: "missing-test", severity: "info", description: "Source file changed without a corresponding test change" },
  { id: "dangerous-eval", severity: "error", description: "Added eval(...) or new Function(...) — unsafe" },
]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath(workspaceId) {
  return join(getDataDir(), "pr-review", `${sanitizeId(workspaceId)}.json`);
}

/**
 * Parse a unified diff string into a list of hunks with per-file, per-line
 * added lines. This is intentionally simple — it does NOT attempt to preserve
 * full diff semantics, only enough to run rules against added content.
 *
 * Returns:
 *   [{ file, addedLines: [{ line, content }] }]
 */
export function parseDiff(diff) {
  const files = [];
  if (typeof diff !== "string" || !diff) return files;
  const lines = diff.split(/\r?\n/);
  let current = null;
  let newLineNum = 0;
  let inHunk = false;
  for (const raw of lines) {
    if (raw.startsWith("+++ ")) {
      const fileName = raw.slice(4).replace(/^b\//, "").trim();
      if (fileName === "/dev/null") {
        current = null;
      } else {
        current = { file: fileName, addedLines: [] };
        files.push(current);
      }
      inHunk = false;
      continue;
    }
    if (raw.startsWith("--- ")) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith("@@")) {
      // e.g. @@ -12,7 +34,9 @@
      const m = raw.match(/\+([0-9]+)(?:,([0-9]+))?/);
      newLineNum = m ? Number(m[1]) : 0;
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      current.addedLines.push({ line: newLineNum, content: raw.slice(1) });
      newLineNum += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // removed line — do not advance newLineNum
    } else {
      // context line
      newLineNum += 1;
    }
  }
  return files;
}

function runRules(parsedFiles) {
  const comments = [];
  const changedSrc = new Set();
  const changedTests = new Set();
  for (const f of parsedFiles) {
    const path = f.file;
    if (/\.test\./.test(path) || /__tests?__/.test(path) || path.startsWith("tests/") || path.startsWith("test/")) {
      changedTests.add(path);
    } else if (path.startsWith("src/") || /\.(js|ts|py|go|rs|java)$/.test(path)) {
      changedSrc.add(path);
    }

    // Line-level rules.
    for (const entry of f.addedLines) {
      const { line, content } = entry;
      if (/\bconsole\.log\s*\(/.test(content)) {
        comments.push({
          file: path,
          line,
          severity: "warn",
          rule: "no-console-log",
          message: "Added console.log — remove before merging or replace with a logger.",
        });
      }
      if (/\b(?:TODO|FIXME)\b/.test(content)) {
        comments.push({
          file: path,
          line,
          severity: "info",
          rule: "todo-fixme",
          message: "Added TODO/FIXME — ensure tracking issue exists.",
        });
      }
      if (/\beval\s*\(/.test(content) || /new\s+Function\s*\(/.test(content)) {
        comments.push({
          file: path,
          line,
          severity: "error",
          rule: "dangerous-eval",
          message: "Added eval() or new Function() — unsafe, refuse to merge.",
        });
      }
    }

    // Long function rule — scan contiguous runs of added lines for a function
    // header followed by >50 added lines.
    const added = f.addedLines;
    for (let i = 0; i < added.length; i += 1) {
      const header = added[i].content;
      if (/\bfunction\b|=>\s*\{|\bdef\s+\w+\(|\bfn\s+\w+\(/.test(header)) {
        // Count contiguous following lines (same-file, consecutive line numbers).
        let count = 1;
        let j = i + 1;
        while (j < added.length && added[j].line === added[j - 1].line + 1) {
          count += 1;
          j += 1;
        }
        if (count > 50) {
          comments.push({
            file: path,
            line: added[i].line,
            severity: "warn",
            rule: "long-function",
            message: `Added function body spans ${count} lines — consider splitting.`,
          });
        }
        i = j - 1;
      }
    }
  }

  // Cross-file rule: src change without test change.
  if (changedSrc.size > 0 && changedTests.size === 0) {
    for (const s of changedSrc) {
      comments.push({
        file: s,
        line: 1,
        severity: "info",
        rule: "missing-test",
        message: "Source file changed but no test file was added/changed.",
      });
    }
  }

  return comments;
}

/**
 * Review a unified diff and persist the result.
 */
export async function reviewDiff({ workspaceId, diff, rules } = {}) {
  const ws = sanitizeId(workspaceId);
  if (typeof diff !== "string" || !diff.trim()) {
    throw new Error("diff is required");
  }
  const parsed = parseDiff(diff);
  const comments = runRules(parsed);
  const allowed = Array.isArray(rules) && rules.length ? new Set(rules) : null;
  const filtered = allowed ? comments.filter((c) => allowed.has(c.rule)) : comments;
  const review = {
    reviewId: randomUUID(),
    workspaceId: ws,
    createdAt: Date.now(),
    fileCount: parsed.length,
    comments: filtered,
  };
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { reviews: [] });
    const reviews = Array.isArray(store.reviews) ? store.reviews : [];
    reviews.push(review);
    const trimmed = reviews.length > MAX_REVIEWS_PER_WORKSPACE
      ? reviews.slice(-MAX_REVIEWS_PER_WORKSPACE)
      : reviews;
    await writeJsonPath(file, { reviews: trimmed });
  });
  return review;
}

export async function getReview(reviewId, workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readJsonPath(storePath(ws), { reviews: [] });
  const reviews = Array.isArray(store.reviews) ? store.reviews : [];
  return reviews.find((r) => r.reviewId === reviewId) || null;
}

export async function listReviews(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readJsonPath(storePath(ws), { reviews: [] });
  const reviews = Array.isArray(store.reviews) ? store.reviews : [];
  return {
    reviews: reviews
      .map((r) => ({
        reviewId: r.reviewId,
        createdAt: r.createdAt,
        fileCount: r.fileCount,
        commentCount: (r.comments || []).length,
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
  };
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(storePath(workspaceId), { reviews: [] });
    return;
  }
  await writeJsonPath(storePath("default"), { reviews: [] });
}

const LLM_DIFF_CAP = 40000;
const LLM_SYSTEM_PROMPT =
  "You are a senior code reviewer. Analyze this diff for: logic errors, missing edge cases, " +
  "security vulnerabilities, performance issues, API misuse, and correctness. " +
  "For each issue, output JSON array of { file, line, severity: \"info\"|\"warn\"|\"error\", rule: string, message: string }. " +
  "Return ONLY valid JSON array.";

function parseLLMComments(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore
  }
  return [];
}

function mergeComments(heuristic, llm) {
  const seen = new Set(heuristic.map((c) => `${c.file}:${c.line}:${c.rule}`));
  const merged = [...heuristic];
  for (const c of llm) {
    const key = `${c.file}:${c.line}:${c.rule}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
    }
  }
  return merged;
}

export async function reviewDiffWithLLM({ workspaceId, diff, prTitle, prDescription, llmClient, model } = {}) {
  if (!llmClient) {
    return reviewDiff({ workspaceId, diff });
  }
  const ws = sanitizeId(workspaceId);
  if (typeof diff !== "string" || !diff.trim()) {
    throw new Error("diff is required");
  }
  const parsed = parseDiff(diff);
  const heuristicComments = runRules(parsed);

  const truncatedDiff = diff.length > LLM_DIFF_CAP ? diff.slice(0, LLM_DIFF_CAP) : diff;
  const userContent = [
    prTitle ? `PR Title: ${prTitle}` : null,
    prDescription ? `PR Description: ${prDescription}` : null,
    `\`\`\`diff\n${truncatedDiff}\n\`\`\``,
  ]
    .filter(Boolean)
    .join("\n\n");

  let llmComments = [];
  try {
    const result = await llmClient({
      model,
      messages: [
        { role: "system", content: LLM_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });
    llmComments = parseLLMComments(result?.content ?? "");
  } catch {
    llmComments = [];
  }

  const comments = mergeComments(heuristicComments, llmComments);

  const review = {
    reviewId: randomUUID(),
    workspaceId: ws,
    createdAt: Date.now(),
    fileCount: parsed.length,
    comments,
    llmUsed: true,
  };

  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { reviews: [] });
    const reviews = Array.isArray(store.reviews) ? store.reviews : [];
    reviews.push(review);
    const trimmed = reviews.length > MAX_REVIEWS_PER_WORKSPACE
      ? reviews.slice(-MAX_REVIEWS_PER_WORKSPACE)
      : reviews;
    await writeJsonPath(file, { reviews: trimmed });
  });

  return review;
}

export const _internals = { sanitizeId, storePath, parseDiff, runRules };
