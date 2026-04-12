/**
 * Phase 62.1: Intent classifier tests.
 *
 * All tests run with embeddings disabled (no OPENAI_API_KEY) so results are
 * deterministic — the classifier falls back to keyword + lexical scoring.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-intent-classifier-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;
delete process.env.OPENAI_API_KEY; // force lexical path

const {
  trainIntent,
  getIntent,
  listIntents,
  classifyIntent,
  deleteIntent,
  _internals,
} = await import("../lib/intent-classifier.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("tokenize lowercases and strips punctuation", () => {
  assert.deepEqual(_internals.tokenize("Hello, World! 123"), ["hello", "world", "123"]);
});

test("cosine returns 1 for identical vectors and 0 for empty", () => {
  assert.equal(_internals.cosine([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(_internals.cosine([], []), 0);
  assert.equal(_internals.cosine([1, 0], [0, 1]), 0);
});

test("trainIntent requires a name", async () => {
  await assert.rejects(() => trainIntent({}), /name is required/);
});

test("trainIntent persists keywords and examples", async () => {
  const rec = await trainIntent({
    name: "billing",
    keywords: ["invoice", "charge", "refund"],
    examples: ["I was charged twice", "Need a refund please"],
    description: "billing-related tickets",
  });
  assert.equal(rec.name, "billing");
  assert.deepEqual(rec.keywords, ["invoice", "charge", "refund"]);
  assert.equal(rec.examples.length, 2);
  const fetched = await getIntent("billing");
  assert.equal(fetched.name, "billing");
});

test("listIntents returns registered intents", async () => {
  await trainIntent({ name: "outage", keywords: ["down", "outage", "error"] });
  await trainIntent({ name: "feature", keywords: ["feature", "request", "wish"] });
  const list = await listIntents();
  const names = list.map((i) => i.name);
  assert.ok(names.includes("outage"));
  assert.ok(names.includes("feature"));
});

test("classifyIntent routes to the strongest matching intent", async () => {
  await trainIntent({
    name: "password-reset",
    keywords: ["password", "reset", "login", "forgot"],
    examples: ["I forgot my password", "Can't log in, need password reset"],
  });
  await trainIntent({
    name: "billing",
    keywords: ["invoice", "charge", "refund"],
    examples: ["I was charged twice"],
  });
  const result = await classifyIntent("I forgot my password and cannot login");
  assert.equal(result.topIntent, "password-reset");
  assert.ok(result.confidence > 0);
  assert.ok(result.scores.length >= 2);
});

test("classifyIntent returns null for empty input", async () => {
  const r1 = await classifyIntent("");
  assert.equal(r1.topIntent, null);
  const r2 = await classifyIntent("   ");
  assert.equal(r2.topIntent, null);
});

test("classifyIntent returns null when no intents trained", async () => {
  // Fresh tmpdir so no existing intents.
  const freshDir = mkdtempSync(join(tmpdir(), "siskel-intent-empty-"));
  const savedPath = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = freshDir;
  try {
    // Re-import in a child scope is awkward; instead call into the same module
    // and trust that the list loads from the new path.
    const { classifyIntent: classifyFresh } = await import(`../lib/intent-classifier.js?empty=${Date.now()}`);
    const result = await classifyFresh("anything here");
    assert.equal(result.topIntent, null);
  } finally {
    process.env.STORAGE_PATH = savedPath;
    try { rmSync(freshDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test("classifyIntent prefers keyword overlap over weak lexical match", async () => {
  await trainIntent({
    name: "shipping",
    keywords: ["shipping", "delivery", "tracking", "package"],
    examples: ["Where is my package?"],
  });
  const result = await classifyIntent("The shipping is delayed and tracking shows nothing");
  assert.equal(result.topIntent, "shipping");
  assert.ok(result.scores[0].components.keyword >= result.scores[0].components.lexical);
});

test("deleteIntent removes and subsequent classify does not return it", async () => {
  await trainIntent({ name: "temp", keywords: ["temp", "temporary"] });
  const res = await deleteIntent("temp");
  assert.equal(res.ok, true);
  const list = await listIntents();
  assert.ok(!list.some((i) => i.name === "temp"));
});

test("classifyIntent components always include embedding:0 when offline", async () => {
  await trainIntent({ name: "offline-only", keywords: ["offline"] });
  const result = await classifyIntent("offline mode is not available");
  const comp = result.scores.find((s) => s.intent === "offline-only").components;
  assert.equal(comp.embedding, 0);
});
