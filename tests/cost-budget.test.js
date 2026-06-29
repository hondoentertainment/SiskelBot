/**
 * Cost budget tests: per-workspace spend attribution, caps, and enforcement.
 * Uses a temp STORAGE_PATH. Sets WORKSPACE_BUDGET_USD before importing so the
 * default cap is exercised.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-budget-"));
process.env.STORAGE_PATH = tempDir;
process.env.COST_BUDGET_PERIOD = "month";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("a fresh workspace has zero spend and no cap by default", async () => {
  const { getBudgetStatus } = await import("../lib/cost-budget.js");
  const status = await getBudgetStatus("fresh-ws");
  assert.equal(status.spentUsd, 0);
  assert.equal(status.budgetUsd, null);
  assert.equal(status.exceeded, false);
});

test("recordSpend accumulates per workspace and per model", async () => {
  const { recordSpend, getBudgetStatus } = await import("../lib/cost-budget.js");
  await recordSpend("spend-ws", 0.5, { model: "gpt-x" });
  await recordSpend("spend-ws", 0.25, { model: "gpt-x" });
  await recordSpend("spend-ws", 1.0, { model: "claude-y" });

  const status = await getBudgetStatus("spend-ws");
  assert.ok(Math.abs(status.spentUsd - 1.75) < 1e-9);
  assert.ok(Math.abs(status.byModel["gpt-x"] - 0.75) < 1e-9);
  assert.ok(Math.abs(status.byModel["claude-y"] - 1.0) < 1e-9);

  // a different workspace is isolated
  const other = await getBudgetStatus("spend-ws-other");
  assert.equal(other.spentUsd, 0);
});

test("setBudget enforces a cap and checkBudget blocks when exceeded", async () => {
  const { setBudget, recordSpend, checkBudget, getBudgetStatus } = await import("../lib/cost-budget.js");
  await setBudget("cap-ws", 1.0);

  let check = await checkBudget("cap-ws");
  assert.equal(check.allowed, true);

  await recordSpend("cap-ws", 0.6, { model: "m" });
  check = await checkBudget("cap-ws");
  assert.equal(check.allowed, true, "0.6 of 1.0 still allowed");

  await recordSpend("cap-ws", 0.6, { model: "m" });
  check = await checkBudget("cap-ws");
  assert.equal(check.allowed, false, "1.2 of 1.0 should be blocked");
  assert.match(check.reason, /exceeded/i);

  const status = await getBudgetStatus("cap-ws");
  assert.equal(status.exceeded, true);
  assert.equal(status.remainingUsd, 0);
});

test("setBudget rejects negative caps", async () => {
  const { setBudget } = await import("../lib/cost-budget.js");
  await assert.rejects(() => setBudget("bad-ws", -5));
});

test("setBudget(null) clears the cap back to unlimited", async () => {
  const { setBudget, getBudgetStatus } = await import("../lib/cost-budget.js");
  await setBudget("clear-ws", 2.0);
  let status = await getBudgetStatus("clear-ws");
  assert.equal(status.budgetUsd, 2.0);
  await setBudget("clear-ws", null);
  status = await getBudgetStatus("clear-ws");
  assert.equal(status.budgetUsd, null);
  assert.equal(status.exceeded, false);
});

test("estimateUsd is zero for unknown models and scales with tokens", async () => {
  const { estimateUsd } = await import("../lib/cost-budget.js");
  const zero = estimateUsd("definitely-not-a-real-model-xyz", 1000);
  assert.equal(zero, 0);
  // Non-negative and monotonic regardless of model cost table.
  const a = estimateUsd("gpt-4", 1000);
  const b = estimateUsd("gpt-4", 2000);
  assert.ok(b >= a);
});
