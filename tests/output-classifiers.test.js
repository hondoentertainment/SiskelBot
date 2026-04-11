/**
 * Phase 51.3: Tests for lib/output-classifiers.js.
 *
 * Covers toxicity, PII, bias, hallucination, streaming classifier, unified
 * report, event logging and stats aggregation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated STORAGE_PATH so persisted events don't leak into the repo data dir.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-output-classifiers-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  classifyToxicity,
  detectPii,
  redactPii,
  classifyBias,
  detectHallucination,
  StreamingClassifier,
  classifyOutput,
  logClassificationEvent,
  getClassificationStats,
  luhnCheck,
  TOXICITY_KEYWORDS,
  PII_PATTERNS,
  BIAS_LEXICONS,
  _resetStore,
} = await import("../lib/output-classifiers.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ─── Toxicity ────────────────────────────────────────────────────────────────

test("classifyToxicity: benign text is not flagged", () => {
  const r = classifyToxicity("The weather is nice today and the cat is happy.");
  assert.equal(r.toxic, false);
  assert.equal(r.score, 0);
  assert.deepEqual(r.flagged, []);
});

test("classifyToxicity: hate speech category detected", () => {
  const r = classifyToxicity("That group is subhuman and inferior race material.");
  assert.equal(r.toxic, true);
  assert.ok(r.score > 0);
  assert.ok(r.categories.hate >= 1);
  assert.ok(r.flagged.some((f) => f.category === "hate"));
});

test("classifyToxicity: violence category detected", () => {
  const r = classifyToxicity("I'm going to kill and attack them with a bomb.");
  assert.equal(r.toxic, true);
  assert.ok(r.categories.violence >= 1);
});

test("classifyToxicity: self-harm category detected", () => {
  const r = classifyToxicity("I want to kill myself and overdose tonight.");
  assert.equal(r.toxic, true);
  assert.ok(r.categories.self_harm >= 1);
});

test("classifyToxicity: score saturates at 1", () => {
  const blob =
    "hate hate racist bigot kill murder attack bomb kill yourself overdose stupid idiot moron worthless racist hate";
  const r = classifyToxicity(blob);
  assert.equal(r.toxic, true);
  assert.ok(r.score <= 1);
  assert.ok(r.score >= 0.9);
});

test("classifyToxicity: empty/null input is safe", () => {
  assert.equal(classifyToxicity("").toxic, false);
  assert.equal(classifyToxicity(null).toxic, false);
  assert.equal(classifyToxicity(undefined).toxic, false);
});

test("TOXICITY_KEYWORDS has all documented categories", () => {
  assert.ok(TOXICITY_KEYWORDS.hate);
  assert.ok(TOXICITY_KEYWORDS.violence);
  assert.ok(TOXICITY_KEYWORDS.sexual);
  assert.ok(TOXICITY_KEYWORDS.self_harm);
  assert.ok(TOXICITY_KEYWORDS.harassment);
});

// ─── PII ─────────────────────────────────────────────────────────────────────

test("detectPii: email is found", () => {
  const r = detectPii("Contact me at alice@example.com for details.");
  assert.equal(r.found, true);
  assert.ok(r.types.includes("email"));
  assert.ok(r.matches.some((m) => m.type === "email" && m.value === "alice@example.com"));
});

test("detectPii: phone number is found", () => {
  const r = detectPii("Call me at 415-555-2671 or (212) 555-0199 tomorrow.");
  assert.equal(r.found, true);
  assert.ok(r.types.includes("phone"));
  assert.ok(r.matches.filter((m) => m.type === "phone").length >= 2);
});

test("detectPii: SSN is found", () => {
  const r = detectPii("His SSN is 123-45-6789, please redact.");
  assert.equal(r.found, true);
  assert.ok(r.types.includes("ssn"));
});

test("detectPii: valid credit card passes Luhn", () => {
  // 4111-1111-1111-1111 is a well-known Visa test number.
  assert.equal(luhnCheck("4111111111111111"), true);
  const r = detectPii("Card on file: 4111-1111-1111-1111");
  assert.equal(r.found, true);
  assert.ok(r.types.includes("credit_card"));
});

test("detectPii: invalid credit card rejected by Luhn", () => {
  // Random 16-digit sequence that fails Luhn.
  assert.equal(luhnCheck("1234567890123456"), false);
  const r = detectPii("Not a card: 1234567890123456");
  assert.ok(!r.types.includes("credit_card"));
});

test("detectPii: IP address is found", () => {
  const r = detectPii("The server is at 192.168.1.42 and 10.0.0.1.");
  assert.equal(r.found, true);
  assert.ok(r.types.includes("ip_address"));
});

test("detectPii: API key token is found", () => {
  const r = detectPii("Use this token: sk-1234567890abcdef1234567890abcdef");
  assert.equal(r.found, true);
  assert.ok(r.types.includes("api_key"));
});

test("detectPii: JWT is found", () => {
  const jwt =
    "eyJhbGciOi.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI.SflKxwRJSMeKKF2QT4fwpMeJf36POk";
  const r = detectPii(`Bearer ${jwt}`);
  assert.equal(r.found, true);
  assert.ok(r.types.includes("jwt"));
});

test("detectPii: PII_PATTERNS exposes expected keys", () => {
  for (const k of ["email", "phone", "ssn", "credit_card", "ip_address", "api_key", "jwt"]) {
    assert.ok(PII_PATTERNS[k], `missing pattern: ${k}`);
  }
});

test("detectPii: matches are sorted by position", () => {
  const r = detectPii("SSN 123-45-6789 then email bob@example.org tail.");
  assert.equal(r.found, true);
  for (let i = 1; i < r.matches.length; i++) {
    assert.ok(r.matches[i].start >= r.matches[i - 1].start);
  }
});

test("redactPii: replaces matches with placeholder", () => {
  const { text, redactedCount } = redactPii("My email is a@b.co and ssn 123-45-6789.");
  assert.ok(text.includes("[REDACTED]"));
  assert.ok(!text.includes("a@b.co"));
  assert.ok(!text.includes("123-45-6789"));
  assert.equal(redactedCount, 2);
});

test("redactPii: hash mode produces stable hashes", () => {
  const a = redactPii("email alice@example.com", { mode: "hash" });
  const b = redactPii("email alice@example.com", { mode: "hash" });
  assert.equal(a.text, b.text);
  assert.ok(a.text.includes("[EMAIL:sha256:"));
});

test("redactPii: mask mode replaces with asterisks", () => {
  const r = redactPii("SSN 123-45-6789 here", { mode: "mask" });
  assert.ok(/\*{4,}/.test(r.text));
  assert.ok(!r.text.includes("123-45-6789"));
});

test("redactPii: types filter limits what gets redacted", () => {
  const r = redactPii("email a@b.co and SSN 123-45-6789", { types: ["email"] });
  assert.ok(!r.text.includes("a@b.co"));
  assert.ok(r.text.includes("123-45-6789"));
});

// ─── Bias ────────────────────────────────────────────────────────────────────

test("classifyBias: stereotyped statement flagged", () => {
  const r = classifyBias("Women are bad at math and men are always better.");
  assert.equal(r.biased, true);
  assert.ok(r.score > 0);
  assert.ok(r.categories.gender >= 1);
});

test("classifyBias: neutral statement not flagged", () => {
  const r = classifyBias("Women and men both contributed to the project.");
  assert.equal(r.biased, false);
  assert.equal(r.score, 0);
});

test("classifyBias: race category with trigger word", () => {
  const r = classifyBias("Asians are always good at math, every single one.");
  assert.equal(r.biased, true);
  assert.ok(r.categories.race >= 1);
});

test("BIAS_LEXICONS exposes protected classes", () => {
  assert.ok(BIAS_LEXICONS.gender);
  assert.ok(BIAS_LEXICONS.race);
  assert.ok(BIAS_LEXICONS.age);
  assert.ok(BIAS_LEXICONS.religion);
});

// ─── Hallucination ───────────────────────────────────────────────────────────

test("detectHallucination: confident unhedged claim is flagged", () => {
  const r = detectHallucination(
    "This is definitely true and absolutely proven without question.",
  );
  assert.ok(r.flags.includes("confident_unhedged"));
  assert.ok(r.confidence > 0);
});

test("detectHallucination: hedged claim is not flagged", () => {
  const r = detectHallucination("I think this might possibly be the case, perhaps.");
  assert.equal(r.likelyHallucination, false);
});

test("detectHallucination: multiple specific numbers flagged", () => {
  const r = detectHallucination("The rate is 87% and the growth is 42% over 18% baseline.");
  assert.ok(r.flags.includes("specific_numbers_unhedged"));
});

test("detectHallucination: ground truth match reduces confidence", () => {
  const claim = "The capital of France is Paris located in Europe.";
  const truth = "Paris is the capital city of France in Europe.";
  const r = detectHallucination(claim, truth);
  assert.ok(typeof r.overlap === "number");
  assert.ok(r.overlap > 0.3);
  assert.equal(r.likelyHallucination, false);
});

test("detectHallucination: ground truth mismatch raises confidence", () => {
  const claim = "The capital of France is Madrid and the population is 50 million.";
  const truth = "The main language of Japan is Japanese.";
  const r = detectHallucination(claim, truth);
  assert.ok(r.overlap < 0.1);
  assert.ok(r.flags.includes("no_overlap_with_ground_truth"));
  assert.ok(r.confidence >= 0.4);
});

// ─── Streaming classifier ────────────────────────────────────────────────────

test("StreamingClassifier: processes chunks without blocking benign text", () => {
  const sc = new StreamingClassifier({ classifyEveryNChars: 10 });
  const chunks = ["Hello", " world", " this is", " fine text"];
  for (const c of chunks) {
    const r = sc.feed(c);
    assert.equal(r.blocked, false);
  }
  const report = sc.getFinalReport();
  assert.equal(report.blocked, false);
  assert.equal(report.chunkCount, 4);
  assert.equal(report.toxicity.toxic, false);
});

test("StreamingClassifier: flags toxic content and blocks further feeds", () => {
  const sc = new StreamingClassifier({ classifyEveryNChars: 1, blockOnToxic: true, toxicityThreshold: 0.3 });
  const r1 = sc.feed("I will ");
  assert.equal(r1.blocked, false);
  const r2 = sc.feed("kill and attack you and bomb the place");
  assert.equal(r2.blocked, true);
  assert.equal(r2.violation.type, "toxicity");
  // Subsequent feeds are no-ops once blocked.
  const r3 = sc.feed("more text");
  assert.equal(r3.blocked, true);
});

test("StreamingClassifier: flags on getFinalReport even without threshold trigger", () => {
  const sc = new StreamingClassifier({ classifyEveryNChars: 10_000, blockOnToxic: false });
  sc.feed("Contact me: alice@example.com");
  const report = sc.getFinalReport();
  assert.equal(report.pii.found, true);
  assert.ok(report.pii.types.includes("email"));
});

test("StreamingClassifier: PII blocking triggers on threshold", () => {
  const sc = new StreamingClassifier({ classifyEveryNChars: 1, blockOnPii: true });
  const r = sc.feed("email me at bob@example.com please");
  assert.equal(r.blocked, true);
  assert.equal(r.violation.type, "pii");
});

test("StreamingClassifier: reset clears state", () => {
  const sc = new StreamingClassifier();
  sc.feed("kill and murder and attack");
  sc.feed("bomb and more kill and murder and attack content here");
  sc.reset();
  assert.equal(sc.buffer, "");
  assert.equal(sc.chunkCount, 0);
  assert.equal(sc.blocked, false);
});

test("StreamingClassifier: max buffer caps memory", () => {
  const sc = new StreamingClassifier({ maxBuffer: 100, classifyEveryNChars: 1_000_000 });
  sc.feed("a".repeat(500));
  assert.ok(sc.buffer.length <= 100);
});

// ─── Unified classifier ──────────────────────────────────────────────────────

test("classifyOutput: unified report on safe text", async () => {
  const r = await classifyOutput("Hello, the weather is nice today.");
  assert.equal(r.safe, true);
  assert.equal(r.severity, 0);
  assert.equal(r.toxicity.toxic, false);
  assert.equal(r.pii.found, false);
  assert.equal(r.bias.biased, false);
  assert.equal(r.hallucination.likelyHallucination, false);
});

test("classifyOutput: unified report flags multiple issues", async () => {
  const r = await classifyOutput(
    "I hate them, email me at alice@example.com, they are definitely always wrong.",
  );
  assert.equal(r.safe, false);
  assert.ok(r.severity > 0);
  assert.equal(r.pii.found, true);
  assert.ok(r.pii.count >= 1);
});

test("classifyOutput: groundTruth option passed to hallucination", async () => {
  const r = await classifyOutput("Paris is definitely the capital of France.", {
    groundTruth: "Paris is the capital of France.",
  });
  assert.ok(typeof r.hallucination.overlap === "number");
});

test("classifyOutput: includeFlagged reveals PII matches", async () => {
  const r = await classifyOutput("email alice@example.com", { includeFlagged: true });
  assert.ok(Array.isArray(r.pii.matches));
  assert.ok(r.pii.matches.length >= 1);
});

// ─── Persistence ─────────────────────────────────────────────────────────────

test("logClassificationEvent: persists event with id and hash", async () => {
  await _resetStore();
  const ev = await logClassificationEvent({
    source: "test",
    workspaceId: "ws-1",
    userId: "u-1",
    text: "hello world",
    report: { toxicity: { toxic: false }, pii: { found: false }, bias: { biased: false }, hallucination: { likelyHallucination: false } },
  });
  assert.ok(ev.id);
  assert.ok(ev.timestamp);
  assert.equal(ev.source, "test");
  assert.ok(ev.textHash?.startsWith("sha256:"));
  // Raw text is not persisted verbatim.
  assert.equal(ev.textPreview, "hello world");
});

test("getClassificationStats: aggregates by category", async () => {
  await _resetStore();
  await logClassificationEvent({
    source: "chat",
    workspaceId: "ws-1",
    text: "bad",
    report: {
      toxicity: { toxic: true, categories: { hate: 1 } },
      pii: { found: false, types: [] },
      bias: { biased: false },
      hallucination: { likelyHallucination: false },
    },
  });
  await logClassificationEvent({
    source: "chat",
    workspaceId: "ws-1",
    text: "pii",
    report: {
      toxicity: { toxic: false, categories: {} },
      pii: { found: true, types: ["email"] },
      bias: { biased: false },
      hallucination: { likelyHallucination: false },
    },
  });
  await logClassificationEvent({
    source: "agent",
    workspaceId: "ws-2",
    text: "hallu",
    report: {
      toxicity: { toxic: false, categories: {} },
      pii: { found: false, types: [] },
      bias: { biased: true, categories: { gender: 1 } },
      hallucination: { likelyHallucination: true },
    },
  });

  const all = await getClassificationStats();
  assert.equal(all.total, 3);
  assert.equal(all.toxic, 1);
  assert.equal(all.pii, 1);
  assert.equal(all.biased, 1);
  assert.equal(all.hallucination, 1);
  assert.equal(all.byCategory.toxicity.hate, 1);
  assert.equal(all.byCategory.pii.email, 1);
  assert.equal(all.byCategory.bias.gender, 1);
  assert.equal(all.bySource.chat, 2);
  assert.equal(all.bySource.agent, 1);

  const ws1 = await getClassificationStats({ workspaceId: "ws-1" });
  assert.equal(ws1.total, 2);

  const chatOnly = await getClassificationStats({ source: "chat" });
  assert.equal(chatOnly.total, 2);
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

test("empty text is handled by all classifiers", async () => {
  assert.equal(classifyToxicity("").toxic, false);
  assert.equal(detectPii("").found, false);
  assert.equal(classifyBias("").biased, false);
  assert.equal(detectHallucination("").likelyHallucination, false);
  const r = await classifyOutput("");
  assert.equal(r.safe, true);
});

test("unicode text is handled", async () => {
  const text = "Hola! こんにちは мир — no issues here 🎉";
  const r = await classifyOutput(text);
  assert.equal(r.safe, true);
  const { found } = detectPii(text);
  assert.equal(found, false);
});

test("very long text is handled", async () => {
  const longBenign = "The quick brown fox jumps over the lazy dog. ".repeat(1000);
  const r = await classifyOutput(longBenign);
  assert.equal(r.safe, true);

  const sc = new StreamingClassifier({ classifyEveryNChars: 500 });
  for (let i = 0; i < 20; i++) sc.feed(longBenign.slice(0, 200));
  const report = sc.getFinalReport();
  assert.equal(report.blocked, false);
  assert.ok(report.bufferLength <= sc.options.maxBuffer);
});
