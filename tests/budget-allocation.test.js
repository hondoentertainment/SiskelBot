/**
 * Phase 65.3: Budget allocation tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-budget-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createCostCenter,
  getCostCenter,
  listCostCenters,
  allocateBudget,
  recordCharge,
  getChargebackReport,
} = await import("../lib/budget-allocation.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

function currentMonthBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return { start, end };
}

test("createCostCenter requires a name", async () => {
  await assert.rejects(() => createCostCenter({}), /name/);
});

test("createCostCenter persists with defaults and lists round-trip", async () => {
  const cc = await createCostCenter({
    name: "eng-platform",
    owner: "alice",
    department: "engineering",
    tags: ["gpu", "priority"],
  });
  assert.ok(cc.id);
  assert.equal(cc.name, "eng-platform");
  assert.deepEqual(cc.tags, ["gpu", "priority"]);
  assert.deepEqual(cc.alertThresholds, [0.5, 0.8, 1.0]);
  const fetched = await getCostCenter(cc.id);
  assert.equal(fetched.id, cc.id);
  const list = await listCostCenters({ department: "engineering" });
  assert.ok(list.some((c) => c.id === cc.id));
});

test("allocateBudget validates amount and stores periods", async () => {
  const cc = await createCostCenter({ name: "alloc-test" });
  await assert.rejects(() => allocateBudget(cc.id, { amountUsd: -5 }), /amountUsd/);
  await assert.rejects(() => allocateBudget(cc.id, { amountUsd: 0 }), /amountUsd/);
  const updated = await allocateBudget(cc.id, { amountUsd: 1000, note: "Q2 budget" });
  assert.equal(updated.allocations.length, 1);
  assert.equal(updated.allocations[0].amountUsd, 1000);
  assert.equal(updated.allocations[0].note, "Q2 budget");
});

test("recordCharge appends and updates bySubject", async () => {
  const cc = await createCostCenter({ name: "charge-test" });
  await allocateBudget(cc.id, { amountUsd: 500 });
  await recordCharge(cc.id, { amountUsd: 10, subject: "gpt-4", description: "inference" });
  await recordCharge(cc.id, { amountUsd: 15, subject: "gpt-4" });
  await recordCharge(cc.id, { amountUsd: 5, subject: "claude" });
  const report = await getChargebackReport(cc.id);
  assert.equal(report.chargeCount, 3);
  assert.equal(report.consumed, 30);
  assert.equal(report.bySubject["gpt-4"], 25);
  assert.equal(report.bySubject.claude, 5);
});

test("recordCharge rejects negative amounts", async () => {
  const cc = await createCostCenter({ name: "neg-test" });
  await assert.rejects(() => recordCharge(cc.id, { amountUsd: -1 }), /amountUsd/);
});

test("getChargebackReport returns utilization and remaining", async () => {
  const cc = await createCostCenter({ name: "util-test" });
  await allocateBudget(cc.id, { amountUsd: 100 });
  await recordCharge(cc.id, { amountUsd: 40, subject: "api" });
  const report = await getChargebackReport(cc.id);
  assert.equal(report.allocated, 100);
  assert.equal(report.consumed, 40);
  assert.equal(report.remaining, 60);
  assert.ok(Math.abs(report.utilization - 0.4) < 1e-9);
  assert.equal(report.overrun, false);
});

test("recordCharge emits overrun alerts at configured thresholds", async () => {
  const cc = await createCostCenter({
    name: "alert-test",
    alertThresholds: [0.5, 1.0],
  });
  await allocateBudget(cc.id, { amountUsd: 100 });
  let rec = await recordCharge(cc.id, { amountUsd: 30, subject: "api" });
  assert.equal(rec.alerts.length, 0);
  rec = await recordCharge(cc.id, { amountUsd: 30, subject: "api" }); // total 60 — crosses 0.5
  assert.equal(rec.alerts.length, 1);
  assert.equal(rec.alerts[0].threshold, 0.5);
  rec = await recordCharge(cc.id, { amountUsd: 50, subject: "api" }); // total 110 — crosses 1.0
  assert.equal(rec.alerts.length, 2);
  assert.equal(rec.alerts[1].threshold, 1.0);
});

test("getChargebackReport flags overrun when consumed > allocated", async () => {
  const cc = await createCostCenter({ name: "overrun-test" });
  await allocateBudget(cc.id, { amountUsd: 50 });
  await recordCharge(cc.id, { amountUsd: 75, subject: "api" });
  const report = await getChargebackReport(cc.id);
  assert.equal(report.overrun, true);
  assert.equal(report.remaining, 0);
});

test("getChargebackReport windows charges to the requested period", async () => {
  const cc = await createCostCenter({ name: "window-test" });
  const { start, end } = currentMonthBounds();
  await allocateBudget(cc.id, { amountUsd: 200, periodStart: start, periodEnd: end });
  // Charge outside the window (one month in the past)
  const pastStart = new Date(Date.parse(start) - 40 * 24 * 3600 * 1000).toISOString();
  await recordCharge(cc.id, { amountUsd: 99, subject: "old", at: pastStart });
  await recordCharge(cc.id, { amountUsd: 20, subject: "now" });
  const report = await getChargebackReport(cc.id, { periodStart: start, periodEnd: end });
  assert.equal(report.consumed, 20);
  assert.equal(report.chargeCount, 1);
});

test("getCostCenter returns null for missing ids and throws on missing report", async () => {
  assert.equal(await getCostCenter("unknown"), null);
  await assert.rejects(() => getChargebackReport("unknown"), /not found/);
});
