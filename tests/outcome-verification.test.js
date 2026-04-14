/**
 * Phase 71.2: Outcome verification tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-outcome-verification-"));
process.env.STORAGE_PATH = TMP;

const {
  defineOutcome,
  listOutcomes,
  getOutcome,
  verifyOutcome,
  getVerification,
  listVerifications,
  CRITERION_TYPES,
  _reset,
} = await import("../lib/outcome-verification.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("CRITERION_TYPES includes all six types", () => {
  for (const t of ["contains", "not_contains", "equals", "regex", "numeric_gte", "numeric_lte"]) {
    assert.ok(CRITERION_TYPES.includes(t), `missing ${t}`);
  }
});

test("defineOutcome rejects missing name or criteria", async () => {
  await _reset();
  await assert.rejects(() => defineOutcome({ workspaceId: "ws", criteria: [{ type: "contains", match: "x" }] }), /name/);
  await assert.rejects(() => defineOutcome({ workspaceId: "ws", name: "n", criteria: [] }), /criteria/);
});

test("defineOutcome stores and returns an outcome", async () => {
  await _reset();
  const o = await defineOutcome({
    workspaceId: "ws",
    name: "shipped",
    criteria: [
      { id: "a", type: "contains", match: "done", weight: 2 },
      { id: "b", type: "numeric_gte", field: "toolCalls", match: 1, weight: 1 },
    ],
  });
  assert.ok(o.outcomeId);
  assert.equal(o.name, "shipped");
  assert.equal(o.criteria.length, 2);
});

test("listOutcomes returns only workspace outcomes", async () => {
  await _reset();
  await defineOutcome({ workspaceId: "a", name: "o1", criteria: [{ type: "contains", match: "x" }] });
  await defineOutcome({ workspaceId: "a", name: "o2", criteria: [{ type: "contains", match: "y" }] });
  await defineOutcome({ workspaceId: "b", name: "o3", criteria: [{ type: "contains", match: "z" }] });
  assert.equal((await listOutcomes("a")).length, 2);
  assert.equal((await listOutcomes("b")).length, 1);
});

test("getOutcome returns outcome by id", async () => {
  await _reset();
  const o = await defineOutcome({
    workspaceId: "ws", name: "x", criteria: [{ type: "equals", match: "done" }],
  });
  const fetched = await getOutcome(o.outcomeId);
  assert.ok(fetched);
  assert.equal(fetched.outcomeId, o.outcomeId);
});

test("verifyOutcome returns score=1.0 and passed=true when all match", async () => {
  await _reset();
  const o = await defineOutcome({
    workspaceId: "ws",
    name: "goal",
    criteria: [
      { id: "c1", type: "contains", match: "success", weight: 1 },
      { id: "c2", type: "numeric_lte", field: "duration", match: 5000, weight: 1 },
    ],
  });
  const v = await verifyOutcome({
    outcomeId: o.outcomeId,
    runId: "run-1",
    signals: { output: "pipeline success", duration: 2000 },
  });
  assert.equal(v.passed, true);
  assert.equal(v.score, 1);
  assert.equal(v.perCriterion.length, 2);
  assert.ok(v.verificationId);
});

test("verifyOutcome partial match returns score < 1 and passed=false", async () => {
  await _reset();
  const o = await defineOutcome({
    workspaceId: "ws",
    name: "goal",
    criteria: [
      { id: "c1", type: "contains", match: "success", weight: 3 },
      { id: "c2", type: "numeric_gte", field: "toolCalls", match: 5, weight: 1 },
    ],
  });
  // c1 passes (weight 3), c2 fails (weight 1) => 3/4 = 0.75
  const v = await verifyOutcome({
    outcomeId: o.outcomeId,
    signals: { output: "big success", toolCalls: 2 },
  });
  assert.equal(v.passed, false);
  assert.ok(Math.abs(v.score - 0.75) < 1e-6, `got ${v.score}`);
});

test("verifyOutcome supports regex and not_contains", async () => {
  await _reset();
  const o = await defineOutcome({
    workspaceId: "ws",
    name: "goal",
    criteria: [
      { id: "r", type: "regex", match: "^ok", weight: 1 },
      { id: "n", type: "not_contains", match: "error", weight: 1 },
    ],
  });
  const v = await verifyOutcome({
    outcomeId: o.outcomeId,
    signals: { output: "ok: all good" },
  });
  assert.equal(v.passed, true);
  assert.equal(v.score, 1);
});

test("verifyOutcome throws if outcome not found", async () => {
  await _reset();
  await assert.rejects(() => verifyOutcome({ outcomeId: "nope", signals: {} }), /not found/);
});

test("getVerification and listVerifications work", async () => {
  await _reset();
  const o = await defineOutcome({
    workspaceId: "ws", name: "g", criteria: [{ type: "contains", match: "ok" }],
  });
  const v = await verifyOutcome({ outcomeId: o.outcomeId, signals: { output: "ok" } });
  const fetched = await getVerification(v.verificationId);
  assert.ok(fetched);
  assert.equal(fetched.verificationId, v.verificationId);
  const list = await listVerifications({ workspaceId: "ws" });
  assert.ok(list.length >= 1);
  const byOutcome = await listVerifications({ outcomeId: o.outcomeId });
  assert.ok(byOutcome.length >= 1);
});

test("verifyOutcome persists signals and runId in record", async () => {
  await _reset();
  const o = await defineOutcome({
    workspaceId: "ws", name: "g", criteria: [{ type: "equals", field: "status", match: "done" }],
  });
  const v = await verifyOutcome({
    outcomeId: o.outcomeId,
    runId: "run-42",
    signals: { status: "done" },
  });
  assert.equal(v.runId, "run-42");
  assert.deepEqual(v.signals, { status: "done" });
  assert.ok(typeof v.confidence === "number");
});
