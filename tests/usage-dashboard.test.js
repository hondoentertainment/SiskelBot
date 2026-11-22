import test from "node:test";
import assert from "node:assert/strict";
import { summarizeUsage, budgetVerdict } from "../lib/usage-dashboard.js";

test("usage groups tokens and spend by user, model, and key", () => {
  const report = summarizeUsage([
    { userId: "ada", model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 0, byok: "openai" },
    { userId: "ada", model: "gpt-4o-mini", inputTokens: 1000, outputTokens: 0 },
    { userId: "grace", model: "local", inputTokens: 10, outputTokens: 0 },
  ]);
  assert.equal(report.byUser.ada.requests, 2);
  assert.equal(report.byModel["gpt-4o-mini"].requests, 2);
  assert.equal(report.byKey["byok:openai"].requests, 1);
  assert.equal(report.byKey.server.requests, 2);
  assert.ok(report.usd >= 0);
});

test("user budgets warn at 80 percent and block only when asked", () => {
  assert.equal(budgetVerdict(8, 10, "warn").state, "warn");
  assert.equal(budgetVerdict(10, 10, "warn").state, "warn");
  assert.equal(budgetVerdict(10, 10, "block").state, "block");
  assert.equal(budgetVerdict(1, 10, "block").state, "ok");
  assert.equal(budgetVerdict(100, 0, "block").state, "open");
});
