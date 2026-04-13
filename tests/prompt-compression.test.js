/**
 * Phase 58.3: Prompt compression tests.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  compressPrompt,
  estimateSavings,
  estimateTokens,
  COMPRESSION_MODES,
  _internals,
} = await import("../lib/prompt-compression.js");

test("COMPRESSION_MODES lists the four modes", () => {
  assert.deepEqual([...COMPRESSION_MODES], ["whitespace", "stopwords", "sentences", "auto"]);
});

test("estimateTokens uses chars/4 rule", () => {
  assert.equal(estimateTokens("hello world"), 3);
  assert.equal(estimateTokens(""), 0);
});

test("compressPrompt is a no-op when PROMPT_COMPRESSION is not set", () => {
  delete process.env.PROMPT_COMPRESSION;
  const r = compressPrompt("The quick brown fox jumps over the lazy dog.");
  assert.equal(r.mode, "disabled");
  assert.equal(r.ratio, 1);
  assert.match(r.text, /quick brown fox/);
});

test("compressPrompt collapses whitespace in whitespace mode", () => {
  const r = compressPrompt("foo    bar\n\n\n\nbaz", { mode: "whitespace", force: true });
  assert.equal(r.mode, "whitespace");
  assert.match(r.text, /foo bar/);
  assert.ok(!/\n{3,}/.test(r.text));
});

test("compressPrompt drops stopwords under 'stopwords' mode", () => {
  const r = compressPrompt("The cat sat on the very big mat.", { mode: "stopwords", force: true });
  assert.equal(r.mode, "stopwords");
  assert.ok(!/\bthe\b/i.test(r.text));
  assert.ok(!/\bvery\b/i.test(r.text));
  assert.match(r.text, /cat sat/i);
});

test("compressPrompt prunes sentences under 'sentences' mode", () => {
  const input = [
    "First sentence here for context.",
    "Second is more important because it mentions keywords like API.",
    "Third sentence is trivial.",
    "Fourth sentence is also trivial.",
    "Fifth sentence is trivial.",
  ].join(" ");
  const r = compressPrompt(input, {
    mode: "sentences",
    targetTokens: 20,
    keywords: ["API"],
    force: true,
  });
  assert.equal(r.mode, "sentences");
  assert.ok(r.text.includes("API"), "keyword sentence should be retained");
  assert.ok(r.compressedTokens <= r.originalTokens);
});

test("compressPrompt 'auto' mode targets token budget", () => {
  const input = "This is sentence one. This is sentence two. This is sentence three. This is sentence four.";
  const r = compressPrompt(input, { mode: "auto", targetTokens: 5, force: true });
  assert.ok(r.compressedTokens <= r.originalTokens);
  assert.ok(r.ratio < 1);
});

test("compressPrompt validates input", () => {
  assert.throws(() => compressPrompt(123, { force: true }), /text must be a string/);
});

test("estimateSavings runs even when feature flag is off", () => {
  delete process.env.PROMPT_COMPRESSION;
  const r = estimateSavings("The quick brown fox jumps.", { mode: "stopwords" });
  assert.ok(r.compressedTokens <= r.originalTokens);
  assert.notEqual(r.mode, "disabled");
});

test("compressPrompt is a no-op on already tight text", () => {
  delete process.env.PROMPT_COMPRESSION;
  const r = compressPrompt("x", { force: true });
  assert.ok(r.compressedTokens <= 1);
});

test("splitSentences handles punctuation", () => {
  const out = _internals.splitSentences("Hello. World! How? Fine.");
  assert.equal(out.length, 4);
});

test("scoreSentence rewards keywords and numbers", () => {
  const withKw = _internals.scoreSentence("Mention the API key here.", ["api"]);
  const without = _internals.scoreSentence("Mention the thing here.", ["api"]);
  assert.ok(withKw > without);
});

test("when PROMPT_COMPRESSION=1, compressPrompt auto-applies", () => {
  process.env.PROMPT_COMPRESSION = "1";
  const r = compressPrompt("The   cat sat on the mat.");
  delete process.env.PROMPT_COMPRESSION;
  assert.notEqual(r.mode, "disabled");
});
