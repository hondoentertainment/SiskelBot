/**
 * Phase 64.2: Paper summarization tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-paper-summary-"));
process.env.STORAGE_PATH = TMP;

const {
  splitSentences,
  extractSections,
  rankBySalience,
  summarizePaper,
  getSummary,
  listSummaries,
} = await import("../lib/paper-summary.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("splitSentences yields individual sentences", () => {
  const out = splitSentences("Foo. Bar! Baz? The end.");
  assert.deepEqual(out, ["Foo.", "Bar!", "Baz?", "The end."]);
});

test("splitSentences handles empty input", () => {
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences(null), []);
});

test("extractSections recognizes headings", () => {
  const text = `Abstract
We present a new method.

Methods
We trained a model.

Results
Accuracy was 90%.

Limitations
Small dataset.`;
  const sections = extractSections(text);
  assert.ok(sections.methods);
  assert.ok(sections.results);
  assert.ok(sections.limitations);
});

test("rankBySalience orders sentences", () => {
  const sents = [
    "The method trains a transformer on a large corpus.",
    "The cat sat on the mat.",
    "Transformer models achieve state-of-the-art accuracy.",
  ];
  const ranked = rankBySalience(sents);
  assert.equal(ranked.length, 3);
  assert.ok(ranked[0].score >= ranked[1].score);
});

test("rankBySalience boosts query-matching sentences", () => {
  const sents = ["alpha beta", "gamma delta epsilon", "foo bar"];
  const ranked = rankBySalience(sents, "gamma");
  assert.equal(ranked[0].text, "gamma delta epsilon");
});

test("rankBySalience returns [] for empty input", () => {
  assert.deepEqual(rankBySalience([]), []);
});

test("summarizePaper produces tl;dr, methods, results, limitations", async () => {
  const paper = {
    id: "p1",
    title: "Test paper",
    abstract: "We propose a new approach. Our method uses transformer models. Results show 95% accuracy improvement. However, the dataset was small as a limitation.",
  };
  const summary = await summarizePaper(paper);
  assert.equal(summary.paperId, "p1");
  assert.ok(summary.tldr.length > 0);
  assert.ok(summary.methods.length > 0);
  assert.ok(summary.results.length > 0);
  assert.ok(summary.limitations.length > 0);
});

test("summarizePaper rejects invalid input", async () => {
  await assert.rejects(() => summarizePaper(null));
  await assert.rejects(() => summarizePaper({}));
});

test("summarizePaper uses llm callback when provided", async () => {
  const paper = { id: "p2", abstract: "We trained a model. It worked well." };
  const summary = await summarizePaper(paper, { llm: async (text) => `POLISHED: ${text}` });
  assert.ok(summary.polished);
  assert.ok(summary.tldr.startsWith("POLISHED:"));
});

test("getSummary returns a persisted summary", async () => {
  const paper = { id: "p3", abstract: "A B C. D E F." };
  const saved = await summarizePaper(paper);
  const fetched = await getSummary(saved.id);
  assert.ok(fetched);
  assert.equal(fetched.id, saved.id);
});

test("getSummary returns null for unknown", async () => {
  assert.equal(await getSummary("unknown"), null);
  assert.equal(await getSummary(""), null);
});

test("listSummaries returns all persisted", async () => {
  const list = await listSummaries();
  assert.ok(list.length >= 2);
});
