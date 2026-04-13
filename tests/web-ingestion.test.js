/**
 * Phase 68.1: Web ingestion tests. Uses an injected fetcher to avoid network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-web-ingestion-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerSource,
  getSource,
  listSources,
  deleteSource,
  runIngestion,
  getIngestionStatus,
  getRun,
} = await import("../lib/web-ingestion.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("registerSource validates fields", async () => {
  await assert.rejects(() => registerSource({}), /name/);
  await assert.rejects(() => registerSource({ name: "x" }), /urls/);
  await assert.rejects(() => registerSource({ name: "x", urls: [""] }), /URL/);
});

test("registerSource persists with defaults and lists", async () => {
  const rec = await registerSource({
    name: "docs",
    urls: ["https://example.test/docs", "https://example.test/spec"],
    schedule: "*/15 * * * *",
    freshnessTargetMs: 60_000,
    tags: ["public"],
  });
  assert.ok(rec.id);
  assert.equal(rec.urls.length, 2);
  assert.equal(rec.schedule, "*/15 * * * *");
  const list = await listSources({ tag: "public" });
  assert.ok(list.some((s) => s.id === rec.id));
});

test("runIngestion with injected fetcher records success and updates counters", async () => {
  const rec = await registerSource({ name: "run-ok", urls: ["https://example.test/a", "https://example.test/b"] });
  const fetcher = async (url) => ({ text: `content of ${url}`, finalUrl: url });
  const run = await runIngestion(rec.id, { fetcher });
  assert.equal(run.status, "success");
  assert.equal(run.successCount, 2);
  assert.equal(run.failureCount, 0);
  assert.ok(run.results[0].byteLength > 0);
  const after = await getSource(rec.id);
  assert.equal(after.runCount, 1);
  assert.equal(after.successCount, 1);
  assert.ok(after.lastSuccessAt);
});

test("runIngestion records partial status on some failures", async () => {
  const rec = await registerSource({ name: "run-partial", urls: ["https://example.test/ok", "https://example.test/bad"] });
  const fetcher = async (url) => {
    if (url.endsWith("bad")) return { error: "HTTP 500", code: "FETCH_FAILED" };
    return { text: "ok", finalUrl: url };
  };
  const run = await runIngestion(rec.id, { fetcher });
  assert.equal(run.status, "partial");
  assert.equal(run.successCount, 1);
  assert.equal(run.failureCount, 1);
  const after = await getSource(rec.id);
  assert.equal(after.lastErrors.length, 1);
});

test("runIngestion records failed status when all urls fail", async () => {
  const rec = await registerSource({ name: "run-fail", urls: ["https://example.test/z"] });
  const fetcher = async () => ({ error: "nope", code: "FETCH_FAILED" });
  const run = await runIngestion(rec.id, { fetcher });
  assert.equal(run.status, "failed");
  assert.equal(run.failureCount, 1);
});

test("getIngestionStatus reports freshness relative to target", async () => {
  const rec = await registerSource({
    name: "fresh-check",
    urls: ["https://example.test/x"],
    freshnessTargetMs: 24 * 3600 * 1000,
  });
  const fresh0 = await getIngestionStatus(rec.id);
  assert.equal(fresh0.freshness, "never_ingested");
  await runIngestion(rec.id, { fetcher: async () => ({ text: "ok", finalUrl: "x" }) });
  const after = await getIngestionStatus(rec.id);
  assert.equal(after.freshness, "fresh");
  assert.ok(after.ageMs >= 0);
});

test("getIngestionStatus flags stale when target exceeded", async () => {
  const rec = await registerSource({
    name: "stale-check",
    urls: ["https://example.test/y"],
    freshnessTargetMs: 1, // 1 ms SLA so it goes stale immediately
  });
  await runIngestion(rec.id, { fetcher: async () => ({ text: "ok", finalUrl: "y" }) });
  await new Promise((r) => setTimeout(r, 10));
  const status = await getIngestionStatus(rec.id);
  assert.equal(status.freshness, "stale");
});

test("getRun returns the saved ingestion record", async () => {
  const rec = await registerSource({ name: "get-run", urls: ["https://example.test/get"] });
  const run = await runIngestion(rec.id, { fetcher: async () => ({ text: "ok", finalUrl: "get" }) });
  const fetched = await getRun(run.id);
  assert.equal(fetched.id, run.id);
  assert.equal(fetched.sourceId, rec.id);
});

test("deleteSource removes and prevents further runs", async () => {
  const rec = await registerSource({ name: "to-delete", urls: ["https://example.test/d"] });
  const del = await deleteSource(rec.id);
  assert.equal(del.ok, true);
  await assert.rejects(() => runIngestion(rec.id, { fetcher: async () => ({ text: "" }) }), /not found/);
});

test("runIngestion handles thrown fetcher errors gracefully", async () => {
  const rec = await registerSource({ name: "throws", urls: ["https://example.test/t"] });
  const fetcher = async () => { throw new Error("boom"); };
  const run = await runIngestion(rec.id, { fetcher });
  assert.equal(run.status, "failed");
  assert.equal(run.results[0].ok, false);
});
