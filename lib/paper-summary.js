/**
 * Phase 64.2: Paper summary.
 *
 * Extracts a structured summary from a paper abstract using heuristic
 * sentence tagging. Deterministic and offline — no model calls.
 *
 * Storage layout:
 *   data/paper-summary/{workspaceId}.json
 *     { summaries: { [id]: { id, workspaceId, paperId, title, summary, timestamp } } }
 *   data/paper-summary/_index.json — known workspaces + summary-id -> workspace map
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_KEY_POINTS = 5;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function workspacePath(workspaceId) {
  return join(getDataDir(), "paper-summary", `${sanitizeId(workspaceId)}.json`);
}

function indexPath() {
  return join(getDataDir(), "paper-summary", "_index.json");
}

async function touchIndex(workspaceId, summaryId) {
  const ws = sanitizeId(workspaceId);
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [], ids: {} });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) list.push(ws);
    const ids = idx.ids && typeof idx.ids === "object" ? idx.ids : {};
    if (summaryId) ids[summaryId] = ws;
    await writeJsonPath(indexPath(), { workspaces: list, ids });
  });
}

function splitSentences(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  // Split on sentence terminators followed by whitespace + capital letter, or end of string.
  const parts = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(])/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

function countWords(text) {
  if (typeof text !== "string") return 0;
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

const KEYPOINT_PATTERNS = [
  /\bwe (show|propose|introduce|present|demonstrate|find)\b/i,
  /\bresults?\b/i,
  /\bfind\b/i,
  /\bour (approach|method|framework|model)\b/i,
  /\bachiev(e|ing|es)\b/i,
  /\boutperform/i,
  /\bimprove/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
];

const METHODOLOGY_PATTERNS = [
  /\bwe (use|train|employ|leverage|build)\b/i,
  /\bapproach\b/i,
  /\bmethod\b/i,
  /\barchitecture\b/i,
  /\btrained on\b/i,
  /\bdataset\b/i,
  /\bframework\b/i,
];

const FINDINGS_PATTERNS = [
  /\bresult/i,
  /\bfind(ing)?s?\b/i,
  /\bshow that\b/i,
  /\bdemonstrate/i,
  /\bobserve/i,
  /\bevidence\b/i,
  /\baccuracy\b/i,
  /\bperformance\b/i,
];

const LIMITATION_PATTERNS = [
  /\blimitation/i,
  /\blimit(ed|s)?\b/i,
  /\bcaveat/i,
  /\bdoes not\b/i,
  /\bfails?\b/i,
  /\bchallenge/i,
  /\bfuture work\b/i,
  /\bhowever\b/i,
];

function firstMatching(sentences, patterns) {
  for (const s of sentences) {
    if (patterns.some((p) => p.test(s))) return s;
  }
  return null;
}

function matchingSentences(sentences, patterns, max) {
  const out = [];
  for (const s of sentences) {
    if (patterns.some((p) => p.test(s))) {
      out.push(s);
      if (out.length >= max) break;
    }
  }
  return out;
}

/**
 * Produce a structured summary of a paper from its abstract.
 *
 * @param {{ title?: string, abstract: string, authors?: string[], year?: number }} input
 */
export function summarizePaper({ title = "", abstract = "", authors, year } = {}) {
  if (typeof abstract !== "string" || !abstract.trim()) {
    throw new Error("abstract is required");
  }
  const sentences = splitSentences(abstract);
  const tldr = sentences[0] || abstract.slice(0, 200);
  let keyPoints = matchingSentences(sentences, KEYPOINT_PATTERNS, MAX_KEY_POINTS);
  if (keyPoints.length === 0) {
    // Fallback: first N sentences excluding tldr.
    keyPoints = sentences.slice(1, 1 + MAX_KEY_POINTS);
  }
  const methodology = firstMatching(sentences, METHODOLOGY_PATTERNS) || null;
  const findings = firstMatching(sentences, FINDINGS_PATTERNS) || null;
  const limitations = firstMatching(sentences, LIMITATION_PATTERNS) || null;
  const words = countWords(abstract);
  const readingTime = Math.max(1, Math.ceil(words / 200));
  return {
    title: String(title || "").trim(),
    authors: Array.isArray(authors) ? authors.slice(0, 20).map(String) : [],
    year: typeof year === "number" ? year : null,
    tldr,
    keyPoints,
    methodology,
    findings,
    limitations,
    readingTime,
    wordCount: words,
    sentenceCount: sentences.length,
  };
}

/**
 * Persist a summary for later retrieval.
 */
export async function recordSummary({ workspaceId, paperId, title, summary } = {}) {
  const ws = sanitizeId(workspaceId);
  const id = randomUUID();
  const record = {
    id,
    workspaceId: ws,
    paperId: paperId ? String(paperId) : null,
    title: title ? String(title) : (summary && summary.title) || "",
    summary: summary && typeof summary === "object" ? summary : null,
    timestamp: Date.now(),
  };
  const file = workspacePath(ws);
  await withPathLock(file, async () => {
    const store = await readJsonPath(file, { summaries: {} });
    const summaries = store.summaries && typeof store.summaries === "object" ? store.summaries : {};
    summaries[id] = record;
    await writeJsonPath(file, { summaries });
  });
  await touchIndex(ws, id);
  return record;
}

export async function listSummaries(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readJsonPath(workspacePath(ws), { summaries: {} });
  const summaries = store.summaries && typeof store.summaries === "object" ? store.summaries : {};
  return Object.values(summaries).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function getSummary(id) {
  if (!id) return null;
  const idx = await readJsonPath(indexPath(), { workspaces: [], ids: {} });
  const ids = idx.ids && typeof idx.ids === "object" ? idx.ids : {};
  const ws = ids[id];
  if (!ws) return null;
  const store = await readJsonPath(workspacePath(ws), { summaries: {} });
  const summaries = store.summaries && typeof store.summaries === "object" ? store.summaries : {};
  return summaries[id] || null;
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(workspacePath(workspaceId), { summaries: {} });
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [], ids: {} });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(workspacePath(ws), { summaries: {} });
  }
  await writeJsonPath(indexPath(), { workspaces: [], ids: {} });
}

export const _internals = { sanitizeId, workspacePath, indexPath, splitSentences };
