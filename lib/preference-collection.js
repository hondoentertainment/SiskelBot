/**
 * Phase 75.3: Pairwise preference collection.
 *
 * A/B preference voting for model comparisons — "given prompt P, do you
 * prefer the response from model A or model B (or tie)?"
 *
 * Storage layout:
 *   data/preference-collection/{workspaceId}.json — cases and votes per workspace
 *   data/preference-collection/_cases.json        — caseId → workspaceId lookup
 *   data/preference-collection/_index.json        — known workspaces
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const VALID_CHOICES = Object.freeze(["A", "B", "tie"]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath(workspaceId) {
  return join(getDataDir(), "preference-collection", `${sanitizeId(workspaceId)}.json`);
}

function casesIndexPath() {
  return join(getDataDir(), "preference-collection", "_cases.json");
}

function indexPath() {
  return join(getDataDir(), "preference-collection", "_index.json");
}

async function touchIndex(workspaceId) {
  const ws = sanitizeId(workspaceId);
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [] });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) {
      list.push(ws);
      await writeJsonPath(indexPath(), { workspaces: list });
    }
  });
}

async function registerCaseLookup(caseId, workspaceId) {
  await withPathLock(casesIndexPath(), async () => {
    const idx = await readJsonPath(casesIndexPath(), { cases: {} });
    const map = idx.cases && typeof idx.cases === "object" ? idx.cases : {};
    map[caseId] = sanitizeId(workspaceId);
    await writeJsonPath(casesIndexPath(), { cases: map });
  });
}

async function lookupCaseWorkspace(caseId) {
  const idx = await readJsonPath(casesIndexPath(), { cases: {} });
  const map = idx.cases && typeof idx.cases === "object" ? idx.cases : {};
  return map[caseId] || null;
}

async function loadStore(workspaceId) {
  return readJsonPath(storePath(workspaceId), { cases: [], votes: [] });
}

/**
 * Create a new comparison case.
 */
export async function createComparisonCase({
  workspaceId,
  modelA,
  modelB,
  prompt,
  responseA,
  responseB,
  metadata,
} = {}) {
  if (!modelA || !modelB) throw new Error("modelA and modelB are required");
  if (prompt == null) throw new Error("prompt is required");
  const ws = sanitizeId(workspaceId);
  const record = {
    caseId: randomUUID(),
    workspaceId: ws,
    modelA: String(modelA),
    modelB: String(modelB),
    prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt),
    responseA: responseA == null ? "" : typeof responseA === "string" ? responseA : JSON.stringify(responseA),
    responseB: responseB == null ? "" : typeof responseB === "string" ? responseB : JSON.stringify(responseB),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    createdAt: Date.now(),
  };
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const cases = Array.isArray(store.cases) ? store.cases : [];
    cases.push(record);
    await writeJsonPath(file, { ...store, cases });
  });
  await registerCaseLookup(record.caseId, ws);
  await touchIndex(ws);
  return record;
}

/**
 * Get one comparison case by ID.
 */
export async function getComparisonCase(caseId) {
  if (!caseId) return null;
  const ws = await lookupCaseWorkspace(caseId);
  if (!ws) return null;
  const store = await loadStore(ws);
  const cases = Array.isArray(store.cases) ? store.cases : [];
  return cases.find((c) => c.caseId === caseId) || null;
}

/**
 * List comparison cases for a workspace.
 */
export async function listComparisonCases(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await loadStore(ws);
  const cases = Array.isArray(store.cases) ? store.cases.slice() : [];
  cases.sort((a, b) => b.createdAt - a.createdAt);
  return cases;
}

/**
 * Record a preference vote for a case.
 */
export async function recordPreference({ caseId, userId, preferred, reason } = {}) {
  if (!caseId) throw new Error("caseId is required");
  if (!VALID_CHOICES.includes(preferred)) {
    throw new Error(`preferred must be one of ${VALID_CHOICES.join(", ")}`);
  }
  const ws = await lookupCaseWorkspace(caseId);
  if (!ws) throw new Error(`unknown caseId ${caseId}`);
  const vote = {
    voteId: randomUUID(),
    caseId: String(caseId),
    workspaceId: ws,
    userId: userId ? String(userId) : null,
    preferred,
    reason: reason ? String(reason).slice(0, 500) : null,
    timestamp: Date.now(),
  };
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const votes = Array.isArray(store.votes) ? store.votes : [];
    votes.push(vote);
    await writeJsonPath(file, { ...store, votes });
  });
  return vote;
}

/**
 * Aggregate stats for a single case.
 */
export async function getPreferenceStats(caseId) {
  if (!caseId) throw new Error("caseId is required");
  const ws = await lookupCaseWorkspace(caseId);
  if (!ws) {
    return { caseId, total: 0, A: 0, B: 0, tie: 0, aShare: 0, bShare: 0, winner: null };
  }
  const store = await loadStore(ws);
  const votes = Array.isArray(store.votes) ? store.votes.filter((v) => v.caseId === caseId) : [];
  const total = votes.length;
  let a = 0;
  let b = 0;
  let tie = 0;
  for (const v of votes) {
    if (v.preferred === "A") a += 1;
    else if (v.preferred === "B") b += 1;
    else if (v.preferred === "tie") tie += 1;
  }
  const nonTie = a + b;
  const aShare = nonTie === 0 ? 0 : Number((a / nonTie).toFixed(4));
  const bShare = nonTie === 0 ? 0 : Number((b / nonTie).toFixed(4));
  let winner = null;
  if (total > 0) {
    if (a > b) winner = "A";
    else if (b > a) winner = "B";
    else winner = "tie";
  }
  return { caseId, total, A: a, B: b, tie, aShare, bShare, winner };
}

/**
 * List preferences (votes) with an optional caseId and/or workspaceId filter.
 */
export async function listPreferences(filter = {}) {
  if (filter.caseId) {
    const ws = await lookupCaseWorkspace(filter.caseId);
    if (!ws) return [];
    const store = await loadStore(ws);
    const votes = Array.isArray(store.votes) ? store.votes : [];
    return votes
      .filter((v) => v.caseId === filter.caseId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }
  if (filter.workspaceId) {
    const ws = sanitizeId(filter.workspaceId);
    const store = await loadStore(ws);
    const votes = Array.isArray(store.votes) ? store.votes.slice() : [];
    votes.sort((a, b) => b.timestamp - a.timestamp);
    return votes;
  }
  // Aggregate across all workspaces.
  const idx = await readJsonPath(indexPath(), { workspaces: [] });
  const workspaces = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  const all = [];
  for (const ws of workspaces) {
    const store = await loadStore(ws);
    if (Array.isArray(store.votes)) all.push(...store.votes);
  }
  all.sort((a, b) => b.timestamp - a.timestamp);
  return all;
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(storePath(workspaceId), { cases: [], votes: [] });
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(storePath(ws), { cases: [], votes: [] });
  }
  await writeJsonPath(indexPath(), { workspaces: [] });
  await writeJsonPath(casesIndexPath(), { cases: {} });
}

export const _internals = { sanitizeId, storePath, indexPath, casesIndexPath, VALID_CHOICES };
