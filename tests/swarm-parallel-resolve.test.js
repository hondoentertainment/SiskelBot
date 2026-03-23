/**
 * Phase 78: resolveSwarmSpecialistNames — SWARM_PARALLEL_AGENTS / agentOptions.parallelAgents.
 * Phase 90: SWARM_CLIENT_SPECIALISTS + agentOptions.swarmSpecialists, rosterSource.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveSwarmSpecialistNames } from "../lib/swarm.js";

const initialParallel = process.env.SWARM_PARALLEL_AGENTS;
const initialClientRoster = process.env.SWARM_CLIENT_SPECIALISTS;
const initialMaxSpecs = process.env.SWARM_MAX_SPECIALISTS;
const initialSwarmSpecAllow = process.env.SWARM_SPECIALISTS_ALLOWLIST;

test.afterEach(() => {
  if (initialParallel === undefined) delete process.env.SWARM_PARALLEL_AGENTS;
  else process.env.SWARM_PARALLEL_AGENTS = initialParallel;
  if (initialClientRoster === undefined) delete process.env.SWARM_CLIENT_SPECIALISTS;
  else process.env.SWARM_CLIENT_SPECIALISTS = initialClientRoster;
  if (initialMaxSpecs === undefined) delete process.env.SWARM_MAX_SPECIALISTS;
  else process.env.SWARM_MAX_SPECIALISTS = initialMaxSpecs;
  if (initialSwarmSpecAllow === undefined) delete process.env.SWARM_SPECIALISTS_ALLOWLIST;
  else process.env.SWARM_SPECIALISTS_ALLOWLIST = initialSwarmSpecAllow;
});

test("intent-only single researcher when env off", () => {
  delete process.env.SWARM_PARALLEL_AGENTS;
  delete process.env.SWARM_CLIENT_SPECIALISTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, {});
  assert.deepEqual(r.specialistNames, ["researcher"]);
  assert.equal(r.parallelFanOut, false);
  assert.equal(r.rosterSource, "intent");
});

test("intent-only researcher and executor when both eligible", () => {
  delete process.env.SWARM_PARALLEL_AGENTS;
  delete process.env.SWARM_CLIENT_SPECIALISTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: true }, {});
  assert.deepEqual(r.specialistNames, ["researcher", "executor"]);
  assert.equal(r.parallelFanOut, false);
  assert.equal(r.rosterSource, "intent");
});

test("SWARM_PARALLEL_AGENTS=1 forces researcher + executor", () => {
  process.env.SWARM_PARALLEL_AGENTS = "1";
  delete process.env.SWARM_CLIENT_SPECIALISTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, {});
  assert.deepEqual(r.specialistNames, ["researcher", "executor"]);
  assert.equal(r.parallelFanOut, true);
  assert.equal(r.rosterSource, "parallel");
});

test("parallelAgents false overrides env", () => {
  process.env.SWARM_PARALLEL_AGENTS = "1";
  delete process.env.SWARM_CLIENT_SPECIALISTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, { parallelAgents: false });
  assert.deepEqual(r.specialistNames, ["researcher"]);
  assert.equal(r.parallelFanOut, false);
  assert.equal(r.rosterSource, "intent");
});

test("parallelAgents true forces fan-out when env off", () => {
  delete process.env.SWARM_PARALLEL_AGENTS;
  delete process.env.SWARM_CLIENT_SPECIALISTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, { parallelAgents: true });
  assert.deepEqual(r.specialistNames, ["researcher", "executor"]);
  assert.equal(r.parallelFanOut, true);
  assert.equal(r.rosterSource, "parallel");
});

test("SWARM_CLIENT_SPECIALISTS=1 uses agentOptions.swarmSpecialists (precedence over parallel)", () => {
  process.env.SWARM_CLIENT_SPECIALISTS = "1";
  process.env.SWARM_PARALLEL_AGENTS = "1";
  delete process.env.SWARM_MAX_SPECIALISTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, {
    parallelAgents: true,
    swarmSpecialists: ["executor", "researcher"],
  });
  assert.deepEqual(r.specialistNames, ["executor", "researcher"]);
  assert.equal(r.parallelFanOut, false);
  assert.equal(r.rosterSource, "client");
});

test("client roster drops synthesizer and unknown names", () => {
  process.env.SWARM_CLIENT_SPECIALISTS = "1";
  delete process.env.SWARM_MAX_SPECIALISTS;
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: true }, {
    swarmSpecialists: ["synthesizer", "nope", "researcher"],
  });
  assert.deepEqual(r.specialistNames, ["researcher"]);
  assert.equal(r.rosterSource, "client");
});

test("empty client roster after filter falls back to parallel", () => {
  process.env.SWARM_CLIENT_SPECIALISTS = "1";
  process.env.SWARM_PARALLEL_AGENTS = "1";
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, { swarmSpecialists: ["synthesizer", "bogus"] });
  assert.deepEqual(r.specialistNames, ["researcher", "executor"]);
  assert.equal(r.parallelFanOut, true);
  assert.equal(r.rosterSource, "parallel");
});

test("SWARM_SPECIALISTS_ALLOWLIST intersects client roster", () => {
  process.env.SWARM_CLIENT_SPECIALISTS = "1";
  delete process.env.SWARM_MAX_SPECIALISTS;
  process.env.SWARM_SPECIALISTS_ALLOWLIST = "executor";
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: true }, {
    swarmSpecialists: ["researcher", "executor"],
  });
  assert.deepEqual(r.specialistNames, ["executor"]);
  assert.equal(r.rosterSource, "client");
});

test("SWARM_SPECIALISTS_ALLOWLIST reduces parallel fan-out to one specialist", () => {
  process.env.SWARM_PARALLEL_AGENTS = "1";
  delete process.env.SWARM_CLIENT_SPECIALISTS;
  process.env.SWARM_SPECIALISTS_ALLOWLIST = "executor";
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, {});
  assert.deepEqual(r.specialistNames, ["executor"]);
  assert.equal(r.parallelFanOut, false);
  assert.equal(r.rosterSource, "parallel");
});

test("client roster empty after allowlist falls through to intent", () => {
  process.env.SWARM_CLIENT_SPECIALISTS = "1";
  delete process.env.SWARM_PARALLEL_AGENTS;
  process.env.SWARM_SPECIALISTS_ALLOWLIST = "executor";
  const r = resolveSwarmSpecialistNames({ researcher: true, executor: false }, { swarmSpecialists: ["researcher"] });
  assert.deepEqual(r.specialistNames, ["executor"]);
  assert.equal(r.rosterSource, "intent");
});
