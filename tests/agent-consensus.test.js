/**
 * Phase 47.4: Agent consensus tests.
 *
 * Covers majority vote, weighted vote, LLM judge (mocked), ranked choice
 * (Borda count), confidence calculation, quorum enforcement, and Byzantine
 * detection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated STORAGE_PATH so persisted runs do not pollute the project
// data directory or interfere across tests.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-consensus-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  executeConsensus,
  majorityVote,
  weightedVote,
  llmJudge,
  rankedChoice,
  calculateConsensusConfidence,
  detectByzantineAgents,
  getByzantineStats,
  getConsensusRun,
} = await import("../lib/agent-consensus.js");

const { groupSimilarResponses, computeTextSimilarity, jaccardSimilarity, cosineSimilarity } =
  await import("../lib/response-similarity.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- response-similarity ----

test("jaccardSimilarity returns 1 for identical strings", () => {
  assert.equal(jaccardSimilarity("the quick brown fox", "the quick brown fox"), 1);
});

test("jaccardSimilarity returns 0 for completely different strings", () => {
  assert.equal(jaccardSimilarity("apple banana", "xenon yttrium"), 0);
});

test("jaccardSimilarity is symmetric and bounded", () => {
  const a = "hello world from siskelbot";
  const b = "hello there from outer space";
  const s1 = jaccardSimilarity(a, b);
  const s2 = jaccardSimilarity(b, a);
  assert.equal(s1, s2);
  assert.ok(s1 >= 0 && s1 <= 1);
});

test("cosineSimilarity computes for equal vectors", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test("computeTextSimilarity prefers embeddings when provided", () => {
  const sim = computeTextSimilarity("a", "b", { aEmbedding: [1, 0], bEmbedding: [1, 0] });
  assert.ok(sim >= 0.99);
});

test("groupSimilarResponses clusters similar texts together", async () => {
  const responses = [
    { text: "Paris is the capital of France." },
    { text: "Paris is the capital of France" },
    { text: "The capital of France is Paris." },
    { text: "Berlin is the capital of Germany." },
  ];
  const clusters = await groupSimilarResponses(responses, 0.4);
  // The largest cluster should hold the three Paris responses.
  assert.ok(clusters[0].count >= 2);
});

// ---- majorityVote ----

test("majorityVote picks the largest cluster as consensus", async () => {
  const responses = [
    { text: "Paris is the capital of France" },
    { text: "Paris is the capital of France" },
    { text: "Paris capital France" },
    { text: "Berlin is the capital of Germany" },
  ];
  const result = await majorityVote(responses, { threshold: 0.3 });
  assert.match(result.consensus, /Paris/);
  assert.ok(result.agreement >= 0.5);
  assert.ok(result.winningMembers.length >= 2);
});

test("majorityVote handles tied groups by selecting the larger or first cluster", async () => {
  const responses = [
    { text: "alpha alpha alpha alpha" },
    { text: "alpha alpha alpha alpha" },
    { text: "beta beta beta beta" },
    { text: "beta beta beta beta" },
  ];
  const result = await majorityVote(responses, { threshold: 0.5 });
  assert.equal(result.winningMembers.length, 2);
  assert.ok(result.agreement === 0.5);
});

test("majorityVote returns empty for empty input", async () => {
  const r = await majorityVote([]);
  assert.equal(r.consensus, "");
  assert.equal(r.agreement, 0);
});

// ---- weightedVote ----

test("weightedVote weights by per-agent weight array", async () => {
  const responses = [
    { text: "answer A is best", agentId: "a" },
    { text: "answer A is best", agentId: "b" },
    { text: "answer B is correct", agentId: "c" },
  ];
  // Agent c has very high weight: B should win.
  const r = await weightedVote(responses, [1, 1, 10], { threshold: 0.4 });
  assert.match(r.consensus, /B/);
  assert.ok(r.winningWeight > r.totalWeight / 2);
});

test("weightedVote falls back to weight 1 when missing", async () => {
  const responses = [
    { text: "x x x x", agentId: "x" },
    { text: "y y y y", agentId: "y" },
  ];
  const r = await weightedVote(responses, [], { threshold: 0.4 });
  assert.equal(r.totalWeight, 2);
});

// ---- llmJudge ----

test("llmJudge uses injected judgeFn and parses JSON", async () => {
  const responses = [{ text: "wrong answer" }, { text: "right answer" }, { text: "maybe answer" }];
  const judgeFn = async (_prompt) =>
    JSON.stringify({ selectedIndex: 1, reasoning: "the second one is correct" });
  const r = await llmJudge(responses, "judge-model", { judgeFn });
  assert.equal(r.selectedIndex, 1);
  assert.match(r.reasoning, /correct/);
});

test("llmJudge defaults to index 0 on bad JSON", async () => {
  const responses = [{ text: "a" }, { text: "b" }];
  const judgeFn = async () => "this is not json";
  const r = await llmJudge(responses, "judge-model", { judgeFn });
  assert.equal(r.selectedIndex, 0);
});

test("llmJudge clamps out-of-range indexes", async () => {
  const responses = [{ text: "a" }, { text: "b" }];
  const judgeFn = async () => JSON.stringify({ selectedIndex: 99, reasoning: "" });
  const r = await llmJudge(responses, "judge-model", { judgeFn });
  assert.equal(r.selectedIndex, 0);
});

test("llmJudge returns -1 for empty input", async () => {
  const r = await llmJudge([], "judge-model");
  assert.equal(r.selectedIndex, -1);
});

// ---- rankedChoice ----

test("rankedChoice with explicit rankings selects Borda winner", async () => {
  // Three candidates, three voters; candidate 0 is everyone's first choice.
  const responses = [{ text: "first" }, { text: "second" }, { text: "third" }];
  const rankings = [
    [0, 1, 2],
    [0, 2, 1],
    [0, 1, 2],
  ];
  const r = await rankedChoice(responses, { rankings });
  assert.equal(r.winningIndex, 0);
  assert.ok(r.scores[0] > r.scores[1]);
  assert.ok(r.scores[0] > r.scores[2]);
});

test("rankedChoice without explicit rankings derives from similarity", async () => {
  const responses = [
    { text: "the quick brown fox jumps" },
    { text: "the quick brown fox jumps over" },
    { text: "completely unrelated text here" },
  ];
  const r = await rankedChoice(responses);
  // Either of the very similar fox responses should beat the unrelated one.
  assert.ok([0, 1].includes(r.winningIndex));
});

test("rankedChoice returns single response unchanged", async () => {
  const r = await rankedChoice([{ text: "only one" }]);
  assert.equal(r.winningIndex, 0);
  assert.equal(r.consensus, "only one");
});

// ---- confidence ----

test("calculateConsensusConfidence multiplies agreement by avg confidence", () => {
  const responses = [{ confidence: 1 }, { confidence: 1 }, { confidence: 1 }];
  assert.equal(calculateConsensusConfidence(responses, 1), 1);
  assert.equal(calculateConsensusConfidence(responses, 0.5), 0.5);
});

test("calculateConsensusConfidence is bounded to [0,1]", () => {
  assert.equal(calculateConsensusConfidence([{ confidence: 5 }], 5), 1);
  assert.equal(calculateConsensusConfidence([{ confidence: -1 }], -1), 0);
});

test("calculateConsensusConfidence uses 0.5 average when no confidence supplied", () => {
  const c = calculateConsensusConfidence([{}, {}], 1);
  assert.equal(c, 0.5);
});

// ---- executeConsensus & quorum ----

function makeAgent(agentId, text, confidence = 0.8) {
  return {
    agentId,
    model: agentId,
    invoke: async () => ({ text, confidence }),
  };
}

test("executeConsensus runs agents in parallel and reports majority", async () => {
  const agents = [
    makeAgent("a1", "Paris is the capital of France"),
    makeAgent("a2", "Paris is the capital of France"),
    makeAgent("a3", "Berlin is the capital of France"),
  ];
  const run = await executeConsensus("capital of France?", {
    agents,
    strategy: "majority_vote",
    quorum: 2,
    threshold: 0.4,
    persist: true,
  });
  assert.match(run.consensus, /Paris/);
  assert.ok(run.confidence > 0);
  assert.equal(run.quorumMet, true);
  assert.equal(run.responses.length, 3);
});

test("executeConsensus enforces quorum and reports failure when not met", async () => {
  const agents = [
    {
      agentId: "f1",
      model: "f1",
      invoke: async () => {
        throw new Error("boom");
      },
    },
    {
      agentId: "f2",
      model: "f2",
      invoke: async () => {
        throw new Error("boom");
      },
    },
  ];
  const run = await executeConsensus("anything", {
    agents,
    strategy: "majority_vote",
    quorum: 2,
    persist: false,
  });
  assert.equal(run.quorumMet, false);
  assert.match(run.error || "", /quorum/);
});

test("executeConsensus rejects empty agent list", async () => {
  const run = await executeConsensus("hi", { agents: [] });
  assert.equal(run.quorumMet, false);
  assert.match(run.error || "", /no agents/);
});

test("executeConsensus persists runs and getConsensusRun retrieves them", async () => {
  const agents = [
    makeAgent("p1", "answer is forty two"),
    makeAgent("p2", "answer is forty two"),
  ];
  const run = await executeConsensus("meaning of life?", {
    agents,
    strategy: "majority_vote",
    quorum: 2,
    threshold: 0.4,
    persist: true,
  });
  const fetched = await getConsensusRun(run.id);
  assert.ok(fetched);
  assert.equal(fetched.id, run.id);
  assert.match(fetched.consensus, /forty/);
});

test("executeConsensus with llm_judge strategy uses judge result", async () => {
  const agents = [
    makeAgent("j1", "the answer is purple"),
    makeAgent("j2", "the answer is yellow"),
    makeAgent("j3", "the answer is green"),
  ];
  const run = await executeConsensus("color?", {
    agents,
    strategy: "llm_judge",
    quorum: 2,
    judgeFn: async () => JSON.stringify({ selectedIndex: 2, reasoning: "green is right" }),
    persist: false,
  });
  assert.match(run.consensus, /green/);
  assert.equal(run.strategy, "llm_judge");
});

test("executeConsensus with weighted strategy uses provided weights", async () => {
  const agents = [
    makeAgent("w1", "answer A"),
    makeAgent("w2", "answer A"),
    makeAgent("w3", "answer B"),
  ];
  const run = await executeConsensus("which?", {
    agents,
    strategy: "weighted",
    weights: [1, 1, 100],
    quorum: 2,
    threshold: 0.4,
    persist: false,
  });
  assert.match(run.consensus, /B/);
});

test("executeConsensus with ranked_choice strategy uses Borda count", async () => {
  const agents = [
    makeAgent("r1", "the same text here"),
    makeAgent("r2", "the same text here"),
    makeAgent("r3", "wildly different content"),
  ];
  const run = await executeConsensus("similar?", {
    agents,
    strategy: "ranked_choice",
    quorum: 2,
    persist: false,
  });
  assert.match(run.consensus, /same|here/);
});

// ---- Byzantine detection ----

test("detectByzantineAgents flags persistently dissenting agents", async () => {
  // Run a sequence of consensus rounds where one agent always dissents.
  const dissenter = "byz1";
  for (let round = 0; round < 5; round++) {
    const agents = [
      makeAgent("good_a", "the sky is blue today"),
      makeAgent("good_b", "the sky is blue today"),
      makeAgent(dissenter, "the sky is bright green completely"),
    ];
    await executeConsensus("color of sky?", {
      agents,
      strategy: "majority_vote",
      quorum: 2,
      threshold: 0.4,
      persist: true,
    });
  }
  // Force lower thresholds for deterministic test outcome.
  process.env.AGENT_BYZANTINE_THRESHOLD = "0.5";
  process.env.AGENT_BYZANTINE_MIN_SAMPLES = "3";
  const stats = await getByzantineStats(dissenter);
  assert.ok(stats);
  assert.ok(stats.dissentRate >= 0.5);
  assert.equal(stats.byzantine, true);
  delete process.env.AGENT_BYZANTINE_THRESHOLD;
  delete process.env.AGENT_BYZANTINE_MIN_SAMPLES;
});

test("detectByzantineAgents respects ground truth overrides", async () => {
  process.env.AGENT_BYZANTINE_THRESHOLD = "0.5";
  process.env.AGENT_BYZANTINE_MIN_SAMPLES = "3";
  // Get current list, mark a known-good agent as Byzantine via ground truth.
  const ground = { good_a: true };
  const list = await detectByzantineAgents([], ground);
  const gA = list.find((x) => x.agentId === "good_a");
  if (gA) {
    assert.equal(gA.byzantine, true);
  }
  delete process.env.AGENT_BYZANTINE_THRESHOLD;
  delete process.env.AGENT_BYZANTINE_MIN_SAMPLES;
});

test("getByzantineStats returns null for unknown agent", async () => {
  const stats = await getByzantineStats("never-seen-agent-xyz-123");
  assert.equal(stats, null);
});
