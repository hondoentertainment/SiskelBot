/**
 * Tests for lib/bpe-tokenizer.js — Karpathy's minBPE in pure JavaScript.
 *
 * Covers:
 *   - getStats / merge helpers
 *   - BasicBPETokenizer training, encode/decode roundtrip, known vocab
 *     reduction, save/load, special tokens
 *   - RegexBPETokenizer regex splitting + training + encode/decode
 *   - countTokens helper with and without a trained tokenizer
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BasicBPETokenizer,
  RegexBPETokenizer,
  GPT2_SPLIT_PATTERN,
  GPT4_SPLIT_PATTERN,
  getStats,
  merge,
  bytesToUnicode,
  countTokens,
} from "../lib/bpe-tokenizer.js";

// --- getStats --------------------------------------------------------------

test("getStats counts consecutive pairs", () => {
  const stats = getStats([1, 2, 3, 1, 2]);
  assert.equal(stats.get("1,2"), 2);
  assert.equal(stats.get("2,3"), 1);
  assert.equal(stats.get("3,1"), 1);
  assert.equal(stats.size, 3);
});

test("getStats handles arrays shorter than 2", () => {
  assert.equal(getStats([]).size, 0);
  assert.equal(getStats([5]).size, 0);
});

test("getStats accumulates across multiple chunks", () => {
  const stats = getStats([
    [1, 2, 3],
    [1, 2, 4],
  ]);
  assert.equal(stats.get("1,2"), 2);
  assert.equal(stats.get("2,3"), 1);
  assert.equal(stats.get("2,4"), 1);
});

// --- merge -----------------------------------------------------------------

test("merge replaces all occurrences of a pair", () => {
  assert.deepEqual(merge([1, 2, 3, 1, 2], [1, 2], 9), [9, 3, 9]);
});

test("merge does not mutate the input", () => {
  const input = [1, 2, 3];
  const out = merge(input, [1, 2], 9);
  assert.deepEqual(input, [1, 2, 3]);
  assert.deepEqual(out, [9, 3]);
});

test("merge handles overlapping / adjacent pairs correctly", () => {
  // [1,1,1] contains only one non-overlapping (1,1).
  assert.deepEqual(merge([1, 1, 1], [1, 1], 9), [9, 1]);
  // [1,1,1,1] -> two non-overlapping pairs.
  assert.deepEqual(merge([1, 1, 1, 1], [1, 1], 9), [9, 9]);
});

test("merge with no matches returns a copy of the input", () => {
  const out = merge([1, 2, 3], [7, 8], 9);
  assert.deepEqual(out, [1, 2, 3]);
});

// --- bytesToUnicode --------------------------------------------------------

test("bytesToUnicode returns a bijective map covering all 256 bytes", () => {
  const map = bytesToUnicode();
  assert.equal(map.size, 256);
  const seen = new Set();
  for (let b = 0; b < 256; b++) {
    const c = map.get(b);
    assert.ok(typeof c === "string" && c.length >= 1);
    seen.add(c);
  }
  assert.equal(seen.size, 256, "unicode values must be unique");
});

// --- BasicBPETokenizer -----------------------------------------------------

test("BasicBPETokenizer starts with a 256-byte base vocab", () => {
  const t = new BasicBPETokenizer();
  assert.equal(t.getVocabSize(), 256);
  assert.equal(t.merges.size, 0);
});

test("BasicBPETokenizer train/encode/decode roundtrip is identity", () => {
  const t = new BasicBPETokenizer();
  const corpus = "aaabdaaabac aaabdaaabac aaabdaaabac";
  t.train(corpus, 270);
  assert.equal(t.decode(t.encode(corpus)), corpus);
  assert.equal(t.decode(t.encode("aaabdaaabac")), "aaabdaaabac");
});

test("BasicBPETokenizer encode actually compresses a repetitive corpus", () => {
  const t = new BasicBPETokenizer();
  // 11 bytes per chunk, three chunks + spaces.
  const corpus = "aaabdaaabac aaabdaaabac aaabdaaabac";
  t.train(corpus, 260);
  const encoded = t.encode("aaabdaaabac");
  assert.ok(
    encoded.length < 11,
    `expected compression below 11 byte tokens, got ${encoded.length}`,
  );
});

test("BasicBPETokenizer known vocab size reduction", () => {
  const t = new BasicBPETokenizer();
  t.train("abcabcabc", 260); // 4 new merges possible
  assert.equal(t.getVocabSize(), 260);
  assert.equal(t.merges.size, 4);
});

test("BasicBPETokenizer train rejects vocabSize < 256", () => {
  const t = new BasicBPETokenizer();
  assert.throws(() => t.train("abc", 100), /vocabSize must be >= 256/);
});

test("BasicBPETokenizer roundtrips non-ASCII UTF-8 text", () => {
  const t = new BasicBPETokenizer();
  const text = "héllo wörld — emoji: \u{1F600}!";
  t.train(text + " " + text, 280);
  assert.equal(t.decode(t.encode(text)), text);
});

test("BasicBPETokenizer encode on empty string returns []", () => {
  const t = new BasicBPETokenizer();
  assert.deepEqual(t.encode(""), []);
  assert.equal(t.decode([]), "");
});

// --- Special tokens --------------------------------------------------------

test("BasicBPETokenizer registerSpecialToken stores id and bytes", () => {
  const t = new BasicBPETokenizer();
  t.registerSpecialToken("<|endoftext|>", 5000);
  assert.equal(t.specialTokens.get("<|endoftext|>"), 5000);
  // decoding the special id by itself yields the token text.
  assert.equal(t.decode([5000]), "<|endoftext|>");
});

test("RegexBPETokenizer encodes special tokens when allowSpecial='all'", () => {
  const t = new RegexBPETokenizer();
  t.train("the quick brown fox jumps over the lazy dog", 280);
  t.registerSpecialToken("<|endoftext|>", 9999);
  const ids = t.encode("hello <|endoftext|> world", { allowSpecial: "all" });
  assert.ok(ids.includes(9999));
  assert.equal(t.decode(ids), "hello <|endoftext|> world");
});

test("RegexBPETokenizer errors on raw special token when allowSpecial='none'", () => {
  const t = new RegexBPETokenizer();
  t.train("the quick brown fox jumps over the lazy dog", 280);
  t.registerSpecialToken("<|endoftext|>", 9999);
  assert.throws(
    () => t.encode("hello <|endoftext|> world"),
    /encountered special token/,
  );
});

// --- Save / load -----------------------------------------------------------

test("BasicBPETokenizer save/load roundtrip preserves encode output", () => {
  const dir = mkdtempSync(join(tmpdir(), "bpe-"));
  try {
    const path = join(dir, "basic.model");
    const a = new BasicBPETokenizer();
    a.train("hello hello world world world", 280);
    a.save(path);

    const b = new BasicBPETokenizer();
    b.load(path);
    assert.equal(b.getVocabSize(), a.getVocabSize());
    assert.equal(b.merges.size, a.merges.size);

    const input = "hello world";
    assert.deepEqual(b.encode(input), a.encode(input));
    assert.equal(b.decode(b.encode(input)), input);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RegexBPETokenizer save/load restores the pattern and specials", () => {
  const dir = mkdtempSync(join(tmpdir(), "bpe-"));
  try {
    const path = join(dir, "regex.model");
    const a = new RegexBPETokenizer();
    a.train("the cat sat on the mat. the cat ran. the mat was red.", 300);
    a.registerSpecialToken("<|endoftext|>", 1234);
    a.save(path);

    const b = new RegexBPETokenizer();
    b.load(path);
    assert.ok(b.pattern instanceof RegExp);
    assert.equal(b.specialTokens.get("<|endoftext|>"), 1234);

    const sample = "the cat ran";
    assert.deepEqual(b.encode(sample), a.encode(sample));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- RegexBPETokenizer -----------------------------------------------------

test("GPT4_SPLIT_PATTERN splits on word / digit / punctuation / whitespace", () => {
  const rx = new RegExp(GPT4_SPLIT_PATTERN.source, "gu");
  const text = "Hello world 42!";
  const tokens = text.match(rx);
  // Expect: ["Hello", " world", " ", "42", "!"] or similar — we just check
  // that reconstructing the pieces yields the original.
  assert.equal(tokens.join(""), text);
});

test("GPT2_SPLIT_PATTERN splits contractions", () => {
  const rx = new RegExp(GPT2_SPLIT_PATTERN.source, "gu");
  const text = "it's fine";
  const tokens = text.match(rx);
  assert.ok(tokens.includes("'s"));
  assert.equal(tokens.join(""), text);
});

test("RegexBPETokenizer prevents merges across pattern boundaries", () => {
  // Train on a corpus where "ab" occurs many times but never inside a single
  // regex chunk. With the basic tokenizer, we'd merge "ab"; with the regex
  // tokenizer we should not.
  const t = new RegexBPETokenizer(/[a-z]+| +/gu);
  // "a b a b a b" -> chunks ["a", " ", "b", " ", "a", " ", "b", ...]
  const corpus = "a b a b a b a b";
  t.train(corpus, 260);
  // No merges across "a" and "b" should be possible because they never sit in
  // the same chunk.
  for (const key of t.merges.keys()) {
    const [x, y] = key.split(",").map(Number);
    // "a"=97, "b"=98: these should never end up adjacent inside a single chunk
    // after pre-splitting.
    assert.ok(
      !(x === 97 && y === 98),
      "regex tokenizer must not merge across boundaries",
    );
  }
});

test("RegexBPETokenizer train/encode/decode roundtrip", () => {
  const t = new RegexBPETokenizer();
  const corpus =
    "the quick brown fox jumps over the lazy dog. " +
    "the quick brown fox is quick. the dog is lazy.";
  t.train(corpus, 300);
  const sample = "the quick dog";
  assert.equal(t.decode(t.encode(sample)), sample);
});

// --- countTokens -----------------------------------------------------------

test("countTokens uses the tokenizer when provided", () => {
  const t = new BasicBPETokenizer();
  t.train("abcabcabc", 260);
  const n = countTokens("abc", t);
  assert.ok(Number.isInteger(n));
  assert.ok(n > 0);
  assert.equal(n, t.encode("abc").length);
});

test("countTokens falls back to a byte heuristic without a tokenizer", () => {
  const n = countTokens("hello world", null);
  // "hello world" is 11 bytes -> ceil(11/4) = 3
  assert.equal(n, 3);
});

test("countTokens returns 0 for non-strings", () => {
  assert.equal(countTokens(null), 0);
  assert.equal(countTokens(undefined), 0);
  assert.equal(countTokens(42), 0);
});

// ---------------------------------------------------------------------------
// HTTP route integration tests
// ---------------------------------------------------------------------------

import express from "express";
import request from "supertest";
import { mountBpeTokenizerRoutes } from "../routes/bpe-tokenizer.js";

function buildApp({ isAdmin } = {}) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((req, res, next) => {
    req.userId = "test-user";
    req.isAdmin = Boolean(isAdmin);
    next();
  });
  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    sanitizeWorkspace(w) {
      if (!w || typeof w !== "string") return "default";
      return w.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
    },
    storageRateLimiter: (req, res, next) => next(),
  };
  mountBpeTokenizerRoutes(app, deps);
  return app;
}

test("routes: train then encode/decode roundtrip", async () => {
  const app = buildApp();
  const corpus = (
    "the quick brown fox jumps over the lazy dog. " +
    "the fox ran home. the dog was tired. the brown fox was quick. "
  ).repeat(8);
  const trainRes = await request(app)
    .post("/api/v1/tokenizer/train")
    .send({ text: corpus, vocabSize: 280, workspace: "test" });
  assert.equal(trainRes.status, 200);
  assert.equal(trainRes.body.kind, "regex");
  assert.ok(trainRes.body.vocabSize >= 256);

  const encRes = await request(app)
    .post("/api/v1/tokenizer/encode")
    .send({ text: "the fox", workspace: "test" });
  assert.equal(encRes.status, 200);
  assert.ok(Array.isArray(encRes.body.ids));
  assert.ok(encRes.body.count > 0);

  const decRes = await request(app)
    .post("/api/v1/tokenizer/decode")
    .send({ ids: encRes.body.ids, workspace: "test" });
  assert.equal(decRes.status, 200);
  assert.equal(decRes.body.text, "the fox");
});

test("routes: encode before train returns 404", async () => {
  const app = buildApp();
  const res = await request(app)
    .post("/api/v1/tokenizer/encode")
    .send({ text: "hi", workspace: "fresh" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("routes: train rejects invalid vocabSize", async () => {
  const app = buildApp();
  const res = await request(app)
    .post("/api/v1/tokenizer/train")
    .send({ text: "abc", vocabSize: 100 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

test("routes: count endpoint works without a trained tokenizer", async () => {
  const app = buildApp();
  const res = await request(app)
    .post("/api/v1/tokenizer/count")
    .send({ text: "hello world", workspace: "unused" });
  assert.equal(res.status, 200);
  assert.equal(res.body.tokenizer, "heuristic");
  assert.ok(res.body.count > 0);
});

test("routes: vocab endpoint returns entries", async () => {
  const app = buildApp();
  await request(app)
    .post("/api/v1/tokenizer/train")
    .send({ text: "abcabcabcabc", vocabSize: 260, workspace: "v1" });
  const res = await request(app)
    .get("/api/v1/tokenizer/vocab?workspace=v1&limit=5");
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 5);
  assert.equal(typeof res.body.entries[0].id, "number");
  assert.ok(Array.isArray(res.body.entries[0].bytes));
});
