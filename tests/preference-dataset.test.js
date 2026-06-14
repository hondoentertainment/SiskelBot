/**
 * Tests for lib/preference-dataset.js — RLHF/DPO preference dataset builder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempDir = mkdtempSync(join(tmpdir(), "pref-dataset-test-"));
process.env.STORAGE_PATH = tempDir;

// Import AFTER setting STORAGE_PATH so all paths resolve inside tempDir.
const {
  createPreferenceDataset,
  listPreferenceDatasets,
  getPreferenceDataset,
  deletePreferenceDataset,
  addPreferencePair,
  removePreferencePair,
  extractFromFeedback,
  extractFromConversationTree,
  createComparison,
  submitRanking,
  validatePreferenceDataset,
  getDatasetStats,
  toDPOFormat,
  toRewardModelFormat,
  toOpenAIDistillation,
  detectLengthBias,
} = await import("../lib/preference-dataset.js");

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const WS = "pref-test";

// ─── CRUD ───────────────────────────────────────────────────────────────────

test("createPreferenceDataset creates a dataset with defaults", async () => {
  const ds = await createPreferenceDataset("Dataset A", WS, {});
  assert.ok(ds.id);
  assert.equal(ds.name, "Dataset A");
  assert.equal(ds.workspaceId, WS);
  assert.equal(ds.config.sourceType, "manual");
  assert.equal(ds.config.format, "dpo");
  assert.equal(ds.pairs.length, 0);
});

test("createPreferenceDataset rejects missing name", async () => {
  const res = await createPreferenceDataset("", WS, {});
  assert.equal(res.code, "INVALID_INPUT");
});

test("createPreferenceDataset rejects invalid sourceType", async () => {
  const res = await createPreferenceDataset("bad", WS, { sourceType: "bogus" });
  assert.equal(res.code, "INVALID_INPUT");
});

test("createPreferenceDataset rejects invalid format", async () => {
  const res = await createPreferenceDataset("bad", WS, { format: "csv" });
  assert.equal(res.code, "INVALID_INPUT");
});

test("listPreferenceDatasets returns created datasets", async () => {
  await createPreferenceDataset("List-1", WS, {});
  await createPreferenceDataset("List-2", WS, {});
  const list = await listPreferenceDatasets(WS);
  assert.ok(list.length >= 2);
  assert.ok(list.find((d) => d.name === "List-1"));
  assert.ok(list.find((d) => d.name === "List-2"));
});

test("getPreferenceDataset loads by id without workspace", async () => {
  const ds = await createPreferenceDataset("Loadable", WS, {});
  const loaded = await getPreferenceDataset(ds.id);
  assert.equal(loaded.id, ds.id);
  assert.equal(loaded.name, "Loadable");
});

test("getPreferenceDataset returns NOT_FOUND for unknown id", async () => {
  const res = await getPreferenceDataset("does-not-exist-id");
  assert.equal(res.code, "NOT_FOUND");
});

test("deletePreferenceDataset removes the dataset", async () => {
  const ds = await createPreferenceDataset("Deletable", WS, {});
  const res = await deletePreferenceDataset(ds.id);
  assert.equal(res.deleted, true);
  const afterList = await listPreferenceDatasets(WS);
  assert.equal(afterList.find((d) => d.id === ds.id), undefined);
  const afterGet = await getPreferenceDataset(ds.id);
  assert.equal(afterGet.code, "NOT_FOUND");
});

// ─── pairs ──────────────────────────────────────────────────────────────────

test("addPreferencePair adds a pair and increments count", async () => {
  const ds = await createPreferenceDataset("PairsDS", WS, {});
  const res = await addPreferencePair(ds.id, {
    prompt: "What is 2+2?",
    chosen: "4",
    rejected: "five",
  });
  assert.ok(res.pairId);
  assert.equal(res.pairCount, 1);

  const loaded = await getPreferenceDataset(ds.id);
  assert.equal(loaded.pairs.length, 1);
  assert.equal(loaded.pairs[0].chosen, "4");
  assert.equal(loaded.pairs[0].rejected, "five");
});

test("addPreferencePair rejects missing fields", async () => {
  const ds = await createPreferenceDataset("PairsDS2", WS, {});
  const r1 = await addPreferencePair(ds.id, { prompt: "x", chosen: "a" });
  assert.equal(r1.code, "INVALID_INPUT");
  const r2 = await addPreferencePair(ds.id, { chosen: "a", rejected: "b" });
  assert.equal(r2.code, "INVALID_INPUT");
});

test("addPreferencePair deduplicates identical triples", async () => {
  const ds = await createPreferenceDataset("DedupeDS", WS, {});
  const pair = { prompt: "hi", chosen: "hello", rejected: "hey" };
  const r1 = await addPreferencePair(ds.id, pair);
  assert.equal(r1.pairCount, 1);
  const r2 = await addPreferencePair(ds.id, pair);
  assert.equal(r2.code, "DUPLICATE");
});

test("removePreferencePair removes the pair", async () => {
  const ds = await createPreferenceDataset("RmDS", WS, {});
  const r1 = await addPreferencePair(ds.id, {
    prompt: "a",
    chosen: "b",
    rejected: "c",
  });
  const rm = await removePreferencePair(ds.id, r1.pairId);
  assert.equal(rm.removed, true);
  assert.equal(rm.pairCount, 0);
});

test("removePreferencePair returns NOT_FOUND for unknown pair", async () => {
  const ds = await createPreferenceDataset("RmDS2", WS, {});
  const rm = await removePreferencePair(ds.id, "nonexistent-id");
  assert.equal(rm.code, "NOT_FOUND");
});

// ─── extraction from feedback ───────────────────────────────────────────────

test("extractFromFeedback pairs high-rated and low-rated responses for same prompt", async () => {
  const feedbackItems = [
    { prompt: "What is 2+2?", response: "The answer is 4.", rating: 5, model: "m1", id: "f1" },
    { prompt: "What is 2+2?", response: "I don't know.", rating: 2, model: "m2", id: "f2" },
    { prompt: "What is 2+2?", response: "Five.", rating: 1, model: "m3", id: "f3" },
    // Prompt with only 1 feedback — should be ignored
    { prompt: "Solo", response: "only", rating: 5, id: "f4" },
  ];
  const pairs = await extractFromFeedback(WS, { feedbackItems, minRatingDiff: 2 });
  assert.equal(pairs.length, 2);
  for (const p of pairs) {
    assert.equal(p.prompt, "What is 2+2?");
    assert.equal(p.chosen, "The answer is 4.");
    assert.ok(p.ratingDiff >= 2);
    assert.equal(p.source, "feedback_ratings");
  }
});

test("extractFromFeedback respects minRatingDiff threshold", async () => {
  const feedbackItems = [
    { prompt: "q", response: "a", rating: 5 },
    { prompt: "q", response: "b", rating: 4 },
  ];
  // diff = 1, threshold = 2 → no pairs
  const none = await extractFromFeedback(WS, { feedbackItems, minRatingDiff: 2 });
  assert.equal(none.length, 0);

  // threshold = 1 → 1 pair
  const one = await extractFromFeedback(WS, { feedbackItems, minRatingDiff: 1 });
  assert.equal(one.length, 1);
});

test("extractFromFeedback skips same-text pairs", async () => {
  const feedbackItems = [
    { prompt: "q", response: "same", rating: 5 },
    { prompt: "q", response: "same", rating: 1 },
  ];
  const pairs = await extractFromFeedback(WS, { feedbackItems, minRatingDiff: 1 });
  assert.equal(pairs.length, 0);
});

test("extractFromFeedback respects maxPairs", async () => {
  const feedbackItems = [
    { prompt: "q", response: "a", rating: 5 },
    { prompt: "q", response: "b", rating: 1 },
    { prompt: "q", response: "c", rating: 2 },
    { prompt: "q", response: "d", rating: 3 },
  ];
  const pairs = await extractFromFeedback(WS, {
    feedbackItems,
    minRatingDiff: 1,
    maxPairs: 2,
  });
  assert.equal(pairs.length, 2);
});

// ─── extraction from conversation tree ─────────────────────────────────────

test("extractFromConversationTree uses alternatives as rejected", async () => {
  const conversations = [
    {
      id: "c1",
      messages: [
        { role: "user", content: "Explain gravity" },
        {
          role: "assistant",
          content: "Gravity is the curvature of spacetime.",
          alternatives: [
            "Gravity is a force between masses.",
            { content: "Things fall because they fall." },
          ],
        },
      ],
    },
  ];
  const pairs = await extractFromConversationTree(WS, { conversations });
  assert.equal(pairs.length, 2);
  for (const p of pairs) {
    assert.equal(p.prompt, "Explain gravity");
    assert.equal(p.chosen, "Gravity is the curvature of spacetime.");
    assert.equal(p.source, "conversation_tree");
  }
});

test("extractFromConversationTree skips messages without alternatives", async () => {
  const conversations = [
    {
      id: "c2",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    },
  ];
  const pairs = await extractFromConversationTree(WS, { conversations });
  assert.equal(pairs.length, 0);
});

// ─── pairwise comparisons ──────────────────────────────────────────────────

test("createComparison returns a pending comparison", async () => {
  const cmp = await createComparison(
    "Best way to sort?",
    [
      { id: "a", content: "Use quicksort." },
      { id: "b", content: "Use bubblesort." },
      { id: "c", content: "Use Array.prototype.sort." },
    ],
    WS,
  );
  assert.ok(cmp.comparisonId);
  assert.equal(cmp.awaitingRanking, true);
  assert.equal(cmp.responses.length, 3);
});

test("createComparison rejects <2 responses", async () => {
  const r = await createComparison("q", [{ content: "only" }], WS);
  assert.equal(r.code, "INVALID_INPUT");
});

test("submitRanking converts ranking into all-pairs preferences", async () => {
  const cmp = await createComparison(
    "q",
    [
      { id: "a", content: "best" },
      { id: "b", content: "middle" },
      { id: "c", content: "worst" },
    ],
    WS,
  );
  const result = await submitRanking(cmp.comparisonId, ["a", "b", "c"], "user-1", WS);
  // ranking [a,b,c] → (a>b), (a>c), (b>c) = 3 pairs
  assert.equal(result.pairCount, 3);
  assert.equal(result.pairs[0].chosen, "best");
  assert.equal(result.pairs[0].rejected, "middle");
  assert.equal(result.pairs[1].chosen, "best");
  assert.equal(result.pairs[1].rejected, "worst");
  assert.equal(result.pairs[2].chosen, "middle");
  assert.equal(result.pairs[2].rejected, "worst");
  for (const p of result.pairs) {
    assert.equal(p.source, "pairwise_comparison");
    assert.equal(p.metadata.userId, "user-1");
  }
});

test("submitRanking handles 2-way comparison", async () => {
  const cmp = await createComparison(
    "q2",
    [
      { id: "x", content: "good" },
      { id: "y", content: "bad" },
    ],
    WS,
  );
  const result = await submitRanking(cmp.comparisonId, ["x", "y"], null, WS);
  assert.equal(result.pairCount, 1);
  assert.equal(result.pairs[0].chosen, "good");
  assert.equal(result.pairs[0].rejected, "bad");
});

test("submitRanking rejects unknown response id", async () => {
  const cmp = await createComparison(
    "q3",
    [
      { id: "x", content: "a" },
      { id: "y", content: "b" },
    ],
    WS,
  );
  const r = await submitRanking(cmp.comparisonId, ["x", "z"], null, WS);
  assert.equal(r.code, "INVALID_INPUT");
});

test("submitRanking returns NOT_FOUND for unknown comparison", async () => {
  const r = await submitRanking("does-not-exist", ["a", "b"], null, WS);
  assert.equal(r.code, "NOT_FOUND");
});

// ─── format conversions ────────────────────────────────────────────────────

test("toDPOFormat emits {prompt, chosen, rejected}", () => {
  const pairs = [
    { prompt: "p1", chosen: "c1", rejected: "r1" },
    { prompt: "p2", chosen: "c2", rejected: "r2", metadata: { ignore: true } },
  ];
  const out = toDPOFormat(pairs);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { prompt: "p1", chosen: "c1", rejected: "r1" });
  assert.deepEqual(out[1], { prompt: "p2", chosen: "c2", rejected: "r2" });
});

test("toRewardModelFormat includes scores and confidence", () => {
  const pairs = [
    { prompt: "p1", chosen: "c1", rejected: "r1", metadata: { ratingDiff: 4 } },
    { prompt: "p2", chosen: "c2", rejected: "r2", confidence: 0.8 },
  ];
  const out = toRewardModelFormat(pairs);
  assert.equal(out.length, 2);
  assert.equal(out[0].chosen_score, 1);
  assert.equal(out[0].rejected_score, 0);
  assert.equal(out[0].confidence, 1); // 4/4 = 1
  assert.equal(out[1].confidence, 0.8);
});

test("toOpenAIDistillation emits OpenAI DPO format", () => {
  const pairs = [{ prompt: "p", chosen: "c", rejected: "r" }];
  const out = toOpenAIDistillation(pairs);
  assert.equal(out.length, 1);
  assert.equal(out[0].input.messages[0].role, "user");
  assert.equal(out[0].input.messages[0].content, "p");
  assert.equal(out[0].preferred_output[0].content, "c");
  assert.equal(out[0].non_preferred_output[0].content, "r");
});

// ─── validation ────────────────────────────────────────────────────────────

test("validatePreferenceDataset flags small datasets", async () => {
  const ds = await createPreferenceDataset("TinyDS", WS, {});
  await addPreferencePair(ds.id, { prompt: "q", chosen: "a", rejected: "b" });
  const v = await validatePreferenceDataset(ds.id);
  const issue = v.issues.find((i) => i.type === "INSUFFICIENT_EXAMPLES");
  assert.ok(issue);
  assert.equal(issue.severity, "error"); // total < 10
  assert.equal(v.valid, false);
});

test("validatePreferenceDataset detects trivial (chosen == rejected) preferences", async () => {
  const ds = await createPreferenceDataset("TrivialDS", WS, {});
  // Inject directly to bypass dedup on identical triples
  const loaded = await getPreferenceDataset(ds.id);
  loaded.pairs.push({
    id: "trivial-1",
    prompt: "q",
    chosen: "same",
    rejected: "same",
    source: "manual",
    metadata: {},
    createdAt: new Date().toISOString(),
  });
  const { writeJsonPath } = await import("../lib/json-path-store.js");
  const { join } = await import("path");
  const filePath = join(tempDir, "preference-datasets", WS, `${loaded.id}.json`);
  await writeJsonPath(filePath, loaded);

  const v = await validatePreferenceDataset(ds.id);
  const issue = v.issues.find((i) => i.type === "TRIVIAL_PREFERENCES");
  assert.ok(issue);
  assert.equal(issue.severity, "error");
});

test("validatePreferenceDataset computes a score", async () => {
  const ds = await createPreferenceDataset("ScoreDS", WS, {});
  await addPreferencePair(ds.id, { prompt: "q", chosen: "long answer", rejected: "short" });
  const v = await validatePreferenceDataset(ds.id);
  assert.ok(typeof v.score === "number");
  assert.ok(v.score >= 0 && v.score <= 100);
});

// ─── length bias ───────────────────────────────────────────────────────────

test("detectLengthBias detects chosen-longer bias", () => {
  const dataset = {
    pairs: Array.from({ length: 20 }, (_, i) => ({
      prompt: "q" + i,
      chosen: "a".repeat(100),
      rejected: "a".repeat(20),
    })),
  };
  const bias = detectLengthBias(dataset);
  assert.equal(bias.biased, true);
  assert.equal(bias.direction, "longer");
  assert.ok(bias.ratio >= 1.5);
});

test("detectLengthBias reports no bias for balanced lengths", () => {
  const dataset = {
    pairs: [
      { chosen: "aaaa", rejected: "bbbb" },
      { chosen: "ccc", rejected: "dddd" },
      { chosen: "eeeee", rejected: "fffff" },
      { chosen: "gggg", rejected: "hhh" },
    ],
  };
  const bias = detectLengthBias(dataset);
  assert.equal(bias.biased, false);
  assert.equal(bias.direction, "none");
});

test("detectLengthBias handles empty dataset", () => {
  const bias = detectLengthBias({ pairs: [] });
  assert.equal(bias.biased, false);
  assert.equal(bias.sampleCount, 0);
});

// ─── stats ─────────────────────────────────────────────────────────────────

test("getDatasetStats returns descriptive statistics", async () => {
  const ds = await createPreferenceDataset("StatsDS", WS, {});
  await addPreferencePair(ds.id, {
    prompt: "short",
    chosen: "yes",
    rejected: "no",
    source: "manual",
  });
  await addPreferencePair(ds.id, {
    prompt: "a longer prompt",
    chosen: "a longer chosen answer",
    rejected: "x",
    metadata: { ratingDiff: 3 },
    source: "feedback_ratings",
  });
  const stats = await getDatasetStats(ds.id);
  assert.equal(stats.total, 2);
  assert.ok(stats.avgPromptLen > 0);
  assert.ok(stats.avgChosenLen > 0);
  assert.ok(stats.avgRejectedLen > 0);
  assert.equal(stats.avgRatingDiff, 3);
  assert.ok(stats.sources.manual >= 1);
  assert.ok(stats.sources.feedback_ratings >= 1);
  assert.ok(stats.lengthBias);
});
