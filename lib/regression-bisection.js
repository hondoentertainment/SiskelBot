/**
 * Phase 75.4: Regression bisection.
 *
 * Binary-searches a client-supplied list of commits between a known-good and
 * a known-failing commit to identify the commit that introduced a regression.
 *
 * Storage layout:
 *   data/regression-bisection/{workspaceId}.json — sessions per workspace
 *   data/regression-bisection/_sessions.json     — sessionId → workspaceId
 *   data/regression-bisection/_index.json        — known workspaces
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const VALID_RESULTS = Object.freeze(["pass", "fail", "skip"]);

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function storePath(workspaceId) {
  return join(getDataDir(), "regression-bisection", `${sanitizeId(workspaceId)}.json`);
}

function sessionsIndexPath() {
  return join(getDataDir(), "regression-bisection", "_sessions.json");
}

function indexPath() {
  return join(getDataDir(), "regression-bisection", "_index.json");
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

async function registerSession(sessionId, workspaceId) {
  await withPathLock(sessionsIndexPath(), async () => {
    const idx = await readJsonPath(sessionsIndexPath(), { sessions: {} });
    const map = idx.sessions && typeof idx.sessions === "object" ? idx.sessions : {};
    map[sessionId] = sanitizeId(workspaceId);
    await writeJsonPath(sessionsIndexPath(), { sessions: map });
  });
}

async function lookupSessionWorkspace(sessionId) {
  const idx = await readJsonPath(sessionsIndexPath(), { sessions: {} });
  const map = idx.sessions && typeof idx.sessions === "object" ? idx.sessions : {};
  return map[sessionId] || null;
}

async function loadStore(workspaceId) {
  return readJsonPath(storePath(workspaceId), { sessions: [] });
}

function midpoint(lo, hi) {
  // lo points at last-known-good; hi at last-known-bad (inclusive).
  return Math.floor((lo + hi) / 2);
}

/**
 * Create a new bisect session.
 *
 * `commits` is the ordered list spanning good → failing, inclusive.
 * commits[0] is the good commit (implicit pass) and commits[commits.length-1]
 * is the failing commit (implicit fail). The search space is commits[1..n-2].
 */
export async function createBisectSession({
  workspaceId,
  failingCommit,
  goodCommit,
  testCommand,
  commits,
} = {}) {
  if (!Array.isArray(commits) || commits.length < 2) {
    throw new Error("commits must be an array of at least 2 entries (good and failing)");
  }
  if (!goodCommit) throw new Error("goodCommit is required");
  if (!failingCommit) throw new Error("failingCommit is required");
  const ws = sanitizeId(workspaceId);
  const cleanCommits = commits.map((c) => String(c));
  const lo = 0;
  const hi = cleanCommits.length - 1;
  const session = {
    sessionId: randomUUID(),
    workspaceId: ws,
    failingCommit: String(failingCommit),
    goodCommit: String(goodCommit),
    testCommand: testCommand ? String(testCommand) : null,
    commits: cleanCommits,
    lo,
    hi,
    current: lo + 1 >= hi ? null : midpoint(lo, hi),
    status: lo + 1 >= hi ? "found" : "in-progress",
    breakerCommit: lo + 1 >= hi ? cleanCommits[hi] : null,
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const file = storePath(ws);
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const list = Array.isArray(store.sessions) ? store.sessions : [];
    list.push(session);
    await writeJsonPath(file, { sessions: list });
  });
  await registerSession(session.sessionId, ws);
  await touchIndex(ws);
  return session;
}

/**
 * Advance a bisect session with the result for its current commit.
 */
export async function advanceBisect({ sessionId, result } = {}) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!VALID_RESULTS.includes(result)) {
    throw new Error(`result must be one of ${VALID_RESULTS.join(", ")}`);
  }
  const ws = await lookupSessionWorkspace(sessionId);
  if (!ws) throw new Error(`unknown sessionId ${sessionId}`);
  const file = storePath(ws);
  let returned;
  await withPathLock(file, async () => {
    const store = await loadStore(ws);
    const list = Array.isArray(store.sessions) ? store.sessions : [];
    const idx = list.findIndex((s) => s.sessionId === sessionId);
    if (idx < 0) throw new Error(`session ${sessionId} not found`);
    const s = list[idx];
    if (s.status === "found" || s.status === "aborted") {
      returned = s;
      return;
    }
    if (s.current == null) {
      s.status = "found";
      s.breakerCommit = s.commits[s.hi];
      s.updatedAt = Date.now();
      list[idx] = s;
      await writeJsonPath(file, { sessions: list });
      returned = s;
      return;
    }

    const historyEntry = {
      commit: s.commits[s.current],
      index: s.current,
      result,
      timestamp: Date.now(),
    };
    s.history.push(historyEntry);

    if (result === "skip") {
      // Try next index up; if none, mark aborted. Skip doesn't narrow the range.
      let next = s.current + 1;
      while (next < s.hi && s.history.some((h) => h.index === next)) next += 1;
      if (next >= s.hi) {
        s.status = "aborted";
        s.current = null;
      } else {
        s.current = next;
        s.status = "in-progress";
      }
    } else {
      if (result === "pass") {
        s.lo = s.current;
      } else if (result === "fail") {
        s.hi = s.current;
      }
      if (s.lo + 1 >= s.hi) {
        s.status = "found";
        s.breakerCommit = s.commits[s.hi];
        s.current = null;
      } else {
        s.current = midpoint(s.lo, s.hi);
        s.status = "in-progress";
      }
    }

    s.updatedAt = Date.now();
    list[idx] = s;
    await writeJsonPath(file, { sessions: list });
    returned = s;
  });
  return returned;
}

/**
 * Fetch a bisect session by ID.
 */
export async function getBisectSession(sessionId) {
  if (!sessionId) return null;
  const ws = await lookupSessionWorkspace(sessionId);
  if (!ws) return null;
  const store = await loadStore(ws);
  const list = Array.isArray(store.sessions) ? store.sessions : [];
  return list.find((s) => s.sessionId === sessionId) || null;
}

/**
 * List all sessions for a workspace.
 */
export async function listSessions(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await loadStore(ws);
  const list = Array.isArray(store.sessions) ? store.sessions.slice() : [];
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(storePath(workspaceId), { sessions: [] });
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [] });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(storePath(ws), { sessions: [] });
  }
  await writeJsonPath(indexPath(), { workspaces: [] });
  await writeJsonPath(sessionsIndexPath(), { sessions: {} });
}

export const _internals = { sanitizeId, storePath, indexPath, sessionsIndexPath, VALID_RESULTS };
