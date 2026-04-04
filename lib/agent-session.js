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

function storePath() {
  return join(getDataDir(), "agent-sessions.json");
}

function normalizeStore(raw) {
  const base =
    raw && typeof raw === "object"
      ? raw
      : { _version: STORE_VERSION, sessions: {}, workspaceIndex: {} };
  const sessions = base.sessions && typeof base.sessions === "object" && !Array.isArray(base.sessions) ? base.sessions : {};
  const workspaceIndex =
    base.workspaceIndex && typeof base.workspaceIndex === "object" && !Array.isArray(base.workspaceIndex)
      ? base.workspaceIndex
      : {};
  return { _version: STORE_VERSION, sessions, workspaceIndex };
}

export function agentSessionApiEnabled() {
  return process.env.AGENT_SESSION_API !== "0";
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
  }
}

/**
 * @param {{ workspace: string, ownerStorageUserId: string, title?: string }} opts
 */
export async function createAgentSession(opts) {
  const workspace = String(opts.workspace || "default").trim();
  const ownerStorageUserId = String(opts.ownerStorageUserId || "anonymous").trim();
  const id = randomUUID();
  const now = new Date().toISOString();
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
    await writeJsonPath(path, data);
  });
  return getAgentSession(sid);
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
