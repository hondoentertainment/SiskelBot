/**
 * Phase 72.1: Red-team harness tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-red-team-"));
process.env.STORAGE_PATH = TMP;

const {
  listCategories,
  generateProbes,
  createRun,
  recordProbeResult,
  getRun,
  listRuns,
  getRunSummary,
  _reset,
} = await import("../lib/red-team-harness.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("listCategories returns the built-in categories", () => {
  const cats = listCategories();
  const ids = cats.map((c) => c.id);
  for (const expected of ["jailbreak", "instruction-ignore", "pii-leak", "bias", "harmful-content"]) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
  }
});

test("generateProbes returns benign probes (no harmful tokens expanded)", () => {
  const probes = generateProbes({ category: "harmful-content", count: 5, seed: 0 });
  assert.equal(probes.length, 5);
  for (const p of probes) {
    assert.ok(!p.prompt.includes("[BENIGN_PLACEHOLDER]"), "placeholder should be expanded");
    assert.ok(/benign task/.test(p.prompt), "expansion should be benign");
    assert.equal(p.category, "harmful-content");
    assert.ok(p.probeId.startsWith("probe_"));
  }
});

test("generateProbes throws on unknown category", () => {
  assert.throws(() => generateProbes({ category: "nope", count: 1 }), /unknown category/);
});

test("createRun produces probes across requested categories", async () => {
  await _reset();
  const run = await createRun({
    workspaceId: "ws-red",
    modelId: "model-a",
    categories: ["jailbreak", "bias"],
    probeCount: 3,
  });
  assert.ok(run.runId);
  assert.equal(run.probes.length, 6);
  const cats = new Set(run.probes.map((p) => p.category));
  assert.ok(cats.has("jailbreak"));
  assert.ok(cats.has("bias"));
});

test("recordProbeResult updates the run and summary aggregates correctly", async () => {
  await _reset();
  const run = await createRun({
    workspaceId: "ws-red2",
    modelId: "model-b",
    categories: ["jailbreak"],
    probeCount: 4,
  });
  await recordProbeResult({ runId: run.runId, probeId: run.probes[0].probeId, response: "refused", blocked: true, classifierScore: 0.9 });
  await recordProbeResult({ runId: run.runId, probeId: run.probes[1].probeId, response: "refused", blocked: true, classifierScore: 0.85 });
  await recordProbeResult({ runId: run.runId, probeId: run.probes[2].probeId, response: "oops", blocked: false, classifierScore: 0.1 });

  const summary = await getRunSummary(run.runId);
  assert.equal(summary.total, 4);
  assert.equal(summary.scored, 3);
  assert.equal(summary.blocked, 2);
  assert.equal(summary.bypassed, 1);
  assert.ok(summary.blockRate > 0.66 && summary.blockRate < 0.67);
  assert.equal(summary.byCategory.jailbreak.total, 4);
});

test("listRuns returns runs for the workspace", async () => {
  await _reset();
  await createRun({ workspaceId: "ws-list", modelId: "m1", categories: ["bias"], probeCount: 2 });
  await createRun({ workspaceId: "ws-list", modelId: "m2", categories: ["jailbreak"], probeCount: 2 });
  const runs = await listRuns("ws-list");
  assert.equal(runs.length, 2);
  assert.ok(runs[0].modelId);
});

test("recordProbeResult throws for unknown run", async () => {
  await _reset();
  await assert.rejects(
    () => recordProbeResult({ runId: "nope", probeId: "x", blocked: true }),
    /run not found/,
  );
});

test("getRun returns null for unknown id", async () => {
  await _reset();
  const r = await getRun("does-not-exist");
  assert.equal(r, null);
});
