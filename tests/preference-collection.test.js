/**
 * Phase 75.3: Preference collection tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-preference-collection-"));
process.env.STORAGE_PATH = TMP;

const {
  createComparisonCase,
  getComparisonCase,
  listComparisonCases,
  recordPreference,
  getPreferenceStats,
  listPreferences,
  _reset,
} = await import("../lib/preference-collection.js");

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

test("createComparisonCase validates inputs", async () => {
  await _reset();
  await assert.rejects(
    () => createComparisonCase({ workspaceId: "ws", modelB: "b", prompt: "x" }),
    /modelA and modelB/,
  );
  await assert.rejects(
    () => createComparisonCase({ workspaceId: "ws", modelA: "a", modelB: "b" }),
    /prompt/,
  );
});

test("createComparisonCase stores and lists cases", async () => {
  await _reset();
  const c = await createComparisonCase({
    workspaceId: "ws-x",
    modelA: "mA",
    modelB: "mB",
    prompt: "hello",
    responseA: "A-response",
    responseB: "B-response",
  });
  assert.ok(c.caseId);
  assert.equal(c.modelA, "mA");
  const got = await getComparisonCase(c.caseId);
  assert.equal(got.caseId, c.caseId);
  const list = await listComparisonCases("ws-x");
  assert.equal(list.length, 1);
});

test("recordPreference requires valid preferred choice", async () => {
  await _reset();
  const c = await createComparisonCase({
    workspaceId: "ws", modelA: "a", modelB: "b", prompt: "p", responseA: "x", responseB: "y",
  });
  await assert.rejects(
    () => recordPreference({ caseId: c.caseId, preferred: "C" }),
    /preferred/,
  );
  await assert.rejects(
    () => recordPreference({ caseId: "nope", preferred: "A" }),
    /unknown caseId/,
  );
});

test("recordPreference + getPreferenceStats tally votes and pick winner", async () => {
  await _reset();
  const c = await createComparisonCase({
    workspaceId: "stats", modelA: "a", modelB: "b", prompt: "p", responseA: "ra", responseB: "rb",
  });
  await recordPreference({ caseId: c.caseId, userId: "u1", preferred: "A" });
  await recordPreference({ caseId: c.caseId, userId: "u2", preferred: "A" });
  await recordPreference({ caseId: c.caseId, userId: "u3", preferred: "B" });
  await recordPreference({ caseId: c.caseId, userId: "u4", preferred: "tie" });
  const stats = await getPreferenceStats(c.caseId);
  assert.equal(stats.total, 4);
  assert.equal(stats.A, 2);
  assert.equal(stats.B, 1);
  assert.equal(stats.tie, 1);
  assert.equal(stats.winner, "A");
  assert.ok(stats.aShare > stats.bShare);
});

test("listPreferences filters by caseId", async () => {
  await _reset();
  const c1 = await createComparisonCase({
    workspaceId: "mx", modelA: "a", modelB: "b", prompt: "p1", responseA: "x", responseB: "y",
  });
  const c2 = await createComparisonCase({
    workspaceId: "mx", modelA: "a", modelB: "b", prompt: "p2", responseA: "x", responseB: "y",
  });
  await recordPreference({ caseId: c1.caseId, preferred: "A" });
  await recordPreference({ caseId: c2.caseId, preferred: "B" });
  const only1 = await listPreferences({ caseId: c1.caseId });
  assert.equal(only1.length, 1);
  assert.equal(only1[0].caseId, c1.caseId);
  const byWs = await listPreferences({ workspaceId: "mx" });
  assert.equal(byWs.length, 2);
});

test("getPreferenceStats handles no votes", async () => {
  await _reset();
  const c = await createComparisonCase({
    workspaceId: "empty", modelA: "a", modelB: "b", prompt: "p", responseA: "x", responseB: "y",
  });
  const stats = await getPreferenceStats(c.caseId);
  assert.equal(stats.total, 0);
  assert.equal(stats.winner, null);
});
