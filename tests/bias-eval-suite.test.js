/**
 * Phase 72.3: Bias evaluation suite tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-bias-eval-"));
process.env.STORAGE_PATH = TMP;

const {
  createPersona,
  listPersonas,
  createEvalRun,
  recordResponse,
  getRunReport,
  listRuns,
  _reset,
} = await import("../lib/bias-eval-suite.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("createPersona stores a persona with demographics", async () => {
  await _reset();
  const p = await createPersona({
    workspaceId: "ws-b",
    name: "Alex",
    demographics: { gender: "nb", ageRange: "30-40", region: "global" },
  });
  assert.ok(p.personaId);
  assert.equal(p.name, "Alex");
  assert.equal(p.demographics.gender, "nb");
});

test("createPersona throws on missing name", async () => {
  await _reset();
  await assert.rejects(() => createPersona({ workspaceId: "ws-b" }), /name is required/);
});

test("listPersonas returns created personas", async () => {
  await _reset();
  await createPersona({ workspaceId: "ws-l", name: "P1", demographics: {} });
  await createPersona({ workspaceId: "ws-l", name: "P2", demographics: {} });
  const list = await listPersonas("ws-l");
  assert.equal(list.length, 2);
});

test("createEvalRun validates inputs", async () => {
  await _reset();
  await assert.rejects(() => createEvalRun({ modelId: "m", prompts: [], personas: ["x"] }), /prompts/);
  await assert.rejects(() => createEvalRun({ modelId: "m", prompts: ["p"], personas: [] }), /personas/);
  await assert.rejects(() => createEvalRun({ prompts: ["p"], personas: ["x"] }), /modelId is required/);
});

test("recordResponse and getRunReport compute disparity", async () => {
  await _reset();
  const p1 = await createPersona({ workspaceId: "ws-r", name: "One", demographics: {} });
  const p2 = await createPersona({ workspaceId: "ws-r", name: "Two", demographics: {} });
  const run = await createEvalRun({
    workspaceId: "ws-r",
    modelId: "m",
    prompts: ["Tell me about yourself", "What is math"],
    personas: [p1.personaId, p2.personaId],
  });
  // Same prompt, same response — should have high overlap (low disparity).
  await recordResponse({ runId: run.runId, personaId: p1.personaId, prompt: "What is math", response: "Math is the study of numbers" });
  await recordResponse({ runId: run.runId, personaId: p2.personaId, prompt: "What is math", response: "Math is the study of numbers" });
  // Very different responses — should flag.
  await recordResponse({ runId: run.runId, personaId: p1.personaId, prompt: "Tell me about yourself", response: "alpha beta gamma delta" });
  await recordResponse({ runId: run.runId, personaId: p2.personaId, prompt: "Tell me about yourself", response: "zeta eta theta iota" });

  const report = await getRunReport(run.runId);
  assert.equal(report.totalResponses, 4);
  const mathStat = report.promptStats.find((s) => s.prompt === "What is math");
  const selfStat = report.promptStats.find((s) => s.prompt === "Tell me about yourself");
  assert.ok(mathStat.avgOverlap > 0.9, "identical responses should have high overlap");
  assert.ok(mathStat.disparityScore < 0.1);
  assert.ok(selfStat.disparityScore > 0.5, "distinct tokens should produce high disparity");
  assert.ok(selfStat.flagged);
  assert.ok(report.personaStats[p1.personaId].count >= 2);
});

test("recordResponse throws for unknown run", async () => {
  await _reset();
  await assert.rejects(
    () => recordResponse({ runId: "nope", personaId: "x", prompt: "p", response: "r" }),
    /run not found/,
  );
});

test("listRuns returns runs for workspace", async () => {
  await _reset();
  const p = await createPersona({ workspaceId: "ws-lr", name: "P", demographics: {} });
  await createEvalRun({ workspaceId: "ws-lr", modelId: "m", prompts: ["p1"], personas: [p.personaId] });
  await createEvalRun({ workspaceId: "ws-lr", modelId: "m2", prompts: ["p2"], personas: [p.personaId] });
  const runs = await listRuns("ws-lr");
  assert.equal(runs.length, 2);
});

test("getRunReport returns null for unknown run", async () => {
  await _reset();
  assert.equal(await getRunReport("missing"), null);
});
