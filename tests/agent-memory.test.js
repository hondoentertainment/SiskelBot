/**
 * Tests for lib/agent-memory.js — remember, recall, forget, listMemories, summarizeMemories, getMemoryStats.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  remember,
  recall,
  forget,
  listMemories,
  summarizeMemories,
  getMemoryStats,
  // Legacy exports for backward compat
  storeMemory,
  getMemories,
  searchMemories,
  deleteMemory,
  extractPotentialMemories,
} from "../lib/agent-memory.js";

const TEST_USER = "test-mem-user-" + Date.now();
const TEST_WS = "test-mem-ws";

// --- remember ---

test("remember stores a memory and returns id + createdAt", async () => {
  const result = await remember(TEST_USER, TEST_WS, {
    content: "The project uses PostgreSQL",
    category: "fact",
    importance: 4,
  });
  assert.ok(result.id);
  assert.ok(result.createdAt);
});

test("remember throws on empty content", async () => {
  await assert.rejects(
    () => remember(TEST_USER, TEST_WS, { content: "", category: "fact" }),
    { message: "content is required" }
  );
});

test("remember throws on invalid category", async () => {
  await assert.rejects(
    () => remember(TEST_USER, TEST_WS, { content: "test", category: "invalid" }),
    /category must be one of/
  );
});

test("remember throws on invalid importance", async () => {
  await assert.rejects(
    () => remember(TEST_USER, TEST_WS, { content: "test", importance: 0 }),
    /importance must be an integer between 1 and 5/
  );
  await assert.rejects(
    () => remember(TEST_USER, TEST_WS, { content: "test", importance: 6 }),
    /importance must be an integer between 1 and 5/
  );
});

test("remember defaults importance to 3 and category to fact", async () => {
  const result = await remember(TEST_USER, TEST_WS, { content: "default test" });
  assert.ok(result.id);
  const { memories } = await listMemories(TEST_USER, TEST_WS);
  const found = memories.find((m) => m.id === result.id);
  assert.equal(found.importance, 3);
  assert.equal(found.category, "fact");
});

// --- recall ---

test("recall finds memories by query", async () => {
  await remember(TEST_USER, TEST_WS, { content: "User prefers dark mode theme", category: "preference", importance: 4 });
  const result = await recall(TEST_USER, TEST_WS, "dark mode");
  assert.ok(result.memories.length >= 1);
  assert.ok(result.memories[0].content.includes("dark mode"));
  assert.ok(result.memories[0].relevance > 0);
});

test("recall returns empty for no match", async () => {
  const result = await recall(TEST_USER, TEST_WS, "xyznonexistentquery12345");
  assert.equal(result.memories.length, 0);
});

test("recall returns empty for empty query", async () => {
  const result = await recall(TEST_USER, TEST_WS, "");
  assert.equal(result.memories.length, 0);
});

test("recall filters by category", async () => {
  await remember(TEST_USER, TEST_WS, { content: "Always use semicolons in JS", category: "instruction", importance: 3 });
  const result = await recall(TEST_USER, TEST_WS, "semicolons", { category: "instruction" });
  assert.ok(result.memories.length >= 1);
  assert.ok(result.memories.every((m) => m.category === "instruction"));
});

test("recall filters by minImportance", async () => {
  await remember(TEST_USER, TEST_WS, { content: "Critical deployment note", category: "fact", importance: 5 });
  await remember(TEST_USER, TEST_WS, { content: "Minor deployment detail", category: "fact", importance: 1 });
  const result = await recall(TEST_USER, TEST_WS, "deployment", { minImportance: 4 });
  assert.ok(result.memories.length >= 1);
  assert.ok(result.memories.every((m) => m.importance >= 4));
});

test("recall respects limit", async () => {
  const result = await recall(TEST_USER, TEST_WS, "test", { limit: 2 });
  assert.ok(result.memories.length <= 2);
});

// --- forget ---

test("forget removes a memory", async () => {
  const { id } = await remember(TEST_USER, TEST_WS, { content: "To be forgotten", category: "observation" });
  const result = await forget(TEST_USER, TEST_WS, id);
  assert.equal(result.ok, true);

  // Should not appear in list
  const { memories } = await listMemories(TEST_USER, TEST_WS);
  assert.ok(!memories.find((m) => m.id === id));
});

test("forget returns error for non-existent id", async () => {
  const result = await forget(TEST_USER, TEST_WS, "nonexistent-id");
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});

test("forget returns error for empty memoryId", async () => {
  const result = await forget(TEST_USER, TEST_WS, "");
  assert.equal(result.ok, false);
});

// --- listMemories ---

test("listMemories returns stored memories", async () => {
  const { memories, total } = await listMemories(TEST_USER, TEST_WS);
  assert.ok(Array.isArray(memories));
  assert.ok(total >= 1);
});

test("listMemories filters by category", async () => {
  const { memories } = await listMemories(TEST_USER, TEST_WS, { category: "preference" });
  assert.ok(memories.every((m) => m.category === "preference"));
});

test("listMemories supports offset and limit", async () => {
  const all = await listMemories(TEST_USER, TEST_WS, { limit: 100 });
  if (all.total >= 2) {
    const page = await listMemories(TEST_USER, TEST_WS, { limit: 1, offset: 1 });
    assert.equal(page.memories.length, 1);
    assert.notEqual(page.memories[0].id, all.memories[0].id);
  }
});

test("listMemories sorts by importance", async () => {
  const { memories } = await listMemories(TEST_USER, TEST_WS, { sortBy: "importance" });
  for (let i = 1; i < memories.length; i++) {
    assert.ok((memories[i - 1].importance || 3) >= (memories[i].importance || 3));
  }
});

// --- summarizeMemories ---

test("summarizeMemories returns formatted string", async () => {
  const summary = await summarizeMemories(TEST_USER, TEST_WS);
  assert.ok(typeof summary === "string");
  assert.ok(summary.length > 0);
  assert.ok(summary.includes("**"));
});

test("summarizeMemories filters by category", async () => {
  const summary = await summarizeMemories(TEST_USER, TEST_WS, "preference");
  if (summary) {
    assert.ok(summary.includes("Preference"));
    assert.ok(!summary.includes("Fact"));
  }
});

test("summarizeMemories returns empty string when no memories", async () => {
  const summary = await summarizeMemories("nonexistent-user-xyz", "nonexistent-ws");
  assert.equal(summary, "");
});

// --- getMemoryStats ---

test("getMemoryStats returns correct structure", async () => {
  const stats = await getMemoryStats(TEST_USER, TEST_WS);
  assert.ok(typeof stats.total === "number");
  assert.ok(stats.total >= 1);
  assert.ok(typeof stats.byCategory === "object");
  assert.ok(stats.oldest);
  assert.ok(stats.newest);
  assert.ok(stats.oldest <= stats.newest);
});

test("getMemoryStats byCategory has all categories", async () => {
  const stats = await getMemoryStats(TEST_USER, TEST_WS);
  for (const cat of ["fact", "preference", "context", "instruction", "observation"]) {
    assert.ok(cat in stats.byCategory, `missing category: ${cat}`);
  }
});

// --- Backward-compatible legacy exports ---

test("storeMemory requires consent (legacy)", async () => {
  const result = await storeMemory(TEST_WS, TEST_USER, {
    content: "Legacy memory",
    category: "preference",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /consent/i);
});

test("storeMemory succeeds with consent (legacy)", async () => {
  const result = await storeMemory(TEST_WS, TEST_USER, {
    content: "Legacy memory with consent",
    category: "fact",
    consent: true,
  });
  assert.equal(result.ok, true);
  assert.ok(result.memory);
  assert.ok(result.memory.id);
});

test("storeMemory rejects invalid category (legacy)", async () => {
  const result = await storeMemory(TEST_WS, TEST_USER, {
    content: "Some fact",
    category: "invalid-cat",
    consent: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /category/i);
});

test("storeMemory rejects invalid confidence (legacy)", async () => {
  const result = await storeMemory(TEST_WS, TEST_USER, {
    content: "Some fact",
    confidence: 5,
    consent: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /confidence/i);
});

test("getMemories returns stored memories (legacy)", async () => {
  const memories = await getMemories(TEST_WS, TEST_USER);
  assert.ok(memories.length >= 1);
});

test("searchMemories finds by substring (legacy)", async () => {
  const results = await searchMemories(TEST_WS, TEST_USER, "Legacy memory");
  assert.ok(results.length >= 1);
});

test("deleteMemory soft-deletes (legacy)", async () => {
  const stored = await storeMemory(TEST_WS, TEST_USER, {
    content: "To be deleted legacy",
    category: "fact",
    consent: true,
  });
  const result = await deleteMemory(stored.memory.id, TEST_WS, TEST_USER);
  assert.equal(result.ok, true);
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
