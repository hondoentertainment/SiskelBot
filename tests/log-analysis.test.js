/**
 * Phase 60.4: Log analysis tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-log-analysis-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  normalizeLine,
  ingestLogs,
  getAnomalies,
  getClusterSummary,
  summarizeWithLlm,
  setLlmSummarizer,
  persistState,
  loadPersistedState,
  resetLogAnalysis,
} = await import("../lib/log-analysis.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test.beforeEach(() => {
  resetLogAnalysis();
});

// ─── Normalization ────────────────────────────────────────────────────────

test("normalizeLine strips timestamps, uuids, numbers, and ids", () => {
  const a = normalizeLine("2024-11-05T12:00:00Z req f47ac10b-58cc-4372-a567-0e02b2c3d479 took 123ms");
  const b = normalizeLine("2024-11-06T12:05:00Z req 550e8400-e29b-41d4-a716-446655440000 took 456ms");
  assert.equal(a, b);
});

test("normalizeLine keeps different templates distinct", () => {
  const a = normalizeLine("request failed in 100ms");
  const b = normalizeLine("request completed in 100ms");
  assert.notEqual(a, b);
});

test("normalizeLine handles empty input", () => {
  assert.equal(normalizeLine(""), "");
  assert.equal(normalizeLine(null), "");
  assert.equal(normalizeLine(undefined), "");
});

// ─── Ingest ───────────────────────────────────────────────────────────────

test("ingestLogs creates clusters and increments counts", () => {
  const lines = [
    "2024-11-05 ERROR db timeout after 100ms",
    "2024-11-05 ERROR db timeout after 200ms",
    "2024-11-05 INFO request served in 50ms",
  ];
  const result = ingestLogs(lines);
  assert.equal(result.ingested, 3);
  assert.equal(result.clusterCount, 2);
});

test("ingestLogs accepts object-shaped entries with `at`", () => {
  const at = Date.now() - 10_000;
  const result = ingestLogs([{ message: "test log 42", at }]);
  assert.equal(result.ingested, 1);
});

test("ingestLogs skips empty messages", () => {
  const result = ingestLogs(["", "  "]);
  assert.equal(result.ingested, 0);
});

// ─── Anomalies ────────────────────────────────────────────────────────────

test("getAnomalies flags a cluster that appeared for the first time", () => {
  ingestLogs([
    "ERROR new thing happened",
    "ERROR new thing happened",
    "ERROR new thing happened",
  ]);
  const result = getAnomalies({ windowMs: 60_000 });
  assert.ok(result.anomalies.length >= 1);
  const first = result.anomalies[0];
  assert.equal(first.kind, "new");
});

test("getAnomalies flags a spiking cluster", () => {
  const now = Date.now();
  // 2 events "long ago" (prior window)
  ingestLogs([
    { message: "foo event happened", at: now - 20 * 60 * 1000 },
    { message: "foo event happened", at: now - 19 * 60 * 1000 },
  ]);
  // 12 events in current window
  const burst = [];
  for (let i = 0; i < 12; i += 1) {
    burst.push({ message: "foo event happened", at: now - 1000 * (i + 1) });
  }
  ingestLogs(burst);
  const result = getAnomalies({ windowMs: 15 * 60 * 1000, spikeRatio: 3 });
  assert.ok(result.anomalies.some((a) => a.kind === "spiking" || a.kind === "new"));
});

test("getAnomalies returns empty when no anomalies", () => {
  // A single cluster with steady low traffic.
  const now = Date.now();
  const lines = [];
  for (let i = 0; i < 4; i += 1) {
    lines.push({ message: "steady event", at: now - 60 * 60 * 1000 + i });
  }
  ingestLogs(lines);
  const result = getAnomalies({ windowMs: 15 * 60 * 1000 });
  // With all events outside the window, none should qualify.
  assert.equal(result.anomalies.length, 0);
});

// ─── Cluster summary ──────────────────────────────────────────────────────

test("getClusterSummary sorts by totalCount and respects limit", () => {
  ingestLogs(["alpha error", "alpha error", "alpha error", "beta warn", "beta warn"]);
  const report = getClusterSummary({ limit: 1 });
  assert.equal(report.clusters.length, 1);
  assert.equal(report.total, 2);
  assert.ok(/alpha/.test(report.clusters[0].sample));
});

// ─── summarizeWithLlm ────────────────────────────────────────────────────

test("summarizeWithLlm falls back to a deterministic digest", async () => {
  ingestLogs(["ERROR new bad event", "ERROR new bad event", "ERROR new bad event"]);
  const result = await summarizeWithLlm({ windowMs: 60_000 });
  assert.ok(typeof result.summary === "string");
  assert.ok(Array.isArray(result.anomalies));
});

test("setLlmSummarizer overrides the default", async () => {
  setLlmSummarizer(async () => "custom summary");
  ingestLogs(["ERROR spike event", "ERROR spike event", "ERROR spike event"]);
  const result = await summarizeWithLlm({ windowMs: 60_000 });
  assert.equal(result.summary, "custom summary");
  // Restore.
  setLlmSummarizer(async (anomalies) => `fallback ${anomalies.length}`);
});

// ─── Persistence ──────────────────────────────────────────────────────────

test("persistState + loadPersistedState round trip", async () => {
  ingestLogs(["ERROR thing a", "ERROR thing b"]);
  await persistState();
  const loaded = await loadPersistedState();
  assert.ok(loaded.clusters.length >= 2);
});
