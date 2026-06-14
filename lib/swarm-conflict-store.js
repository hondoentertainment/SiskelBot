/**
 * Per-workspace durable log of swarm specialist conflicts.
 *
 * When the swarm coordinator detects disagreement between specialists it emits
 * a Prometheus metric, but metrics do not let evals later grade the quality of
 * conflict reconciliation. This store persists every conflict event so:
 *   - admins can inspect where swarms disagree most
 *   - evals can replay conflicts and grade reconciliations
 *
 * Storage: one JSON blob per workspace at
 *   data/swarm-conflicts/<workspace>/events.json
 * Routed through the same JSON -> SQLite -> Postgres backend as the rest of
 * the app via json-path-store.
 *
 * Ring buffer: keep only the 1000 newest events per workspace; drop oldest
 * on write when exceeded.
 *
 * @module swarm-conflict-store
 */

import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";

const MAX_EVENTS_PER_WORKSPACE = 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const MAX_RESPONSE_CHARS = 4000;

/**
 * @typedef {object} ConflictEvent
 * @property {string} id
 * @property {number} ts
 * @property {string} type
 * @property {number} similarity
 * @property {string} summary
 * @property {string[]} specialists
 * @property {Array<{specialist: string, output: string}>} responses
 * @property {string} [reconciled]
 * @property {string} [judgeError]
 */

/**
 * @typedef {object} WorkspaceConflictLog
 * @property {number} version
 * @property {number} updatedAt
 * @property {ConflictEvent[]} events
 */

function sanitizeSegment(s) {
  if (typeof s !== "string" || s.length === 0) return "default";
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function storePath(workspace) {
  const ws = sanitizeSegment(workspace);
  return join(getDataDir(), "swarm-conflicts", ws, "events.json");
}

function emptyLog() {
  return { version: 1, updatedAt: 0, events: [] };
}

function truncateResponses(responses) {
  if (!Array.isArray(responses)) return [];
  const out = [];
  for (const r of responses) {
    if (!r || typeof r !== "object") continue;
    const specialist = typeof r.specialist === "string" ? r.specialist : "unknown";
    let output = typeof r.output === "string" ? r.output : "";
    if (output.length > MAX_RESPONSE_CHARS) output = output.slice(0, MAX_RESPONSE_CHARS);
    out.push({ specialist, output });
  }
  return out;
}

/**
 * Is the swarm conflict log enabled? Default enabled; disable with
 * `SWARM_CONFLICT_LOG=0`.
 * @returns {boolean}
 */
export function swarmConflictLogEnabled() {
  const raw = process.env.SWARM_CONFLICT_LOG;
  if (raw == null || raw === "") return true;
  const v = String(raw).trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

async function loadLog(workspace) {
  const path = storePath(workspace);
  const raw = await readJsonPath(path, emptyLog());
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.events)) return emptyLog();
  return raw;
}

/**
 * Record one conflict event for a workspace. Returns the stored event
 * (with generated id + ts).
 *
 * @param {string} workspace
 * @param {Omit<ConflictEvent, "id" | "ts">} event
 * @returns {Promise<ConflictEvent>}
 */
export async function recordConflict(workspace, event) {
  const path = storePath(workspace);
  const log = await loadLog(workspace);
  const now = Date.now();

  /** @type {ConflictEvent} */
  const stored = {
    id: randomUUID(),
    ts: now,
    type: typeof event?.type === "string" ? event.type : "unknown",
    similarity: Number.isFinite(event?.similarity) ? event.similarity : 0,
    summary: typeof event?.summary === "string" ? event.summary : "",
    specialists: Array.isArray(event?.specialists)
      ? event.specialists.filter((s) => typeof s === "string")
      : [],
    responses: truncateResponses(event?.responses),
  };
  if (typeof event?.reconciled === "string") stored.reconciled = event.reconciled;
  if (typeof event?.judgeError === "string") stored.judgeError = event.judgeError;

  log.events.push(stored);

  if (log.events.length > MAX_EVENTS_PER_WORKSPACE) {
    const drop = log.events.length - MAX_EVENTS_PER_WORKSPACE;
    log.events.splice(0, drop);
  }

  log.updatedAt = now;
  await writeJsonPath(path, log);
  return stored;
}

/**
 * List conflict events for a workspace, newest-first.
 *
 * @param {string} workspace
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<ConflictEvent[]>}
 */
export async function listConflicts(workspace, opts = {}) {
  const log = await loadLog(workspace);
  const requested = Number(opts?.limit);
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIST_LIMIT),
  );
  const reversed = [...log.events].reverse();
  return reversed.slice(0, limit);
}

/**
 * Fetch a single conflict event by id for a workspace.
 *
 * @param {string} workspace
 * @param {string} id
 * @returns {Promise<ConflictEvent | null>}
 */
export async function getConflict(workspace, id) {
  if (typeof id !== "string" || id.length === 0) return null;
  const log = await loadLog(workspace);
  for (let i = log.events.length - 1; i >= 0; i--) {
    if (log.events[i].id === id) return log.events[i];
  }
  return null;
}

/**
 * Clear all conflict events for a workspace.
 *
 * @param {string} workspace
 * @returns {Promise<void>}
 */
export async function clearConflicts(workspace) {
  const path = storePath(workspace);
  await writeJsonPath(path, emptyLog());
}
