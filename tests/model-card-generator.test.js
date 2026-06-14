/**
 * Phase 72.2: Model card generator tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-model-card-"));
process.env.STORAGE_PATH = TMP;

const {
  generateCard,
  updateCardField,
  getCard,
  listCards,
  exportCardMarkdown,
  _reset,
} = await import("../lib/model-card-generator.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("generateCard creates a card with defaults", async () => {
  await _reset();
  const card = await generateCard({ modelId: "gpt-test-1" });
  assert.equal(card.modelId, "gpt-test-1");
  assert.equal(card.displayName, "gpt-test-1");
  assert.ok(card.createdAt);
  assert.ok(card.updatedAt);
});

test("generateCard merges metadata fields", async () => {
  await _reset();
  const card = await generateCard({
    modelId: "m2",
    metadata: {
      displayName: "Model Two",
      provider: "openai",
      version: "0.1",
      intendedUse: "code generation",
      evalScores: { mmlu: 0.75 },
    },
  });
  assert.equal(card.displayName, "Model Two");
  assert.equal(card.provider, "openai");
  assert.equal(card.evalScores.mmlu, 0.75);
});

test("generateCard throws on missing modelId", async () => {
  await _reset();
  await assert.rejects(() => generateCard({}), /modelId is required/);
});

test("updateCardField updates an existing card", async () => {
  await _reset();
  await generateCard({ modelId: "m3" });
  const updated = await updateCardField({ modelId: "m3", field: "provider", value: "anthropic" });
  assert.equal(updated.provider, "anthropic");
  const again = await getCard("m3");
  assert.equal(again.provider, "anthropic");
});

test("updateCardField rejects invalid field", async () => {
  await _reset();
  await generateCard({ modelId: "m4" });
  await assert.rejects(
    () => updateCardField({ modelId: "m4", field: "hack", value: "x" }),
    /field must be one of/,
  );
});

test("updateCardField rejects missing card", async () => {
  await _reset();
  await assert.rejects(
    () => updateCardField({ modelId: "nope", field: "provider", value: "x" }),
    /not found/,
  );
});

test("listCards returns sorted cards", async () => {
  await _reset();
  await generateCard({ modelId: "a" });
  await new Promise((r) => setTimeout(r, 5));
  await generateCard({ modelId: "b" });
  const cards = await listCards();
  assert.equal(cards.length, 2);
  assert.equal(cards[0].modelId, "b");
});

test("exportCardMarkdown produces a formatted document", async () => {
  await _reset();
  await generateCard({
    modelId: "md-model",
    metadata: { displayName: "Markdown Model", provider: "test", intendedUse: "testing" },
  });
  const md = await exportCardMarkdown("md-model");
  assert.ok(md.includes("# Model Card: Markdown Model"));
  assert.ok(md.includes("## Intended use"));
  assert.ok(md.includes("testing"));
  assert.ok(md.includes("## Evaluation scores"));
});

test("exportCardMarkdown returns null when missing", async () => {
  await _reset();
  const md = await exportCardMarkdown("nope");
  assert.equal(md, null);
});
