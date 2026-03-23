/**
 * Phase 78: resolveSwarmSpecialistNames — SWARM_PARALLEL_AGENTS / agentOptions.parallelAgents.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSwarmSpecialistNames } from "../lib/swarm.js";

const initialParallel = process.env.SWARM_PARALLEL_AGENTS;

test.afterEach(() => {
  if (initialParallel === undefined) delete process.env.SWARM_PARALLEL_AGENTS;
  else process.env.SWARM_PARALLEL_AGENTS = initialParallel;
});

test("intent-only single researcher when env off", () => {
  delete process.env.SWARM_PARALLEL_AGENTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, {});
  assert.deepEqual(r.specialistNames, ["researcher"]);
  assert.equal(r.parallelFanOut, false);
});

test("intent-only researcher and executor when both eligible", () => {
  delete process.env.SWARM_PARALLEL_AGENTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: true }, {});
  assert.deepEqual(r.specialistNames, ["researcher", "executor"]);
  assert.equal(r.parallelFanOut, false);
});

test("SWARM_PARALLEL_AGENTS=1 forces researcher + executor", () => {
  process.env.SWARM_PARALLEL_AGENTS = "1";
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, {});
  assert.deepEqual(r.specialistNames, ["researcher", "executor"]);
  assert.equal(r.parallelFanOut, true);
});

test("parallelAgents false overrides env", () => {
  process.env.SWARM_PARALLEL_AGENTS = "1";
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, { parallelAgents: false });
  assert.deepEqual(r.specialistNames, ["researcher"]);
  assert.equal(r.parallelFanOut, false);
});

test("parallelAgents true forces fan-out when env off", () => {
  delete process.env.SWARM_PARALLEL_AGENTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, { parallelAgents: true });
  assert.deepEqual(r.specialistNames, ["researcher", "executor"]);
  assert.equal(r.parallelFanOut, true);
});
