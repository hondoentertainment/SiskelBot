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
  allocateBudget,
  recordSpend,
  getUtilization,
  listCostCenters,
  getCostCenter,
  listAllocations,
  listSpend,
} = await import("../lib/budget-allocation.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("createCostCenter creates a uniquely-coded cost center", async () => {
  const cc = await createCostCenter({ code: "ENG-001", name: "Engineering", department: "eng" });
  assert.ok(cc.id);
  assert.equal(cc.code, "ENG-001");
  assert.equal(cc.name, "Engineering");
  assert.equal(cc.department, "eng");
  await assert.rejects(() => createCostCenter({ code: "ENG-001", name: "dup" }));
});

test("createCostCenter rejects missing fields", async () => {
  await assert.rejects(() => createCostCenter(null));
  await assert.rejects(() => createCostCenter({ code: "ONLY-CODE" }));
  await assert.rejects(() => createCostCenter({ name: "only-name" }));
});

test("allocateBudget records an allocation for a period", async () => {
  const cc = await createCostCenter({ code: "MKT-001", name: "Marketing" });
  const alloc = await allocateBudget({
    costCenterId: cc.id,
    amount: 10000,
    currency: "USD",
    periodStart: "2026-01-01",
    periodEnd: "2026-02-01",
  });
  assert.ok(alloc.id);
  assert.equal(alloc.amount, 10000);
  assert.equal(alloc.currency, "USD");
});

test("allocateBudget validates inputs", async () => {
  const cc = await createCostCenter({ code: "VAL-001", name: "Validation" });
  await assert.rejects(() => allocateBudget({ costCenterId: cc.id, amount: -1, periodStart: "2026-01-01", periodEnd: "2026-02-01" }));
  await assert.rejects(() => allocateBudget({ costCenterId: cc.id, amount: 100, periodStart: "bogus", periodEnd: "2026-02-01" }));
  await assert.rejects(() => allocateBudget({ costCenterId: cc.id, amount: 100, periodStart: "2026-02-01", periodEnd: "2026-01-01" }));
  await assert.rejects(() => allocateBudget({ costCenterId: "missing", amount: 100, periodStart: "2026-01-01", periodEnd: "2026-02-01" }));
});

test("recordSpend persists a spend event", async () => {
  const cc = await createCostCenter({ code: "SP-001", name: "Spend test" });
  const ev = await recordSpend({ costCenterId: cc.id, amount: 42.5, description: "test charge" });
  assert.ok(ev.id);
  assert.equal(ev.amount, 42.5);
  assert.equal(ev.description, "test charge");
  await assert.rejects(() => recordSpend({ costCenterId: cc.id, amount: -1 }));
  await assert.rejects(() => recordSpend({ costCenterId: "nope", amount: 1 }));
});

test("getUtilization computes allocated, spent, and remaining", async () => {
  const cc = await createCostCenter({ code: "UT-001", name: "Utilization" });
  await allocateBudget({
    costCenterId: cc.id,
    amount: 1000,
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
  });
  await recordSpend({ costCenterId: cc.id, amount: 250, at: "2026-02-15" });
  await recordSpend({ costCenterId: cc.id, amount: 100, at: "2026-03-15" });
  const util = await getUtilization(cc.id);
  assert.equal(util.allocated, 1000);
  assert.equal(util.spent, 350);
  assert.equal(util.remaining, 650);
  assert.equal(util.utilization, 0.35);
  assert.equal(util.events, 2);
  assert.equal(util.overBudget, false);
});

test("getUtilization flags over-budget", async () => {
  const cc = await createCostCenter({ code: "OB-001", name: "Over budget" });
  await allocateBudget({
    costCenterId: cc.id,
    amount: 100,
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
  });
  await recordSpend({ costCenterId: cc.id, amount: 150, at: "2026-06-01" });
  const util = await getUtilization(cc.id);
  assert.equal(util.overBudget, true);
  assert.ok(util.utilization > 1);
});

test("getUtilization honors a period window", async () => {
  const cc = await createCostCenter({ code: "WIN-001", name: "Window" });
  await allocateBudget({
    costCenterId: cc.id,
    amount: 500,
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
  });
  await recordSpend({ costCenterId: cc.id, amount: 100, at: "2026-02-01" });
  await recordSpend({ costCenterId: cc.id, amount: 200, at: "2026-07-01" });
  const q2 = await getUtilization(cc.id, { periodStart: "2026-04-01", periodEnd: "2026-09-30" });
  assert.equal(q2.spent, 200);
});

test("listCostCenters / listAllocations / listSpend", async () => {
  const cc = await createCostCenter({ code: "LIST-001", name: "Listed", department: "ops" });
  await allocateBudget({
    costCenterId: cc.id,
    amount: 50,
    periodStart: "2026-05-01",
    periodEnd: "2026-06-01",
  });
  await recordSpend({ costCenterId: cc.id, amount: 5 });
  const ccs = await listCostCenters();
  assert.ok(ccs.length >= 1);
  const opsCcs = await listCostCenters({ department: "ops" });
  for (const c of opsCcs) assert.equal(c.department, "ops");
  const allocs = await listAllocations({ costCenterId: cc.id });
  assert.ok(allocs.length >= 1);
  const spends = await listSpend({ costCenterId: cc.id, limit: 5 });
  assert.ok(spends.length >= 1);
});

test("getCostCenter returns a record or null", async () => {
  const cc = await createCostCenter({ code: "GET-001", name: "Getter" });
  const found = await getCostCenter(cc.id);
  assert.ok(found);
  assert.equal(found.code, "GET-001");
  assert.equal(await getCostCenter("missing"), null);
});
