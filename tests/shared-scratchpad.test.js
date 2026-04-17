/**
 * Tests for lib/shared-scratchpad.js and the read_scratchpad / write_scratchpad
 * agent tools registered in lib/agent-tools.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated storage so tool calls that touch disk don't pollute project data.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-scratchpad-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const { getScratchpad, __getStoreForTests } = await import("../lib/shared-scratchpad.js");
const { runTool } = await import("../lib/agent-tools.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- Unit: shared-scratchpad.js ----

test("write + read roundtrip", () => {
  const pad = getScratchpad("session-1");
  pad.write("greeting", "hello world", { author: "child-a" });
  const entry = pad.read("greeting");
  assert.equal(entry.value, "hello world");
  assert.equal(entry.author, "child-a");
  assert.ok(entry.updatedAt);
  pad.clear();
});

test("write overwrites existing key and updates timestamp", () => {
  const pad = getScratchpad("session-overwrite");
  pad.write("k", "v1", { author: "a" });
  const t1 = pad.read("k").updatedAt;
  pad.write("k", "v2", { author: "b" });
  const entry = pad.read("k");
  assert.equal(entry.value, "v2");
  assert.equal(entry.author, "b");
  assert.ok(entry.updatedAt >= t1);
  pad.clear();
});

test("read returns null for missing key", () => {
  const pad = getScratchpad("session-miss");
  assert.equal(pad.read("nope"), null);
  pad.clear();
});

test("list returns all keys with previews", () => {
  const pad = getScratchpad("session-list");
  pad.write("a", { x: 1 }, { author: "c1" });
  pad.write("b", "short", { author: "c2" });
  const items = pad.list();
  assert.equal(items.length, 2);
  const keys = items.map((i) => i.key).sort();
  assert.deepEqual(keys, ["a", "b"]);
  // preview is JSON.stringify of value
  const itemA = items.find((i) => i.key === "a");
  assert.equal(itemA.preview, '{"x":1}');
  assert.equal(itemA.author, "c1");
  pad.clear();
});

test("list preview is truncated at 200 chars", () => {
  const pad = getScratchpad("session-preview");
  const longVal = "x".repeat(300);
  pad.write("big", longVal);
  const items = pad.list();
  assert.equal(items.length, 1);
  // JSON.stringify wraps in quotes, so length is 302. Preview should be 200 chars.
  assert.equal(items[0].preview.length, 200);
  pad.clear();
});

test("100-key limit rejects new keys", () => {
  const pad = getScratchpad("session-limit");
  for (let i = 0; i < 100; i++) {
    pad.write(`k${i}`, i);
  }
  assert.throws(
    () => pad.write("k100", "over"),
    (err) => err.code === "SCRATCHPAD_KEY_LIMIT"
  );
  // Updating existing key should still work
  pad.write("k0", "updated");
  assert.equal(pad.read("k0").value, "updated");
  pad.clear();
});

test("64KB value limit rejects oversized values", () => {
  const pad = getScratchpad("session-size");
  const huge = "a".repeat(65 * 1024);
  assert.throws(
    () => pad.write("big", huge),
    (err) => err.code === "SCRATCHPAD_VALUE_TOO_LARGE"
  );
  pad.clear();
});

test("sibling isolation: different parent sessions have separate scratchpads", () => {
  const padA = getScratchpad("parent-A");
  const padB = getScratchpad("parent-B");
  padA.write("shared-key", "from-A");
  padB.write("shared-key", "from-B");
  assert.equal(padA.read("shared-key").value, "from-A");
  assert.equal(padB.read("shared-key").value, "from-B");
  padA.clear();
  padB.clear();
});

test("delete removes a key", () => {
  const pad = getScratchpad("session-del");
  pad.write("k", "v");
  assert.equal(pad.delete("k"), true);
  assert.equal(pad.read("k"), null);
  assert.equal(pad.delete("k"), false); // already gone
  pad.clear();
});

test("entries returns a Map copy", () => {
  const pad = getScratchpad("session-entries");
  pad.write("x", 42);
  pad.write("y", "hello");
  const ent = pad.entries();
  assert.ok(ent instanceof Map);
  assert.equal(ent.size, 2);
  assert.equal(ent.get("x").value, 42);
  pad.clear();
});

test("clear removes all entries", () => {
  const pad = getScratchpad("session-clear");
  pad.write("a", 1);
  pad.write("b", 2);
  pad.clear();
  assert.equal(pad.list().length, 0);
  assert.equal(pad.read("a"), null);
});

test("auto-cleanup: scratchpad evicted after 1 hour of inactivity", () => {
  const store = __getStoreForTests();
  const pad = getScratchpad("session-evict");
  pad.write("alive", true);
  assert.ok(store.has("session-evict"));

  // Simulate time passing by backdating lastAccess
  const padData = store.get("session-evict");
  padData.lastAccess = Date.now() - (60 * 60 * 1000 + 1); // 1h + 1ms ago

  // Next access triggers lazy eviction
  const pad2 = getScratchpad("session-evict");
  assert.equal(pad2.read("alive"), null); // evicted
  assert.equal(pad2.list().length, 0);
});

test("value must be JSON-serializable", () => {
  const pad = getScratchpad("session-json");
  // BigInt is not JSON-serializable
  assert.throws(
    () => pad.write("bad", BigInt(123)),
    /JSON-serializable/
  );
  pad.clear();
});

test("author defaults to null when not provided", () => {
  const pad = getScratchpad("session-null-author");
  pad.write("k", "v");
  assert.equal(pad.read("k").author, null);
  pad.clear();
});

// ---- Tool integration tests ----

test("write_scratchpad tool: write and verify via read_scratchpad", async () => {
  const ctx = { agentSessionId: "tool-session-root", parentSessionId: null };
  const writeResult = await runTool("write_scratchpad", { key: "research", value: "findings here" }, ctx);
  const parsed = JSON.parse(writeResult.content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.key, "research");

  const readResult = await runTool("read_scratchpad", { key: "research" }, ctx);
  const readParsed = JSON.parse(readResult.content);
  assert.equal(readParsed.ok, true);
  assert.equal(readParsed.value, "findings here");
  assert.equal(readParsed.author, "tool-session-root");

  // Cleanup
  getScratchpad("tool-session-root").clear();
});

test("read_scratchpad tool: list mode when key is omitted", async () => {
  const ctx = { agentSessionId: "tool-list-session", parentSessionId: null };
  await runTool("write_scratchpad", { key: "a", value: "1" }, ctx);
  await runTool("write_scratchpad", { key: "b", value: "2" }, ctx);

  const listResult = await runTool("read_scratchpad", {}, ctx);
  const parsed = JSON.parse(listResult.content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.count, 2);
  const keys = parsed.entries.map((e) => e.key).sort();
  assert.deepEqual(keys, ["a", "b"]);

  getScratchpad("tool-list-session").clear();
});

test("write_scratchpad tool: returns error when no session context", async () => {
  const ctx = {};
  const result = await runTool("write_scratchpad", { key: "k", value: "v" }, ctx);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "NO_SESSION");
});

test("read_scratchpad tool: returns error when no session context", async () => {
  const ctx = {};
  const result = await runTool("read_scratchpad", { key: "k" }, ctx);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "NO_SESSION");
});

test("write_scratchpad tool: missing key returns error", async () => {
  const ctx = { agentSessionId: "s1" };
  const result = await runTool("write_scratchpad", { value: "v" }, ctx);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /key/i);
  getScratchpad("s1").clear();
});

test("write_scratchpad tool: missing value returns error", async () => {
  const ctx = { agentSessionId: "s1" };
  const result = await runTool("write_scratchpad", { key: "k" }, ctx);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /value/i);
  getScratchpad("s1").clear();
});

test("read_scratchpad tool: returns null for missing key", async () => {
  const ctx = { agentSessionId: "tool-miss-session" };
  const result = await runTool("read_scratchpad", { key: "nonexistent" }, ctx);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value, null);
  getScratchpad("tool-miss-session").clear();
});

test("tool uses parentSessionId from ctx when available", async () => {
  const ctx = { agentSessionId: "child-1", parentSessionId: "parent-shared" };
  await runTool("write_scratchpad", { key: "data", value: "from-child-1" }, ctx);

  // Sibling reads using same parent
  const ctx2 = { agentSessionId: "child-2", parentSessionId: "parent-shared" };
  const result = await runTool("read_scratchpad", { key: "data" }, ctx2);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value, "from-child-1");
  assert.equal(parsed.author, "child-1");

  getScratchpad("parent-shared").clear();
});
