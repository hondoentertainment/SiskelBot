/**
 * Phase 69.4: Personalized prompts tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-pprompt-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  buildSystemPrompt,
  registerTrait,
  listTraits,
  clearTraits,
  getPromptForUser,
} = await import("../lib/personalized-prompts.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("buildSystemPrompt returns default when no traits", () => {
  const s = buildSystemPrompt("You are helpful.", []);
  assert.equal(s, "You are helpful.");
});

test("buildSystemPrompt appends trait lines", () => {
  const s = buildSystemPrompt("Base", [
    { key: "tone", value: "formal" },
    { key: "language", value: "English" },
  ]);
  assert.ok(s.includes("Base"));
  assert.ok(s.includes("- tone: formal"));
  assert.ok(s.includes("- language: English"));
});

test("buildSystemPrompt skips invalid traits", () => {
  const s = buildSystemPrompt("Base", [
    null,
    { key: "", value: "x" },
    { key: "a" },
    { key: "a", value: "" },
    { key: "good", value: "yes" },
  ]);
  assert.ok(s.includes("- good: yes"));
  assert.ok(!s.includes("- a:"));
});

test("registerTrait persists a trait", async () => {
  const user = await registerTrait("u1", { key: "tone", value: "concise" });
  assert.ok(user.traits.tone);
  assert.equal(user.traits.tone.value, "concise");
});

test("registerTrait validates input", async () => {
  await assert.rejects(() => registerTrait("", { key: "k", value: "v" }));
  await assert.rejects(() => registerTrait("u", null));
  await assert.rejects(() => registerTrait("u", { key: "", value: "v" }));
  await assert.rejects(() => registerTrait("u", { key: "k", value: 42 }));
});

test("listTraits returns all user traits", async () => {
  await registerTrait("u2", { key: "a", value: "1" });
  await registerTrait("u2", { key: "b", value: "2" });
  const list = await listTraits("u2");
  assert.equal(list.length, 2);
});

test("listTraits returns [] for unknown users", async () => {
  const list = await listTraits("ghost");
  assert.deepEqual(list, []);
});

test("clearTraits removes a specific key or all", async () => {
  await registerTrait("u3", { key: "keep", value: "y" });
  await registerTrait("u3", { key: "drop", value: "n" });
  const r = await clearTraits("u3", { key: "drop" });
  assert.equal(r.cleared, 1);
  const list = await listTraits("u3");
  assert.equal(list.length, 1);
  assert.equal(list[0].key, "keep");
  const r2 = await clearTraits("u3");
  assert.equal(r2.cleared, 1);
});

test("clearTraits validates input", async () => {
  await assert.rejects(() => clearTraits(""));
});

test("getPromptForUser composes prompt with traits", async () => {
  await registerTrait("u4", { key: "tone", value: "friendly" });
  const prompt = await getPromptForUser("u4");
  assert.ok(prompt.includes("- tone: friendly"));
});

test("getPromptForUser falls back to default base when no traits", async () => {
  const prompt = await getPromptForUser("u5");
  assert.ok(prompt.length > 0);
  assert.ok(!prompt.includes("- "));
});
