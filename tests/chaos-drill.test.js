/**
 * chaos-drill tests.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { runChaosDrill } = await import("../lib/chaos-drill.js");

test("runChaosDrill skips when CHAOS_DRILL_ENABLE is unset", async () => {
  const prev = process.env.CHAOS_DRILL_ENABLE;
  delete process.env.CHAOS_DRILL_ENABLE;
  try {
    const res = await runChaosDrill({ backend: "drill-skip" });
    assert.equal(res.ok, false);
    assert.equal(res.summary.skipped, true);
    assert.match(res.summary.reason, /CHAOS_DRILL_ENABLE/);
  } finally {
    if (prev != null) process.env.CHAOS_DRILL_ENABLE = prev;
  }
});

test("runChaosDrill trips, short-circuits, then recovers", async () => {
  process.env.CHAOS_DRILL_ENABLE = "1";
  const res = await runChaosDrill({
    backend: "drill-success",
    failures: 6,
  });
  assert.equal(res.ok, true);
  assert.equal(res.steps.length, 3);
  assert.equal(res.steps[0].step, "trip-breaker");
  assert.equal(res.steps[0].open, true);
  assert.equal(res.steps[1].shortCircuited, true);
  assert.equal(res.steps[2].open, false);
  delete process.env.CHAOS_DRILL_ENABLE;
});

test("runChaosDrill captures backend name in summary", async () => {
  process.env.CHAOS_DRILL_ENABLE = "1";
  const res = await runChaosDrill({ backend: "drill-named" });
  assert.equal(res.summary.backend, "drill-named");
  delete process.env.CHAOS_DRILL_ENABLE;
});
