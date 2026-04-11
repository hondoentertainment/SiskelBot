/**
 * Phase 62.1: Intent classification tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-intent-"));
process.env.STORAGE_PATH = TMP;

const {
  tokenize,
  addTrainingExample,
  listIntents,
  listExamples,
  trainIntentClassifier,
  classifyTicket,
  evaluateClassifier,
} = await import("../lib/intent-classification.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("tokenize lowercases and drops stopwords/punctuation", () => {
  const t = tokenize("Please help me RESET my password!");
  assert.ok(t.includes("reset"));
  assert.ok(t.includes("password"));
  assert.ok(!t.includes("please"));
  assert.ok(!t.includes("me"));
});

test("tokenize handles null/empty", () => {
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(""), []);
});

test("addTrainingExample persists records", async () => {
  const ex = await addTrainingExample("billing", "I was charged twice this month");
  assert.equal(ex.intent, "billing");
  assert.ok(ex.id);
  assert.ok(ex.createdAt);
  const all = await listExamples();
  assert.ok(all.length >= 1);
});

test("addTrainingExample rejects invalid input", async () => {
  await assert.rejects(() => addTrainingExample("", "text"));
  await assert.rejects(() => addTrainingExample("intent", ""));
});

test("listIntents returns counts per intent", async () => {
  await addTrainingExample("password", "reset my password please");
  await addTrainingExample("password", "I forgot my login password");
  await addTrainingExample("password", "password not working");
  await addTrainingExample("refund", "I want a refund for my order");
  await addTrainingExample("refund", "please refund my money");
  const intents = await listIntents();
  const names = intents.map((i) => i.intent).sort();
  assert.ok(names.includes("password"));
  assert.ok(names.includes("refund"));
  const pw = intents.find((i) => i.intent === "password");
  assert.ok(pw.count >= 3);
});

test("trainIntentClassifier requires examples", async () => {
  await assert.rejects(() => trainIntentClassifier({ examples: [] }));
});

test("trainIntentClassifier produces a model", async () => {
  const model = await trainIntentClassifier();
  assert.ok(model.centroids);
  assert.ok(model.idf);
  assert.ok(Array.isArray(model.intents));
  assert.ok(model.intents.length >= 2);
  assert.ok(model.trainedAt);
});

test("classifyTicket returns the expected intent for a matching query", async () => {
  const result = await classifyTicket("I need to reset my password");
  assert.equal(result.intent, "password");
  assert.ok(result.confidence > 0);
  assert.ok(Array.isArray(result.scores));
});

test("classifyTicket returns null for empty text", async () => {
  const result = await classifyTicket("");
  assert.equal(result.intent, null);
  assert.equal(result.confidence, 0);
});

test("classifyTicket scores refund queries as refund intent", async () => {
  const result = await classifyTicket("please refund my payment");
  assert.equal(result.intent, "refund");
});

test("evaluateClassifier computes accuracy on a held-out set", async () => {
  const testSet = [
    { intent: "password", text: "my password does not work" },
    { intent: "refund", text: "give me my refund back" },
    { intent: "password", text: "forgot password on login" },
  ];
  const result = await evaluateClassifier(testSet);
  assert.equal(result.total, 3);
  assert.ok(result.accuracy > 0);
  assert.ok(result.perIntent.password);
});

test("evaluateClassifier handles empty test set", async () => {
  const result = await evaluateClassifier([]);
  assert.equal(result.total, 0);
  assert.equal(result.accuracy, 0);
});
