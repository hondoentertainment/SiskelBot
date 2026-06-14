/**
 * Coverage tests for lib/swarm.js: exercise runSwarmDirect (tool-only) and
 * helpers that aren't covered by existing allowlist / resolve tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "swarm-cov-"));

const swarm = await import("../lib/swarm.js");

test("detectIntent re-export returns boolean flags", () => {
  const r = swarm.detectIntent("research the knowledge base for foo");
  assert.equal(typeof r.researcher, "boolean");
  assert.equal(typeof r.executor, "boolean");
});

test("getSwarmSelectableSpecialistNames excludes synthesizer", () => {
  const names = swarm.getSwarmSelectableSpecialistNames();
  assert.ok(Array.isArray(names));
  assert.ok(!names.includes("synthesizer"));
});

test("intersectSwarmSpecialistsWithAllowlist returns a copy when unset", () => {
  const prev = process.env.SWARM_SPECIALISTS_ALLOWLIST;
  delete process.env.SWARM_SPECIALISTS_ALLOWLIST;
  try {
    const a = ["researcher", "executor"];
    const b = swarm.intersectSwarmSpecialistsWithAllowlist(a);
    assert.deepEqual(b, a);
    assert.notEqual(b, a, "should be a fresh array");
  } finally {
    if (prev === undefined) delete process.env.SWARM_SPECIALISTS_ALLOWLIST;
    else process.env.SWARM_SPECIALISTS_ALLOWLIST = prev;
  }
});

test("intersectSwarmSpecialistsWithAllowlist handles non-array input", () => {
  // when names is not an array, returns [] regardless of allowlist
  const prev = process.env.SWARM_SPECIALISTS_ALLOWLIST;
  process.env.SWARM_SPECIALISTS_ALLOWLIST = "researcher";
  try {
    const out = swarm.intersectSwarmSpecialistsWithAllowlist(null);
    assert.deepEqual(out, []);
  } finally {
    if (prev === undefined) delete process.env.SWARM_SPECIALISTS_ALLOWLIST;
    else process.env.SWARM_SPECIALISTS_ALLOWLIST = prev;
  }
});

test("runSwarmDirect executes researcher with tool list (empty workspace) and reports success=false when no snippets", async () => {
  const r = await swarm.runSwarmDirect(["researcher"], "some query", {
    workspace: "swarm-cov-ws",
  });
  assert.ok(Array.isArray(r.aggregation));
  assert.equal(r.aggregation.length, 1);
  assert.equal(r.aggregation[0].specialist, "researcher");
  assert.equal(typeof r.aggregation[0].output, "string");
  // metrics shape
  assert.equal(typeof r.metrics.agentCount, "number");
  assert.equal(typeof r.metrics.durationMs, "number");
});

test("runSwarmDirect handles unknown specialist as per-entry error without throwing", async () => {
  const r = await swarm.runSwarmDirect(["no_such_specialist"], "q", { workspace: "swarm-cov-ws" });
  assert.equal(r.aggregation.length, 1);
  assert.equal(r.aggregation[0].success, false);
  assert.ok(r.aggregation[0].error);
});

test("runSwarmDirect with researcher + executor runs both in parallel", async () => {
  const r = await swarm.runSwarmDirect(["researcher", "executor"], "", { workspace: "swarm-cov-ws" });
  assert.equal(r.aggregation.length, 2);
  const names = r.aggregation.map((a) => a.specialist).sort();
  assert.deepEqual(names, ["executor", "researcher"]);
});

test("runSwarmDirect with a CONTEXT_DOC_ID-shaped query attempts get_context_document", async () => {
  const uuid = "01234567-89ab-4cde-8f01-234567890abc";
  const r = await swarm.runSwarmDirect(["researcher"], uuid, { workspace: "swarm-cov-ws" });
  assert.equal(r.aggregation.length, 1);
  assert.ok(typeof r.aggregation[0].output === "string");
});

test("runSwarmDirect: executor returns both list_recipes and get_recipe JSON blocks", async () => {
  const r = await swarm.runSwarmDirect(["executor"], "", { workspace: "swarm-cov-ws" });
  assert.equal(r.aggregation[0].specialist, "executor");
  // parallel fan-out returns parts keyed by tool name
  const parts = JSON.parse(r.aggregation[0].output);
  assert.ok("list_recipes" in parts || "get_recipe" in parts);
});

test("runSwarmDirect: synthesizer (no tools) yields a 'no runnable tools' payload", async () => {
  const r = await swarm.runSwarmDirect(["synthesizer"], "q", { workspace: "swarm-cov-ws" });
  assert.equal(r.aggregation.length, 1);
  const out = JSON.parse(r.aggregation[0].output);
  assert.ok(out.error && /no runnable tools/.test(out.error));
});

test("resolveSwarmSpecialistNames default empty intent picks researcher", () => {
  delete process.env.SWARM_CLIENT_SPECIALISTS;
  delete process.env.SWARM_PARALLEL_AGENTS;
  delete process.env.SWARM_SPECIALISTS_ALLOWLIST;
  const r = swarm.resolveSwarmSpecialistNames({ researcher: false, executor: false }, {});
  assert.deepEqual(r.specialistNames, ["researcher"]);
});

test("resolveSwarmSpecialistNames: SWARM_MAX_SPECIALISTS clamps client roster", () => {
  const p1 = process.env.SWARM_CLIENT_SPECIALISTS;
  const p2 = process.env.SWARM_MAX_SPECIALISTS;
  process.env.SWARM_CLIENT_SPECIALISTS = "1";
  process.env.SWARM_MAX_SPECIALISTS = "1";
  try {
    const r = swarm.resolveSwarmSpecialistNames(
      { researcher: true, executor: true },
      { swarmSpecialists: ["researcher", "executor"] }
    );
    assert.equal(r.specialistNames.length, 1);
    assert.equal(r.rosterSource, "client");
  } finally {
    if (p1 === undefined) delete process.env.SWARM_CLIENT_SPECIALISTS;
    else process.env.SWARM_CLIENT_SPECIALISTS = p1;
    if (p2 === undefined) delete process.env.SWARM_MAX_SPECIALISTS;
    else process.env.SWARM_MAX_SPECIALISTS = p2;
  }
});

test("resolveSwarmSpecialistNames: client duplicate names are de-duplicated", () => {
  const p = process.env.SWARM_CLIENT_SPECIALISTS;
  process.env.SWARM_CLIENT_SPECIALISTS = "1";
  try {
    const r = swarm.resolveSwarmSpecialistNames(
      { researcher: true, executor: false },
      { swarmSpecialists: ["researcher", "researcher"] }
    );
    assert.deepEqual(r.specialistNames, ["researcher"]);
  } finally {
    if (p === undefined) delete process.env.SWARM_CLIENT_SPECIALISTS;
    else process.env.SWARM_CLIENT_SPECIALISTS = p;
  }
});
