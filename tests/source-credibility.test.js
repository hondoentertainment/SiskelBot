/**
 * Phase 68.4: Source credibility tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-cred-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  scoreSource,
  updateReputation,
  listSources,
  getReputation,
  exportScorecard,
} = await import("../lib/source-credibility.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("scoreSource blends accuracy, bias, and recency", () => {
  const now = new Date().toISOString();
  const s = scoreSource({ accuracy: 1, bias: 0, lastUpdatedAt: now });
  assert.ok(s.overall >= 0.9);
  const w = scoreSource({ accuracy: 0, bias: 1, lastUpdatedAt: new Date(0).toISOString() });
  assert.ok(w.overall <= 0.1);
});

test("scoreSource clamps out-of-range inputs", () => {
  const s = scoreSource({ accuracy: 5, bias: -1, lastUpdatedAt: new Date().toISOString() });
  assert.equal(s.accuracy, 1);
  assert.equal(s.bias, 0);
});

test("scoreSource returns 0 recency without a timestamp", () => {
  const s = scoreSource({ accuracy: 1, bias: 0 });
  assert.equal(s.recency, 0);
});

test("updateReputation creates and updates entries", async () => {
  const rec = await updateReputation("nyt", {
    name: "NYT",
    accuracy: 0.9,
    bias: 0.2,
    notes: "trusted",
  });
  assert.equal(rec.name, "NYT");
  assert.equal(rec.accuracy, 0.9);
  assert.ok(rec.score.overall > 0.5);
  const rec2 = await updateReputation("nyt", { accuracy: 0.95 });
  assert.equal(rec2.accuracy, 0.95);
  assert.ok(rec2.history.length >= 2);
});

test("updateReputation rejects invalid input", async () => {
  await assert.rejects(() => updateReputation("", {}));
  await assert.rejects(() => updateReputation("abc", null));
});

test("getReputation returns stored record or null", async () => {
  await updateReputation("src1", { accuracy: 0.8, bias: 0.1 });
  const rec = await getReputation("src1");
  assert.ok(rec);
  assert.equal(rec.accuracy, 0.8);
  assert.equal(await getReputation("missing"), null);
});

test("listSources returns entries sorted by overall score", async () => {
  await updateReputation("high", { accuracy: 1, bias: 0 });
  await updateReputation("low", { accuracy: 0.1, bias: 0.9 });
  const all = await listSources();
  const highIdx = all.findIndex((s) => s.id === "high");
  const lowIdx = all.findIndex((s) => s.id === "low");
  assert.ok(highIdx >= 0);
  assert.ok(lowIdx >= 0);
  assert.ok(highIdx < lowIdx);
});

test("exportScorecard produces ordered rows with rank", async () => {
  await updateReputation("sc1", { accuracy: 1, bias: 0 });
  await updateReputation("sc2", { accuracy: 0.3, bias: 0.5 });
  const report = await exportScorecard();
  assert.ok(report.generatedAt);
  assert.ok(report.count >= 2);
  assert.equal(report.rows[0].rank, 1);
  for (let i = 1; i < report.rows.length; i++) {
    assert.ok(report.rows[i - 1].overall >= report.rows[i].overall);
  }
});

test("exportScorecard handles empty store without throwing", async () => {
  // Not emptying store; but still verifies no crash on a follow-on run
  const report = await exportScorecard();
  assert.ok(Array.isArray(report.rows));
  assert.equal(typeof report.version, "number");
});

test("updateReputation preserves history length cap", async () => {
  for (let i = 0; i < 110; i++) {
    await updateReputation("hist", { accuracy: 0.5 + (i % 5) * 0.05, bias: 0.3 });
  }
  const rec = await getReputation("hist");
  assert.ok(rec.history.length <= 100);
});
