/**
 * Covers runSwarmLegacy and runSpecialistWithTolerance — both previously
 * had zero hits. Exercises happy path and error/unknown-specialist branches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "swarm-legacy-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { runSwarmLegacy } = await import("../lib/swarm.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("runSwarmLegacy: researcher specialist returns aggregation shape", async () => {
  const result = await runSwarmLegacy(["researcher"], "what is the purpose of this codebase?", {
    workspace: "default",
  });
  assert.ok(Array.isArray(result.aggregation));
  assert.equal(result.aggregation.length, 1);
  assert.equal(result.aggregation[0].specialist, "researcher");
  assert.ok(typeof result.aggregation[0].latencyMs === "number");
  assert.equal(result.metrics.agentCount, 1);
  assert.ok(typeof result.metrics.durationMs === "number");
});

test("runSwarmLegacy: unknown specialist is tolerated and marked failed", async () => {
  const result = await runSwarmLegacy(["does-not-exist"], "x", { workspace: "default" });
  assert.equal(result.aggregation.length, 1);
  assert.equal(result.aggregation[0].specialist, "does-not-exist");
  assert.equal(result.aggregation[0].success, false);
  assert.match(result.aggregation[0].error || "", /Unknown specialist/);
});

test("runSwarmLegacy: multiple specialists run in parallel", async () => {
  const result = await runSwarmLegacy(["researcher", "executor"], "help", {
    workspace: "default",
  });
  assert.equal(result.aggregation.length, 2);
  const names = result.aggregation.map((r) => r.specialist).sort();
  assert.deepEqual(names, ["executor", "researcher"]);
});

test("runSwarmLegacy: with allowExecution option", async () => {
  const result = await runSwarmLegacy(["researcher"], "query", {
    workspace: "default",
    allowExecution: true,
    projectDir: "/tmp",
  });
  assert.ok(result.aggregation);
  assert.equal(result.aggregation[0].specialist, "researcher");
});

test("runSwarmLegacy: empty specialist list returns empty aggregation", async () => {
  const result = await runSwarmLegacy([], "query", { workspace: "default" });
  assert.deepEqual(result.aggregation, []);
  assert.equal(result.metrics.agentCount, 0);
});
