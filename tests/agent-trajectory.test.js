/**
 * Phase 59: Trajectory collector and store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTrajectoryCollector, saveTrajectory, loadTrajectory } from "../lib/agent-trajectory.js";

test("collector records steps and snapshot", () => {
  const c = createTrajectoryCollector({ runId: "test-run-1", workspace: "default" });
  c.record({ type: "iteration", iteration: 1 });
  c.record({ type: "tool_call", name: "list_context" });
  const snap = c.getSnapshot();
  assert.equal(snap.runId, "test-run-1");
  assert.equal(snap.steps.length, 2);
  assert.ok(snap.stepCount >= 2);
});

test("saveTrajectory and loadTrajectory round-trip", () => {
  const runId = "traj-roundtrip-" + Date.now();
  const c = createTrajectoryCollector({ runId });
  c.record({ type: "stop", reason: "model_finished" });
  saveTrajectory(runId, c.getSnapshot());
  const loaded = loadTrajectory(runId);
  assert.ok(loaded);
  assert.equal(loaded.runId, runId);
  assert.ok(loaded.steps.some((s) => s.type === "stop"));
});
