/**
 * Phase 68.4: Source credibility tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-source-credibility-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  scoreSource,
  getScore,
  listScores,
  updateScore,
  credibilityLevel,
} = await import("../lib/source-credibility.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("scoreSource requires sourceKey", async () => {
  await assert.rejects(() => scoreSource("", {}), /sourceKey/);
});

test("credibilityLevel maps scores to bands", () => {
  assert.equal(credibilityLevel(0.9), "high");
  assert.equal(credibilityLevel(0.6), "moderate");
  assert.equal(credibilityLevel(0.3), "low");
  assert.equal(credibilityLevel(0.1), "minimal");
  assert.equal(credibilityLevel(null), "unknown");
});

test("scoreSource assigns higher score to mature, frequently cited source", async () => {
  const mature = await scoreSource("big-news.example", {
    citationCount: 500,
    ageDays: 1800,
    updateFrequencyDays: 1,
  });
  const new_source = await scoreSource("blog.example", {
    citationCount: 0,
    ageDays: 30,
    updateFrequencyDays: 180,
  });
  assert.ok(mature.score > new_source.score);
  assert.ok(mature.score > 0.4);
  assert.ok(new_source.score < 0.5);
});

test("scoreSource manualOverride pins the score directly", async () => {
  const rec = await scoreSource("pinned.example", {
    citationCount: 0,
    manualOverride: 0.95,
  });
  assert.equal(rec.score, 0.95);
  assert.equal(rec.level, "high");
});

test("scoreSource penalties reduce the score", async () => {
  const base = await scoreSource("penalty-base.example", {
    citationCount: 500,
    ageDays: 1000,
    updateFrequencyDays: 7,
  });
  const penalized = await scoreSource("penalty-base.example", {
    penalties: [{ reason: "retraction", amount: 0.3 }],
  });
  assert.ok(penalized.score < base.score);
});

test("scoreSource appends to history on each call", async () => {
  await scoreSource("history.example", { citationCount: 10 });
  await scoreSource("history.example", { citationCount: 50 });
  const rec = await getScore("history.example");
  assert.equal(rec.history.length, 2);
});

test("updateScore modifies an existing source's override and persists", async () => {
  await scoreSource("u.example", { citationCount: 5 });
  const updated = await updateScore("u.example", { manualOverride: 0.2 });
  assert.equal(updated.score, 0.2);
  assert.equal(updated.level, "low");
});

test("updateScore rejects when source was never scored", async () => {
  await assert.rejects(() => updateScore("never.example", { manualOverride: 0.5 }), /not scored/);
});

test("listScores filters by level and score bounds", async () => {
  await scoreSource("high.example", { citationCount: 2000, ageDays: 3000, updateFrequencyDays: 1, manualOverride: 0.9 });
  await scoreSource("low.example", { citationCount: 0, ageDays: 1, updateFrequencyDays: 300 });
  const highs = await listScores({ level: "high" });
  assert.ok(highs.some((r) => r.sourceKey === "high.example"));
  assert.ok(!highs.some((r) => r.sourceKey === "low.example"));
  const bounded = await listScores({ minScore: 0.5 });
  assert.ok(bounded.every((r) => r.score >= 0.5));
});

test("getScore returns null for unknown source", async () => {
  assert.equal(await getScore("unknown.example"), null);
});
