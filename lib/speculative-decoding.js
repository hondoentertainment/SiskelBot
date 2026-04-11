// @ts-check
/**
 * Phase 58.2: Speculative decoding.
 *
 * Abstraction over the "draft + verify" speedup strategy where a small
 * draft model proposes N tokens, and a larger target model verifies
 * them in a single forward pass. Accepted drafts save wall-clock time
 * since only rejected suffixes require target-model generation.
 *
 * This is a deterministic, dependency-free simulation intended for
 * testing the orchestration logic (session lifecycle, acceptance rate
 * tracking, stats persistence). The draft and target generators can
 * be any synchronous functions producing token arrays; the default
 * pair is two mock generators that interleave predictable tokens so
 * tests can assert acceptance math exactly.
 *
 * The module exposes:
 *   - `createSpeculativeSession(opts)` — allocate a session
 *   - `generateSpeculative(session, prompt, opts)` — run one decode
 *   - `getAcceptanceRate(sessionId?)` — global or per-session rate
 *   - `resetStats(sessionId?)` — clear rolling stats
 *
 * @module speculative-decoding
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function statsPath() {
  return join(getDataDir(), "speculative-decoding-stats.json");
}

/* -------------------------------------------------------------------------- */
/* In-memory session registry                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SpeculativeSession
 * @property {string} id
 * @property {number} draftLookahead
 * @property {(prompt: string, n: number) => string[]} draftGen
 * @property {(prompt: string, draft: string[]) => number} verify
 * @property {string} createdAt
 */

/** @type {Map<string, SpeculativeSession>} */
const sessions = new Map();

let _idCounter = 0;
function nextId(random) {
  _idCounter += 1;
  const r = typeof random === "function" ? random() : Math.random();
  return `spec-${Date.now().toString(36)}-${_idCounter}-${Math.floor(r * 1e6).toString(36)}`;
}

/* -------------------------------------------------------------------------- */
/* Default mock generators                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Draft generator: emits `n` tokens of the form `draft_i`. Pure and
 * deterministic given the prompt + request size.
 *
 * @param {string} prompt
 * @param {number} n
 * @returns {string[]}
 */
export function defaultDraftGen(prompt, n) {
  const out = [];
  const base = String(prompt || "").length % 10;
  for (let i = 0; i < n; i += 1) {
    out.push(`draft_${(base + i) % 20}`);
  }
  return out;
}

/**
 * Verifier: returns the count of draft tokens accepted from the start.
 * A fully accepted draft returns draft.length. Default accepts the
 * first k tokens where k = min(draft.length, 3 + (prompt.length % 3)).
 *
 * @param {string} prompt
 * @param {string[]} draft
 * @returns {number}
 */
export function defaultVerify(prompt, draft) {
  if (!Array.isArray(draft) || draft.length === 0) return 0;
  const k = Math.min(draft.length, 3 + (String(prompt || "").length % 3));
  return k;
}

/* -------------------------------------------------------------------------- */
/* Session API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Create a speculative decoding session. If generators are omitted,
 * the deterministic defaults above are used.
 *
 * @param {{ draftLookahead?: number, draftGen?: Function, verify?: Function, random?: () => number }} [opts]
 * @returns {SpeculativeSession}
 */
export function createSpeculativeSession(opts = {}) {
  const draftLookahead = Number.isFinite(opts.draftLookahead) && opts.draftLookahead > 0
    ? Math.floor(opts.draftLookahead)
    : 4;
  const draftGen = typeof opts.draftGen === "function"
    ? /** @type {any} */ (opts.draftGen)
    : defaultDraftGen;
  const verify = typeof opts.verify === "function"
    ? /** @type {any} */ (opts.verify)
    : defaultVerify;
  const id = nextId(opts.random);
  const session = {
    id,
    draftLookahead,
    draftGen,
    verify,
    createdAt: new Date().toISOString(),
  };
  sessions.set(id, session);
  return session;
}

/**
 * Look up an existing session by id.
 * @param {string} id
 */
export function getSession(id) {
  return sessions.get(id) || null;
}

/**
 * Drop a session from the in-memory registry.
 * @param {string} id
 */
export function destroySession(id) {
  return sessions.delete(id);
}

/* -------------------------------------------------------------------------- */
/* Generate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run one speculative-decode pass. Interleaves draft tokens with
 * verifier acceptance counts and returns the final accepted token
 * stream. Persists acceptance stats so `getAcceptanceRate` can read
 * them.
 *
 * @param {SpeculativeSession | string} sessionOrId
 * @param {string} prompt
 * @param {{ maxTokens?: number }} [opts]
 * @returns {Promise<{ tokens: string[], drafted: number, accepted: number, rounds: number, acceptanceRate: number }>}
 */
export async function generateSpeculative(sessionOrId, prompt, opts = {}) {
  const session = typeof sessionOrId === "string"
    ? sessions.get(sessionOrId)
    : sessionOrId;
  if (!session || typeof session !== "object") {
    throw new Error("invalid session");
  }
  const maxTokens = Number.isFinite(opts.maxTokens) && opts.maxTokens > 0
    ? Math.floor(opts.maxTokens)
    : 32;

  /** @type {string[]} */
  const produced = [];
  let drafted = 0;
  let accepted = 0;
  let rounds = 0;

  while (produced.length < maxTokens) {
    const remaining = maxTokens - produced.length;
    const n = Math.min(session.draftLookahead, remaining);
    const draft = session.draftGen(prompt, n);
    rounds += 1;
    if (!Array.isArray(draft) || draft.length === 0) break;
    drafted += draft.length;
    const k = Math.max(0, Math.min(draft.length, Number(session.verify(prompt, draft)) || 0));
    for (let i = 0; i < k; i += 1) produced.push(draft[i]);
    accepted += k;
    // When not all draft tokens accepted, target emits one "fallback" token
    // (the verifier's chosen replacement) and we retry the draft on a new prompt window.
    if (k < draft.length && produced.length < maxTokens) {
      produced.push(`target_${rounds}`);
    }
    // Guard against infinite loop when nothing progresses.
    if (k === 0 && produced.length === 0) break;
    if (k === draft.length && k === 0) break;
  }

  const acceptanceRate = drafted > 0
    ? Math.round((accepted / drafted) * 10000) / 10000
    : 0;

  await updateStats(session.id, { drafted, accepted, rounds });

  return { tokens: produced, drafted, accepted, rounds, acceptanceRate };
}

/* -------------------------------------------------------------------------- */
/* Stats persistence                                                          */
/* -------------------------------------------------------------------------- */

async function loadStats() {
  const data = await readJsonPath(statsPath(), {
    version: STORE_VERSION,
    global: { drafted: 0, accepted: 0, rounds: 0, calls: 0 },
    sessions: {},
  });
  if (!data.global) data.global = { drafted: 0, accepted: 0, rounds: 0, calls: 0 };
  if (!data.sessions) data.sessions = {};
  return data;
}

async function saveStats(data) {
  await writeJsonPath(statsPath(), {
    version: STORE_VERSION,
    global: data.global,
    sessions: data.sessions,
    updatedAt: new Date().toISOString(),
  });
}

async function updateStats(sessionId, delta) {
  const path = statsPath();
  await withPathLock(path, async () => {
    const data = await loadStats();
    data.global.drafted += delta.drafted;
    data.global.accepted += delta.accepted;
    data.global.rounds += delta.rounds;
    data.global.calls += 1;
    const s = data.sessions[sessionId] || { drafted: 0, accepted: 0, rounds: 0, calls: 0 };
    s.drafted += delta.drafted;
    s.accepted += delta.accepted;
    s.rounds += delta.rounds;
    s.calls += 1;
    data.sessions[sessionId] = s;
    await saveStats(data);
  });
}

/**
 * Acceptance rate across all sessions (or for a specific session).
 *
 * @param {string} [sessionId]
 * @returns {Promise<number>}
 */
export async function getAcceptanceRate(sessionId) {
  const data = await loadStats();
  const src = sessionId ? data.sessions[sessionId] : data.global;
  if (!src || !src.drafted) return 0;
  return Math.round((src.accepted / src.drafted) * 10000) / 10000;
}

/**
 * Clear acceptance stats globally or for one session.
 *
 * @param {string} [sessionId]
 * @returns {Promise<void>}
 */
export async function resetStats(sessionId) {
  const path = statsPath();
  await withPathLock(path, async () => {
    const data = await loadStats();
    if (sessionId) {
      delete data.sessions[sessionId];
    } else {
      data.global = { drafted: 0, accepted: 0, rounds: 0, calls: 0 };
      data.sessions = {};
    }
    await saveStats(data);
  });
}

/**
 * Diagnostic: list per-session stats snapshots.
 */
export async function listSessionStats() {
  const data = await loadStats();
  return data.sessions;
}
