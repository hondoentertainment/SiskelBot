/**
 * Tests for lib/prompt-optimizer.js — analyzePromptPerformance, suggestPromptImprovements, getABTestResults.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recordFeedback } from "../lib/feedback.js";
import {
  analyzePromptPerformance,
  suggestPromptImprovements,
  getABTestResults,
} from "../lib/prompt-optimizer.js";

const TEST_WS = "test-optimizer-ws-" + Date.now();

// Seed feedback data for analysis
async function seedFeedback() {
  const entries = [
    { conv: "c1", idx: 0, rating: 5, comment: "Excellent", model: "gpt-4o", response: "A".repeat(1500) },
    { conv: "c1", idx: 1, rating: 4, comment: "Good", model: "gpt-4o", response: "B".repeat(1200) },
    { conv: "c2", idx: 0, rating: 5, comment: null, model: "gpt-4o", response: "C".repeat(1800) },
    { conv: "c2", idx: 1, rating: 4, comment: "Helpful", model: "gpt-4o", response: "D".repeat(1000) },
    { conv: "c3", idx: 0, rating: 2, comment: "Wrong answer", model: "llama3", response: "E".repeat(300) },
    { conv: "c3", idx: 1, rating: 1, comment: "Incorrect information", model: "llama3", response: "F".repeat(200) },
    { conv: "c4", idx: 0, rating: 2, comment: "Not what I asked", model: "llama3", response: "G".repeat(400) },
    { conv: "c4", idx: 1, rating: 3, comment: null, model: "llama3", response: "H".repeat(600) },
    { conv: "c5", idx: 0, rating: 4, comment: null, model: "gpt-4o", response: "I".repeat(2500) },
    { conv: "c5", idx: 1, rating: 3, comment: "Unclear explanation", model: "gpt-4o", response: "J".repeat(800) },
  ];

  for (const e of entries) {
    await recordFeedback(e.conv, e.idx, e.rating, e.comment, "test-user", {
      workspaceId: TEST_WS,
      model: e.model,
      response: e.response,
    });
  }
}

// Seed data once before tests run
let seeded = false;
async function ensureSeeded() {
  if (!seeded) {
    await seedFeedback();
    seeded = true;
  }
}

// --- analyzePromptPerformance ---

test("analyzePromptPerformance returns insights array", async () => {
  await ensureSeeded();
  const result = await analyzePromptPerformance(TEST_WS);
  assert.ok(result.insights);
  assert.ok(Array.isArray(result.insights));
  assert.ok(result.insights.length >= 1);
});

test("analyzePromptPerformance insights have required fields", async () => {
  await ensureSeeded();
  const result = await analyzePromptPerformance(TEST_WS);
  for (const insight of result.insights) {
    assert.ok(typeof insight.type === "string");
    assert.ok(typeof insight.finding === "string");
    assert.ok(typeof insight.confidence === "number");
    assert.ok(insight.confidence >= 0 && insight.confidence <= 1);
  }
});

test("analyzePromptPerformance detects model comparison", async () => {
  await ensureSeeded();
  const result = await analyzePromptPerformance(TEST_WS);
  const modelInsight = result.insights.find((i) => i.type === "model_comparison");
  assert.ok(modelInsight, "Should detect model performance difference");
  assert.ok(modelInsight.finding.includes("gpt-4o"), "gpt-4o should be the better model");
});

test("analyzePromptPerformance detects response length pattern", async () => {
  await ensureSeeded();
  const result = await analyzePromptPerformance(TEST_WS);
  const lengthInsight = result.insights.find((i) => i.type === "response_length" || i.type === "length_preference");
  // Should find at least one length-related insight since we have varied lengths
  assert.ok(lengthInsight, "Should detect length preference");
});

test("analyzePromptPerformance returns insufficient_data for empty workspace", async () => {
  const result = await analyzePromptPerformance("empty-optimizer-ws-" + Date.now());
  assert.equal(result.insights.length, 1);
  assert.equal(result.insights[0].type, "insufficient_data");
});

// --- suggestPromptImprovements ---

test("suggestPromptImprovements returns suggestions array", async () => {
  await ensureSeeded();
  const result = await suggestPromptImprovements(TEST_WS);
  assert.ok(result.suggestions);
  assert.ok(Array.isArray(result.suggestions));
  assert.ok(result.suggestions.length >= 1);
});

test("suggestPromptImprovements suggestions have required fields", async () => {
  await ensureSeeded();
  const result = await suggestPromptImprovements(TEST_WS);
  for (const suggestion of result.suggestions) {
    assert.ok(typeof suggestion.area === "string");
    assert.ok(typeof suggestion.current === "string");
    assert.ok(typeof suggestion.suggested === "string");
    assert.ok(typeof suggestion.reasoning === "string");
  }
});

test("suggestPromptImprovements suggests model selection", async () => {
  await ensureSeeded();
  const result = await suggestPromptImprovements(TEST_WS);
  const modelSuggestion = result.suggestions.find((s) => s.area === "model_selection");
  // With 6 gpt-4o entries (avg ~4.2) vs 4 llama3 entries (avg ~2.0), should suggest model change
  assert.ok(modelSuggestion, "Should suggest model selection improvement");
  assert.ok(modelSuggestion.suggested.includes("gpt-4o"), "Should suggest gpt-4o as preferred");
});

test("suggestPromptImprovements returns data suggestion for empty workspace", async () => {
  const result = await suggestPromptImprovements("empty-optimizer-ws-" + Date.now());
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].area, "data");
});

// --- getABTestResults ---

test("getABTestResults returns correct structure", async () => {
  await ensureSeeded();
  const result = await getABTestResults(TEST_WS);
  assert.ok(result.modelA);
  assert.ok(result.modelB);
  assert.ok(typeof result.modelA.model === "string");
  assert.ok(typeof result.modelA.avgRating === "number");
  assert.ok(typeof result.modelA.samples === "number");
  assert.ok(typeof result.modelB.model === "string");
  assert.ok(typeof result.modelB.avgRating === "number");
  assert.ok(typeof result.modelB.samples === "number");
});

test("getABTestResults ranks modelA higher than modelB", async () => {
  await ensureSeeded();
  const result = await getABTestResults(TEST_WS);
  assert.ok(result.modelA.avgRating >= result.modelB.avgRating);
});

test("getABTestResults identifies gpt-4o as better model", async () => {
  await ensureSeeded();
  const result = await getABTestResults(TEST_WS);
  assert.equal(result.modelA.model, "gpt-4o");
});

test("getABTestResults returns null winner without enough samples", async () => {
  await ensureSeeded();
  // With only 6 and 4 samples (< 10 each), not statistically significant
  const result = await getABTestResults(TEST_WS);
  assert.equal(result.significant, false);
  assert.equal(result.winner, null);
});

test("getABTestResults handles empty workspace", async () => {
  const result = await getABTestResults("empty-ab-ws-" + Date.now());
  assert.equal(result.modelA, null);
  assert.equal(result.modelB, null);
  assert.equal(result.winner, null);
  assert.equal(result.significant, false);
});

test("getABTestResults handles single model workspace", async () => {
  const singleWs = "single-model-ws-" + Date.now();
  await recordFeedback("c1", 0, 4, null, "user", { workspaceId: singleWs, model: "gpt-4o" });
  await recordFeedback("c1", 1, 5, null, "user", { workspaceId: singleWs, model: "gpt-4o" });

  const result = await getABTestResults(singleWs);
  assert.ok(result.modelA);
  assert.equal(result.modelB, null);
  assert.equal(result.winner, null);
});
