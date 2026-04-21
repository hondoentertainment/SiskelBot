/**
 * Phase 63 cost attribution tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-phase63-cost-"));
process.env.STORAGE_PATH = TMP;

const { recordPhase63Usage, PHASE63_FEATURES } = await import(
  "../lib/phase63-cost.js"
);
const { getRecordsForPeriod } = await import("../lib/usage-tracker.js");
const { createPricingRule, _reset: resetPricing } = await import(
  "../lib/pricing-engine.js"
);

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test("PHASE63_FEATURES enumerates the five Phase 63 tools", () => {
  for (const f of [
    "repo-rag",
    "pr-review-agent",
    "test-gen",
    "refactor-agent",
    "migration-assistant",
  ]) {
    assert.ok(PHASE63_FEATURES.includes(f), `missing ${f}`);
  }
});

test("recordPhase63Usage rejects unknown features", async () => {
  await assert.rejects(
    () => recordPhase63Usage({ feature: "bogus", workspaceId: "ws-1" }),
    /Unknown Phase 63 feature/
  );
});

test("recordPhase63Usage requires workspaceId", async () => {
  await assert.rejects(
    () => recordPhase63Usage({ feature: "repo-rag" }),
    /workspaceId required/
  );
});

test("recordPhase63Usage writes a usage record tagged with feature", async () => {
  await recordPhase63Usage({
    feature: "test-gen",
    workspaceId: "ws-cost",
    inputTokens: 1200,
    outputTokens: 300,
  });
  const records = await getRecordsForPeriod(1);
  const ours = records.filter((r) => r.workspace === "ws-cost");
  assert.ok(ours.length >= 1, "expected at least one usage record");
  assert.equal(ours[ours.length - 1].feature, "test-gen");
  assert.equal(ours[ours.length - 1].inputTokens, 1200);
  assert.equal(ours[ours.length - 1].outputTokens, 300);
});

test("recordPhase63Usage returns a cost breakdown when a rule matches", async () => {
  await resetPricing();
  await createPricingRule({
    workspaceId: "ws-cost-2",
    unit: "input_token",
    rate: 0.0001,
  });
  const result = await recordPhase63Usage({
    feature: "pr-review-agent",
    workspaceId: "ws-cost-2",
    inputTokens: 1000,
    outputTokens: 0,
  });
  assert.equal(result.recorded, true);
  assert.ok(result.cost, "cost expected");
  assert.equal(result.cost.currency, "USD");
  assert.ok(result.cost.breakdown.length >= 1);
});
