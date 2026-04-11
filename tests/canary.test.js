/**
 * Phase 59.4: Canary tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-canary-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createCanary,
  tickCanary,
  rollbackCanary,
  getCanaryStatus,
  listCanaries,
} = await import("../lib/canary.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("createCanary persists default steps", async () => {
  const c = await createCanary({
    name: "feature-x",
    stable: "v1",
    candidate: "v2",
  });
  assert.equal(c.name, "feature-x");
  assert.equal(c.stable, "v1");
  assert.equal(c.candidate, "v2");
  assert.equal(c.status, "pending");
  assert.equal(c.currentPercent, 0);
  assert.deepEqual(c.steps, [1, 5, 25, 50, 100]);
});

test("createCanary rejects invalid spec", async () => {
  await assert.rejects(() => createCanary(null));
  await assert.rejects(() => createCanary({ name: "n" }));
  await assert.rejects(() => createCanary({ name: "n", stable: "a" }));
});

test("createCanary normalizes custom steps and appends 100", async () => {
  const c = await createCanary({
    name: "custom",
    stable: "s",
    candidate: "c",
    steps: [10, 50, 30],
  });
  // 30 is bumped up to 50 to enforce monotonic order, then 100 appended.
  assert.equal(c.steps[0], 10);
  assert.ok(c.steps.includes(50));
  assert.equal(c.steps[c.steps.length - 1], 100);
});

test("tickCanary advances after minSuccessCount clean ticks", async () => {
  const c = await createCanary({
    name: "advance",
    stable: "s",
    candidate: "c",
    steps: [10, 50, 100],
    minSuccessCount: 2,
  });
  const t1 = await tickCanary(c.id, { errorRate: 0 });
  assert.equal(t1.status, "running");
  assert.equal(t1.currentPercent, 10);
  const t2 = await tickCanary(c.id, { errorRate: 0 });
  assert.equal(t2.successCount, 0);
  assert.equal(t2.currentPercent, 50);
  const t3 = await tickCanary(c.id, { errorRate: 0 });
  assert.equal(t3.successCount, 1);
  const t4 = await tickCanary(c.id, { errorRate: 0 });
  assert.equal(t4.currentPercent, 100);
  assert.equal(t4.status, "completed");
});

test("tickCanary auto-rollbacks on elevated errorRate", async () => {
  const c = await createCanary({
    name: "bad-deploy",
    stable: "s",
    candidate: "c",
    errorRateFloor: 0.02,
  });
  await tickCanary(c.id, { errorRate: 0 });
  const rolled = await tickCanary(c.id, { errorRate: 0.1 });
  assert.equal(rolled.status, "rolled-back");
  assert.equal(rolled.currentPercent, 0);
});

test("tickCanary rejects unknown id", async () => {
  await assert.rejects(() => tickCanary("none"));
  await assert.rejects(() => tickCanary(""));
});

test("tickCanary is a no-op on terminal canaries", async () => {
  const c = await createCanary({ name: "done", stable: "a", candidate: "b" });
  await rollbackCanary(c.id, "manual");
  const after = await tickCanary(c.id, { errorRate: 0 });
  assert.equal(after.status, "rolled-back");
});

test("rollbackCanary marks manual rollback in history", async () => {
  const c = await createCanary({ name: "manual", stable: "a", candidate: "b" });
  const rolled = await rollbackCanary(c.id, "ops decision");
  assert.equal(rolled.status, "rolled-back");
  assert.ok(rolled.history.some((h) => h.action === "manual-rollback"));
});

test("getCanaryStatus returns null for unknown", async () => {
  const none = await getCanaryStatus("nope");
  assert.equal(none, null);
  assert.equal(await getCanaryStatus(""), null);
});

test("listCanaries returns all created canaries", async () => {
  const list = await listCanaries();
  assert.ok(list.length >= 4);
  assert.ok(list.every((c) => typeof c.id === "string"));
});
