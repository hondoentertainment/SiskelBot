/**
 * Tests for lib/agent-memory-inject.js — scoreMemory, buildMemoryBlock, injectMemories.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { scoreMemory, buildMemoryBlock, injectMemories } from "../lib/agent-memory-inject.js";

// ---------------------------------------------------------------------------
// scoreMemory
// ---------------------------------------------------------------------------

test("scoreMemory: memory mentioning 'deploy' scores high when user says 'deploy the app'", () => {
  const memory = {
    content: "The deploy pipeline uses GitHub Actions",
    importance: 4,
    createdAt: new Date().toISOString(),
  };
  const scores = scoreMemory(memory, "deploy the app");
  assert.ok(scores.keyword > 0, "keyword score should be positive for matching word");
  assert.ok(scores.combined > 0.3, "combined score should be meaningfully high");
});

test("scoreMemory: memory scores low for completely unrelated message", () => {
  const memory = {
    content: "PostgreSQL replication is configured for high availability",
    importance: 3,
    createdAt: new Date().toISOString(),
  };
  const scores = scoreMemory(memory, "bake a chocolate cake tonight");
  assert.equal(scores.keyword, 0, "keyword score should be 0 when no meaningful words overlap");
});

test("scoreMemory: today's memory scores higher recency than 30-day-old", () => {
  const now = new Date();
  const todayMemory = {
    content: "something",
    importance: 3,
    createdAt: now.toISOString(),
  };
  const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oldMemory = {
    content: "something",
    importance: 3,
    createdAt: oldDate.toISOString(),
  };
  const todayScores = scoreMemory(todayMemory, "anything", now);
  const oldScores = scoreMemory(oldMemory, "anything", now);
  assert.ok(
    todayScores.recency > oldScores.recency,
    `today recency ${todayScores.recency} should exceed 30-day ${oldScores.recency}`
  );
});

test("scoreMemory: importance 5 scores higher than importance 1", () => {
  const now = new Date();
  const highImp = { content: "test", importance: 5, createdAt: now.toISOString() };
  const lowImp = { content: "test", importance: 1, createdAt: now.toISOString() };
  const highScores = scoreMemory(highImp, "test", now);
  const lowScores = scoreMemory(lowImp, "test", now);
  assert.ok(
    highScores.importance > lowScores.importance,
    `importance=5 score ${highScores.importance} should exceed importance=1 score ${lowScores.importance}`
  );
  assert.equal(highScores.importance, 1, "importance=5 maps to 1.0");
  assert.equal(lowScores.importance, 0, "importance=1 maps to 0.0");
});

test("scoreMemory: combined formula weights are 0.5 keyword + 0.3 recency + 0.2 importance", () => {
  const now = new Date();
  const memory = { content: "deploy app", importance: 5, createdAt: now.toISOString() };
  const scores = scoreMemory(memory, "deploy app", now);
  // keyword=1.0 (both words match), recency=1.0 (created now), importance=1.0 (5->1.0)
  const expected = 0.5 * 1.0 + 0.3 * 1.0 + 0.2 * 1.0;
  assert.ok(
    Math.abs(scores.combined - expected) < 0.01,
    `combined ${scores.combined} should be close to ${expected}`
  );
});

test("scoreMemory: handles missing createdAt gracefully", () => {
  const scores = scoreMemory({ content: "test", importance: 3 }, "test");
  assert.equal(typeof scores.recency, "number");
  assert.equal(typeof scores.combined, "number");
});

test("scoreMemory: handles empty user message", () => {
  const scores = scoreMemory({ content: "test", importance: 3, createdAt: new Date().toISOString() }, "");
  assert.equal(scores.keyword, 0);
  assert.equal(typeof scores.combined, "number");
});

// ---------------------------------------------------------------------------
// buildMemoryBlock
// ---------------------------------------------------------------------------

test("buildMemoryBlock: formats correctly with category and importance", () => {
  const memories = [
    { content: "Uses PostgreSQL for storage", category: "fact", importance: 4 },
    { content: "Prefers dark mode", category: "preference", importance: 2 },
  ];
  const block = buildMemoryBlock(memories);
  assert.ok(block.includes("## Workspace Memory"), "should have header");
  assert.ok(block.includes("remembered facts"), "should have description line");
  assert.ok(block.includes("[fact] Uses PostgreSQL for storage (importance: 4)"), "first memory formatted");
  assert.ok(block.includes("[preference] Prefers dark mode (importance: 2)"), "second memory formatted");
});

test("buildMemoryBlock: returns empty string for empty array", () => {
  assert.equal(buildMemoryBlock([]), "");
});

test("buildMemoryBlock: returns empty string for non-array", () => {
  assert.equal(buildMemoryBlock(null), "");
  assert.equal(buildMemoryBlock(undefined), "");
});

test("buildMemoryBlock: defaults category to fact and importance to 3", () => {
  const block = buildMemoryBlock([{ content: "some memory" }]);
  assert.ok(block.includes("[fact]"), "defaults to fact category");
  assert.ok(block.includes("(importance: 3)"), "defaults to importance 3");
});

// ---------------------------------------------------------------------------
// injectMemories — using _listMemoriesFn for dependency injection
// ---------------------------------------------------------------------------

const NOW = new Date("2026-04-17T12:00:00Z");

function makeMockMemories(count) {
  const memories = [];
  for (let i = 0; i < count; i++) {
    const daysAgo = i; // first memory is most recent
    const date = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
    memories.push({
      id: `mem-${i}`,
      content: `Memory about deploy and testing number ${i}`,
      category: i % 2 === 0 ? "fact" : "preference",
      importance: Math.min(5, 1 + (i % 5)),
      createdAt: date.toISOString(),
      deleted: false,
    });
  }
  return memories;
}

function mockListFn(memories) {
  return async () => ({ memories, total: memories.length });
}

test("injectMemories: inserts system message at correct position", async () => {
  const mockMemories = makeMockMemories(5);
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "deploy the app" },
  ];

  const result = await injectMemories({
    messages,
    workspace: "default",
    userId: "user1",
    _listMemoriesFn: mockListFn(mockMemories),
  });

  assert.ok(result.injectedCount > 0, "should inject at least one memory");
  assert.equal(result.messages[0].role, "system", "first message stays system");
  assert.equal(result.messages[0].content, "You are a helpful assistant.", "original system prompt preserved");
  assert.equal(result.messages[1].role, "system", "injected memory is second system message");
  assert.ok(result.messages[1].content.includes("## Workspace Memory"), "injected content has memory header");
  assert.equal(result.messages[2].role, "user", "user message follows after injection");
  assert.equal(result.messages.length, messages.length + 1, "exactly one message added");
});

test("injectMemories: respects maxMemories cap", async () => {
  const mockMemories = makeMockMemories(20);
  const messages = [
    { role: "system", content: "System prompt." },
    { role: "user", content: "deploy the app" },
  ];

  const result = await injectMemories({
    messages,
    workspace: "ws",
    userId: "u",
    maxMemories: 3,
    _listMemoriesFn: mockListFn(mockMemories),
  });

  assert.ok(result.injectedCount <= 3, `injectedCount ${result.injectedCount} should be <= 3`);
  assert.equal(result.totalMemories, 20, "totalMemories reflects all stored memories");
});

test("injectMemories: respects maxTokens cap", async () => {
  // Create memories with long content to exceed a small token budget
  const bigMemories = [];
  for (let i = 0; i < 10; i++) {
    bigMemories.push({
      id: `big-${i}`,
      content: "deploy ".repeat(50).trim(), // ~350 chars each
      category: "fact",
      importance: 5,
      createdAt: new Date(NOW.getTime() - i * 86400000).toISOString(),
      deleted: false,
    });
  }

  const messages = [
    { role: "user", content: "deploy" },
  ];

  // With maxTokens=100 (~400 chars), only 1 memory line should fit
  const result = await injectMemories({
    messages,
    workspace: "ws",
    userId: "u",
    maxTokens: 100,
    _listMemoriesFn: mockListFn(bigMemories),
  });

  assert.ok(result.injectedCount < 10, `should trim: got ${result.injectedCount} of 10`);
  assert.ok(result.injectedCount >= 1, "should inject at least 1 memory (first always fits)");
});

test("injectMemories: empty memories returns messages unchanged", async () => {
  const messages = [
    { role: "system", content: "System." },
    { role: "user", content: "hello" },
  ];

  const result = await injectMemories({
    messages,
    workspace: "ws",
    userId: "u",
    _listMemoriesFn: mockListFn([]),
  });

  assert.equal(result.injectedCount, 0);
  assert.equal(result.totalMemories, 0);
  assert.deepEqual(result.messages, messages, "messages array should be unchanged");
});

test("injectMemories: throwing store returns messages unchanged, injectedCount 0", async () => {
  const messages = [
    { role: "system", content: "System prompt." },
    { role: "user", content: "deploy" },
  ];

  const throwingFn = async () => { throw new Error("Storage unavailable"); };

  const result = await injectMemories({
    messages,
    workspace: "ws",
    userId: "u",
    _listMemoriesFn: throwingFn,
  });

  assert.equal(result.injectedCount, 0, "injectedCount should be 0 on error");
  assert.deepEqual(result.messages, messages, "messages should be unchanged on error");
});

test("injectMemories: works when no system message exists", async () => {
  const mockMemories = makeMockMemories(3);
  const messages = [
    { role: "user", content: "deploy the app" },
  ];

  const result = await injectMemories({
    messages,
    workspace: "ws",
    userId: "u",
    _listMemoriesFn: mockListFn(mockMemories),
  });

  assert.ok(result.injectedCount > 0);
  assert.equal(result.messages[0].role, "system", "memory block prepended as system message");
  assert.equal(result.messages[1].role, "user", "user message follows");
});

test("injectMemories: returns topScore from highest-ranked memory", async () => {
  const mockMemories = [
    {
      id: "m1",
      content: "deploy pipeline config",
      category: "fact",
      importance: 5,
      createdAt: NOW.toISOString(),
      deleted: false,
    },
    {
      id: "m2",
      content: "unrelated obscure trivia item",
      category: "observation",
      importance: 1,
      createdAt: new Date(NOW.getTime() - 60 * 86400000).toISOString(),
      deleted: false,
    },
  ];

  const result = await injectMemories({
    messages: [{ role: "user", content: "deploy the app" }],
    workspace: "ws",
    userId: "u",
    _listMemoriesFn: mockListFn(mockMemories),
  });

  assert.ok(result.topScore > 0, "topScore should be positive");
  assert.ok(result.topScore <= 1, "topScore should be <= 1");
});

test("injectMemories: missing userId returns unchanged", async () => {
  const messages = [{ role: "user", content: "hello" }];
  const result = await injectMemories({ messages, workspace: "ws", userId: "" });
  assert.equal(result.injectedCount, 0);
  assert.deepEqual(result.messages, messages);
});

test("injectMemories: does not mutate original messages array", async () => {
  const mockMemories = makeMockMemories(3);
  const messages = [
    { role: "system", content: "System." },
    { role: "user", content: "deploy" },
  ];
  const originalLen = messages.length;

  const result = await injectMemories({
    messages,
    workspace: "ws",
    userId: "u",
    _listMemoriesFn: mockListFn(mockMemories),
  });

  assert.equal(messages.length, originalLen, "original array should not be modified");
  assert.ok(result.messages.length > originalLen, "returned array should be longer");
});
