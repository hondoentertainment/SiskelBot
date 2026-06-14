import test from "node:test";
import assert from "node:assert/strict";
import {
  recordRagPrecision,
  recordRagMrr,
  recordRagRetrievalDuration,
  recordRagChunksRetrieved,
  __resetRagMetricsForTests,
  __getRagMetricsForTests,
  renderPrometheus,
} from "../lib/metrics.js";

function enableMetrics(fn) {
  const prev = process.env.ENABLE_METRICS;
  process.env.ENABLE_METRICS = "1";
  try { return fn(); } finally { process.env.ENABLE_METRICS = prev; }
}

function makeSnippets(scores) {
  return scores.map((score, i) => ({ id: String(i), title: `doc-${i}`, snippet: "text", score }));
}

const THRESHOLD = 0.7;
const isRelevant = (s) => s.score >= THRESHOLD;

function precisionAtK(snippets, k) {
  const slice = snippets.slice(0, k);
  if (slice.length === 0) return 0;
  return slice.filter(isRelevant).length / slice.length;
}

function computeMrr(snippets) {
  for (let i = 0; i < snippets.length; i++) {
    if (isRelevant(snippets[i])) return 1 / (i + 1);
  }
  return 0;
}

test("precisionAtK: all relevant → 1.0 for all k", () => {
  const snippets = makeSnippets([0.9, 0.85, 0.8, 0.75, 0.72]);
  assert.equal(precisionAtK(snippets, 1), 1.0);
  assert.equal(precisionAtK(snippets, 3), 1.0);
  assert.equal(precisionAtK(snippets, 5), 1.0);
});

test("precisionAtK: none relevant → 0.0", () => {
  const snippets = makeSnippets([0.5, 0.4, 0.3]);
  assert.equal(precisionAtK(snippets, 1), 0.0);
  assert.equal(precisionAtK(snippets, 3), 0.0);
});

test("precisionAtK: mixed results computes correctly at k=3", () => {
  const snippets = makeSnippets([0.9, 0.5, 0.8]);
  const p3 = precisionAtK(snippets, 3);
  assert.ok(Math.abs(p3 - 2 / 3) < 1e-9, `expected 2/3, got ${p3}`);
});

test("MRR: first result relevant → 1.0", () => {
  const snippets = makeSnippets([0.9, 0.5, 0.4]);
  assert.equal(computeMrr(snippets), 1.0);
});

test("MRR: second result is first relevant → 0.5", () => {
  const snippets = makeSnippets([0.4, 0.9, 0.3]);
  assert.ok(Math.abs(computeMrr(snippets) - 0.5) < 1e-9);
});

test("MRR: no relevant result → 0.0", () => {
  const snippets = makeSnippets([0.3, 0.2, 0.1]);
  assert.equal(computeMrr(snippets), 0.0);
});

test("recordRagPrecision increments per-k counters", () => {
  enableMetrics(() => {
    __resetRagMetricsForTests();
    recordRagPrecision({ p1: 1.0, p3: 0.667, p5: 0.4 });
    const snap = __getRagMetricsForTests();
    assert.equal(snap.precisionAtK["1"].count, 1);
    assert.ok(Math.abs(snap.precisionAtK["1"].sum - 1.0) < 1e-6);
    assert.equal(snap.precisionAtK["3"].count, 1);
    assert.ok(Math.abs(snap.precisionAtK["3"].sum - 0.667) < 1e-6);
    assert.equal(snap.precisionAtK["5"].count, 1);
  });
});

test("recordRagMrr accumulates sum and count", () => {
  enableMetrics(() => {
    __resetRagMetricsForTests();
    recordRagMrr(1.0);
    recordRagMrr(0.5);
    const snap = __getRagMetricsForTests();
    assert.equal(snap.mrr.count, 2);
    assert.ok(Math.abs(snap.mrr.sum - 1.5) < 1e-9);
  });
});

test("recordRagRetrievalDuration records latency", () => {
  enableMetrics(() => {
    __resetRagMetricsForTests();
    recordRagRetrievalDuration(50);
    const snap = __getRagMetricsForTests();
    assert.equal(snap.duration.count, 1);
    assert.ok(snap.duration.sumSec > 0);
  });
});

test("recordRagChunksRetrieved increments workspace counter", () => {
  enableMetrics(() => {
    __resetRagMetricsForTests();
    recordRagChunksRetrieved("workspace1", 5);
    recordRagChunksRetrieved("workspace1", 3);
    const snap = __getRagMetricsForTests();
    const wsKey = Object.keys(snap.chunksRetrieved)[0];
    assert.ok(wsKey, "expected at least one workspace key");
    assert.equal(snap.chunksRetrieved[wsKey], 8);
  });
});

test("metrics are no-ops when ENABLE_METRICS is not set", () => {
  __resetRagMetricsForTests();
  const prev = process.env.ENABLE_METRICS;
  delete process.env.ENABLE_METRICS;
  recordRagPrecision({ p1: 1.0, p3: 1.0, p5: 1.0 });
  recordRagMrr(1.0);
  const snap = __getRagMetricsForTests();
  assert.equal(snap.mrr.count, 0);
  assert.equal(Object.keys(snap.precisionAtK).length, 0);
  process.env.ENABLE_METRICS = prev;
});

test("renderPrometheus includes RAG metric lines when enabled", () => {
  enableMetrics(() => {
    __resetRagMetricsForTests();
    recordRagPrecision({ p1: 1.0, p3: 0.667, p5: 0.6 });
    recordRagMrr(0.5);
    recordRagRetrievalDuration(100);
    recordRagChunksRetrieved("default", 3);
    const output = renderPrometheus();
    assert.ok(output.includes("siskelbot_rag_precision_at_k"), "missing precision@k metric");
    assert.ok(output.includes("siskelbot_rag_mrr"), "missing MRR metric");
    assert.ok(output.includes("siskelbot_rag_retrieval_duration_seconds"), "missing retrieval duration metric");
    assert.ok(output.includes("siskelbot_rag_chunks_retrieved_total"), "missing chunks retrieved metric");
  });
});
