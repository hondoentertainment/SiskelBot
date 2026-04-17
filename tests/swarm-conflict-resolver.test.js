/**
 * Tests for the swarm conflict resolver: detection, classification, and
 * reconciliation prompt construction.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  jaccard,
  classifyPolarity,
  extractNumbers,
  detectConflicts,
  buildReconciliationPrompt,
  analyzeSwarmConflicts,
} from "../lib/swarm-conflict-resolver.js";

test("tokenize: extracts content words and drops stopwords", () => {
  const t = tokenize("The quick brown fox jumps over the lazy dog.");
  assert.ok(t.has("quick"));
  assert.ok(t.has("brown"));
  assert.ok(t.has("fox"));
  assert.ok(!t.has("the"));
  assert.ok(!t.has("a"));
});

test("tokenize: handles non-string input and short tokens", () => {
  assert.equal(tokenize(null).size, 0);
  assert.equal(tokenize("").size, 0);
  const t = tokenize("a big cat");
  assert.ok(!t.has("a"));
  assert.ok(t.has("big"));
  assert.ok(t.has("cat"));
});

test("jaccard: identical sets -> 1.0", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
});

test("jaccard: disjoint sets -> 0", () => {
  assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
});

test("jaccard: partial overlap -> intersection / union", () => {
  const j = jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]));
  assert.ok(Math.abs(j - 0.5) < 0.001);
});

test("jaccard: both empty -> 1", () => {
  assert.equal(jaccard(new Set(), new Set()), 1);
});

test("classifyPolarity: affirmative phrases", () => {
  assert.equal(classifyPolarity("Yes, this is correct."), "affirmative");
  assert.equal(classifyPolarity("Indeed, the answer is right."), "affirmative");
});

test("classifyPolarity: negative phrases", () => {
  assert.equal(classifyPolarity("No, this is not accurate."), "negative");
  assert.equal(classifyPolarity("That is incorrect."), "negative");
});

test("classifyPolarity: ambiguous text -> unknown", () => {
  assert.equal(classifyPolarity("Consider the implications of this approach."), "unknown");
  assert.equal(classifyPolarity(""), "unknown");
});

test("extractNumbers: pulls leading numbers from text", () => {
  const nums = extractNumbers("The answer is 42, with a margin of 0.5.");
  assert.deepEqual(nums, [42, 0.5]);
});

test("extractNumbers: handles negatives and decimals", () => {
  const nums = extractNumbers("Temperature dropped from -5 to -12.3 degrees.");
  assert.deepEqual(nums, [-5, -12.3]);
});

test("extractNumbers: empty / non-string returns []", () => {
  assert.deepEqual(extractNumbers(""), []);
  assert.deepEqual(extractNumbers(null), []);
});

test("detectConflicts: <2 responses -> no conflict", () => {
  const r = detectConflicts([{ specialist: "a", output: "solo answer" }]);
  assert.equal(r.hasConflict, false);
  assert.equal(r.conflictType, "none");
});

test("detectConflicts: high similarity responses -> no conflict", () => {
  const r = detectConflicts([
    { specialist: "a", output: "The fix is to bump the version in package.json and redeploy." },
    { specialist: "b", output: "To fix this, bump version in package.json and redeploy it." },
  ]);
  assert.equal(r.hasConflict, false);
  assert.ok(r.similarity > 0.3);
});

test("detectConflicts: polarity conflict beats similarity", () => {
  const r = detectConflicts([
    { specialist: "a", output: "Yes, definitely use the new approach." },
    { specialist: "b", output: "No, do not use the new approach." },
  ]);
  assert.equal(r.hasConflict, true);
  assert.equal(r.conflictType, "polarity");
  assert.deepEqual(r.polarityCamps, ["affirmative", "negative"]);
});

test("detectConflicts: numeric conflict detected when different lead numbers", () => {
  const r = detectConflicts([
    { specialist: "a", output: "There are 42 users affected by this bug." },
    { specialist: "b", output: "About 73 users are affected according to logs." },
  ]);
  assert.equal(r.hasConflict, true);
  assert.equal(r.conflictType, "numeric");
  assert.ok(r.numericValues.includes(42));
  assert.ok(r.numericValues.includes(73));
});

test("detectConflicts: divergent responses (low similarity) flagged as divergent", () => {
  const r = detectConflicts([
    { specialist: "researcher", output: "Kubernetes pods scaled automatically via HPA." },
    { specialist: "executor", output: "Database migration script creates users table." },
  ]);
  assert.equal(r.hasConflict, true);
  assert.equal(r.conflictType, "divergent");
  assert.ok(r.similarity < 0.25);
});

test("detectConflicts: partial overlap flagged as 'partial'", () => {
  const r = detectConflicts([
    { specialist: "a", output: "The authentication service uses JWT tokens signed with RS256 keys issued hourly by the ops team which rotates them." },
    { specialist: "b", output: "Authentication service issues tokens rotated daily by admins via different service accounts entirely." },
  ], { divergenceThreshold: 0.15, partialThreshold: 0.6 });
  assert.equal(r.hasConflict, true);
  assert.ok(["partial", "divergent"].includes(r.conflictType));
});

test("detectConflicts: skips responses with missing output", () => {
  const r = detectConflicts([
    { specialist: "a", output: "yes this works" },
    { specialist: "b" },
    { specialist: "c", output: null },
  ]);
  // Only "a" is a valid response -> no conflict possible
  assert.equal(r.hasConflict, false);
});

test("buildReconciliationPrompt: returns null when no conflict", () => {
  const report = { hasConflict: false, conflictType: "none", specialists: [], polarityCamps: [], numericValues: [], similarity: 1, summary: "" };
  assert.equal(buildReconciliationPrompt([], report), null);
});

test("buildReconciliationPrompt: includes each specialist output and a reconciliation instruction", () => {
  const responses = [
    { specialist: "a", output: "Yes, use the new approach." },
    { specialist: "b", output: "No, stick with the old approach." },
  ];
  const report = detectConflicts(responses);
  const prompt = buildReconciliationPrompt(responses, report);
  assert.ok(prompt);
  assert.match(prompt, /conflicting answers/);
  assert.match(prompt, /Conflict type: polarity/);
  assert.match(prompt, /--- a ---/);
  assert.match(prompt, /--- b ---/);
  assert.match(prompt, /reconciliation/);
});

test("buildReconciliationPrompt: numeric conflict prompt names the numbers", () => {
  const responses = [
    { specialist: "x", output: "There are 10 records." },
    { specialist: "y", output: "There are 25 records." },
  ];
  const report = detectConflicts(responses);
  const prompt = buildReconciliationPrompt(responses, report);
  assert.ok(prompt);
  assert.match(prompt, /10/);
  assert.match(prompt, /25/);
});

test("buildReconciliationPrompt: truncates long responses", () => {
  const long = "a".repeat(5000);
  const responses = [
    { specialist: "a", output: `Yes, answer ${long}` },
    { specialist: "b", output: `No, answer ${long}` },
  ];
  const report = detectConflicts(responses);
  const prompt = buildReconciliationPrompt(responses, report, { maxChars: 500 });
  assert.ok(prompt);
  assert.match(prompt, /truncated/);
  assert.ok(prompt.length < 5000);
});

test("analyzeSwarmConflicts: returns null when no conflict", () => {
  const out = analyzeSwarmConflicts([
    { specialist: "a", output: "bump version redeploy services" },
    { specialist: "b", output: "bump version redeploy services cleanly" },
  ]);
  assert.equal(out, null);
});

test("analyzeSwarmConflicts: returns {report, prompt} on conflict", () => {
  const out = analyzeSwarmConflicts([
    { specialist: "a", output: "Yes this works." },
    { specialist: "b", output: "No, this does not work." },
  ]);
  assert.ok(out);
  assert.equal(out.report.conflictType, "polarity");
  assert.match(out.prompt, /polarity/);
});
