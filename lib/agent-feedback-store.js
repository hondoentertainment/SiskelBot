/**
 * Per-workspace durable human-feedback store for agent runs.
 *
 * SiskelBot already collects rich automated signals (failure categories,
 * genealogy, swarm conflicts, tool-result judge). What was missing was a
 * human-in-the-loop feedback surface: users / ops / reviewers need to be able
 * to mark a specific agent response as thumbs-up / thumbs-down, optionally
 * attach a numeric score, tags, a freeform comment, and a snapshot of the
 * response being rated.
 *
 * Without this we can't:
 *   - collect RLHF-style training signal
 *   - A/B test agent improvements against ground-truth user satisfaction
 *   - surface systematic problem categories (hallucination, wrong_tool, ...)
 *
 * Storage pattern follows lib/swarm-conflict-store.js:
 *   - one JSON blob per workspace at data/agent-feedback/<workspace>/events.json
 *   - routed through readJsonPath / writeJsonPath (JSON -> SQLite -> Postgres)
 *   - ring buffer of MAX_EVENTS_PER_WORKSPACE=5000 (larger than conflict log
 *     because feedback is more valuable and lower volume)
 *
 * @module agent-feedback-store
 */

import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";

const MAX_EVENTS_PER_WORKSPACE = 5000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const MAX_TEXT_CHARS = 2000;
const MAX_TAGS = 10;
const MAX_TAG_LEN = 40;
const VALID_RATINGS = new Set(["up", "down"]);

/**
 * @typedef {object} FeedbackEvent
 * @property {string} id
 * @property {number} ts
 * @property {string} runId
 * @property {string} [sessionId]
 * @property {string} workspace
 * @property {string} userId
 * @property {"up" | "down"} rating
 * @property {number} [score]
 * @property {string[]} [tags]
 * @property {string} [comment]
 * @property {string} [agentResponse]
 */

/**
 * @typedef {object} WorkspaceFeedbackLog
 * @property {number} version
 * @property {number} updatedAt
 * @property {FeedbackEvent[]} events
 */

function sanitizeSegment(s) {
  if (typeof s !== "string" || s.length === 0) return "default";
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function storePath(workspace) {
  const ws = sanitizeSegment(workspace);
  return join(getDataDir(), "agent-feedback", ws, "events.json");
}

function emptyLog() {
  return { version: 1, updatedAt: 0, events: [] };
}

async function loadLog(workspace) {
  const path = storePath(workspace);
  const raw = await readJsonPath(path, emptyLog());
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.events)) return emptyLog();
  return raw;
}

function truncateText(s) {
  if (typeof s !== "string") return undefined;
  if (s.length > MAX_TEXT_CHARS) return s.slice(0, MAX_TEXT_CHARS);
  return s;
}

function validateAndNormalize(workspace, event) {
  if (!event || typeof event !== "object") {
    throw new Error("invalid feedback event: body must be an object");
  }
  const rating = event.rating;
  if (typeof rating !== "string" || !VALID_RATINGS.has(rating)) {
    throw new Error("invalid feedback event: rating must be 'up' or 'down'");
  }
  const runId = typeof event.runId === "string" ? event.runId.trim() : "";
  if (!runId) {
    throw new Error("invalid feedback event: runId required");
  }
  const userId = typeof event.userId === "string" ? event.userId.trim() : "";
  if (!userId) {
    throw new Error("invalid feedback event: userId required");
  }

  /** @type {FeedbackEvent} */
  const normalized = {
    id: randomUUID(),
    ts: Date.now(),
    runId,
    workspace: sanitizeSegment(workspace),
    userId,
    rating,
  };

  if (typeof event.sessionId === "string" && event.sessionId.trim()) {
    normalized.sessionId = event.sessionId.trim();
  }

  if (event.score !== undefined && event.score !== null) {
    const n = Number(event.score);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw new Error("invalid feedback event: score must be an integer 1-5");
    }
    normalized.score = n;
  }

  if (event.tags !== undefined && event.tags !== null) {
    if (!Array.isArray(event.tags)) {
      throw new Error("invalid feedback event: tags must be an array");
    }
    if (event.tags.length > MAX_TAGS) {
      throw new Error(`invalid feedback event: tags must be <= ${MAX_TAGS} entries`);
    }
    const cleaned = [];
    for (const t of event.tags) {
      if (typeof t !== "string") {
        throw new Error("invalid feedback event: tags must all be strings");
      }
      const trimmed = t.trim();
      if (!trimmed) continue;
      if (trimmed.length > MAX_TAG_LEN) {
        throw new Error(`invalid feedback event: tag length must be <= ${MAX_TAG_LEN} chars`);
      }
      cleaned.push(trimmed);
    }
    if (cleaned.length > 0) normalized.tags = cleaned;
  }

  // comment + agentResponse are truncated (NOT thrown) when too long.
  if (event.comment !== undefined && event.comment !== null) {
    if (typeof event.comment !== "string") {
      throw new Error("invalid feedback event: comment must be a string");
    }
    const t = truncateText(event.comment);
    if (t) normalized.comment = t;
  }
  if (event.agentResponse !== undefined && event.agentResponse !== null) {
    if (typeof event.agentResponse !== "string") {
      throw new Error("invalid feedback event: agentResponse must be a string");
    }
    const t = truncateText(event.agentResponse);
    if (t) normalized.agentResponse = t;
  }

  return normalized;
}

/**
 * Record one feedback event for a workspace. Returns the stored event.
 *
 * @param {string} workspace
 * @param {Omit<FeedbackEvent, "id" | "ts" | "workspace">} event
 * @returns {Promise<FeedbackEvent>}
 */
export async function recordFeedback(workspace, event) {
  const normalized = validateAndNormalize(workspace, event);
  const path = storePath(workspace);
  const log = await loadLog(workspace);

  log.events.push(normalized);

  if (log.events.length > MAX_EVENTS_PER_WORKSPACE) {
    const drop = log.events.length - MAX_EVENTS_PER_WORKSPACE;
    log.events.splice(0, drop);
  }

  log.updatedAt = normalized.ts;
  await writeJsonPath(path, log);
  return normalized;
}

/**
 * List feedback events for a workspace, newest-first.
 *
 * @param {string} workspace
 * @param {{ limit?: number, runId?: string, rating?: "up"|"down" }} [opts]
 * @returns {Promise<FeedbackEvent[]>}
 */
export async function listFeedback(workspace, opts = {}) {
  const log = await loadLog(workspace);
  const requested = Number(opts?.limit);
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIST_LIMIT),
  );
  const runFilter = typeof opts?.runId === "string" && opts.runId.length > 0 ? opts.runId : null;
  const ratingFilter = VALID_RATINGS.has(opts?.rating) ? opts.rating : null;

  const out = [];
  for (let i = log.events.length - 1; i >= 0 && out.length < limit; i--) {
    const ev = log.events[i];
    if (runFilter && ev.runId !== runFilter) continue;
    if (ratingFilter && ev.rating !== ratingFilter) continue;
    out.push(ev);
  }
  return out;
}

/**
 * Fetch a single feedback event by id for a workspace.
 *
 * @param {string} workspace
 * @param {string} id
 * @returns {Promise<FeedbackEvent | null>}
 */
export async function getFeedback(workspace, id) {
  if (typeof id !== "string" || id.length === 0) return null;
  const log = await loadLog(workspace);
  for (let i = log.events.length - 1; i >= 0; i--) {
    if (log.events[i].id === id) return log.events[i];
  }
  return null;
}

/**
 * Clear all feedback events for a workspace.
 *
 * @param {string} workspace
 * @returns {Promise<void>}
 */
export async function clearFeedback(workspace) {
  const path = storePath(workspace);
  await writeJsonPath(path, emptyLog());
}

/**
 * Aggregate feedback for a workspace. Optionally restrict to events at/after
 * `sinceTs`.
 *
 * @param {string} workspace
 * @param {{ sinceTs?: number }} [opts]
 * @returns {Promise<{
 *   total: number,
 *   upCount: number,
 *   downCount: number,
 *   upRate: number,
 *   avgScore: number | null,
 *   tagCounts: Record<string, number>,
 *   byDay: Array<{date: string, up: number, down: number}>
 * }>}
 */
export async function aggregateFeedback(workspace, opts = {}) {
  const log = await loadLog(workspace);
  const since = Number.isFinite(opts?.sinceTs) ? Number(opts.sinceTs) : 0;

  let upCount = 0;
  let downCount = 0;
  let scoreSum = 0;
  let scoreN = 0;
  /** @type {Record<string, number>} */
  const tagCounts = {};
  /** @type {Map<string, {up: number, down: number}>} */
  const dayMap = new Map();

  for (const ev of log.events) {
    if (!ev || typeof ev !== "object") continue;
    if (since && ev.ts < since) continue;

    if (ev.rating === "up") upCount += 1;
    else if (ev.rating === "down") downCount += 1;

    if (Number.isFinite(ev.score)) {
      scoreSum += Number(ev.score);
      scoreN += 1;
    }

    if (Array.isArray(ev.tags)) {
      for (const t of ev.tags) {
        if (typeof t !== "string" || !t) continue;
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }

    const date = new Date(ev.ts).toISOString().slice(0, 10);
    let bucket = dayMap.get(date);
    if (!bucket) {
      bucket = { up: 0, down: 0 };
      dayMap.set(date, bucket);
    }
    if (ev.rating === "up") bucket.up += 1;
    else if (ev.rating === "down") bucket.down += 1;
  }

  const total = upCount + downCount;
  const upRate = total > 0 ? upCount / total : 0;
  const avgScore = scoreN > 0 ? scoreSum / scoreN : null;
  const byDay = Array.from(dayMap.entries())
    .map(([date, v]) => ({ date, up: v.up, down: v.down }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { total, upCount, downCount, upRate, avgScore, tagCounts, byDay };
}
