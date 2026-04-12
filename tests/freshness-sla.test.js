/**
 * Phase 68.5: Freshness SLA tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-freshness-sla-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  defineFreshnessSla,
  recordUpdate,
  getFreshness,
  listFreshness,
  listAlerts,
  evaluateAlerts,
} = await import("../lib/freshness-sla.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("defineFreshnessSla validates inputs", async () => {
  await assert.rejects(() => defineFreshnessSla("", { targetMs: 1000 }), /corpusKey/);
  await assert.rejects(() => defineFreshnessSla("k", {}), /targetMs/);
  await assert.rejects(() => defineFreshnessSla("k", { targetMs: -1 }), /targetMs/);
});

test("defineFreshnessSla creates a record and listFreshness returns it", async () => {
  const rec = await defineFreshnessSla("wiki-snapshot", {
    targetMs: 24 * 3600 * 1000,
    name: "Wiki Snapshot",
    severity: "warn",
  });
  assert.equal(rec.corpusKey, "wiki-snapshot");
  assert.equal(rec.targetMs, 86400000);
  const list = await listFreshness();
  assert.ok(list.some((r) => r.corpusKey === "wiki-snapshot"));
});

test("defineFreshnessSla on existing key updates target and preserves history", async () => {
  await defineFreshnessSla("iter", { targetMs: 1000 });
  await recordUpdate("iter", {});
  const updated = await defineFreshnessSla("iter", { targetMs: 5000 });
  assert.equal(updated.targetMs, 5000);
  assert.equal(updated.updates.length, 1);
});

test("recordUpdate requires existing SLA", async () => {
  await assert.rejects(() => recordUpdate("nope", {}), /not defined/);
});

test("recordUpdate moves lastUpdateAt and getFreshness reports fresh", async () => {
  await defineFreshnessSla("fresh-test", { targetMs: 60_000 });
  await recordUpdate("fresh-test", { actor: "cron" });
  const status = await getFreshness("fresh-test");
  assert.equal(status.status, "fresh");
  assert.equal(status.overdue, false);
  assert.ok(status.ageMs >= 0);
});

test("getFreshness flags never when no updates yet", async () => {
  await defineFreshnessSla("never", { targetMs: 10_000 });
  const status = await getFreshness("never");
  assert.equal(status.status, "never");
  assert.equal(status.neverUpdated, true);
});

test("getFreshness flags overdue when ageMs > targetMs", async () => {
  await defineFreshnessSla("overdue-test", { targetMs: 1 });
  await recordUpdate("overdue-test", { at: new Date(Date.now() - 60_000).toISOString() });
  const status = await getFreshness("overdue-test");
  assert.equal(status.status, "overdue");
  assert.equal(status.overdue, true);
});

test("evaluateAlerts generates alerts for overdue corpora and deduplicates by day", async () => {
  await defineFreshnessSla("alert-test", { targetMs: 1, severity: "error" });
  await recordUpdate("alert-test", { at: new Date(Date.now() - 10_000).toISOString() });
  const first = await evaluateAlerts();
  assert.ok(first.some((a) => a.corpusKey === "alert-test"));
  const second = await evaluateAlerts(); // same day — should dedupe
  assert.ok(!second.some((a) => a.corpusKey === "alert-test"));
  const all = await listAlerts({ corpusKey: "alert-test" });
  assert.ok(all.length >= 1);
});

test("listAlerts filters by severity and status", async () => {
  await defineFreshnessSla("warn-alert", { targetMs: 1, severity: "warn" });
  await recordUpdate("warn-alert", { at: new Date(Date.now() - 10_000).toISOString() });
  await evaluateAlerts();
  const warns = await listAlerts({ severity: "warn" });
  assert.ok(warns.every((a) => a.severity === "warn"));
  const overdues = await listAlerts({ status: "overdue" });
  assert.ok(overdues.every((a) => a.status === "overdue"));
});

test("listFreshness includes all defined corpora", async () => {
  await defineFreshnessSla("a", { targetMs: 60_000 });
  await defineFreshnessSla("b", { targetMs: 60_000 });
  const list = await listFreshness();
  const keys = list.map((r) => r.corpusKey);
  assert.ok(keys.includes("a"));
  assert.ok(keys.includes("b"));
});

test("getFreshness throws NOT_FOUND for undefined corpusKey", async () => {
  await assert.rejects(() => getFreshness("not-there"), /not defined/);
});
