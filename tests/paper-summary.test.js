/**
 * Phase 64.2: Paper summary tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-paper-summary-"));
process.env.STORAGE_PATH = TMP;

const {
  summarizePaper,
  recordSummary,
  listSummaries,
  getSummary,
  _reset,
} = await import("../lib/paper-summary.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const SAMPLE_ABSTRACT = [
  "We study few-shot learning in large vision-language models.",
  "We propose a novel prompting scheme that improves sample efficiency.",
  "Our approach is trained on a curated dataset of 1M image-text pairs.",
  "Results show that the method achieves state-of-the-art accuracy on five benchmarks.",
  "We find that smaller models benefit more than larger ones.",
  "A key limitation is reliance on high-quality captions.",
  "Future work will address noisy supervision.",
].join(" ");

test("summarizePaper throws without abstract", () => {
  assert.throws(() => summarizePaper({ abstract: "" }), /abstract is required/);
  assert.throws(() => summarizePaper({}), /abstract is required/);
});

test("summarizePaper produces tldr from first sentence", () => {
  const s = summarizePaper({ title: "Few-shot VLM", abstract: SAMPLE_ABSTRACT });
  assert.ok(s.tldr.includes("few-shot learning"));
  assert.equal(s.title, "Few-shot VLM");
});

test("summarizePaper identifies key points via patterns", () => {
  const s = summarizePaper({ abstract: SAMPLE_ABSTRACT });
  assert.ok(s.keyPoints.length > 0);
  assert.ok(s.keyPoints.length <= 5);
  // At least one of the key points should contain a signal phrase.
  const joined = s.keyPoints.join(" ").toLowerCase();
  assert.ok(/we propose|we show|result|find|our approach|achieve|state-of-the-art/.test(joined));
});

test("summarizePaper identifies methodology/findings/limitations", () => {
  const s = summarizePaper({ abstract: SAMPLE_ABSTRACT });
  assert.ok(s.methodology, "methodology should be identified");
  assert.ok(s.findings, "findings should be identified");
  assert.ok(s.limitations, "limitations should be identified");
  assert.ok(/limit/i.test(s.limitations));
});

test("summarizePaper computes reading time from word count", () => {
  const s = summarizePaper({ abstract: SAMPLE_ABSTRACT });
  assert.ok(s.wordCount > 0);
  assert.equal(s.readingTime, Math.max(1, Math.ceil(s.wordCount / 200)));
  assert.ok(s.sentenceCount >= 6);
});

test("summarizePaper handles abstract without standard signals via fallback", () => {
  const s = summarizePaper({ abstract: "First sentence here. Second sentence. Third sentence. Fourth sentence." });
  assert.ok(s.tldr.includes("First sentence"));
  // Fallback should populate keyPoints with other sentences.
  assert.ok(s.keyPoints.length > 0);
});

test("summarizePaper accepts authors and year", () => {
  const s = summarizePaper({
    abstract: SAMPLE_ABSTRACT,
    title: "Test",
    authors: ["A. Author", "B. Author"],
    year: 2024,
  });
  assert.deepEqual(s.authors, ["A. Author", "B. Author"]);
  assert.equal(s.year, 2024);
});

test("recordSummary persists and listSummaries returns", async () => {
  await _reset("ws-p1");
  const summary = summarizePaper({ title: "Paper1", abstract: SAMPLE_ABSTRACT });
  const rec = await recordSummary({ workspaceId: "ws-p1", paperId: "arxiv:2301.00001", title: "Paper1", summary });
  assert.ok(rec.id);
  assert.equal(rec.paperId, "arxiv:2301.00001");
  const list = await listSummaries("ws-p1");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, rec.id);
});

test("getSummary retrieves by id across workspaces", async () => {
  await _reset();
  const summary = summarizePaper({ abstract: SAMPLE_ABSTRACT });
  const rec = await recordSummary({ workspaceId: "ws-get", paperId: "p1", title: "T", summary });
  const got = await getSummary(rec.id);
  assert.ok(got);
  assert.equal(got.id, rec.id);
  assert.equal(got.workspaceId, "ws-get");
  const none = await getSummary("does-not-exist");
  assert.equal(none, null);
});

test("listSummaries returns newest first", async () => {
  await _reset("ws-ord");
  const summary = summarizePaper({ abstract: SAMPLE_ABSTRACT });
  await recordSummary({ workspaceId: "ws-ord", paperId: "a", title: "A", summary });
  await new Promise((r) => setTimeout(r, 2));
  await recordSummary({ workspaceId: "ws-ord", paperId: "b", title: "B", summary });
  const list = await listSummaries("ws-ord");
  assert.equal(list[0].paperId, "b");
  assert.equal(list[1].paperId, "a");
});
