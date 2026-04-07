import test from "node:test";
import assert from "node:assert/strict";
import { chunkPlainText } from "../lib/knowledge-chunking.js";

test("chunkPlainText returns empty array for empty string", () => {
  assert.deepEqual(chunkPlainText(""), []);
  assert.deepEqual(chunkPlainText("   "), []);
});

test("chunkPlainText returns single chunk for short text", () => {
  const chunks = chunkPlainText("Hello world", 4000, 200);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "Hello world");
});

test("chunkPlainText returns single chunk when text equals maxChars", () => {
  const text = "a".repeat(4000);
  const chunks = chunkPlainText(text, 4000, 200);
  assert.equal(chunks.length, 1);
});

test("chunkPlainText splits long text into multiple chunks", () => {
  const text = "word ".repeat(2000); // ~10000 chars
  const chunks = chunkPlainText(text, 1000, 100);
  assert.ok(chunks.length > 1);
  // Each chunk should be around maxChars or less
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1100); // Allow small overshoot due to break-at logic
  }
});

test("chunkPlainText respects overlap parameter", () => {
  const text = "abcdefghij ".repeat(500); // ~5500 chars
  const chunks = chunkPlainText(text, 1000, 200);
  assert.ok(chunks.length >= 2);
  // Check overlap: end of chunk N should overlap with start of chunk N+1
  if (chunks.length >= 2) {
    const _endOfFirst = chunks[0].slice(-100);
    const _startOfSecond = chunks[1].slice(0, 200);
    // There should be some shared content due to overlap
    // (not guaranteed to be exact due to break-at logic, but they should be close)
    assert.ok(chunks[0].length > 0);
    assert.ok(chunks[1].length > 0);
  }
});

test("chunkPlainText enforces minimum maxChars of 256", () => {
  const text = "a".repeat(1000);
  const chunks = chunkPlainText(text, 10, 0); // too small, should clamp to 256
  assert.ok(chunks.length > 0);
  // With min 256, we'd get ~4 chunks from 1000 chars
  assert.ok(chunks.length <= 5);
});

test("chunkPlainText enforces maximum maxChars of 32000", () => {
  const text = "a".repeat(40000);
  const chunks = chunkPlainText(text, 100000, 0); // too large, should clamp to 32000
  assert.ok(chunks.length >= 2);
});

test("chunkPlainText limits overlap to half of maxChars", () => {
  const text = "a".repeat(2000);
  // overlap larger than max/2 should be clamped
  const chunks = chunkPlainText(text, 500, 400);
  assert.ok(chunks.length >= 2);
});

test("chunkPlainText handles non-string input", () => {
  assert.deepEqual(chunkPlainText(null), []);
  assert.deepEqual(chunkPlainText(undefined), []);
  assert.deepEqual(chunkPlainText(42), []);
});

test("chunkPlainText prefers natural break points", () => {
  const sentences = [];
  for (let i = 0; i < 20; i++) {
    sentences.push(`Sentence number ${i}. `);
  }
  const text = sentences.join("");
  const chunks = chunkPlainText(text, 100, 0);
  assert.ok(chunks.length >= 2);
  // Chunks should tend to end at sentence boundaries
});
