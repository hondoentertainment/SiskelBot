/**
 * Phase 70.4: Voice-only mode tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-voice-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerCommand,
  matchCommand,
  listCommands,
  disambiguate,
  clearCommands,
  compilePattern,
} = await import("../lib/voice-only.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("compilePattern extracts slots", () => {
  const { slots, regex } = compilePattern("open {section}");
  assert.deepEqual(slots, ["section"]);
  assert.ok(regex.test("open settings"));
});

test("compilePattern rejects invalid input", () => {
  assert.throws(() => compilePattern(""));
  assert.throws(() => compilePattern(null));
});

test("registerCommand persists a command", async () => {
  await clearCommands();
  const rec = await registerCommand({ id: "open", pattern: "open {section}", action: "NAV_OPEN" });
  assert.equal(rec.id, "open");
  assert.deepEqual(rec.slots, ["section"]);
});

test("registerCommand validates input", async () => {
  await assert.rejects(() => registerCommand(null));
  await assert.rejects(() => registerCommand({ id: "x", pattern: "" }));
  await assert.rejects(() => registerCommand({ id: "", pattern: "hi" }));
});

test("matchCommand finds exact matches and extracts slots", async () => {
  await clearCommands();
  await registerCommand({ id: "open", pattern: "open {section}" });
  const m = await matchCommand("Open Settings");
  assert.ok(m);
  assert.equal(m.id, "open");
  assert.equal(m.slots.section, "settings");
  assert.equal(m.score, 1);
});

test("matchCommand returns null for no match below threshold", async () => {
  await clearCommands();
  await registerCommand({ id: "open", pattern: "open settings" });
  const m = await matchCommand("completely unrelated phrase", { minScore: 0.9 });
  assert.equal(m, null);
});

test("matchCommand fuzzy matches single-word nudges", async () => {
  await clearCommands();
  await registerCommand({ id: "close", pattern: "close window" });
  const m = await matchCommand("close windo", { minScore: 0.5 });
  assert.ok(m);
  assert.equal(m.id, "close");
  assert.ok(m.score < 1);
});

test("matchCommand returns null for empty input", async () => {
  assert.equal(await matchCommand(""), null);
  assert.equal(await matchCommand(null), null);
});

test("listCommands returns all registered", async () => {
  await clearCommands();
  await registerCommand({ id: "a", pattern: "go back" });
  await registerCommand({ id: "b", pattern: "go forward" });
  const all = await listCommands();
  assert.equal(all.length, 2);
});

test("disambiguate returns multiple candidates sorted by score", async () => {
  await clearCommands();
  await registerCommand({ id: "a", pattern: "open browser" });
  await registerCommand({ id: "b", pattern: "open bookmarks" });
  await registerCommand({ id: "c", pattern: "quit" });
  const results = await disambiguate("open bookmarkz", { minScore: 0.4 });
  assert.ok(results.length >= 1);
  assert.ok(results[0].score >= results[results.length - 1].score);
});

test("disambiguate respects limit and handles empty input", async () => {
  const r = await disambiguate("");
  assert.deepEqual(r, []);
  const r2 = await disambiguate("open", { limit: 1 });
  assert.ok(r2.length <= 1);
});

test("clearCommands empties the store", async () => {
  await registerCommand({ id: "to-clear", pattern: "clear me" });
  const r = await clearCommands();
  assert.ok(r.cleared >= 1);
  const all = await listCommands();
  assert.equal(all.length, 0);
});
