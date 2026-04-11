/**
 * Tests for lib/privacy-accounting.js.
 *
 * Covers:
 *   - ledger CRUD and persistence
 *   - recordPrivacyLoss / remaining / affordability
 *   - basic and advanced (strong) composition theorems
 *   - RDP accountant for the sub-sampled Gaussian mechanism
 *   - RDP → (ε, δ)-DP conversion
 *   - freeze behavior (manual + auto on exhaustion)
 *   - JSON / CSV exports
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "privacy-ledger-test-"));
process.env.STORAGE_PATH = tmpRoot;

const {
  createPrivacyLedger,
  listPrivacyLedgers,
  getPrivacyLedger,
  deletePrivacyLedger,
  recordPrivacyLoss,
  getRemainingBudget,
  canAffordOperation,
  freezeLedger,
  composePrivacyLoss,
  subsampledGaussian,
  convertRDPtoDP,
  exportLedger,
} = await import("../lib/privacy-accounting.js");

test.after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// --- Ledger CRUD -----------------------------------------------------------

test("createPrivacyLedger persists a new ledger with zero spent", () => {
  const ledger = createPrivacyLedger({
    epsilon: 1.0,
    delta: 1e-5,
    workspaceId: "ws-create",
    name: "Training Run A",
  });
  assert.ok(ledger.id);
  assert.equal(ledger.budget.epsilon, 1.0);
  assert.equal(ledger.budget.delta, 1e-5);
  assert.equal(ledger.spent.epsilon, 0);
  assert.equal(ledger.spent.delta, 0);
  assert.equal(ledger.frozen, false);
  assert.equal(ledger.entries.length, 0);
  assert.equal(ledger.name, "Training Run A");

  const reloaded = getPrivacyLedger(ledger.id, "ws-create");
  assert.equal(reloaded.id, ledger.id);
});

test("createPrivacyLedger rejects invalid budgets", () => {
  assert.throws(() => createPrivacyLedger({ epsilon: -1, delta: 1e-5 }));
  assert.throws(() => createPrivacyLedger({ epsilon: 1, delta: 1.5 }));
  assert.throws(() => createPrivacyLedger({ epsilon: 1, delta: -0.1 }));
  assert.throws(() => createPrivacyLedger(null));
});

test("listPrivacyLedgers returns all ledgers in a workspace", () => {
  createPrivacyLedger({ epsilon: 0.5, delta: 1e-6, workspaceId: "ws-list" });
  createPrivacyLedger({ epsilon: 2.0, delta: 1e-5, workspaceId: "ws-list" });
  const all = listPrivacyLedgers("ws-list");
  assert.equal(all.length, 2);
});

test("deletePrivacyLedger removes the ledger file", () => {
  const l = createPrivacyLedger({ epsilon: 1, delta: 1e-6, workspaceId: "ws-del" });
  const ok = deletePrivacyLedger(l.id, "ws-del");
  assert.equal(ok, true);
  assert.equal(getPrivacyLedger(l.id, "ws-del"), null);
});

// --- recordPrivacyLoss / remaining / afford --------------------------------

test("recordPrivacyLoss debits the budget and appends an entry", () => {
  const l = createPrivacyLedger({ epsilon: 2.0, delta: 1e-5, workspaceId: "ws-debit" });
  const after = recordPrivacyLoss(l.id, 0.5, 1e-6, "warmup-epoch");
  assert.equal(after.spent.epsilon, 0.5);
  assert.equal(after.spent.delta, 1e-6);
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].operation.label, "warmup-epoch");
});

test("getRemainingBudget reports correct remaining and utilization", () => {
  const l = createPrivacyLedger({ epsilon: 4.0, delta: 4e-5, workspaceId: "ws-rem" });
  recordPrivacyLoss(l.id, 1.0, 1e-5, "step-1");
  const rem = getRemainingBudget(l.id);
  assert.ok(Math.abs(rem.remaining.epsilon - 3.0) < 1e-12);
  assert.ok(Math.abs(rem.remaining.delta - 3e-5) < 1e-20);
  assert.ok(Math.abs(rem.utilization.epsilon - 0.25) < 1e-12);
  assert.ok(Math.abs(rem.utilization.delta - 0.25) < 1e-12);
  assert.equal(rem.frozen, false);
});

test("canAffordOperation returns true when within budget and false otherwise", () => {
  const l = createPrivacyLedger({ epsilon: 1.0, delta: 1e-5, workspaceId: "ws-afford" });
  recordPrivacyLoss(l.id, 0.6, 5e-6, "op-1");
  const yes = canAffordOperation(l.id, 0.3, 4e-6);
  assert.equal(yes.affordable, true);
  const noEps = canAffordOperation(l.id, 0.5, 1e-7);
  assert.equal(noEps.affordable, false);
  assert.match(noEps.reason, /ε budget/);
  const noDelta = canAffordOperation(l.id, 0.1, 1e-5);
  assert.equal(noDelta.affordable, false);
  assert.match(noDelta.reason, /δ budget/);
});

test("recordPrivacyLoss throws when debit exceeds budget", () => {
  const l = createPrivacyLedger({ epsilon: 1.0, delta: 1e-5, workspaceId: "ws-over" });
  recordPrivacyLoss(l.id, 0.8, 5e-6, "op-1");
  assert.throws(() => recordPrivacyLoss(l.id, 0.5, 1e-6, "op-2"), /exhausted/);
});

// --- Composition theorems --------------------------------------------------

test("composePrivacyLoss basic additive sums correctly", () => {
  const { epsilon, delta } = composePrivacyLoss([0.1, 0.2, 0.3], [1e-6, 1e-6, 1e-6], "basic");
  assert.ok(Math.abs(epsilon - 0.6) < 1e-12);
  assert.ok(Math.abs(delta - 3e-6) < 1e-20);
});

test("composePrivacyLoss advanced composition is tighter than basic for many small ε", () => {
  const k = 100;
  const eps = Array(k).fill(0.01);
  const deltas = Array(k).fill(1e-6);
  const basic = composePrivacyLoss(eps, deltas, "basic");
  const adv = composePrivacyLoss(eps, deltas, "advanced", { deltaPrime: 1e-5 });
  // Basic sums to 1.0; advanced should be close to 1.0 here (small ε per step)
  assert.ok(Math.abs(basic.epsilon - 1.0) < 1e-9);
  assert.ok(adv.epsilon > 0);
  // For small k × ε the sqrt term dominates and advanced is not necessarily
  // smaller than basic — but for very small ε it should be sub-linear:
  // Σ ε_i (e^ε_i - 1) ≈ Σ ε_i² = k · 1e-4 = 0.01
  // slack ≈ sqrt(2 · ln(1e5) · k · 1e-4) ≈ sqrt(2 · 11.5 · 0.01) ≈ 0.48
  assert.ok(adv.epsilon < 0.6);
  assert.ok(adv.delta > basic.delta);
});

test("composePrivacyLoss rejects mismatched arrays and unknown methods", () => {
  assert.throws(() => composePrivacyLoss([0.1, 0.2], [1e-6], "basic"));
  assert.throws(() => composePrivacyLoss([0.1], [1e-6], "unknown-method"));
});

test("composePrivacyLoss returns zero for empty input", () => {
  const r = composePrivacyLoss([], [], "basic");
  assert.equal(r.epsilon, 0);
  assert.equal(r.delta, 0);
});

// --- RDP accountant --------------------------------------------------------

test("subsampledGaussian RDP is monotonically non-decreasing in iterations", () => {
  const r1 = subsampledGaussian(1.1, 0.01, 100);
  const r2 = subsampledGaussian(1.1, 0.01, 1000);
  for (let i = 0; i < r1.orders.length; i++) {
    assert.ok(r2.rdp[i] >= r1.rdp[i] - 1e-12);
  }
});

test("subsampledGaussian RDP is monotonically non-increasing in sigma", () => {
  const rLoNoise = subsampledGaussian(0.5, 0.01, 500);
  const rHiNoise = subsampledGaussian(2.0, 0.01, 500);
  for (let i = 0; i < rLoNoise.orders.length; i++) {
    assert.ok(rHiNoise.rdp[i] <= rLoNoise.rdp[i] + 1e-9);
  }
});

test("subsampledGaussian produces finite RDP for realistic DP-SGD params", () => {
  // Typical DP-SGD params: σ=1.1, q=256/60000≈0.00427, T=10000 steps
  const rdp = subsampledGaussian(1.1, 256 / 60000, 10000);
  for (const r of rdp.rdp) {
    assert.ok(Number.isFinite(r));
    assert.ok(r >= 0);
  }
});

test("subsampledGaussian rejects invalid parameters", () => {
  assert.throws(() => subsampledGaussian(0, 0.01, 100));
  assert.throws(() => subsampledGaussian(1.0, 0, 100));
  assert.throws(() => subsampledGaussian(1.0, 1.5, 100));
  assert.throws(() => subsampledGaussian(1.0, 0.01, -1));
});

test("convertRDPtoDP yields a sensible (ε, δ) bound for DP-SGD", () => {
  const rdp = subsampledGaussian(1.1, 256 / 60000, 10000);
  const { epsilon, delta, optimalOrder } = convertRDPtoDP(rdp, 1e-5);
  assert.equal(delta, 1e-5);
  assert.ok(Number.isFinite(epsilon));
  // For these canonical DP-SGD params the ε should be single-digit.
  assert.ok(epsilon > 0 && epsilon < 10, `epsilon=${epsilon} outside expected range`);
  assert.ok(rdp.orders.includes(optimalOrder));
});

test("convertRDPtoDP rejects invalid input", () => {
  assert.throws(() => convertRDPtoDP(null, 1e-5));
  assert.throws(() => convertRDPtoDP({ orders: [], rdp: [] }, 1e-5));
  assert.throws(() => convertRDPtoDP({ orders: [2], rdp: [1] }, 0));
  assert.throws(() => convertRDPtoDP({ orders: [2], rdp: [1] }, 1.5));
});

test("RDP accountant + conversion integrates with ledger for a training run", () => {
  const l = createPrivacyLedger({
    epsilon: 8.0,
    delta: 1e-5,
    workspaceId: "ws-dpsgd",
    name: "DP-SGD run",
  });
  const rdp = subsampledGaussian(1.2, 0.005, 5000);
  const { epsilon } = convertRDPtoDP(rdp, 1e-5);
  assert.ok(canAffordOperation(l.id, epsilon, 1e-5).affordable);
  recordPrivacyLoss(l.id, epsilon, 1e-5, { label: "dp-sgd", sigma: 1.2, q: 0.005, steps: 5000 });
  const after = getRemainingBudget(l.id);
  assert.ok(after.spent.epsilon > 0);
});

// --- Freeze behavior -------------------------------------------------------

test("freezeLedger blocks further recordPrivacyLoss calls", () => {
  const l = createPrivacyLedger({ epsilon: 2.0, delta: 1e-5, workspaceId: "ws-freeze" });
  freezeLedger(l.id, "manual audit hold");
  const frozen = getRemainingBudget(l.id);
  assert.equal(frozen.frozen, true);
  assert.throws(() => recordPrivacyLoss(l.id, 0.1, 1e-7, "blocked"), /frozen/);
});

test("ledger auto-freezes when budget is fully spent", () => {
  const l = createPrivacyLedger({ epsilon: 1.0, delta: 1e-5, workspaceId: "ws-auto" });
  recordPrivacyLoss(l.id, 1.0, 1e-5, "full-spend");
  const after = getRemainingBudget(l.id);
  assert.equal(after.frozen, true);
  assert.throws(() => recordPrivacyLoss(l.id, 0.001, 1e-8, "nope"));
});

test("canAffordOperation reports frozen ledgers as unaffordable", () => {
  const l = createPrivacyLedger({ epsilon: 1.0, delta: 1e-5, workspaceId: "ws-af-frozen" });
  freezeLedger(l.id, "admin");
  const res = canAffordOperation(l.id, 0.01, 1e-8);
  assert.equal(res.affordable, false);
  assert.match(res.reason, /frozen/);
});

// --- Export ----------------------------------------------------------------

test("exportLedger json round-trips the ledger", () => {
  const l = createPrivacyLedger({ epsilon: 1.0, delta: 1e-5, workspaceId: "ws-exp-json" });
  recordPrivacyLoss(l.id, 0.1, 1e-6, "op-1");
  recordPrivacyLoss(l.id, 0.2, 2e-6, "op-2");
  const exp = exportLedger(l.id, "json");
  assert.equal(exp.contentType, "application/json");
  const parsed = JSON.parse(exp.body);
  assert.equal(parsed.id, l.id);
  assert.equal(parsed.entries.length, 2);
});

test("exportLedger csv contains header and cumulative columns", () => {
  const l = createPrivacyLedger({ epsilon: 1.0, delta: 1e-5, workspaceId: "ws-exp-csv" });
  recordPrivacyLoss(l.id, 0.1, 1e-6, "op-a");
  recordPrivacyLoss(l.id, 0.2, 1e-6, "op-b");
  const exp = exportLedger(l.id, "csv");
  assert.equal(exp.contentType, "text/csv");
  const lines = exp.body.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^entry_id,at,epsilon,delta,operation,cumulative_epsilon,cumulative_delta$/);
  // Cumulative eps after second row should be 0.3 (approx)
  const lastFields = lines[2].split(",");
  assert.ok(Math.abs(Number(lastFields[5]) - 0.3) < 1e-12);
});

test("exportLedger rejects unknown formats", () => {
  const l = createPrivacyLedger({ epsilon: 1.0, delta: 1e-5, workspaceId: "ws-exp-bad" });
  assert.throws(() => exportLedger(l.id, "xml"));
});
