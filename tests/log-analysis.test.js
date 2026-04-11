/**
 * Phase 60.4: log-analysis tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-loganalysis-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  ingestLog,
  detectAnomalies,
  clusterErrors,
  summarizeWindow,
  listAnomalies,
  clearLogs,
  normalizeEntry,
  signature,
  bucketByWindow,
} = await import("../lib/log-analysis.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("normalizeEntry fills defaults", () => {
  const n = normalizeEntry({ message: "hello" });
  assert.equal(n.message, "hello");
  assert.equal(n.level, "info");
  assert.equal(n.source, "unknown");
  assert.ok(n.timestamp);
});

test("normalizeEntry rejects empty or invalid entries", () => {
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry({ message: "" }), null);
  assert.equal(normalizeEntry({ message: "   " }), null);
});

test("signature strips numbers, uuids, ips, quoted strings", () => {
  const s1 = signature("Request 123 for user aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee failed");
  const s2 = signature("Request 999 for user 11112222-3333-4444-5555-666677778888 failed");
  assert.equal(s1, s2);
  const s3 = signature('Error: "connection refused" from 10.0.0.1');
  assert.ok(s3.includes("<str>"));
  assert.ok(s3.includes("<ip>"));
});

test("ingestLog persists entries", async () => {
  await clearLogs();
  const log = await ingestLog({ message: "hello world", level: "info", source: "test" });
  assert.ok(log.id);
  assert.equal(log.message, "hello world");
  const summary = await summarizeWindow({ windowMs: 60000 });
  assert.equal(summary.totalLogs, 1);
});

test("ingestLog rejects invalid input", async () => {
  await assert.rejects(() => ingestLog({ message: "" }));
  await assert.rejects(() => ingestLog(null));
});

test("bucketByWindow groups logs by time", () => {
  const base = 1_700_000_000_000;
  const logs = [
    { timestamp: new Date(base).toISOString() },
    { timestamp: new Date(base + 10_000).toISOString() },
    { timestamp: new Date(base + 70_000).toISOString() },
  ];
  const buckets = bucketByWindow(logs, 60_000, base + 70_000);
  assert.ok(buckets.length >= 2);
  const total = buckets.reduce((a, b) => a + b.count, 0);
  assert.equal(total, 3);
});

test("summarizeWindow counts by level and source", async () => {
  await clearLogs();
  await ingestLog({ message: "one", level: "info", source: "api" });
  await ingestLog({ message: "two", level: "error", source: "api" });
  await ingestLog({ message: "three", level: "error", source: "worker" });
  const summary = await summarizeWindow({ windowMs: 60_000 });
  assert.equal(summary.totalLogs, 3);
  assert.equal(summary.byLevel.error, 2);
  assert.equal(summary.byLevel.info, 1);
  assert.equal(summary.bySource.api, 2);
});

test("clusterErrors groups by signature", async () => {
  await clearLogs();
  for (let i = 0; i < 5; i += 1) {
    await ingestLog({
      message: `Request ${i} failed with code ${100 + i}`,
      level: "error",
      source: "api",
    });
  }
  await ingestLog({
    message: "Database connection reset by peer",
    level: "error",
    source: "db",
  });
  const result = await clusterErrors({ top: 5 });
  assert.ok(result.clusters.length >= 2);
  const biggest = result.clusters[0];
  assert.equal(biggest.count, 5);
  assert.equal(result.total, 6);
});

test("detectAnomalies flags frequency spikes", async () => {
  await clearLogs();
  const base = Date.parse("2024-01-01T00:00:00Z");
  // Baseline: 1 log per minute for 5 minutes
  for (let i = 0; i < 5; i += 1) {
    await ingestLog({
      message: `base ${i}`,
      level: "info",
      source: "api",
      timestamp: new Date(base + i * 60_000 + 10_000).toISOString(),
    });
  }
  // Spike: 20 logs in the next minute
  for (let i = 0; i < 20; i += 1) {
    await ingestLog({
      message: `spike ${i}`,
      level: "info",
      source: "api",
      timestamp: new Date(base + 5 * 60_000 + 10_000 + i).toISOString(),
    });
  }
  const result = await detectAnomalies({
    windowMs: 60_000,
    baselineWindows: 5,
    spikeFactor: 2,
    now: base + 5 * 60_000 + 30_000,
  });
  assert.ok(result.anomalies.some((a) => a.kind === "frequency_spike"));
});

test("detectAnomalies flags error bursts", async () => {
  await clearLogs();
  const base = Date.parse("2024-02-01T00:00:00Z");
  for (let i = 0; i < 10; i += 1) {
    await ingestLog({
      message: `err ${i}`,
      level: "error",
      source: "worker",
      timestamp: new Date(base + i).toISOString(),
    });
  }
  const result = await detectAnomalies({
    windowMs: 60_000,
    now: base + 5_000,
  });
  assert.ok(result.anomalies.some((a) => a.kind === "error_burst"));
});

test("listAnomalies returns persisted anomalies", async () => {
  await clearLogs();
  const base = Date.parse("2024-03-01T00:00:00Z");
  for (let i = 0; i < 10; i += 1) {
    await ingestLog({
      message: `x ${i}`,
      level: "error",
      source: "api",
      timestamp: new Date(base + i).toISOString(),
    });
  }
  await detectAnomalies({ windowMs: 60_000, now: base + 1000 });
  const anomalies = await listAnomalies();
  assert.ok(anomalies.length >= 1);
});

test("clearLogs empties the store", async () => {
  await ingestLog({ message: "to clear", level: "info" });
  await clearLogs();
  const s = await summarizeWindow({ windowMs: 60_000 });
  assert.equal(s.totalLogs, 0);
  const anomalies = await listAnomalies();
  assert.equal(anomalies.length, 0);
});
