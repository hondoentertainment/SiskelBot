/**
 * Phase 63.2: PR review tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-pr-review-"));
process.env.STORAGE_PATH = TMP;

const {
  parseDiff,
  reviewDiff,
  listSuggestions,
  applySuggestion,
  dismissSuggestion,
  listRules,
  listReviews,
} = await import("../lib/pr-review.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const SAMPLE_DIFF = `--- a/src/foo.js
+++ b/src/foo.js
@@ -1,3 +1,6 @@
 function old() {}
+// TODO: refactor this
+console.log("debug");
+var count = 9999;
 function tail() {}
`;

test("parseDiff extracts added lines with file + line number", () => {
  const parsed = parseDiff(SAMPLE_DIFF);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].file, "src/foo.js");
  assert.ok(parsed[0].content.includes("TODO"));
});

test("parseDiff handles empty input", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff(null), []);
});

test("listRules returns the built-in rules", () => {
  const rules = listRules();
  const ids = rules.map((r) => r.id);
  assert.ok(ids.includes("todo"));
  assert.ok(ids.includes("console_log"));
  assert.ok(ids.includes("magic_number"));
  assert.ok(ids.includes("var_usage"));
});

test("reviewDiff emits suggestions for common issues", async () => {
  const result = await reviewDiff(SAMPLE_DIFF);
  assert.ok(result.reviewId);
  assert.ok(result.suggestions.length >= 3);
  const ruleIds = result.suggestions.map((s) => s.ruleId);
  assert.ok(ruleIds.includes("todo"));
  assert.ok(ruleIds.includes("console_log"));
  assert.ok(ruleIds.includes("var_usage"));
});

test("reviewDiff rejects non-string input", async () => {
  await assert.rejects(() => reviewDiff(null));
});

test("reviewDiff respects rules filter", async () => {
  const result = await reviewDiff(SAMPLE_DIFF, { rules: ["todo"] });
  assert.ok(result.suggestions.every((s) => s.ruleId === "todo"));
});

test("listSuggestions returns persisted suggestions for a review", async () => {
  const review = await reviewDiff(SAMPLE_DIFF, { title: "test PR" });
  const list = await listSuggestions(review.reviewId);
  assert.equal(list.length, review.suggestions.length);
  assert.ok(list[0].file);
});

test("listSuggestions returns [] for unknown review", async () => {
  const list = await listSuggestions("unknown_id");
  assert.deepEqual(list, []);
});

test("applySuggestion sets status to applied", async () => {
  const review = await reviewDiff(SAMPLE_DIFF);
  const sug = review.suggestions[0];
  const out = await applySuggestion(sug.id);
  assert.equal(out.status, "applied");
});

test("dismissSuggestion sets status to dismissed", async () => {
  const review = await reviewDiff(SAMPLE_DIFF);
  const sug = review.suggestions[0];
  const out = await dismissSuggestion(sug.id);
  assert.equal(out.status, "dismissed");
});

test("applySuggestion returns null for unknown id", async () => {
  const out = await applySuggestion("unknown");
  assert.equal(out, null);
});

test("reviewDiff detects long lines and magic numbers", async () => {
  const diff = `--- a/a.js
+++ b/a.js
@@ -1,1 +1,2 @@
 existing
+const threshold = 12345;
`;
  const result = await reviewDiff(diff);
  const ids = result.suggestions.map((s) => s.ruleId);
  assert.ok(ids.includes("magic_number"));
});

test("listReviews returns metadata", async () => {
  const reviews = await listReviews();
  assert.ok(reviews.length >= 1);
  assert.ok(reviews[0].id);
});
