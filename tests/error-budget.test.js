/**
 * Phase 59.5: error-budget enforcement unit tests.
 * Uses a temp STORAGE_PATH so tests don't touch data/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-error-budget-"));
process.env.STORAGE_PATH = tempDir;

const {
  ENFORCEMENT_ACTIONS,
  createSlo,
  getSlo,
  listSlos,
  deleteSlo,
  updateSlo,
  recordEvent,
  getErrorBudget,
  getBurnRate,
  getBurnRateHistory,
  setEnforcementPolicy,
  getEnforcementPolicy,
  checkEnforcement,
  computeBurnRateMultiplier,
  rollingWindow,
  recordBudgetAction,
  getActionHistory,
  generateBudgetReport,
  projectExhaustion,
} = await import("../lib/error-budget.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function makeSlo(name, overrides = {}) {
  return {
    name,
    description: "Test SLO",
    sli: { type: "availability", threshold: 1 },
    objective: 0.99,
    windowMs: 60 * 60 * 1000,
    severity: "medium",
    ...overrides,
  };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

test("createSlo persists a record", async () => {
  const name = "eb-create-" + Date.now();
  const rec = await createSlo(makeSlo(name));
  assert.equal(rec.name, name);
  assert.equal(rec.objective, 0.99);
  assert.equal(rec.sli.type, "availability");
  const loaded = await getSlo(name);
  assert.equal(loaded.name, name);
});

test("createSlo rejects duplicates", async () => {
  const name = "eb-dup-" + Date.now();
  await createSlo(makeSlo(name));
  await assert.rejects(() => createSlo(makeSlo(name)), /already exists/);
});

test("createSlo rejects invalid objective", async () => {
  await assert.rejects(
    () => createSlo(makeSlo("eb-bad-" + Date.now(), { objective: 1.5 })),
    /objective must be between/,
  );
});

test("getSlo returns null for missing", async () => {
  const rec = await getSlo("does-not-exist-xyz-abc");
  assert.equal(rec, null);
});

test("listSlos returns created SLOs", async () => {
  const a = "eb-list-a-" + Date.now();
  const b = "eb-list-b-" + Date.now();
  await createSlo(makeSlo(a));
  await createSlo(makeSlo(b, { severity: "high" }));
  const all = await listSlos();
  const names = all.map((s) => s.name);
  assert.ok(names.includes(a));
  assert.ok(names.includes(b));
});

test("listSlos filters by severity", async () => {
  const a = "eb-filter-a-" + Date.now();
  const b = "eb-filter-b-" + Date.now();
  await createSlo(makeSlo(a, { severity: "critical" }));
  await createSlo(makeSlo(b, { severity: "low" }));
  const high = await listSlos({ severity: "critical" });
  const names = high.map((s) => s.name);
  assert.ok(names.includes(a));
  assert.ok(!names.includes(b));
});

test("deleteSlo removes the SLO", async () => {
  const name = "eb-del-" + Date.now();
  await createSlo(makeSlo(name));
  const res = await deleteSlo(name);
  assert.equal(res.ok, true);
  const after = await getSlo(name);
  assert.equal(after, null);
  const bad = await deleteSlo(name);
  assert.equal(bad.ok, false);
});

test("updateSlo merges updates and preserves identity", async () => {
  const name = "eb-upd-" + Date.now();
  await createSlo(makeSlo(name, { description: "v1" }));
  const updated = await updateSlo(name, { description: "v2", severity: "high" });
  assert.equal(updated.name, name);
  assert.equal(updated.description, "v2");
  assert.equal(updated.severity, "high");
  assert.equal(updated.objective, 0.99);
});

test("updateSlo rejects unknown SLO", async () => {
  await assert.rejects(
    () => updateSlo("eb-does-not-exist-123", { description: "x" }),
    /not found/,
  );
});

// ─── Events ─────────────────────────────────────────────────────────────────

test("recordEvent persists event", async () => {
  const name = "eb-ev-" + Date.now();
  await createSlo(makeSlo(name));
  const rec = await recordEvent(name, { success: true, latencyMs: 50 });
  assert.equal(rec.success, true);
  assert.equal(rec.latencyMs, 50);
  assert.ok(Number.isFinite(rec.timestamp));
});

test("recordEvent rejects unknown SLO", async () => {
  await assert.rejects(
    () => recordEvent("eb-missing-xyz-123", { success: true }),
    /not found/,
  );
});

test("recordEvent rejects non-boolean success", async () => {
  const name = "eb-ev-bad-" + Date.now();
  await createSlo(makeSlo(name));
  await assert.rejects(
    () => recordEvent(name, { success: "yes" }),
    /success must be a boolean/,
  );
});

// ─── Budget ────────────────────────────────────────────────────────────────

test("getErrorBudget when no events has full remaining", async () => {
  const name = "eb-budget-empty-" + Date.now();
  await createSlo(makeSlo(name));
  const b = await getErrorBudget(name);
  assert.equal(b.sampleSize, 0);
  assert.equal(b.consumed, 0);
  assert.ok(b.remaining > 0);
  assert.equal(b.exhaustedAt, null);
});

test("getErrorBudget after failures consumes budget", async () => {
  const name = "eb-budget-fail-" + Date.now();
  await createSlo(makeSlo(name, { objective: 0.9 })); // 10% allowed failures
  // 10 events, 3 failures — well above allowed.
  for (let i = 0; i < 7; i += 1) await recordEvent(name, { success: true });
  for (let i = 0; i < 3; i += 1) await recordEvent(name, { success: false });
  const b = await getErrorBudget(name);
  assert.equal(b.sampleSize, 10);
  // total = 0.1 * 10 = 1. consumed = 3.
  assert.ok(Math.abs(b.total - 1) < 1e-6);
  assert.ok(Math.abs(b.consumed - 3) < 1e-6);
  assert.equal(b.remaining, 0);
});

test("getErrorBudget consumedFraction and remainingFraction math", async () => {
  const name = "eb-budget-frac-" + Date.now();
  await createSlo(makeSlo(name, { objective: 0.8 })); // 20% allowed
  for (let i = 0; i < 8; i += 1) await recordEvent(name, { success: true });
  for (let i = 0; i < 1; i += 1) await recordEvent(name, { success: false });
  const b = await getErrorBudget(name);
  // total = 0.2 * 9 = 1.8; consumed=1; fraction ~0.555
  assert.ok(b.consumedFraction > 0.5 && b.consumedFraction < 0.65);
  assert.ok(Math.abs(b.consumedFraction + b.remainingFraction - 1) < 1e-6);
});

// ─── Burn rate ─────────────────────────────────────────────────────────────

test("getBurnRate returns burn rate for sub-window", async () => {
  const name = "eb-burn-" + Date.now();
  await createSlo(makeSlo(name, { objective: 0.9 }));
  for (let i = 0; i < 5; i += 1) await recordEvent(name, { success: true });
  for (let i = 0; i < 5; i += 1) await recordEvent(name, { success: false });
  const br = await getBurnRate(name, 60 * 60 * 1000);
  assert.equal(br.sampleSize, 10);
  assert.equal(br.badCount, 5);
  // actualRate = 0.5; base = 0.1; burnRate = 5
  assert.ok(br.burnRate >= 4.9 && br.burnRate <= 5.1);
});

test("getBurnRateHistory returns 4 windows", async () => {
  const name = "eb-burn-hist-" + Date.now();
  await createSlo(makeSlo(name));
  await recordEvent(name, { success: true });
  const hist = await getBurnRateHistory(name);
  assert.equal(hist.name, name);
  assert.equal(hist.windows.length, 4);
  const labels = hist.windows.map((w) => w.window);
  assert.deepEqual(labels.sort(), ["1h", "5m", "6h", "full"].sort());
});

// ─── Policy & enforcement ──────────────────────────────────────────────────

test("setEnforcementPolicy validates and persists", async () => {
  const name = "eb-pol-" + Date.now();
  await createSlo(makeSlo(name));
  const policy = await setEnforcementPolicy(name, {
    thresholds: [
      { consumed: 0.5, action: "alert" },
      { consumed: 0.9, action: "rollback" },
    ],
  });
  assert.equal(policy.thresholds.length, 2);
  assert.equal(policy.thresholds[0].consumed, 0.5);
  const loaded = await getEnforcementPolicy(name);
  assert.equal(loaded.thresholds[1].action, "rollback");
});

test("setEnforcementPolicy rejects invalid action", async () => {
  const name = "eb-pol-bad-" + Date.now();
  await createSlo(makeSlo(name));
  await assert.rejects(
    () =>
      setEnforcementPolicy(name, {
        thresholds: [{ consumed: 0.5, action: "launch_nukes" }],
      }),
    /action must be one of/,
  );
});

test("checkEnforcement triggers alert at 50%", async () => {
  const name = "eb-enf-alert-" + Date.now();
  await createSlo(makeSlo(name, { objective: 0.9 })); // 10% allowed
  await setEnforcementPolicy(name, {
    thresholds: [
      { consumed: 0.5, action: "alert" },
      { consumed: 0.9, action: "rollback" },
    ],
  });
  // 10 events, 1 failure => consumed=1, total=1, fraction=1.0 — both triggered.
  for (let i = 0; i < 9; i += 1) await recordEvent(name, { success: true });
  for (let i = 0; i < 1; i += 1) await recordEvent(name, { success: false });
  const results = await checkEnforcement(name);
  const alertEntry = results.find((r) => r.action === "alert");
  assert.ok(alertEntry?.triggered, "alert should trigger at 50%");
});

test("checkEnforcement triggers rollback at 90%", async () => {
  const name = "eb-enf-rollback-" + Date.now();
  await createSlo(makeSlo(name, { objective: 0.9 }));
  await setEnforcementPolicy(name, {
    thresholds: [
      { consumed: 0.5, action: "alert" },
      { consumed: 0.9, action: "rollback" },
    ],
  });
  // 10 events, 1 failure => fraction=1.0 (>=0.9)
  for (let i = 0; i < 9; i += 1) await recordEvent(name, { success: true });
  await recordEvent(name, { success: false });
  const results = await checkEnforcement(name);
  const rb = results.find((r) => r.action === "rollback");
  assert.ok(rb?.triggered, "rollback should trigger at 90%");
});

test("checkEnforcement low consumption does not trigger rollback", async () => {
  const name = "eb-enf-low-" + Date.now();
  await createSlo(makeSlo(name, { objective: 0.5 })); // 50% allowed
  await setEnforcementPolicy(name, {
    thresholds: [
      { consumed: 0.5, action: "alert" },
      { consumed: 0.9, action: "rollback" },
    ],
  });
  // 10 events, 1 failure => total=5, consumed=1, fraction=0.2
  for (let i = 0; i < 9; i += 1) await recordEvent(name, { success: true });
  await recordEvent(name, { success: false });
  const results = await checkEnforcement(name);
  const rb = results.find((r) => r.action === "rollback");
  assert.equal(rb.triggered, false);
});

// ─── Windowing pure functions ──────────────────────────────────────────────

test("rollingWindow filters events outside window", () => {
  const now = 10_000;
  const events = [
    { timestamp: 1000, success: true },
    { timestamp: 5000, success: false },
    { timestamp: 9500, success: true },
  ];
  const out = rollingWindow(events, 5000, now);
  assert.equal(out.length, 2);
  assert.equal(out[0].timestamp, 5000);
  assert.equal(out[1].timestamp, 9500);
});

test("computeBurnRateMultiplier math", () => {
  const events = [
    { success: true },
    { success: false },
    { success: false },
    { success: true },
  ];
  // failure rate = 0.5, baseRate = 0.1, multiplier = 5
  const m = computeBurnRateMultiplier(events, 0.1);
  assert.ok(Math.abs(m - 5) < 1e-6);
  assert.equal(computeBurnRateMultiplier([], 0.1), 0);
  assert.equal(computeBurnRateMultiplier(events, 0), 0);
});

// ─── Actions ───────────────────────────────────────────────────────────────

test("recordBudgetAction and getActionHistory", async () => {
  const name = "eb-act-" + Date.now();
  await createSlo(makeSlo(name));
  await recordBudgetAction(name, "alert", { reason: "50% consumed" });
  await recordBudgetAction(name, "rollback", { deploymentId: "d123" });
  const hist = await getActionHistory(name);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].action, "alert");
  assert.equal(hist[1].action, "rollback");
  assert.equal(hist[1].context.deploymentId, "d123");
});

test("recordBudgetAction rejects invalid action", async () => {
  const name = "eb-act-bad-" + Date.now();
  await createSlo(makeSlo(name));
  await assert.rejects(
    () => recordBudgetAction(name, "nuke_prod"),
    /action must be one of/,
  );
});

test("ENFORCEMENT_ACTIONS is frozen list", () => {
  assert.ok(Array.isArray(ENFORCEMENT_ACTIONS));
  assert.ok(ENFORCEMENT_ACTIONS.includes("rollback"));
  assert.ok(ENFORCEMENT_ACTIONS.includes("alert"));
});

// ─── Reporting ─────────────────────────────────────────────────────────────

test("projectExhaustion returns ETA when burning", () => {
  const slo = { name: "x", windowMs: 60 * 60 * 1000 }; // 1h
  const p = projectExhaustion(slo, 2); // 2x burn rate — exhausts at ~30m
  assert.ok(p.willExhaust);
  assert.ok(p.etaMs > 0);
  assert.ok(p.etaMs <= 60 * 60 * 1000);
  assert.ok(typeof p.etaAt === "string");
});

test("projectExhaustion safe for zero burn", () => {
  const slo = { name: "x", windowMs: 60 * 60 * 1000 };
  const p = projectExhaustion(slo, 0);
  assert.equal(p.willExhaust, false);
  assert.equal(p.etaMs, null);
  assert.equal(p.etaAt, null);
});

test("generateBudgetReport summarises list", () => {
  const slos = [
    { name: "s1", severity: "high", sli: { type: "availability" }, objective: 0.99, windowMs: 1000 },
    { name: "s2", severity: "low", sli: { type: "latency" }, objective: 0.95, windowMs: 1000 },
    { name: "s3", severity: "high", sli: { type: "availability" }, objective: 0.999, windowMs: 1000 },
  ];
  const report = generateBudgetReport(slos);
  assert.equal(report.total, 3);
  assert.equal(report.bySeverity.high, 2);
  assert.equal(report.bySeverity.low, 1);
  assert.equal(report.byType.availability, 2);
  assert.equal(report.byType.latency, 1);
  assert.equal(report.items.length, 3);
  assert.ok(typeof report.generatedAt === "string");
});

test("generateBudgetReport on empty list", () => {
  const report = generateBudgetReport([]);
  assert.equal(report.total, 0);
  assert.deepEqual(report.items, []);
});
