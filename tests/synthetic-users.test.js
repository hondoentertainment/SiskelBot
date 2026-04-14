/**
 * Phase 75.5: Synthetic user simulation tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-synthetic-users-"));
process.env.STORAGE_PATH = TMP;

const {
  createPersona,
  listPersonas,
  getPersona,
  startSimulation,
  appendTurn,
  completeSimulation,
  scoreSimulation,
  getSimulation,
  listSimulations,
  _reset,
} = await import("../lib/synthetic-users.js");

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

test("createPersona stores traits and goals", async () => {
  await _reset();
  const p = await createPersona({
    workspaceId: "ws",
    name: "Alice",
    traits: ["friendly", "impatient"],
    goals: ["find pricing", "book demo"],
  });
  assert.ok(p.personaId);
  assert.equal(p.name, "Alice");
  assert.deepEqual(p.traits, ["friendly", "impatient"]);
  assert.deepEqual(p.goals, ["find pricing", "book demo"]);
  const got = await getPersona(p.personaId);
  assert.equal(got.personaId, p.personaId);
  const list = await listPersonas("ws");
  assert.equal(list.length, 1);
});

test("createPersona requires a name", async () => {
  await _reset();
  await assert.rejects(() => createPersona({ workspaceId: "ws" }), /name/);
});

test("startSimulation + appendTurn + completeSimulation", async () => {
  await _reset();
  const p = await createPersona({ workspaceId: "sim", name: "Bob", goals: ["answer A", "answer B"] });
  const sim = await startSimulation({
    workspaceId: "sim",
    personaId: p.personaId,
    systemPrompt: "You are helpful.",
    maxTurns: 10,
  });
  assert.equal(sim.status, "running");
  assert.equal(sim.turns.length, 0);

  const withTurn = await appendTurn({ simulationId: sim.simulationId, role: "user", content: "Hi" });
  assert.equal(withTurn.turns.length, 1);
  assert.equal(withTurn.status, "running");

  await appendTurn({ simulationId: sim.simulationId, role: "assistant", content: "hello, answer A" });

  const done = await completeSimulation({ simulationId: sim.simulationId });
  assert.equal(done.status, "complete");
  assert.ok(done.completedAt);
});

test("appendTurn rejects invalid role", async () => {
  await _reset();
  const p = await createPersona({ workspaceId: "w", name: "X", goals: ["ok"] });
  const sim = await startSimulation({ workspaceId: "w", personaId: p.personaId });
  await assert.rejects(
    () => appendTurn({ simulationId: sim.simulationId, role: "wizard", content: "hi" }),
    /role/,
  );
});

test("scoreSimulation counts goal substrings in assistant turns", async () => {
  await _reset();
  const p = await createPersona({
    workspaceId: "sc",
    name: "Scorer",
    goals: ["pricing", "demo", "roadmap"],
  });
  const sim = await startSimulation({ workspaceId: "sc", personaId: p.personaId });
  await appendTurn({ simulationId: sim.simulationId, role: "user", content: "tell me pricing" });
  await appendTurn({ simulationId: sim.simulationId, role: "assistant", content: "Our pricing starts at $10. We also offer a demo." });
  const score = await scoreSimulation({ simulationId: sim.simulationId });
  assert.equal(score.goalsTotal, 3);
  assert.equal(score.goalsHit, 2);
  assert.equal(score.score, 0.6667);
  assert.equal(score.perGoal.pricing, true);
  assert.equal(score.perGoal.demo, true);
  assert.equal(score.perGoal.roadmap, false);
});

test("scoreSimulation applies goalWeights", async () => {
  await _reset();
  const p = await createPersona({ workspaceId: "w", name: "W", goals: ["a", "b"] });
  const sim = await startSimulation({ workspaceId: "w", personaId: p.personaId });
  await appendTurn({ simulationId: sim.simulationId, role: "assistant", content: "we have a" });
  const s1 = await scoreSimulation({ simulationId: sim.simulationId });
  assert.equal(s1.score, 0.5);
  const s2 = await scoreSimulation({ simulationId: sim.simulationId, goalWeights: { a: 3, b: 1 } });
  // 3 / 4 = 0.75
  assert.equal(s2.weightedScore, 0.75);
});

test("maxTurns auto-completes simulation", async () => {
  await _reset();
  const p = await createPersona({ workspaceId: "mt", name: "M", goals: ["x"] });
  const sim = await startSimulation({ workspaceId: "mt", personaId: p.personaId, maxTurns: 2 });
  await appendTurn({ simulationId: sim.simulationId, role: "user", content: "1" });
  const final = await appendTurn({ simulationId: sim.simulationId, role: "assistant", content: "x" });
  assert.equal(final.status, "complete");
});

test("listSimulations returns simulations for a workspace", async () => {
  await _reset();
  const p = await createPersona({ workspaceId: "lst", name: "L", goals: ["g"] });
  await startSimulation({ workspaceId: "lst", personaId: p.personaId });
  await startSimulation({ workspaceId: "lst", personaId: p.personaId });
  const list = await listSimulations("lst");
  assert.equal(list.length, 2);
});

test("getSimulation returns null for unknown id", async () => {
  const missing = await getSimulation("nope-nope");
  assert.equal(missing, null);
});
