/**
 * Phase 13: Observability & Cost Control.
 * Token usage tracking and summary for SiskelBot streaming assistant.
 * Stores per-request records in data/usage.json; supports summary and budget alerts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = process.env.STORAGE_PATH || join(process.cwd(), "data");
const USAGE_FILE = "usage.json";
const MAX_ENTRIES = 100_000; // rolling window: keep last N entries

let _locks = new Map();

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getUsagePath() {
  const dir = process.env.STORAGE_PATH || join(process.cwd(), "data");
  ensureDir(dir);
  return join(dir, USAGE_FILE);
}

function loadRaw() {
  const path = getUsagePath();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data.records) ? data.records : [];
    }
  } catch (e) {
    console.warn("[usage-tracker] Failed to load", path, e.message);
  }
  return [];
}

function saveRecords(records) {
  const path = getUsagePath();
  ensureDir(dirname(path));
  const trimmed = records.length > MAX_ENTRIES ? records.slice(-MAX_ENTRIES) : records;
  writeFileSync(path, JSON.stringify({ _version: 1, records: trimmed }, null, 0), "utf8");
}

async function withLock(fn) {
  const key = "usage";
  let q = _locks.get(key);
  if (!q) q = Promise.resolve();
  const next = q.then(() => fn()).catch((e) => {
    throw e;
  });
  _locks.set(key, next);
  return next;
}

/**
 * Estimate tokens from character length (approximate: ~4 chars per token for English).
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (typeof text !== "string" || !text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Count input tokens from messages array (OpenAI-style structure).
 * Handles string content and multimodal content (text + image).
 * @param {Array} messages
 * @returns {number}
 */
function countInputTokensFromMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    const c = m?.content;
    if (typeof c === "string") {
      chars += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "text" && typeof part.text === "string") chars += part.text.length;
        if (part?.type === "image_url") chars += 1000; // rough image token equivalent
      }
    }
  }
  return Math.max(1, Math.ceil((chars || 0) / 4));
}

/**
 * Record a usage entry and persist to data/usage.json.
 * Phase 18: Optional workspace, userId for auth-scoped analytics.
 * @param {Object} entry - { timestamp, model, inputTokens, outputTokens, backend, workspace?, userId? }
 */
export async function recordUsage(entry) {
  const rec = {
    timestamp: entry.timestamp || new Date().toISOString(),
    model: String(entry.model || "unknown"),
    inputTokens: Math.max(0, Number(entry.inputTokens) || 0),
    outputTokens: Math.max(0, Number(entry.outputTokens) || 0),
    backend: String(entry.backend || "unknown"),
  };
  if (entry.workspace != null && String(entry.workspace).trim()) rec.workspace = String(entry.workspace).trim();
  if (entry.userId != null && String(entry.userId).trim()) rec.userId = String(entry.userId).trim();
  return withLock(() => {
    const records = loadRaw();
    records.push(rec);
    saveRecords(records);
  });
}

/**
 * Get usage summary for the last N days.
 * @param {number} days - number of days to include (default 7)
 * @returns {Object} { totalRequests, totalInputTokens, totalOutputTokens, byModel, byDay }
 */
export function getSummary(days = 7) {
  const records = loadRaw();
  const since = days * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - since;
  const filtered = records.filter((r) => {
    const ts = new Date(r.timestamp).getTime();
    return ts >= cutoff;
  });

  const totalRequests = filtered.length;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const byModel = {};
  const byDay = {};

  for (const r of filtered) {
    totalInputTokens += r.inputTokens || 0;
    totalOutputTokens += r.outputTokens || 0;
    const m = r.model || "unknown";
    if (!byModel[m]) byModel[m] = { requests: 0, inputTokens: 0, outputTokens: 0 };
    byModel[m].requests += 1;
    byModel[m].inputTokens += r.inputTokens || 0;
    byModel[m].outputTokens += r.outputTokens || 0;

    const dayKey = r.timestamp ? r.timestamp.slice(0, 10) : "unknown";
    if (!byDay[dayKey]) byDay[dayKey] = { requests: 0, inputTokens: 0, outputTokens: 0 };
    byDay[dayKey].requests += 1;
    byDay[dayKey].inputTokens += r.inputTokens || 0;
    byDay[dayKey].outputTokens += r.outputTokens || 0;
  }

  return {
    totalRequests,
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    byModel,
    byDay,
    days,
  };
}

/**
 * Get usage records for a time period, optionally filtered by workspace or userId.
 * Phase 18: Used by analytics dashboard and export.
 * @param {number} days - number of days to include (default 7)
 * @param {{ workspace?: string, userId?: string }} opts - optional filters
 * @returns {Array<{ timestamp, model, inputTokens, outputTokens, backend, workspace?, userId? }>}
 */
export function getRecordsForPeriod(days = 7, opts = {}) {
  const records = loadRaw();
  const since = days * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - since;
  return records.filter((r) => {
    const ts = new Date(r.timestamp).getTime();
    if (ts < cutoff) return false;
    if (opts.workspace != null && opts.workspace !== "" && (r.workspace == null || r.workspace !== opts.workspace)) return false;
    if (opts.userId != null && opts.userId !== "" && (r.userId == null || r.userId !== opts.userId)) return false;
    return true;
  });
}

/**
 * Get total tokens in rolling window (all stored records).
 * Used for budget alert comparison.
 * @returns {number}
 */
export function getTotalTokensInWindow() {
  const records = loadRaw();
  return records.reduce((sum, r) => sum + (r.inputTokens || 0) + (r.outputTokens || 0), 0);
}

/**
 * Helper to estimate input tokens from request body and output from stream.
 * For OpenAI streaming: parses usage from final SSE chunk when available.
 */
export const estimate = {
  inputFromMessages: countInputTokensFromMessages,
  outputFromChars: (chars) => estimateTokens(String(chars || "")),
};
