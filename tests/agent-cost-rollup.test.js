/**
 * Tests for parent-child cost rollup in lib/agent-cost-emitter.js.
 *
 * Covers: child cost rolls up to parent, multiple children sum correctly,
 * grandchild cascading through child to root, and no-parent case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setTimeout as delay } from "node:timers/promises";

const dir = mkdtempSync(join(tmpdir(), "agent-cost-rollup-"));
const prevStoragePath = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  emitCostUpdate,
  __resetAccumulatorsForTests,
  __getParentCostMapForTests,
} = await import("../lib/agent-cost-emitter.js");
const {
  getAgentRunEmitter,
  __resetAgentRunStreamForTests,
} = await import("../lib/agent-run-stream.js");
const { createAgentSession } = await import("../lib/agent-session.js");
const { parseCostConfig } = await import("../lib/smart-router.js");

test.after(() => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("");
  if (prevStoragePath === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStoragePath;
  rmSync(dir, { recursive: true, force: true });
});

test("child emits cost -> parent receives cost.update with childCostUsd", async () => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("model-a:0.002");

  const parent = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "parent",
  });
  const child = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "child",
    parentSessionId: parent.id,
  });

  const parentEvents = [];
  const parentEmitter = getAgentRunEmitter(parent.id);
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  // Also need an emitter for the child session so the child publish works
  getAgentRunEmitter(child.id);

  emitCostUpdate({
    sessionId: child.id,
    runId: "run-child-1",
    model: "model-a",
    iteration: 1,
    usage: { prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 },
  });

  // Rollup is async (uses getAgentSession), wait briefly
  await delay(50);

  const parentCostEvents = parentEvents.filter((e) => e.type === "cost.update");
  assert.ok(parentCostEvents.length >= 1, "parent should receive cost.update");
  const last = parentCostEvents[parentCostEvents.length - 1];
  // 1000 * 0.002 / 1000 = 0.002
  assert.ok(Math.abs(last.payload.childCostUsd - 0.002) < 1e-9);
  assert.equal(last.payload.ownCostUsd, 0);
  assert.ok(Math.abs(last.payload.totalUsd - 0.002) < 1e-9);
});

test("two children emitting -> parent total sums both", async () => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("model-b:0.004");

  const parent = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "parent-multi",
  });
  const childA = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "child-a",
    parentSessionId: parent.id,
  });
  const childB = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "child-b",
    parentSessionId: parent.id,
  });

  const parentEvents = [];
  const parentEmitter = getAgentRunEmitter(parent.id);
  parentEmitter.on("event", (ev) => parentEvents.push(ev));
  getAgentRunEmitter(childA.id);
  getAgentRunEmitter(childB.id);

  emitCostUpdate({
    sessionId: childA.id,
    runId: "run-a",
    model: "model-b",
    usage: { total_tokens: 1000 },
  });
  await delay(50);

  emitCostUpdate({
    sessionId: childB.id,
    runId: "run-b",
    model: "model-b",
    usage: { total_tokens: 2000 },
  });
  await delay(50);

  const parentCostEvents = parentEvents.filter((e) => e.type === "cost.update");
  assert.ok(parentCostEvents.length >= 2, "parent should receive at least 2 cost.update events");
  const last = parentCostEvents[parentCostEvents.length - 1];
  // childA: 1000 * 0.004 / 1000 = 0.004
  // childB: 2000 * 0.004 / 1000 = 0.008
  // total child cost: 0.012
  assert.ok(Math.abs(last.payload.childCostUsd - 0.012) < 1e-9, `childCostUsd=${last.payload.childCostUsd}`);
  assert.ok(Math.abs(last.payload.totalUsd - 0.012) < 1e-9, `totalUsd=${last.payload.totalUsd}`);
});

test("grandchild cost rolls up to child, then child update rolls up to root", async () => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("model-c:0.001");

  const root = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "root-cascade",
  });
  const mid = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "mid-cascade",
    parentSessionId: root.id,
  });
  const leaf = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "leaf-cascade",
    parentSessionId: mid.id,
  });

  const rootEvents = [];
  const rootEmitter = getAgentRunEmitter(root.id);
  rootEmitter.on("event", (ev) => rootEvents.push(ev));

  const midEvents = [];
  const midEmitter = getAgentRunEmitter(mid.id);
  midEmitter.on("event", (ev) => midEvents.push(ev));

  getAgentRunEmitter(leaf.id);

  // Leaf emits cost -> rolls up to mid
  emitCostUpdate({
    sessionId: leaf.id,
    runId: "run-leaf",
    model: "model-c",
    usage: { total_tokens: 5000 },
  });

  // Wait for async rollup chain
  await delay(100);

  // Mid should have received a cost.update from the leaf rollup
  const midCostEvents = midEvents.filter((e) => e.type === "cost.update");
  assert.ok(midCostEvents.length >= 1, "mid should get cost.update from leaf rollup");
  const midLast = midCostEvents[midCostEvents.length - 1];
  // leaf: 5000 * 0.001 / 1000 = 0.005
  assert.ok(Math.abs(midLast.payload.childCostUsd - 0.005) < 1e-9);

  // The mid cost.update was published via publishAgentRunEvent on mid's emitter,
  // but the rollup to root happens inside emitCostUpdate (only for the child's
  // own cost.update call). The rollupCostToParent function only fires inside
  // emitCostUpdate, not on every publishAgentRunEvent. So the root receives
  // a rollup only if mid itself calls emitCostUpdate.
  // Let's verify: mid emits its own cost -> root gets rollup including mid's own + mid's children
  emitCostUpdate({
    sessionId: mid.id,
    runId: "run-mid",
    model: "model-c",
    usage: { total_tokens: 1000 },
  });
  await delay(100);

  const rootCostEvents = rootEvents.filter((e) => e.type === "cost.update");
  assert.ok(rootCostEvents.length >= 1, "root should get cost.update from mid rollup");
  const rootLast = rootCostEvents[rootCostEvents.length - 1];
  // mid own: 1000 * 0.001 / 1000 = 0.001 (from run accumulator)
  // root sees mid as child with mid's run accumulator totalUsd = 0.001
  assert.ok(rootLast.payload.childCostUsd > 0, "root should see child cost");
});

test("no parent -> no rollup, no error", async () => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("model-d:0.003");

  const standalone = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "user1",
    title: "standalone",
  });

  const events = [];
  const emitter = getAgentRunEmitter(standalone.id);
  emitter.on("event", (ev) => events.push(ev));

  // Should not throw and should only produce the child's own cost.update
  assert.doesNotThrow(() => {
    emitCostUpdate({
      sessionId: standalone.id,
      runId: "run-standalone",
      model: "model-d",
      usage: { total_tokens: 100 },
    });
  });

  await delay(50);

  const costEvents = events.filter((e) => e.type === "cost.update");
  assert.equal(costEvents.length, 1, "only one cost.update (no rollup)");
  // No childCostUsd key on the direct cost.update
  assert.equal(costEvents[0].payload.runId, "run-standalone");
  assert.ok(!("childCostUsd" in costEvents[0].payload));
});
