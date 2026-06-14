import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/conv-search-test-" + Date.now();
});

// Pre-populate some conversations for searching
await test("setup: create test conversations", async () => {
  const storage = await import("../lib/storage.js");
  const conversations = [
    {
      id: "conv-1",
      title: "Weather Discussion",
      createdAt: new Date().toISOString(),
      messages: [
        { role: "user", content: "What is the weather like today?" },
        { role: "assistant", content: "It is sunny and warm today." },
      ],
    },
    {
      id: "conv-2",
      title: "Coding Help",
      createdAt: new Date().toISOString(),
      messages: [
        { role: "user", content: "How do I write a JavaScript function?" },
        { role: "assistant", content: "You can use the function keyword or arrow syntax." },
      ],
    },
    {
      id: "conv-3",
      title: "Recipe Ideas",
      createdAt: new Date().toISOString(),
      messages: [
        { role: "user", content: "Give me a recipe for chocolate cake." },
        { role: "assistant", content: "Mix flour, cocoa, sugar, eggs, and bake at 350F." },
      ],
    },
  ];
  await storage.replace("conversations", conversations, "default", "searchuser");
});

await test("searchConversations returns empty for empty query", async () => {
  const { searchConversations } = await import("../lib/conversation-search.js");
  const result = await searchConversations("", "searchuser", "default");
  assert.deepEqual(result.results, []);
  assert.equal(result.total, 0);
});

await test("searchConversations returns empty for null query", async () => {
  const { searchConversations } = await import("../lib/conversation-search.js");
  const result = await searchConversations(null, "searchuser", "default");
  assert.deepEqual(result.results, []);
});

await test("searchConversations finds matching conversations", async () => {
  const { searchConversations } = await import("../lib/conversation-search.js");
  const result = await searchConversations("weather", "searchuser", "default");
  assert.ok(result.total >= 1);
  assert.ok(result.results[0].title === "Weather Discussion" || result.results[0].matchSnippet.toLowerCase().includes("weather"));
});

await test("searchConversations finds by message content", async () => {
  const { searchConversations } = await import("../lib/conversation-search.js");
  const result = await searchConversations("chocolate cake", "searchuser", "default");
  assert.ok(result.total >= 1);
});

await test("searchConversations returns no results for unmatched query", async () => {
  const { searchConversations } = await import("../lib/conversation-search.js");
  const result = await searchConversations("zzzznonexistent", "searchuser", "default");
  assert.equal(result.total, 0);
});

await test("searchConversations respects limit", async () => {
  const { searchConversations } = await import("../lib/conversation-search.js");
  const result = await searchConversations("the", "searchuser", "default", { limit: 1 });
  assert.ok(result.results.length <= 1);
});

await test("searchConversations respects offset", async () => {
  const { searchConversations } = await import("../lib/conversation-search.js");
  const all = await searchConversations("the", "searchuser", "default");
  if (all.total > 1) {
    const offset = await searchConversations("the", "searchuser", "default", { offset: 1 });
    assert.ok(offset.results.length < all.results.length);
  }
});

await test("searchConversations results have expected shape", async () => {
  const { searchConversations } = await import("../lib/conversation-search.js");
  const result = await searchConversations("JavaScript", "searchuser", "default");
  if (result.total > 0) {
    const r = result.results[0];
    assert.ok(r.conversationId);
    assert.ok(typeof r.title === "string");
    assert.ok(typeof r.score === "number");
    assert.ok(r.score > 0 && r.score <= 1);
  }
});

await test("searchConversations sorts by score descending", async () => {
  const { searchConversations } = await import("../lib/conversation-search.js");
  const result = await searchConversations("the", "searchuser", "default");
  for (let i = 1; i < result.results.length; i++) {
    assert.ok(result.results[i - 1].score >= result.results[i].score);
  }
});
