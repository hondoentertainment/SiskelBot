/**
 * Tests for lib/continuous-learning.js and lib/continuous-learning-worker.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Route storage to an isolated temp dir before importing the module.
process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "siskel-cl-"));

const {
  recordInteraction,
  recordSignal,
  scoreInteraction,
  curateTrainingData,
  detectDrift,
  proposeTrainingRun,
  getLearningStats,
  listTrainingCandidates,
  computeInteractionScore,
  computeQualityRung,
  detectRegeneration,
  detectAcceptance,
  detectCopy,
  QUALITY_RUNGS,
  __resetWorkspaceForTests,
} = await import("../lib/continuous-learning.js");

const {
  runCurationCycle,
  startCurationWorker,
  stopCurationWorker,
  isCurationWorkerRunning,
} = await import("../lib/continuous-learning-worker.js");

function uniqueWorkspace(name) {
  return `cl-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- recordInteraction ---

test("recordInteraction stores interaction and returns id+createdAt", async () => {
  const ws = uniqueWorkspace("record");
  const r = await recordInteraction({
    workspaceId: ws,
    prompt: "How do I sort a list in Python?",
    response: "Use sorted(my_list).",
    model: "gpt-4o",
  });
  assert.ok(r.id);
  assert.ok(r.createdAt);
});

test("recordInteraction throws when prompt missing", async () => {
  await assert.rejects(
    () => recordInteraction({ workspaceId: "x", prompt: "", response: "ok" }),
    /required/
  );
});

test("recordInteraction throws when response missing", async () => {
  await assert.rejects(
    () => recordInteraction({ workspaceId: "x", prompt: "ok", response: "" }),
    /required/
  );
});

// --- scoring ---

test("scoreInteraction returns 0 for unknown id", async () => {
  const out = await scoreInteraction("nonexistent-id", uniqueWorkspace("none"));
  assert.equal(out.score, 0);
  assert.equal(out.rung, "R0");
});

test("computeInteractionScore rewards positive rating", () => {
  const it = { id: "a", prompt: "hi", response: "hello there friend how are you" };
  const neutral = computeInteractionScore(it, []);
  const pos = computeInteractionScore(it, [{ type: "rating", value: 1 }]);
  assert.ok(pos.score > neutral.score);
  assert.equal(pos.rung, "R2");
});

test("computeInteractionScore penalizes regeneration", () => {
  const target = { id: "a", prompt: "hi", response: "answer one", conversationId: "c1", createdAt: "2024-01-01T00:00:00Z" };
  const corpus = [
    target,
    { id: "b", prompt: "hi", response: "answer two", conversationId: "c1", createdAt: "2024-01-01T00:00:30Z" },
  ];
  const s = computeInteractionScore(target, [], corpus);
  assert.ok(s.signals.regenerated);
  assert.ok(s.score < 0.3);
});

test("computeInteractionScore rewards copy event", () => {
  const it = { id: "a", prompt: "test prompt", response: "test response" };
  const plain = computeInteractionScore(it, []);
  const copied = computeInteractionScore(it, [{ type: "copy" }]);
  assert.ok(copied.score > plain.score);
  assert.equal(copied.rung, "R3");
});

test("computeInteractionScore returns R4 when shared", () => {
  const it = { id: "a", prompt: "test", response: "test" };
  const shared = computeInteractionScore(it, [{ type: "share" }]);
  assert.equal(shared.rung, "R4");
});

// --- rungs ---

test("QUALITY_RUNGS has all 5 levels with expected weights", () => {
  assert.equal(QUALITY_RUNGS.R0.weight, 0);
  assert.equal(QUALITY_RUNGS.R4.weight, 1.0);
  assert.ok(QUALITY_RUNGS.R2.weight > QUALITY_RUNGS.R1.weight);
});

test("computeQualityRung picks highest rung reached", () => {
  assert.equal(computeQualityRung({}), "R0");
  assert.equal(computeQualityRung({ accepted: true }), "R1");
  assert.equal(computeQualityRung({ explicitRating: 1 }), "R2");
  assert.equal(computeQualityRung({ copied: true }), "R3");
  assert.equal(computeQualityRung({ shared: true }), "R4");
  // Multiple signals → highest.
  assert.equal(computeQualityRung({ accepted: true, shared: true, copied: true }), "R4");
});

// --- detection helpers ---

test("detectRegeneration finds duplicate prompt in short window", () => {
  const target = { id: "a", prompt: "same q", createdAt: "2024-01-01T00:00:00Z", conversationId: "c1" };
  const corpus = [
    target,
    { id: "b", prompt: "same q", createdAt: "2024-01-01T00:00:30Z", conversationId: "c1" },
  ];
  assert.equal(detectRegeneration(corpus, target), true);
});

test("detectRegeneration ignores different prompt", () => {
  const target = { id: "a", prompt: "first", createdAt: "2024-01-01T00:00:00Z", conversationId: "c1" };
  const corpus = [
    target,
    { id: "b", prompt: "second", createdAt: "2024-01-01T00:00:30Z", conversationId: "c1" },
  ];
  assert.equal(detectRegeneration(corpus, target), false);
});

test("detectAcceptance detects continued conversation", () => {
  const target = { id: "a", prompt: "q1", createdAt: "2024-01-01T00:00:00Z", conversationId: "c1" };
  const corpus = [
    target,
    { id: "b", prompt: "q2", createdAt: "2024-01-01T00:05:00Z", conversationId: "c1" },
  ];
  assert.equal(detectAcceptance(corpus, target), true);
});

test("detectCopy reads metadata flag", () => {
  assert.equal(detectCopy({ metadata: { copied: true } }), true);
  assert.equal(detectCopy({ metadata: {} }), false);
  assert.equal(detectCopy(null), false);
});

// --- curation ---

test("curateTrainingData selects high-quality interactions only", async () => {
  const ws = uniqueWorkspace("curate");
  __resetWorkspaceForTests(ws);
  const good = await recordInteraction({
    workspaceId: ws,
    prompt: "Explain closures in JS",
    response: "A closure is a function that captures variables from its lexical scope to retain state between calls.",
    model: "gpt-4o",
  });
  await recordInteraction({
    workspaceId: ws,
    prompt: "foo",
    response: "bar",
    model: "gpt-4o",
  });
  await recordSignal(ws, good.id, { type: "share" });
  await recordSignal(ws, good.id, { type: "rating", value: 1 });

  const result = await curateTrainingData(ws, { minScore: 0.5 });
  assert.ok(result.count >= 1);
  assert.ok(result.candidates.some((c) => c.id === good.id));
  assert.ok(result.jsonl.includes("closures"));
});

test("curateTrainingData deduplicates by prompt fingerprint", async () => {
  const ws = uniqueWorkspace("dedup");
  __resetWorkspaceForTests(ws);
  for (let i = 0; i < 3; i++) {
    const r = await recordInteraction({
      workspaceId: ws,
      prompt: "duplicate prompt",
      response: `variant ${i} of a response with enough content to score well`,
      model: "m",
    });
    await recordSignal(ws, r.id, { type: "share" });
  }
  const result = await curateTrainingData(ws, { minScore: 0.4 });
  assert.equal(result.count, 1);
});

test("curateTrainingData respects maxExamples", async () => {
  const ws = uniqueWorkspace("max");
  __resetWorkspaceForTests(ws);
  for (let i = 0; i < 5; i++) {
    const r = await recordInteraction({
      workspaceId: ws,
      prompt: `prompt ${i}`,
      response: `response content number ${i} has enough length`,
      model: "m",
    });
    await recordSignal(ws, r.id, { type: "share" });
  }
  const result = await curateTrainingData(ws, { minScore: 0.4, maxExamples: 2 });
  assert.equal(result.count, 2);
});

// --- drift detection ---

test("detectDrift returns insufficient_data when corpus is small", async () => {
  const ws = uniqueWorkspace("drift-small");
  __resetWorkspaceForTests(ws);
  await recordInteraction({ workspaceId: ws, prompt: "p", response: "r" });
  const d = await detectDrift(ws);
  assert.equal(d.trend, "insufficient_data");
  assert.equal(d.driftDetected, false);
});

test("detectDrift reports declining trend", async () => {
  const ws = uniqueWorkspace("drift-decline");
  __resetWorkspaceForTests(ws);
  // Previous window: 50 high-quality (shared)
  for (let i = 0; i < 50; i++) {
    const r = await recordInteraction({
      workspaceId: ws,
      prompt: `good prompt ${i}`,
      response: `good quality long response number ${i} with plenty of detail`,
      model: "m",
    });
    await recordSignal(ws, r.id, { type: "share" });
    await recordSignal(ws, r.id, { type: "rating", value: 1 });
  }
  // Recent window: 50 low-quality (regenerated)
  for (let i = 0; i < 50; i++) {
    const r = await recordInteraction({
      workspaceId: ws,
      prompt: `bad prompt ${i}`,
      response: `x`,
      model: "m",
    });
    await recordSignal(ws, r.id, { type: "regenerate" });
    await recordSignal(ws, r.id, { type: "rating", value: -1 });
  }
  const d = await detectDrift(ws);
  assert.equal(d.trend, "declining");
  assert.equal(d.driftDetected, true);
  assert.ok(d.recommendations.length > 0);
});

// --- proposeTrainingRun ---

test("proposeTrainingRun refuses when too few candidates", async () => {
  const ws = uniqueWorkspace("propose-few");
  __resetWorkspaceForTests(ws);
  const p = await proposeTrainingRun(ws);
  assert.equal(p.shouldTrain, false);
  assert.match(p.reason, /high-quality candidates/);
});

test("proposeTrainingRun recommends training when threshold met", async () => {
  const ws = uniqueWorkspace("propose-ok");
  __resetWorkspaceForTests(ws);
  // Override threshold for this test.
  const orig = process.env.CL_TRAIN_MIN_CANDIDATES;
  process.env.CL_TRAIN_MIN_CANDIDATES = "5";
  try {
    // Re-import to pick up new env? The constant is read at module load.
    // Instead, create enough candidates to satisfy default.
    for (let i = 0; i < 110; i++) {
      const r = await recordInteraction({
        workspaceId: ws,
        prompt: `unique prompt ${i} about topic ${i}`,
        response: `a well formed response with quality content here ${i}`,
        model: "m",
      });
      await recordSignal(ws, r.id, { type: "share" });
    }
    const p = await proposeTrainingRun(ws);
    assert.equal(p.shouldTrain, true);
    assert.ok(p.dataCount >= 100);
  } finally {
    if (orig === undefined) delete process.env.CL_TRAIN_MIN_CANDIDATES;
    else process.env.CL_TRAIN_MIN_CANDIDATES = orig;
  }
});

// --- stats & listing ---

test("getLearningStats returns aggregate view", async () => {
  const ws = uniqueWorkspace("stats");
  __resetWorkspaceForTests(ws);
  const r = await recordInteraction({
    workspaceId: ws,
    prompt: "test question",
    response: "a thorough answer with good content to score well",
    model: "m",
  });
  await recordSignal(ws, r.id, { type: "share" });
  const stats = await getLearningStats(ws);
  assert.equal(stats.totalInteractions, 1);
  assert.ok(stats.qualityAvg > 0);
  assert.equal(stats.rungCounts.R4, 1);
});

test("listTrainingCandidates returns sorted candidates", async () => {
  const ws = uniqueWorkspace("list");
  __resetWorkspaceForTests(ws);
  for (let i = 0; i < 3; i++) {
    const r = await recordInteraction({
      workspaceId: ws,
      prompt: `question about topic ${i}`,
      response: `good quality answer number ${i} with enough detail to score`,
      model: "m",
    });
    await recordSignal(ws, r.id, { type: "share" });
  }
  const result = await listTrainingCandidates(ws, { limit: 10 });
  assert.ok(result.candidates.length >= 1);
  // Sorted by score desc.
  for (let i = 1; i < result.candidates.length; i++) {
    assert.ok(result.candidates[i - 1].score >= result.candidates[i].score);
  }
});

// --- signal recording ---

test("recordSignal rejects unknown signal types", async () => {
  await assert.rejects(
    () => recordSignal("ws", "id", { type: "unknown" }),
    /signal.type must be one of/
  );
});

test("recordSignal requires interactionId", async () => {
  await assert.rejects(
    () => recordSignal("ws", "", { type: "copy" }),
    /interactionId/
  );
});

// --- worker lifecycle ---

test("startCurationWorker / stopCurationWorker lifecycle", () => {
  assert.equal(isCurationWorkerRunning(), false);
  const started = startCurationWorker(60_000);
  assert.equal(started.started, true);
  assert.equal(isCurationWorkerRunning(), true);
  const stopped = stopCurationWorker();
  assert.equal(stopped.stopped, true);
  assert.equal(isCurationWorkerRunning(), false);
});

test("startCurationWorker is idempotent", () => {
  startCurationWorker(60_000);
  startCurationWorker(60_000); // should replace, not throw
  assert.equal(isCurationWorkerRunning(), true);
  stopCurationWorker();
});

test("runCurationCycle promotes and rejects interactions", async () => {
  const ws = uniqueWorkspace("worker");
  __resetWorkspaceForTests(ws);
  const good = await recordInteraction({
    workspaceId: ws,
    prompt: "good prompt",
    response: "a well-formed answer with enough useful content in it",
    model: "m",
  });
  await recordSignal(ws, good.id, { type: "share" });

  const bad = await recordInteraction({
    workspaceId: ws,
    prompt: "bad prompt",
    response: "x",
    model: "m",
  });
  await recordSignal(ws, bad.id, { type: "regenerate" });
  await recordSignal(ws, bad.id, { type: "rating", value: -1 });

  const result = await runCurationCycle(ws);
  assert.equal(result.workspaceId, ws);
  assert.ok(result.curated >= 1);
  assert.ok(result.proposal);
});
