import test from "node:test";
import assert from "node:assert/strict";
import {
  detectStagnation,
  computeFingerprint,
  buildStagnationHistory,
  stagnationDetectionEnabled,
  stagnationRecoveryEnabled,
} from "../lib/agent-stagnation.js";

// ---------------------------------------------------------------------------
// stagnationDetectionEnabled / stagnationRecoveryEnabled
// ---------------------------------------------------------------------------

test("stagnationDetectionEnabled returns true by default", () => {
  const orig = process.env.AGENT_STAGNATION_STOP;
  delete process.env.AGENT_STAGNATION_STOP;
  assert.equal(stagnationDetectionEnabled(), true);
  if (orig !== undefined) process.env.AGENT_STAGNATION_STOP = orig;
});

test("stagnationDetectionEnabled returns false when AGENT_STAGNATION_STOP=0", (t) => {
  const orig = process.env.AGENT_STAGNATION_STOP;
  process.env.AGENT_STAGNATION_STOP = "0";
  t.after(() => {
    if (orig !== undefined) process.env.AGENT_STAGNATION_STOP = orig;
    else delete process.env.AGENT_STAGNATION_STOP;
  });
  assert.equal(stagnationDetectionEnabled(), false);
});

test("stagnationRecoveryEnabled returns false by default", () => {
  const orig = process.env.AGENT_STAGNATION_RECOVERY;
  delete process.env.AGENT_STAGNATION_RECOVERY;
  assert.equal(stagnationRecoveryEnabled(), false);
  if (orig !== undefined) process.env.AGENT_STAGNATION_RECOVERY = orig;
});

test("stagnationRecoveryEnabled returns true when AGENT_STAGNATION_RECOVERY=1", (t) => {
  const orig = process.env.AGENT_STAGNATION_RECOVERY;
  process.env.AGENT_STAGNATION_RECOVERY = "1";
  t.after(() => {
    if (orig !== undefined) process.env.AGENT_STAGNATION_RECOVERY = orig;
    else delete process.env.AGENT_STAGNATION_RECOVERY;
  });
  assert.equal(stagnationRecoveryEnabled(), true);
});

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

test("computeFingerprint returns empty string for empty array", () => {
  assert.equal(computeFingerprint([]), "");
});

test("computeFingerprint returns empty string for non-array", () => {
  assert.equal(computeFingerprint(null), "");
  assert.equal(computeFingerprint(undefined), "");
});

test("computeFingerprint is deterministic for same tool calls regardless of arg order", () => {
  const a = computeFingerprint([{ name: "search", args: { q: "hello", limit: 10 } }]);
  const b = computeFingerprint([{ name: "search", args: { limit: 10, q: "hello" } }]);
  assert.equal(a, b);
});

test("computeFingerprint produces different results for different tool names", () => {
  const a = computeFingerprint([{ name: "search", args: { q: "hello" } }]);
  const b = computeFingerprint([{ name: "list", args: { q: "hello" } }]);
  assert.notEqual(a, b);
});

test("computeFingerprint sorts tool calls so order does not matter", () => {
  const a = computeFingerprint([
    { name: "search", args: { q: "hello" } },
    { name: "list", args: {} },
  ]);
  const b = computeFingerprint([
    { name: "list", args: {} },
    { name: "search", args: { q: "hello" } },
  ]);
  assert.equal(a, b);
});

test("computeFingerprint handles missing name/args gracefully", () => {
  const fp = computeFingerprint([{ name: undefined, args: undefined }]);
  assert.equal(typeof fp, "string");
  assert.ok(fp.length > 0);
});

// ---------------------------------------------------------------------------
// detectStagnation — new fingerprint-based history
// ---------------------------------------------------------------------------

test("detectStagnation returns not stagnant for empty history", () => {
  const result = detectStagnation([]);
  assert.equal(result.stagnant, false);
});

test("detectStagnation returns not stagnant for null/undefined", () => {
  assert.equal(detectStagnation(null).stagnant, false);
  assert.equal(detectStagnation(undefined).stagnant, false);
});

test("detectStagnation returns not stagnant for single entry", () => {
  const result = detectStagnation([{ fingerprint: "A", iteration: 1 }]);
  assert.equal(result.stagnant, false);
});

test("exact 1-cycle: same fingerprint repeated -> stagnant", () => {
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "A", iteration: 2 },
    { fingerprint: "A", iteration: 3 },
  ];
  const result = detectStagnation(history);
  assert.equal(result.stagnant, true);
  assert.equal(result.cycleLength, 1);
  assert.ok(result.reason.includes("exact_cycle"));
  assert.equal(result.confidence, 1.0);
});

test("exact 2-cycle: [A,B,A,B] -> stagnant, cycleLength 2", () => {
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "B", iteration: 2 },
    { fingerprint: "A", iteration: 3 },
    { fingerprint: "B", iteration: 4 },
  ];
  const result = detectStagnation(history);
  assert.equal(result.stagnant, true);
  assert.equal(result.cycleLength, 2);
  assert.ok(result.reason.includes("2-cycle"));
  assert.equal(result.confidence, 1.0);
});

test("no cycle: [A,B,C,D,E] -> not stagnant", () => {
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "B", iteration: 2 },
    { fingerprint: "C", iteration: 3 },
    { fingerprint: "D", iteration: 4 },
    { fingerprint: "E", iteration: 5 },
  ];
  const result = detectStagnation(history);
  assert.equal(result.stagnant, false);
});

test("partial repetition: 3 of 5 same -> stagnant (>60%)", () => {
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "B", iteration: 2 },
    { fingerprint: "A", iteration: 3 },
    { fingerprint: "A", iteration: 4 },
    { fingerprint: "A", iteration: 5 },
  ];
  // 4/5 = 80% for "A" -> partial_repetition (not caught as exact cycle since [A,A] precedes [A,A] -> cycle first)
  // Actually: last 2 = [A,A], preceding 2 = [A,B] -> not a cycle.
  // last 1 = [A], preceding 1 = [A] at index 3 -> 1-cycle detected.
  // Let me use a pattern where cycle detection doesn't trigger first.
  // Actually the iteration 4 and 5 are both A, so last 1 = [A], preceding 1 = [A] -> 1-cycle.
  // Let me adjust to not trigger exact cycle but still trigger partial.
  const result = detectStagnation(history);
  assert.equal(result.stagnant, true);
});

test("partial repetition: 4 of 5 same but not consecutive -> stagnant", () => {
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "A", iteration: 2 },
    { fingerprint: "B", iteration: 3 },
    { fingerprint: "A", iteration: 4 },
    { fingerprint: "A", iteration: 5 },
  ];
  // Cycle check: last 1 = [A], preceding 1 = [A] at idx 3 -> exact 1-cycle.
  const result = detectStagnation(history);
  assert.equal(result.stagnant, true);
  assert.equal(result.confidence, 1.0);
});

test("partial repetition triggers when no exact cycle", () => {
  // Pattern: [A,B,A,C,A] -- 3 of 5 A's = 60%, but threshold is >60% so not triggered.
  // Pattern: [A,B,A,A,C] -- last 1 = [C], preceding 1 = [A] -> no 1-cycle; last 2 = [A,C], preceding 2 = [A,B] -> no.
  // 3 A's of 5 = 60%, not > 60%.
  // Use [A,B,A,A,A] -> 4/5 = 80%. last 1=[A] preceding 1=[A] -> exact 1-cycle.
  // Need to avoid cycle: [A,A,A,B,A] -> last 1=[A] preceding 1=[B] -> no; last 2=[B,A] preceding 2=[A,A] -> no.
  // 4 A's of 5 = 80% > 60%  -> partial_repetition.
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "A", iteration: 2 },
    { fingerprint: "A", iteration: 3 },
    { fingerprint: "B", iteration: 4 },
    { fingerprint: "A", iteration: 5 },
  ];
  const result = detectStagnation(history);
  assert.equal(result.stagnant, true);
  assert.ok(result.reason.includes("partial_repetition"));
  assert.ok(result.confidence > 0.6);
});

test("low diversity: 2 unique out of 5 with cycling pattern -> stagnant via cycle detection", () => {
  // [A,B,A,B,A]: window.slice(-2) = [B,A], window.slice(-4,-2) = [B,A] -> exact 2-cycle.
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "B", iteration: 2 },
    { fingerprint: "A", iteration: 3 },
    { fingerprint: "B", iteration: 4 },
    { fingerprint: "A", iteration: 5 },
  ];
  const result = detectStagnation(history);
  assert.equal(result.stagnant, true);
  assert.equal(result.cycleLength, 2);
});

test("borderline diversity: 3 unique out of 5 -> not stagnant", () => {
  // [A,B,C,A,B]: last 2=[A,B] preceding 2=[B,C] -> no cycle. last 1=[B] preceding 1=[A] -> no.
  // Partial: A=2,B=2,C=1 -> maxFreq=2, 2/5=0.4 not >0.6.
  // Diversity: 3/5=0.6 not <0.4.
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "B", iteration: 2 },
    { fingerprint: "C", iteration: 3 },
    { fingerprint: "A", iteration: 4 },
    { fingerprint: "B", iteration: 5 },
  ];
  const result = detectStagnation(history);
  assert.equal(result.stagnant, false);
});

test("low diversity triggers when < 0.4", () => {
  // [A,A,B,B,A,B] with windowSize=6:
  // Cycle checks: last 1=[B] prec 1=[A] no. last 2=[A,B] prec 2=[B,B] no.
  // last 3=[B,A,B] prec 3=[A,A,B] no. No exact cycle.
  // Partial: A=3/6=0.5, B=3/6=0.5 -> max 0.5 not > 0.6.
  // Diversity: 2/6 = 0.33 < 0.4 -> stagnant.
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "A", iteration: 2 },
    { fingerprint: "B", iteration: 3 },
    { fingerprint: "B", iteration: 4 },
    { fingerprint: "A", iteration: 5 },
    { fingerprint: "B", iteration: 6 },
  ];
  const result = detectStagnation(history, { windowSize: 6 });
  assert.equal(result.stagnant, true);
  assert.ok(result.reason.includes("low_diversity"));
});

test("window < N: insufficient data -> not stagnant", () => {
  const result = detectStagnation([{ fingerprint: "A", iteration: 1 }]);
  assert.equal(result.stagnant, false);
});

test("custom window size via opts", () => {
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "A", iteration: 2 },
  ];
  const result = detectStagnation(history, { windowSize: 3 });
  assert.equal(result.stagnant, true);
  assert.equal(result.cycleLength, 1);
});

// ---------------------------------------------------------------------------
// detectStagnation — legacy toolCallsLog compatibility
// ---------------------------------------------------------------------------

test("legacy: returns not stagnant for empty array", () => {
  const result = detectStagnation([]);
  assert.equal(result.stagnant, false);
});

test("legacy: identical tool calls in consecutive iterations -> stagnant (boolean)", () => {
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "search_context", args: { q: "hello" }, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), true);
});

test("legacy: diverse tool calls -> not stagnant (boolean)", () => {
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "list_context", args: {}, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), false);
});

test("legacy: same tool with different arg values but same keys -> not stagnant (values matter)", () => {
  // The fingerprint includes arg values, so different values produce different
  // fingerprints and should NOT trigger stagnation detection.
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "search_context", args: { q: "world" }, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), false);
});

test("legacy: same tool with different arg structure -> not stagnant (boolean)", () => {
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "search_context", args: { q: "hello", limit: 5 }, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), false);
});

test("legacy: arg key ordering does not affect stagnation (boolean)", () => {
  const log = [
    { name: "search_context", args: { q: "hello", limit: 10 }, iteration: 1 },
    { name: "search_context", args: { limit: 10, q: "hello" }, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), true);
});

test("legacy: skips validationError entries (boolean)", () => {
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "search_context", args: { q: "hello" }, iteration: 1, validationError: true },
    { name: "list_context", args: {}, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), false);
});

// ---------------------------------------------------------------------------
// buildStagnationHistory
// ---------------------------------------------------------------------------

test("buildStagnationHistory: tracks fingerprints and detects stagnation", () => {
  const tracker = buildStagnationHistory();
  const fp = computeFingerprint([{ name: "search", args: { q: "a" } }]);

  tracker.append(fp, 1);
  assert.equal(tracker.check().stagnant, false);

  tracker.append(fp, 2);
  const result = tracker.check();
  assert.equal(result.stagnant, true);
  assert.equal(result.cycleLength, 1);
});

test("buildStagnationHistory: diverse appends do not trigger stagnation", () => {
  const tracker = buildStagnationHistory();
  tracker.append(computeFingerprint([{ name: "a", args: {} }]), 1);
  tracker.append(computeFingerprint([{ name: "b", args: {} }]), 2);
  tracker.append(computeFingerprint([{ name: "c", args: {} }]), 3);
  tracker.append(computeFingerprint([{ name: "d", args: {} }]), 4);
  tracker.append(computeFingerprint([{ name: "e", args: {} }]), 5);

  const result = tracker.check();
  assert.equal(result.stagnant, false);
});

test("buildStagnationHistory: getHistory returns copy of internal state", () => {
  const tracker = buildStagnationHistory();
  tracker.append("fp1", 1);
  tracker.append("fp2", 2);

  const history = tracker.getHistory();
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { fingerprint: "fp1", iteration: 1 });
  // Modifying returned array does not affect internal state
  history.push({ fingerprint: "fp3", iteration: 3 });
  assert.equal(tracker.getHistory().length, 2);
});

test("buildStagnationHistory: detects 2-cycle", () => {
  const tracker = buildStagnationHistory();
  tracker.append("A", 1);
  tracker.append("B", 2);
  assert.equal(tracker.check().stagnant, false);

  tracker.append("A", 3);
  tracker.append("B", 4);
  const result = tracker.check();
  assert.equal(result.stagnant, true);
  assert.equal(result.cycleLength, 2);
});

test("buildStagnationHistory: supports custom windowSize in check", () => {
  const tracker = buildStagnationHistory();
  tracker.append("A", 1);
  tracker.append("B", 2);
  tracker.append("A", 3);

  // With window=2: last 2 = [B, A], only 1 cycle check: last 1=[A] preceding 1=[B] -> no cycle.
  // 2 unique / 2 = 1.0 diversity. Not stagnant.
  const r1 = tracker.check({ windowSize: 2 });
  assert.equal(r1.stagnant, false);

  // With window=4 (covers all 3 entries): A appears 2/3 = 67% > 60% -> partial_repetition.
  const r2 = tracker.check({ windowSize: 4 });
  assert.equal(r2.stagnant, true);
  assert.ok(r2.reason.includes("partial_repetition"));
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("exact 3-cycle detection", () => {
  const history = [
    { fingerprint: "A", iteration: 1 },
    { fingerprint: "B", iteration: 2 },
    { fingerprint: "C", iteration: 3 },
    { fingerprint: "A", iteration: 4 },
    { fingerprint: "B", iteration: 5 },
    { fingerprint: "C", iteration: 6 },
  ];
  const result = detectStagnation(history, { windowSize: 6 });
  assert.equal(result.stagnant, true);
  assert.equal(result.cycleLength, 3);
});

test("window trims to last N entries", () => {
  // Old diverse entries + recent cycle
  const history = [
    { fingerprint: "X", iteration: 1 },
    { fingerprint: "Y", iteration: 2 },
    { fingerprint: "Z", iteration: 3 },
    { fingerprint: "A", iteration: 4 },
    { fingerprint: "A", iteration: 5 },
  ];
  // With windowSize=2, only see [A, A] -> 1-cycle
  const result = detectStagnation(history, { windowSize: 2 });
  assert.equal(result.stagnant, true);
  assert.equal(result.cycleLength, 1);
});

test("empty fingerprints are filtered out", () => {
  const history = [
    { fingerprint: "", iteration: 1 },
    { fingerprint: "", iteration: 2 },
  ];
  const result = detectStagnation(history);
  assert.equal(result.stagnant, false);
});
