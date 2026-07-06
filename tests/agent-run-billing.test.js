import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-run-billing-"));
process.env.STORAGE_PATH = dir;

const { emitCostUpdate, __resetAccumulatorsForTests } = await import("../lib/agent-cost-emitter.js");
const { flushRunBilling } = await import("../lib/agent-run-billing.js");
const { createBillingManager } = await import("../lib/billing.js");

test.after(() => {
  __resetAccumulatorsForTests();
  rmSync(dir, { recursive: true, force: true });
});

test("flushRunBilling records tokens from cost accumulator", async () => {
  __resetAccumulatorsForTests();
  const runId = "billing-run-1";
  emitCostUpdate({
    sessionId: "sess-1",
    runId,
    model: "test-model",
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });

  const r = await flushRunBilling({ runId, workspace: "billing-ws", model: "test-model" });
  assert.equal(r.flushed, true);
  assert.equal(r.totalTokens, 150);

  const mgr = createBillingManager();
  const summary = await mgr.getUsageSummary("billing-ws", "30d");
  assert.ok(summary.tokens >= 150);
});

test("flushRunBilling no-ops when accumulator empty", async () => {
  __resetAccumulatorsForTests();
  const r = await flushRunBilling({ runId: "missing", workspace: "default", model: "m" });
  assert.equal(r.flushed, false);
});
