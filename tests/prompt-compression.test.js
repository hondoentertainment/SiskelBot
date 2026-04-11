/**
 * Phase 58.3: Prompt compression tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-prompt-comp-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  compressPrompt,
  decompressPrompt,
  computeCompressionRatio,
  rankSentences,
  dedupeNgrams,
  listCompressionHistory,
} = await import("../lib/prompt-compression.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("computeCompressionRatio handles edge cases", () => {
  assert.equal(computeCompressionRatio("hello world", "hi"), Math.round((11 / 2) * 10000) / 10000);
  assert.equal(computeCompressionRatio("", ""), 1);
  assert.equal(computeCompressionRatio("abc", ""), Infinity);
  assert.equal(computeCompressionRatio(100, 25), 4);
});

test("dedupeNgrams removes repeated 2-grams", () => {
  const tokens = ["search", "knowledge", "search", "knowledge", "deploy"];
  const deduped = dedupeNgrams(tokens);
  // Second "knowledge" follows the same 2-gram pattern and should be dropped.
  assert.ok(deduped.length < tokens.length);
  assert.ok(deduped.includes("deploy"));
});

test("rankSentences orders by TF-IDF informativeness", () => {
  const text = [
    "The quick brown fox jumps over the lazy dog.",
    "A rare metallurgy furnace operates at unusual temperatures.",
    "The quick brown fox jumps over the lazy dog.",
  ].join(" ");
  const ranked = rankSentences(text);
  assert.ok(ranked.length >= 2);
  // The unique metallurgy sentence should score highest.
  assert.ok(ranked[0].sentence.toLowerCase().includes("metallurgy"));
  assert.ok(ranked[0].score >= ranked[1].score);
});

test("rankSentences handles empty / null input", () => {
  assert.deepEqual(rankSentences(""), []);
  assert.deepEqual(rankSentences(null), []);
});

test("compressPrompt produces a shorter text with valid map", async () => {
  const text = [
    "Agents should be polite to users.",
    "Please note that our weather API uses barometric pressure kPa values.",
    "Thank you for reading our documentation carefully.",
    "Rate limits are 60 requests per minute per workspace.",
  ].join(" ");
  const out = await compressPrompt(text, { ratio: 0.5 });
  assert.ok(out.text.length > 0);
  assert.ok(out.text.length <= text.length);
  assert.equal(out.originalLength, text.length);
  assert.equal(out.compressedLength, out.text.length);
  assert.ok(out.ratio >= 1);
  assert.ok(Array.isArray(out._map));
  const kept = out._map.filter((m) => m.kept).length;
  assert.ok(kept >= 1);
});

test("compressPrompt keeps at least minSentences", async () => {
  const text = "One. Two. Three. Four. Five.";
  const out = await compressPrompt(text, { ratio: 0.01, minSentences: 2 });
  const kept = out._map.filter((m) => m.kept).length;
  assert.ok(kept >= 2);
});

test("compressPrompt handles empty input", async () => {
  const out = await compressPrompt("");
  assert.equal(out.text, "");
  assert.equal(out.originalLength, 0);
  assert.deepEqual(out._map, []);
});

test("decompressPrompt inserts placeholders for dropped sentences", async () => {
  const text = [
    "Critical security alert: rotate keys.",
    "Minor typo in docs about banana tree metadata.",
    "Another less important note about spelling.",
  ].join(" ");
  const out = await compressPrompt(text, { ratio: 0.34, minSentences: 1 });
  const recovered = decompressPrompt(out);
  assert.ok(typeof recovered === "string");
  assert.ok(recovered.length > 0);
  // At least one placeholder or kept sentence should be present.
  assert.ok(recovered.includes("[") || recovered.includes("critical"));
});

test("decompressPrompt handles null / invalid input", () => {
  assert.equal(decompressPrompt(null), "");
  assert.equal(decompressPrompt({ text: "plain" }), "plain");
});

test("compressPrompt persists history when persist=true", async () => {
  const before = await listCompressionHistory();
  await compressPrompt("Some long text. Another sentence. Third one.", {
    ratio: 0.5,
    persist: true,
    label: "test-label",
  });
  const after = await listCompressionHistory();
  assert.ok(after.length > before.length);
  assert.equal(after[after.length - 1].label, "test-label");
});
