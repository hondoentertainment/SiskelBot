import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/karpathy-pipeline-test-" + Date.now();
  process.env.TRAINING_PIPELINE_DATA_DIR = process.env.STORAGE_PATH + "/training-pipelines";
});

await test("createTrainingPipeline stores a pipeline with canonical stages", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const p = await lib.createTrainingPipeline({
    name: "MyModel-v1",
    baseModel: "llama3-8b",
    stages: ["pretrain", "sft", "dpo"],
    workspaceId: "ws-kp",
  });
  assert.ok(p.id);
  assert.equal(p.name, "MyModel-v1");
  assert.equal(p.baseModel, "llama3-8b");
  assert.deepEqual(p.stages, ["pretrain", "sft", "dpo"]);
  assert.equal(p.currentStage, "pretrain");
  assert.equal(p.currentStageIndex, 0);
  assert.equal(p.status, "created");
  assert.ok(p.createdAt);
});

await test("createTrainingPipeline requires a name", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  await assert.rejects(() => lib.createTrainingPipeline({ name: "" }), /name required/);
});

await test("createTrainingPipeline defaults to pretrain -> sft -> dpo when no stages given", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const p = await lib.createTrainingPipeline({ name: "default-stages", workspaceId: "ws-kp" });
  assert.deepEqual(p.stages, ["pretrain", "sft", "dpo"]);
});

await test("createTrainingPipeline normalizes stage order to canonical", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const p = await lib.createTrainingPipeline({
    name: "jumbled",
    stages: ["dpo", "pretrain", "sft"],
    workspaceId: "ws-kp",
  });
  assert.deepEqual(p.stages, ["pretrain", "sft", "dpo"]);
});

await test("advanceStage progresses through stages and records history", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const p = await lib.createTrainingPipeline({
    name: "advance-test",
    stages: ["pretrain", "sft", "dpo"],
    workspaceId: "ws-adv",
  });
  const after1 = await lib.advanceStage(p.id, { outputModel: "base-v1", metrics: { loss: 2.3 } }, "ws-adv");
  assert.equal(after1.currentStage, "sft");
  assert.equal(after1.currentStageIndex, 1);
  assert.equal(after1.status, "running");
  assert.equal(after1.history.length, 1);
  assert.equal(after1.history[0].stage, "pretrain");
  assert.equal(after1.history[0].outputModel, "base-v1");
  assert.equal(after1.models.pretrain, "base-v1");

  const after2 = await lib.advanceStage(p.id, { outputModel: "sft-v1" }, "ws-adv");
  assert.equal(after2.currentStage, "dpo");

  const after3 = await lib.advanceStage(p.id, { outputModel: "dpo-v1" }, "ws-adv");
  assert.equal(after3.status, "completed");
  assert.equal(after3.history.length, 3);
  assert.equal(after3.models.dpo, "dpo-v1");
});

await test("advanceStage throws for unknown pipeline", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  await assert.rejects(() => lib.advanceStage("nonexistent", {}, "ws-adv"), /not found/i);
});

await test("listPipelines and getPipelineStatus round-trip", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const p = await lib.createTrainingPipeline({ name: "status-test", workspaceId: "ws-list" });
  const fetched = await lib.getPipelineStatus(p.id, "ws-list");
  assert.ok(fetched);
  assert.equal(fetched.id, p.id);
  const all = await lib.listPipelines("ws-list");
  assert.ok(all.length >= 1);
  assert.ok(all.find((x) => x.id === p.id));
});

await test("preparePretrainingData cleans, deduplicates and reports stats", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const docs = [
    { text: "The quick brown fox jumps over the lazy dog. Many times." },
    { text: "The quick brown fox jumps over the lazy dog. Many times." }, // duplicate
    { text: "Short" }, // too short
    { text: "" }, // empty
    { text: "Another useful document about training language models end to end." },
  ];
  const out = await lib.preparePretrainingData(docs, { minChars: 20 });
  assert.equal(out.stats.inputDocs, 5);
  assert.equal(out.stats.keptDocs, 2);
  assert.equal(out.stats.skippedDup, 1);
  assert.equal(out.stats.skippedShort, 1);
  assert.equal(out.stats.skippedEmpty, 1);
  assert.ok(out.tokens.length > 0);
  assert.ok(out.stats.approxBpeTokens > 0);
});

await test("prepareSFTData extracts (prompt, response) pairs from conversations", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const conversations = [
    {
      id: "c1",
      rating: 5,
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello, how can I help?", rating: 5 },
        { role: "user", content: "Explain DPO." },
        { role: "assistant", content: "DPO is direct preference optimization.", rating: 5 },
      ],
    },
    {
      id: "c2",
      rating: 1, // filtered out by minRating
      messages: [
        { role: "user", content: "Hey" },
        { role: "assistant", content: "sup", rating: 1 },
      ],
    },
  ];
  const out = await lib.prepareSFTData(conversations, { minRating: 3, minResponseChars: 5 });
  assert.equal(out.pairs.length, 2);
  assert.equal(out.pairs[0].prompt, "Hi");
  assert.ok(out.pairs[0].response.startsWith("Hello"));
  assert.ok(out.jsonl.split("\n").length === 2);
  assert.ok(out.stats.skippedLowRating >= 1);
});

await test("prepareSFTData applies instruction template when provided", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const convs = [{
    id: "t1",
    messages: [
      { role: "user", content: "2+2" },
      { role: "assistant", content: "4 is the answer" },
    ],
  }];
  const out = await lib.prepareSFTData(convs, {
    template: "### Instruction:\n{prompt}\n### Response:\n{response}",
  });
  assert.equal(out.pairs.length, 1);
  assert.ok(out.pairs[0].formatted.includes("### Instruction:"));
  assert.ok(out.pairs[0].formatted.includes("### Response:"));
  assert.ok(out.pairs[0].formatted.includes("2+2"));
});

await test("preparePreferenceData builds triples from explicit chosen/rejected", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const convs = [{
    id: "p1",
    preferencePairs: [
      { prompt: "Write a poem", chosen: "Roses are red, violets are blue.", rejected: "poem" },
    ],
  }];
  const out = await lib.preparePreferenceData(convs, { minResponseChars: 3 });
  assert.equal(out.triples.length, 1);
  assert.equal(out.triples[0].source, "explicit");
  assert.equal(out.triples[0].chosen, "Roses are red, violets are blue.");
  assert.ok(out.jsonl.includes("chosen"));
});

await test("preparePreferenceData builds triples from sibling ratings", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const convs = [{
    id: "p2",
    messages: [
      { role: "user", content: "Describe a cat" },
      { role: "assistant", content: "A cat is a small furry mammal known for purring.", rating: 5 },
      { role: "assistant", content: "meow", rating: 1 },
    ],
  }];
  const out = await lib.preparePreferenceData(convs, { minRatingGap: 2, minResponseChars: 3 });
  assert.equal(out.triples.length, 1);
  assert.equal(out.triples[0].source, "siblings");
  assert.ok(out.triples[0].chosen.includes("furry"));
  assert.equal(out.triples[0].rejected, "meow");
});

await test("preparePreferenceData respects minRatingGap", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const convs = [{
    id: "p3",
    messages: [
      { role: "user", content: "Explain" },
      { role: "assistant", content: "answer one variant", rating: 4 },
      { role: "assistant", content: "answer two variant", rating: 3 },
    ],
  }];
  const out = await lib.preparePreferenceData(convs, { minRatingGap: 3 });
  assert.equal(out.triples.length, 0);
  assert.ok(out.stats.skippedGap >= 1);
});

await test("evaluatePretraining computes perplexity from labeled losses", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const testSet = [
    { prompt: "a", loss: 1.0, correct: true },
    { prompt: "b", loss: 2.0, correct: false },
    { prompt: "c", loss: 1.5, correct: true },
  ];
  const res = await lib.evaluatePretraining(null, testSet);
  assert.ok(res.loss > 1 && res.loss < 2);
  assert.ok(res.perplexity > Math.E);
  assert.ok(res.accuracy > 0.5 && res.accuracy < 1);
  assert.equal(res.sampleCount, 3);
});

await test("evaluatePretraining uses model.scoreBatch when provided", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const model = {
    scoreBatch: async (prompts) => prompts.map(() => ({ logLoss: 0.5, correct: true })),
  };
  const res = await lib.evaluatePretraining(model, [{ prompt: "x" }, { prompt: "y" }]);
  assert.equal(res.loss, 0.5);
  assert.equal(res.accuracy, 1);
  assert.ok(Math.abs(res.perplexity - Math.exp(0.5)) < 1e-6);
});

await test("evaluateSFT averages labeled helpfulness, coherence, toxicity", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const testSet = [
    { helpfulness: 0.8, coherence: 0.9, toxic: false },
    { helpfulness: 0.6, coherence: 0.7, toxic: false },
    { helpfulness: 0.4, coherence: 0.5, toxic: true },
  ];
  const res = await lib.evaluateSFT(null, testSet);
  assert.ok(Math.abs(res.avgHelpfulness - 0.6) < 1e-6);
  assert.ok(Math.abs(res.coherence - 0.7) < 1e-6);
  assert.ok(Math.abs(res.toxicity - (1 / 3)) < 1e-6);
  assert.equal(res.sampleCount, 3);
});

await test("evaluatePreferenceAlignment scores correct vs. incorrect preferences", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const pairs = [
    { prompt: "p", chosen: "good", rejected: "bad", modelPreferred: "chosen" },
    { prompt: "p", chosen: "good", rejected: "bad", modelPreferred: "rejected" },
    { prompt: "p", chosen: "good", rejected: "bad", modelPreferred: "chosen" },
  ];
  const res = await lib.evaluatePreferenceAlignment(null, pairs);
  assert.ok(Math.abs(res.preferenceAccuracy - (2 / 3)) < 1e-6);
});

await test("evaluatePreferenceAlignment uses logProb when provided", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const model = {
    logProb: async (prompt, response) => (response === "good" ? -0.1 : -2.5),
  };
  const pairs = [
    { prompt: "p1", chosen: "good", rejected: "bad" },
    { prompt: "p2", chosen: "good", rejected: "bad" },
  ];
  const res = await lib.evaluatePreferenceAlignment(model, pairs);
  assert.equal(res.preferenceAccuracy, 1);
});

await test("computeLossGradient detects a decreasing trend", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const diag = lib.computeLossGradient([4, 3.5, 3.2, 3.0, 2.8, 2.6]);
  assert.equal(diag.trend, "decreasing");
  assert.ok(diag.avgDelta < 0);
  assert.equal(diag.unstable, false);
});

await test("computeLossGradient flags spikes as unstable", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const diag = lib.computeLossGradient([2.0, 2.0, 2.0, 8.0, 2.0, 2.0, 9.0, 2.0]);
  assert.ok(diag.maxSpike > 5);
  assert.ok(diag.spikeIndices.length >= 1);
});

await test("computeLossGradient is safe on empty or tiny input", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  assert.equal(lib.computeLossGradient([]).trend, "flat");
  assert.equal(lib.computeLossGradient([1]).trend, "flat");
});

await test("recommendLearningRate follows Karpathy's 10x rule", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const pre = lib.recommendLearningRate({ stage: "pretrain", params: 1e6 }, 100_000);
  const sft = lib.recommendLearningRate({ stage: "sft", params: 1e6 }, 100_000);
  const dpo = lib.recommendLearningRate({ stage: "dpo", params: 1e6 }, 100_000);
  assert.ok(pre.learningRate > sft.learningRate);
  assert.ok(sft.learningRate > dpo.learningRate);
  // SFT ~ 10x smaller than pretraining
  assert.ok(pre.learningRate / sft.learningRate >= 5);
  assert.ok(sft.learningRate / dpo.learningRate >= 5);
});

await test("recommendLearningRate scales down with larger parameter count", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const small = lib.recommendLearningRate({ stage: "sft", params: 1e6 }, 1_000_000);
  const big = lib.recommendLearningRate({ stage: "sft", params: 1e9 }, 1_000_000);
  assert.ok(small.learningRate > big.learningRate);
});

await test("recommendLearningRate reduces LR for small datasets", async () => {
  const lib = await import("../lib/karpathy-pipeline.js");
  const tiny = lib.recommendLearningRate({ stage: "sft", params: 1e6 }, 500);
  assert.equal(tiny.adjustment, "reduced_for_small_dataset");
});

await test("STAGES constants match Karpathy's 3-stage pipeline", async () => {
  const { STAGES } = await import("../lib/karpathy-pipeline.js");
  assert.equal(STAGES.PRETRAIN, "pretrain");
  assert.equal(STAGES.SFT, "sft");
  assert.equal(STAGES.RLHF, "rlhf");
  assert.equal(STAGES.DPO, "dpo");
  assert.equal(STAGES.REWARD_MODELING, "reward_modeling");
});
