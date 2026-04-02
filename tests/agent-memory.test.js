/**
 * Tests for lib/agent-memory.js — CRUD, search, extraction, and consent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  storeMemory,
  getMemories,
  searchMemories,
  updateMemory,
  deleteMemory,
  getMemoryStats,
  extractPotentialMemories,
} from "../lib/agent-memory.js";

const TEST_WS = "test-mem-" + Date.now();
const TEST_USER = "test-user-mem";

test("storeMemory requires consent", async () => {
  const result = await storeMemory(TEST_WS, TEST_USER, {
    content: "User prefers dark mode",
    category: "preference",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /consent/i);
});

test("storeMemory rejects empty content", async () => {
  const result = await storeMemory(TEST_WS, TEST_USER, {
    content: "",
    consent: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /content/i);
});

test("storeMemory rejects invalid category", async () => {
  const result = await storeMemory(TEST_WS, TEST_USER, {
    content: "Some fact",
    category: "invalid-cat",
    consent: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /category/i);
});

test("storeMemory rejects invalid confidence", async () => {
  const result = await storeMemory(TEST_WS, TEST_USER, {
    content: "Some fact",
    confidence: 5,
    consent: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /confidence/i);
});

test("storeMemory succeeds with consent", async () => {
  const result = await storeMemory(TEST_WS, TEST_USER, {
    content: "User prefers dark mode",
    category: "preference",
    consent: true,
  });
  assert.equal(result.ok, true);
  assert.ok(result.memory);
  assert.ok(result.memory.id);
  assert.equal(result.memory.category, "preference");
  assert.equal(result.memory.content, "User prefers dark mode");
  assert.equal(result.memory.active, true);
  assert.ok(result.memory.createdAt);
});

test("getMemories returns stored memories", async () => {
  const memories = await getMemories(TEST_WS, TEST_USER);
  assert.ok(memories.length >= 1);
  const found = memories.find((m) => m.content === "User prefers dark mode");
  assert.ok(found);
});

test("getMemories filters by category", async () => {
  await storeMemory(TEST_WS, TEST_USER, {
    content: "User works at Acme Corp",
    category: "fact",
    consent: true,
  });
  const prefs = await getMemories(TEST_WS, TEST_USER, { category: "preference" });
  const facts = await getMemories(TEST_WS, TEST_USER, { category: "fact" });
  assert.ok(prefs.every((m) => m.category === "preference"));
  assert.ok(facts.every((m) => m.category === "fact"));
});

test("searchMemories finds by substring", async () => {
  const results = await searchMemories(TEST_WS, TEST_USER, "dark mode");
  assert.ok(results.length >= 1);
  assert.ok(results[0].content.includes("dark mode"));
});

test("searchMemories returns empty for no match", async () => {
  const results = await searchMemories(TEST_WS, TEST_USER, "xyznonexistent");
  assert.equal(results.length, 0);
});

test("searchMemories handles empty query", async () => {
  const results = await searchMemories(TEST_WS, TEST_USER, "");
  assert.equal(results.length, 0);
});

test("updateMemory updates content and category", async () => {
  const stored = await storeMemory(TEST_WS, TEST_USER, {
    content: "Original content",
    category: "fact",
    consent: true,
  });
  const result = await updateMemory(stored.memory.id, {
    content: "Updated content",
    category: "preference",
  }, TEST_WS, TEST_USER);
  assert.equal(result.ok, true);
  assert.equal(result.memory.content, "Updated content");
  assert.equal(result.memory.category, "preference");
});

test("updateMemory returns error for non-existent memory", async () => {
  const result = await updateMemory("nonexistent-id", {
    content: "New content",
  }, TEST_WS, TEST_USER);
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});

test("deleteMemory soft-deletes", async () => {
  const stored = await storeMemory(TEST_WS, TEST_USER, {
    content: "To be deleted",
    category: "fact",
    consent: true,
  });
  const result = await deleteMemory(stored.memory.id, TEST_WS, TEST_USER);
  assert.equal(result.ok, true);

  // Should not appear in active memories
  const active = await getMemories(TEST_WS, TEST_USER, { activeOnly: true });
  const found = active.find((m) => m.id === stored.memory.id);
  assert.equal(found, undefined);
});

test("deleteMemory returns error for non-existent memory", async () => {
  const result = await deleteMemory("nonexistent-id", TEST_WS, TEST_USER);
  assert.equal(result.ok, false);
});

test("getMemoryStats returns correct counts", async () => {
  const stats = await getMemoryStats(TEST_WS, TEST_USER);
  assert.ok(stats.total >= 3);
  assert.ok(stats.active >= 2);
  assert.ok(stats.inactive >= 1);
  assert.ok(typeof stats.byCategory === "object");
});

test("extractPotentialMemories finds preference patterns", () => {
  const messages = [
    { role: "user", content: "I prefer TypeScript over JavaScript for all projects" },
  ];
  const results = extractPotentialMemories(messages, { conversationId: "c1" });
  assert.ok(results.length >= 1);
  assert.ok(results.some((s) => s.category === "preference"));
});

test("extractPotentialMemories finds fact patterns", () => {
  const messages = [
    { role: "user", content: "My name is Alice" },
  ];
  const results = extractPotentialMemories(messages, { conversationId: "c2" });
  assert.ok(results.length >= 1);
  assert.ok(results.some((s) => s.category === "fact"));
});

test("extractPotentialMemories finds instruction patterns", () => {
  const messages = [
    { role: "user", content: "Always remember to use semicolons in JavaScript code" },
  ];
  const results = extractPotentialMemories(messages, { conversationId: "c3" });
  assert.ok(results.length >= 1);
  assert.ok(results.some((s) => s.category === "instruction"));
});

test("extractPotentialMemories returns empty for non-user messages", () => {
  const messages = [
    { role: "assistant", content: "I prefer TypeScript over JavaScript" },
  ];
  const results = extractPotentialMemories(messages);
  assert.equal(results.length, 0);
});

test("extractPotentialMemories returns empty for empty input", () => {
  assert.deepEqual(extractPotentialMemories([]), []);
  assert.deepEqual(extractPotentialMemories(null), []);
});
