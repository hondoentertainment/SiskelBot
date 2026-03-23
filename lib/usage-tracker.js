/**
 * Phase 13: Observability & Cost Control.
 * Token usage tracking and summary for SiskelBot streaming assistant.
 * Phase 68: usage.json via json-path-store (Postgres / SQLite / file).
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_ENTRIES = 100_000;

function usagePath() {
  return join(getDataDir(), "usage.json");
}

async function loadRaw() {
  const path = usagePath();
  const data = await readJsonPath(path, { _version: 1, records: [] });
  return Array.isArray(data.records) ? data.records : [];
}

async function saveRecords(records) {
  const path = usagePath();
  const trimmed = records.length > MAX_ENTRIES ? records.slice(-MAX_ENTRIES) : records;
  await writeJsonPath(path, { _version: 1, records: trimmed });
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
        if (part?.type === "image_url") chars += 1000;
      }
    }
  }
  return Math.max(1, Math.ceil((chars || 0) / 4));
}

/**
 * Record a usage entry and persist.
 * @param {Object} entry
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

  const path = usagePath();
  return withPathLock(path, async () => {
    const records = await loadRaw();
    records.push(rec);
    await saveRecords(records);
  });
}

/**
 * Get usage summary for the last N days.
 * @param {number} days
 * @returns {Promise<Object>}
 */
export async function getSummary(days = 7) {
  const records = await loadRaw();
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
 * @param {number} days
 * @param {{ workspace?: string, userId?: string }} opts
 * @returns {Promise<Array>}
 */
export async function getRecordsForPeriod(days = 7, opts = {}) {
  const records = await loadRaw();
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
 * @returns {Promise<number>}
 */
export async function getTotalTokensInWindow() {
  const records = await loadRaw();
  return records.reduce((sum, r) => sum + (r.inputTokens || 0) + (r.outputTokens || 0), 0);
}

/**
 * Helper to estimate input tokens from request body and output from stream.
 */
export const estimate = {
  inputFromMessages: countInputTokensFromMessages,
  outputFromChars: (chars) => estimateTokens(String(chars || "")),
};
