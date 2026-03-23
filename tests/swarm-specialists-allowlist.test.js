/**
 * Phase 91: SWARM_SPECIALISTS_ALLOWLIST
 */
import test from "node:test";
import assert from "node:assert/strict";

const initial = process.env.SWARM_SPECIALISTS_ALLOWLIST;

test.afterEach(() => {
  if (initial === undefined) delete process.env.SWARM_SPECIALISTS_ALLOWLIST;
  else process.env.SWARM_SPECIALISTS_ALLOWLIST = initial;
});

test("parseSwarmSpecialistsAllowlistSet null when unset", async () => {
  delete process.env.SWARM_SPECIALISTS_ALLOWLIST;
  const mod = await import("../lib/swarm.js");
  assert.equal(mod.parseSwarmSpecialistsAllowlistSet(), null);
  assert.equal(mod.getSwarmSpecialistsAllowlistNames(), null);
});

test("getSwarmSelectableSpecialistNames filters by allowlist", async () => {
  process.env.SWARM_SPECIALISTS_ALLOWLIST = "researcher";
  const mod = await import("../lib/swarm.js");
  const sel = mod.getSwarmSelectableSpecialistNames();
  assert.ok(sel.includes("researcher"));
  assert.equal(sel.includes("executor"), false);
});

test("intersectSwarmSpecialistsWithAllowlist preserves order", async () => {
  process.env.SWARM_SPECIALISTS_ALLOWLIST = "executor,researcher";
  const mod = await import("../lib/swarm.js");
  const x = mod.intersectSwarmSpecialistsWithAllowlist(["researcher", "executor", "nope"]);
  assert.deepEqual(x, ["researcher", "executor"]);
});
