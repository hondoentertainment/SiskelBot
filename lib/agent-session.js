/**
 * Durable agent sessions: step log, linked run IDs, pause/resume metadata.
 * Stored via json-path-store (file / SQLite / Postgres).
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_SESSIONS = Math.min(10_000, Math.max(100, Number(process.env.AGENT_SESSIONS_MAX_STORE) || 4000));
const MAX_EVENTS_PER_SESSION = Math.min(2000, Math.max(50, Number(process.env.AGENT_SESSION_MAX_EVENTS) || 400));
const MAX_PLAN_SUMMARY_CHARS = Math.min(32_000, Math.max(256, Number(process.env.AGENT_SESSION_PLAN_SUMMARY_MAX) || 16_384));
const MAX_PLAN_DAG_JSON_CHARS = Math.min(
  500_000,
  Math.max(2000, Number(process.env.AGENT_SESSION_PLAN_DAG_MAX_JSON) || 200_000),
);
const MAX_PLAN_DAG_DEPTH = Math.min(40, Math.max(8, Number(process.env.AGENT_SESSION_PLAN_DAG_MAX_DEPTH) || 24));

function storePath() {
  return join(getDataDir(), "agent-sessions.json");
}

function normalizeStore(raw) {
  const base =
    raw && typeof raw === "object"
      ? raw
      : { _version: STORE_VERSION, sessions: {}, workspaceIndex: {}, runIndex: {} };
  const sessions = base.sessions && typeof base.sessions === "object" && !Array.isArray(base.sessions) ? base.sessions : {};
  const workspaceIndex =
    base.workspaceIndex && typeof base.workspaceIndex === "object" && !Array.isArray(base.workspaceIndex)
      ? base.workspaceIndex
      : {};
  const runIndex =
    base.runIndex && typeof base.runIndex === "object" && !Array.isArray(base.runIndex)
      ? base.runIndex
      : {};
  return { _version: STORE_VERSION, sessions, workspaceIndex, runIndex };
}

export function agentSessionApiEnabled() {
  return process.env.AGENT_SESSION_API !== "0";
}

function jsonValueDepth(v, d = 0) {
  if (d > MAX_PLAN_DAG_DEPTH) return d + 1;
  if (v === null || typeof v !== "object") return d;
  if (Array.isArray(v)) {
    let m = d;
    for (const x of v) m = Math.max(m, jsonValueDepth(x, d + 1));
    return m;
  }
  let m = d;
  for (const x of Object.values(v)) m = Math.max(m, jsonValueDepth(x, d + 1));
  return m;
}

/**
 * @param {{ planSummary?: unknown; planDag?: unknown }} body
 * @returns {{ ok: true; planSummary?: string; planDag?: object } | { ok: false; code: string; message: string }}
 */
export function validateAgentSessionPlanInput(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, code: "INVALID_BODY", message: "Body must be an object" };
  }
  let planSummary;
  let planDag;
  if ("planSummary" in body) {
    if (body.planSummary === null || body.planSummary === undefined) {
      planSummary = "";
    } else if (typeof body.planSummary !== "string") {
      return { ok: false, code: "INVALID_PLAN_SUMMARY", message: "planSummary must be a string" };
    } else {
      planSummary = body.planSummary.slice(0, MAX_PLAN_SUMMARY_CHARS);
    }
  }
  if ("planDag" in body && body.planDag !== null && body.planDag !== undefined) {
    if (typeof body.planDag !== "object" || Array.isArray(body.planDag)) {
      return { ok: false, code: "INVALID_PLAN_DAG", message: "planDag must be a plain object" };
    }
    let serialized;
    try {
      serialized = JSON.stringify(body.planDag);
    } catch {
      return { ok: false, code: "INVALID_PLAN_DAG", message: "planDag is not JSON-serializable" };
    }
    if (serialized.length > MAX_PLAN_DAG_JSON_CHARS) {
      return {
        ok: false,
        code: "PLAN_DAG_TOO_LARGE",
        message: `planDag JSON exceeds ${MAX_PLAN_DAG_JSON_CHARS} characters`,
      };
    }
    if (jsonValueDepth(body.planDag) > MAX_PLAN_DAG_DEPTH) {
      return { ok: false, code: "PLAN_DAG_TOO_DEEP", message: `planDag exceeds max nesting depth ${MAX_PLAN_DAG_DEPTH}` };
    }
    try {
      planDag = JSON.parse(serialized);
    } catch {
      return { ok: false, code: "INVALID_PLAN_DAG", message: "planDag round-trip failed" };
    }
  }
  if (planSummary === undefined && planDag === undefined) {
    return { ok: false, code: "EMPTY_PLAN", message: "Provide planSummary and/or planDag" };
  }
  return { ok: true, planSummary, planDag };
}

function pruneSessions(data) {
  const entries = Object.entries(data.sessions || {}).map(
    ([id, row]) => ({
      id,
      row,
      updated: new Date(row?.updatedAt || row?.createdAt || 0).getTime() || 0,
    })
  );
  entries.sort((a, b) => a.updated - b.updated);
  while (entries.length > MAX_SESSIONS) {
    const drop = entries.shift();
    if (!drop) break;
    delete data.sessions[drop.id];
    for (const k of Object.keys(data.workspaceIndex)) {
      data.workspaceIndex[k] = (data.workspaceIndex[k] || []).filter((e) => e !== drop.id);
    }
    const droppedRuns = Array.isArray(drop.row?.runIds) ? drop.row.runIds : [];
    if (data.runIndex) {
      for (const rid of droppedRuns) {
        if (data.runIndex[rid] === drop.id) delete data.runIndex[rid];
      }
    }
  }
}

/**
 * @param {{ workspace: string, ownerStorageUserId: string, title?: string, planSummary?: string, planDag?: object }} opts
 */
export async function createAgentSession(opts) {
  const workspace = String(opts.workspace || "default").trim();
  const ownerStorageUserId = String(opts.ownerStorageUserId || "anonymous").trim();
  const id = randomUUID();
  const now = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const session = {
    id,
    workspace,
    ownerStorageUserId,
    title: typeof opts.title === "string" ? opts.title.trim().slice(0, 200) : "",
    status: "running",
    createdAt: now,
    updatedAt: now,
    runIds: [],
    events: [
      {
        type: "session_created",
        at: now,
      },
    ],
  };
  if (opts.planSummary !== undefined || opts.planDag !== undefined) {
    /** @type {{ planSummary?: unknown; planDag?: unknown }} */
    const planBody = {};
    if (opts.planSummary !== undefined) planBody.planSummary = opts.planSummary;
    if (opts.planDag !== undefined) planBody.planDag = opts.planDag;
    const planCheck = validateAgentSessionPlanInput(planBody);
    if (!planCheck.ok) {
      const err = new Error(planCheck.message);
      err.code = planCheck.code;
      throw err;
    }
    if (planCheck.planSummary !== undefined) session.planSummary = planCheck.planSummary;
    if (planCheck.planDag !== undefined) session.planDag = planCheck.planDag;
    session.planUpdatedAt = now;
  }

  const path = storePath();
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    data.sessions[id] = session;
    const idx = Array.isArray(data.workspaceIndex[workspace]) ? [...data.workspaceIndex[workspace]] : [];
    idx.unshift(id);
    data.workspaceIndex[workspace] = [...new Set(idx)].slice(0, 2000);
    pruneSessions(data);
    await writeJsonPath(path, data);
  });
  return session;
}

export async function getAgentSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const path = storePath();
  const data = normalizeStore(await readJsonPath(path, null));
  return data.sessions[id] || null;
}

/**
 * @param {string} sessionId
 * @param {{ type: string, [k: string]: unknown }} event
 */
export async function appendAgentSessionEvent(sessionId, event) {
  const id = String(sessionId || "").trim();
  if (!id || !event?.type) return null;
  const path = storePath();
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const row = data.sessions[id];
    if (!row) return;
    const at = new Date().toISOString();
    const ev = { ...event, at };
    const events = Array.isArray(row.events) ? row.events : [];
    events.push(ev);
    row.events = events.slice(-MAX_EVENTS_PER_SESSION);
    row.updatedAt = at;
    await writeJsonPath(path, data);
  });
  return getAgentSession(id);
}

/**
 * @param {string} sessionId
 * @param {"running"|"paused"|"completed"|"failed"} status
 */
export async function setAgentSessionStatus(sessionId, status) {
  const allowed = new Set(["running", "paused", "completed", "failed"]);
  if (!allowed.has(status)) return null;
  const id = String(sessionId || "").trim();
  const path = storePath();
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const row = data.sessions[id];
    if (!row) return;
    const at = new Date().toISOString();
    row.status = status;
    row.updatedAt = at;
    (row.events ||= []).push({ type: "status", status, at });
    row.events = row.events.slice(-MAX_EVENTS_PER_SESSION);
    await writeJsonPath(path, data);
  });
  return getAgentSession(id);
}

/**
 * @param {string} sessionId
 * @param {string} runId
 *
 * Maintains a reverse index (runId → sessionId) alongside the session record
 * so callers holding only a runId can still resolve a sessionId (see
 * getSessionIdForRun). Last-write-wins: if the runId was previously linked to
 * a different session, the reverse index points to the most recent session
 * and the older session's runIds array is trimmed so the mapping is
 * consistent. Forward runIds arrays on other sessions are not modified if the
 * same runId is explicitly linked to a new session; the reverse index simply
 * reflects the latest link.
 */
export async function linkRunToAgentSession(sessionId, runId) {
  const sid = String(sessionId || "").trim();
  const rid = String(runId || "").trim();
  if (!sid || !rid) return null;
  const path = storePath();
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const row = data.sessions[sid];
    if (!row) return;
    const at = new Date().toISOString();
    const runs = Array.isArray(row.runIds) ? row.runIds : [];
    if (!runs.includes(rid)) runs.unshift(rid);
    row.runIds = runs.slice(0, 100);
    (row.events ||= []).push({ type: "run_linked", runId: rid, at });
    row.updatedAt = at;
    row.events = row.events.slice(-MAX_EVENTS_PER_SESSION);
    // Last-write-wins reverse index
    data.runIndex[rid] = sid;
    runIndexMemory.set(rid, sid);
    await writeJsonPath(path, data);
  });
  return getAgentSession(sid);
}

/**
 * In-memory mirror of the persisted runIndex. This lets hot paths
 * (e.g. agent-loop event publishing) resolve runId → sessionId without a
 * disk read. The mirror is populated on demand by lookups and by
 * buildRunIndexFromSessions(), and kept in sync on writes.
 *
 * @type {Map<string, string>}
 */
const runIndexMemory = new Map();

/**
 * Look up the sessionId that owns a given runId.
 *
 * Checks the in-memory mirror first, falls back to the persisted store.
 * Returns null when no link exists (including for empty/invalid runIds).
 *
 * @param {string} runId
 * @returns {Promise<string | null>}
 */
export async function getSessionIdForRun(runId) {
  const rid = String(runId || "").trim();
  if (!rid) return null;
  const cached = runIndexMemory.get(rid);
  if (typeof cached === "string" && cached) return cached;
  const path = storePath();
  const data = normalizeStore(await readJsonPath(path, null));
  const mapped = data.runIndex?.[rid];
  if (typeof mapped === "string" && mapped && data.sessions?.[mapped]) {
    runIndexMemory.set(rid, mapped);
    return mapped;
  }
  return null;
}

/**
 * Synchronous runId → sessionId lookup (in-memory mirror only).
 *
 * Intended for hot paths (e.g. per-iteration event publishing in
 * agent-loop.js) that cannot await. Returns null when the mapping is not in
 * the in-memory mirror; callers wanting a guaranteed persisted lookup should
 * use the async getSessionIdForRun() instead.
 *
 * @param {string} runId
 * @returns {string | null}
 */
export function getSessionIdForRunSync(runId) {
  const rid = String(runId || "").trim();
  if (!rid) return null;
  const cached = runIndexMemory.get(rid);
  return typeof cached === "string" && cached ? cached : null;
}

/**
 * Unlink a runId from its reverse-index entry.
 *
 * Removes the mapping from both the in-memory mirror and the persisted store.
 * Does not modify the session's runIds array (callers managing the forward
 * relationship should update that separately). Safe to call for unknown
 * runIds.
 *
 * @param {string} runId
 * @returns {Promise<void>}
 */
export async function unlinkRunFromAgentSession(runId) {
  const rid = String(runId || "").trim();
  if (!rid) return;
  runIndexMemory.delete(rid);
  const path = storePath();
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    if (data.runIndex && rid in data.runIndex) {
      delete data.runIndex[rid];
      await writeJsonPath(path, data);
    }
  });
}

/**
 * One-time migration that scans all persisted sessions, rebuilds the
 * runId → sessionId index, and populates the in-memory mirror. Safe to call
 * multiple times — each call replaces the on-disk runIndex with a freshly
 * computed mapping.
 *
 * When the same runId appears in multiple sessions' runIds arrays, the one
 * whose session has the most recent updatedAt wins (last-write-wins,
 * consistent with linkRunToAgentSession).
 *
 * @returns {Promise<{ runs: number, sessions: number }>}
 */
export async function buildRunIndexFromSessions() {
  const path = storePath();
  /** @type {{ runs: number, sessions: number }} */
  const counts = { runs: 0, sessions: 0 };
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    /** @type {Record<string, string>} */
    const rebuilt = {};
    /** @type {Record<string, number>} */
    const winningTs = {};
    const sessions = data.sessions || {};
    for (const [sid, row] of Object.entries(sessions)) {
      counts.sessions++;
      const runs = Array.isArray(row?.runIds) ? row.runIds : [];
      const ts = new Date(row?.updatedAt || row?.createdAt || 0).getTime() || 0;
      for (const r of runs) {
        const rid = typeof r === "string" ? r.trim() : "";
        if (!rid) continue;
        if (!(rid in rebuilt) || ts >= (winningTs[rid] || 0)) {
          rebuilt[rid] = sid;
          winningTs[rid] = ts;
        }
      }
    }
    counts.runs = Object.keys(rebuilt).length;
    data.runIndex = rebuilt;
    runIndexMemory.clear();
    for (const [rid, sid] of Object.entries(rebuilt)) runIndexMemory.set(rid, sid);
    await writeJsonPath(path, data);
  });
  return counts;
}

/**
 * Test helper: clear the in-memory run-index mirror. Used by tests to assert
 * behavior when the mirror is cold (i.e. first lookup after process restart).
 */
export function __resetRunIndexMemoryForTests() {
  runIndexMemory.clear();
}

/**
 * @param {string} sessionId
 * @param {{ planSummary?: string; planDag?: object }} body
 * @returns {Promise<{ ok: true, session: object } | { ok: false, code: string, message: string }>}
 */
export async function updateAgentSessionPlan(sessionId, body) {
  const id = String(sessionId || "").trim();
  if (!id) return { ok: false, code: "INVALID", message: "session id required" };
  const v = validateAgentSessionPlanInput(body);
  if (!v.ok) return v;
  const path = storePath();
  let found = false;
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const row = data.sessions[id];
    if (!row) return;
    found = true;
    const at = new Date().toISOString();
    if (v.planSummary !== undefined) row.planSummary = v.planSummary;
    if (v.planDag !== undefined) row.planDag = v.planDag;
    row.planUpdatedAt = at;
    row.updatedAt = at;
    (row.events ||= []).push({ type: "plan_updated", at });
    row.events = row.events.slice(-MAX_EVENTS_PER_SESSION);
    await writeJsonPath(path, data);
  });
  if (!found) return { ok: false, code: "NOT_FOUND", message: "Session not found" };
  return { ok: true, session: await getAgentSession(id) };
}

/**
 * @param {{ workspace: string, ownerStorageUserId: string, limit?: number, offset?: number }} opts
 */
export async function listAgentSessionsForWorkspace(opts) {
  const workspace = String(opts.workspace || "default").trim();
  const owner = String(opts.ownerStorageUserId || "").trim();
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 40));
  const offset = Math.max(0, Number(opts.offset) || 0);

  const path = storePath();
  const data = normalizeStore(await readJsonPath(path, null));
  const ids = Array.isArray(data.workspaceIndex[workspace]) ? [...data.workspaceIndex[workspace]] : [];
  /** @type {object[]} */
  const items = [];
  for (const id of ids) {
    const row = data.sessions[id];
    if (!row) continue;
    if (owner && row.ownerStorageUserId !== owner) continue;
    items.push({
      id: row.id,
      workspace: row.workspace,
      status: row.status,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      runIds: Array.isArray(row.runIds) ? row.runIds.slice(0, 5) : [],
      eventCount: Array.isArray(row.events) ? row.events.length : 0,
    });
  }
  const total = items.length;
  return { items: items.slice(offset, offset + limit), total, limit, offset };
}

/**
 * @param {string} sessionId
 * @param {string} workspace
 * @param {string} ownerStorageUserId
 * @returns {{ ok: true, session: object } | { ok: false, code: string, message: string }}
 */
export async function assertAgentSessionForRun(sessionId, workspace, ownerStorageUserId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: true, session: null };
  const session = await getAgentSession(sid);
  if (!session) {
    return { ok: false, code: "SESSION_NOT_FOUND", message: "Agent session not found" };
  }
  const ws = String(workspace || "default");
  if (session.workspace !== ws) {
    return { ok: false, code: "SESSION_WORKSPACE_MISMATCH", message: "Session belongs to a different workspace" };
  }
  const owner = String(ownerStorageUserId || "anonymous");
  if (session.ownerStorageUserId !== owner) {
    return { ok: false, code: "SESSION_ACCESS_DENIED", message: "Session is owned by another user" };
  }
  return { ok: true, session };
}
