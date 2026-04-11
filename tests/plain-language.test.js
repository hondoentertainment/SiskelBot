/**
 * Phase 70.5: Plain-language tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-plain-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  computeReadability,
  simplifyText,
  listSynonymRules,
  addSynonymRule,
  grade,
  countSyllables,
  splitSentences,
} = await import("../lib/plain-language.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("countSyllables handles simple and complex words", () => {
  assert.equal(countSyllables("cat"), 1);
  assert.equal(countSyllables("running"), 2);
  assert.ok(countSyllables("beautiful") >= 3);
  assert.equal(countSyllables(""), 0);
  assert.equal(countSyllables(null), 0);
});

test("splitSentences splits on terminal punctuation", () => {
  const s = splitSentences("Hello. World! Is it? Yes.");
  assert.equal(s.length, 4);
});

test("computeReadability returns score and counts", () => {
  const r = computeReadability("The cat sat on the mat. The dog ran away.");
  assert.ok(r.score > 0);
  assert.equal(r.sentences, 2);
  assert.ok(r.words > 0);
  assert.ok(r.syllables > 0);
});

test("computeReadability returns zero for empty input", () => {
  const r = computeReadability("");
  assert.equal(r.score, 0);
  const r2 = computeReadability(null);
  assert.equal(r2.score, 0);
});

test("grade labels scores", () => {
  assert.equal(grade(95), "very easy");
  assert.equal(grade(75), "fairly easy");
  assert.equal(grade(55), "fairly difficult");
  assert.equal(grade(10), "very difficult");
  assert.equal(grade("nope"), "unknown");
});

test("simplifyText swaps default synonyms and preserves case", async () => {
  const r = await simplifyText("We should Utilize the new method to Commence the project.");
  assert.ok(r.replacements >= 2);
  assert.ok(r.text.toLowerCase().includes("use"));
  assert.ok(r.text.toLowerCase().includes("start"));
  // Case preservation for "Utilize" at a capitalized position.
  assert.ok(/Use/.test(r.text) || /use/.test(r.text));
});

test("simplifyText returns unchanged text when nothing matches", async () => {
  const r = await simplifyText("hello there.");
  assert.equal(r.replacements, 0);
  assert.equal(r.text, "hello there.");
});

test("simplifyText computes before/after readability", async () => {
  const r = await simplifyText("Approximately all users utilize this feature subsequently.");
  assert.ok(r.readabilityBefore);
  assert.ok(r.readabilityAfter);
  assert.ok(Number.isFinite(r.readabilityBefore.score));
  assert.ok(Number.isFinite(r.readabilityAfter.score));
});

test("simplifyText rejects non-string input", async () => {
  await assert.rejects(() => simplifyText(null));
  await assert.rejects(() => simplifyText(42));
});

test("listSynonymRules returns defaults", async () => {
  const rules = await listSynonymRules();
  assert.ok(rules.length > 0);
  assert.ok(rules.some((r) => r.from === "utilize"));
});

test("addSynonymRule persists new rules and replaces duplicates", async () => {
  const rules = await addSynonymRule({ from: "novel", to: "new" });
  assert.ok(rules.some((r) => r.from === "novel" && r.to === "new"));
  const rules2 = await addSynonymRule({ from: "Novel", to: "recent" });
  const found = rules2.filter((r) => r.from.toLowerCase() === "novel");
  assert.equal(found.length, 1);
  assert.equal(found[0].to, "recent");
});

test("addSynonymRule validates input", async () => {
  await assert.rejects(() => addSynonymRule(null));
  await assert.rejects(() => addSynonymRule({ from: "", to: "x" }));
  await assert.rejects(() => addSynonymRule({ from: "x", to: "" }));
});
