/**
 * Tests for lib/gbrain-memory.js and lib/gbrain-memory-rank.js.
 *
 * The module is written to accept a `deps` parameter for every function so
 * subsystem modules can be swapped for mocks without needing module-level
 * import interception.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "fs";
import { join } from "path";

import {
  unifiedRecall,
  unifiedStore,
  classifyObservation,
  getUnifiedStats,
  consolidateMemory,
  forgetOldMemory,
  buildContextForPrompt,
  linkMemories,
  getRelatedMemories,
} from "../lib/gbrain-memory.js";

import {
  rankByRelevance,
  deduplicateAcrossSystems,
  scoreMemoryImportance,
  memoryText,
  estimateTokens,
} from "../lib/gbrain-memory-rank.js";

// Isolate any on-disk side effects (links file) to a temp STORAGE_PATH.
const TMP_STORAGE = join(process.cwd(), ".tmp-gbrain-test-" + Date.now());
process.env.STORAGE_PATH = TMP_STORAGE;

test.after(() => {
  try { rmSync(TMP_STORAGE, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Mock dependency factory
// ---------------------------------------------------------------------------

function createMockDeps(overrides = {}) {
  const state = {
    facts: [],
    reasoningSteps: [],
    docs: [],
    entities: [],
    conversationResults: [],
    toolStats: {},
  };

  const base = {
    state,
    agentMemory: {
      remember: async (_u, _w, m) => {
        const id = "fact-" + (state.facts.length + 1);
        state.facts.push({ id, ...m, createdAt: new Date().toISOString() });
        return { id, createdAt: new Date().toISOString() };
      },
      recall: async (_u, _w, q) => {
        const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
        const hits = state.facts.filter((f) => {
          const content = (f.content || "").toLowerCase();
          return words.some((w) => content.includes(w));
        });
        return { memories: hits.map((f) => ({
          id: f.id,
          content: f.content,
          category: f.category || "fact",
          importance: f.importance || 3,
          createdAt: f.createdAt,
          relevance: 1,
        })) };
      },
      forget: async (_u, _w, id) => {
        const before = state.facts.length;
        state.facts = state.facts.filter((f) => f.id !== id);
        return { ok: state.facts.length !== before };
      },
      listMemories: async () => ({ memories: state.facts, total: state.facts.length }),
      getMemoryStats: async () => ({
        total: state.facts.length,
        byCategory: {},
        oldest: state.facts[0]?.createdAt || null,
        newest: state.facts[state.facts.length - 1]?.createdAt || null,
      }),
    },
    reasoningMemory: {
      recordReasoningStep: async (conversationId, step) => {
        const id = "reason-" + (state.reasoningSteps.length + 1);
        state.reasoningSteps.push({ id, conversationId, ...step });
        return { id, createdAt: new Date().toISOString() };
      },
      findRelatedReasoning: async (q) => {
        const qLower = (q || "").toLowerCase();
        return state.reasoningSteps
          .filter((s) => JSON.stringify(s).toLowerCase().includes(qLower))
          .map((s) => ({ step: s, conversationId: s.conversationId, relevance: 0.8 }));
      },
      listReasoningConversations: async () => {
        const uniq = new Set(state.reasoningSteps.map((s) => s.conversationId));
        return [...uniq];
      },
      getReasoningChain: async (cid) => ({
        conversationId: cid,
        workspaceId: "default",
        steps: state.reasoningSteps.filter((s) => s.conversationId === cid),
        links: [],
      }),
    },
    knowledgeStore: {
      search: async ({ query }) => {
        const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
        const snippets = state.docs
          .filter((d) => {
            const hay = `${d.title || ""} ${d.content || ""}`.toLowerCase();
            return words.some((w) => hay.includes(w));
          })
          .map((d) => ({ id: d.id, title: d.title, snippet: d.content.slice(0, 200), score: 1 }));
        return { snippets, query };
      },
      semanticSearch: async () => ({ snippets: [] }),
      list: async () => ({ items: state.docs.map((d) => ({ id: d.id, title: d.title, createdAt: d.createdAt })) }),
      indexDocument: async (opts) => {
        const id = "doc-" + (state.docs.length + 1);
        state.docs.push({ id, title: opts.title, content: opts.content, createdAt: new Date().toISOString() });
        return { id };
      },
    },
    knowledgeGraph: {
      getWorkspaceKnowledgeGraph: async () => ({
        findEntities: (q) => {
          if (!q || !q.name) return state.entities.slice();
          const n = String(q.name).toLowerCase();
          return state.entities.filter((e) => e.name.toLowerCase().includes(n));
        },
        addEntity: (e) => {
          const id = "ent-" + (state.entities.length + 1);
          state.entities.push({ id, ...e });
          return { ok: true, id };
        },
        getStats: () => ({ entityCount: state.entities.length, relationCount: 0 }),
      }),
      persistWorkspaceKnowledgeGraph: async () => {},
    },
    conversationSearch: {
      searchConversations: async () => ({ results: state.conversationResults, total: state.conversationResults.length }),
    },
    toolDiscovery: {
      recommendToolsForTask: () => Object.entries(state.toolStats).map(([tool, stats]) => ({
        tool,
        reason: `seen ${stats.uses} times`,
        confidence: stats.successRate || 0.5,
      })),
      getAllStats: () => state.toolStats,
      recordToolUsage: () => {},
    },
  };

  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// classifyObservation
// ---------------------------------------------------------------------------

test("classifyObservation: detects preferences", () => {
  assert.equal(classifyObservation("I prefer dark mode"), "preference");
  assert.equal(classifyObservation("Please always use TypeScript"), "preference");
});

test("classifyObservation: detects reasoning chains", () => {
  assert.equal(classifyObservation("The build failed because the test suite timed out"), "reasoning");
  assert.equal(classifyObservation("Therefore we conclude the cache is stale"), "reasoning");
});

test("classifyObservation: long prose -> document", () => {
  const long = "This is a very long piece of prose. ".repeat(30);
  assert.equal(classifyObservation(long), "document");
});

test("classifyObservation: entity-style statements", () => {
  assert.equal(classifyObservation("Postgres depends on LibPQ"), "entity");
  assert.equal(classifyObservation("SiskelBot uses Express"), "entity");
});

test("classifyObservation: conversation-style input", () => {
  assert.equal(classifyObservation("user: what is the deploy schedule?"), "conversation");
});

test("classifyObservation: defaults to fact", () => {
  assert.equal(classifyObservation("The API key expires monthly"), "fact");
});

test("classifyObservation: empty input defaults to fact", () => {
  assert.equal(classifyObservation(""), "fact");
  assert.equal(classifyObservation(null), "fact");
});

// ---------------------------------------------------------------------------
// unifiedRecall
// ---------------------------------------------------------------------------

test("unifiedRecall: merges results from multiple subsystems", async () => {
  const deps = createMockDeps();
  deps.state.facts.push({
    id: "f1",
    content: "Postgres is the primary database",
    category: "fact",
    importance: 4,
    createdAt: new Date().toISOString(),
  });
  deps.state.docs.push({
    id: "d1",
    title: "Database runbook",
    content: "The Postgres cluster runs on AWS RDS with multi-az",
    createdAt: new Date().toISOString(),
  });
  deps.state.entities.push({ id: "e1", name: "Postgres", type: "technology" });
  deps.state.reasoningSteps.push({
    id: "r1",
    conversationId: "c1",
    premise: "Postgres was upgraded",
    inference: "migrations applied cleanly",
    conclusion: "Postgres is healthy",
  });
  deps.state.conversationResults.push({
    id: "conv-1",
    title: "Postgres outage",
    matchSnippet: "Postgres was down last week",
  });

  const out = await unifiedRecall("postgres", { workspaceId: "ws", limit: 10 }, deps);

  assert.equal(out.facts.length, 1);
  assert.equal(out.documents.length, 1);
  assert.equal(out.entities.length, 1);
  assert.equal(out.reasoning.length, 1);
  assert.equal(out.conversations.length, 1);
  assert.ok(out.combined.length > 0, "combined should merge results");
  // All combined entries should carry a _gbrainScore from ranking.
  for (const m of out.combined) {
    assert.ok(typeof m._gbrainScore === "number");
    assert.ok(m._gbrainSource);
  }
});

test("unifiedRecall: empty query returns empty buckets", async () => {
  const deps = createMockDeps();
  const out = await unifiedRecall("", { workspaceId: "ws" }, deps);
  assert.deepEqual(out.combined, []);
  assert.deepEqual(out.facts, []);
});

test("unifiedRecall: tolerates subsystem errors", async () => {
  const deps = createMockDeps();
  deps.agentMemory.recall = async () => { throw new Error("boom"); };
  deps.knowledgeStore.search = async () => { throw new Error("boom"); };

  const out = await unifiedRecall("anything", { workspaceId: "ws" }, deps);
  assert.deepEqual(out.facts, []);
  assert.deepEqual(out.documents, []);
});

// ---------------------------------------------------------------------------
// unifiedStore
// ---------------------------------------------------------------------------

test("unifiedStore: routes facts to agent-memory", async () => {
  const deps = createMockDeps();
  const res = await unifiedStore(
    { text: "The API version is v2" },
    { userId: "u", workspaceId: "ws" },
    deps
  );
  assert.equal(res.routedTo, "fact");
  assert.equal(deps.state.facts.length, 1);
  assert.equal(deps.state.facts[0].content, "The API version is v2");
});

test("unifiedStore: routes preferences to agent-memory as preference", async () => {
  const deps = createMockDeps();
  const res = await unifiedStore(
    { text: "I prefer tabs over spaces" },
    { userId: "u", workspaceId: "ws" },
    deps
  );
  assert.equal(res.routedTo, "preference");
  assert.equal(deps.state.facts[0].category, "preference");
});

test("unifiedStore: routes reasoning to reasoning-memory", async () => {
  const deps = createMockDeps();
  const res = await unifiedStore(
    { text: "Therefore the deployment is safe because tests passed" },
    { userId: "u", workspaceId: "ws", conversationId: "c1" },
    deps
  );
  assert.equal(res.routedTo, "reasoning");
  assert.equal(deps.state.reasoningSteps.length, 1);
  assert.equal(deps.state.reasoningSteps[0].conversationId, "c1");
});

test("unifiedStore: long content routes to knowledge-store", async () => {
  const deps = createMockDeps();
  const long = "A long-form explanation of our deployment pipeline. ".repeat(20);
  const res = await unifiedStore(
    { text: long },
    { userId: "u", workspaceId: "ws" },
    deps
  );
  assert.equal(res.routedTo, "document");
  assert.equal(deps.state.docs.length, 1);
});

test("unifiedStore: entity statement routes to knowledge-graph", async () => {
  const deps = createMockDeps();
  const res = await unifiedStore(
    { text: "SiskelBot uses Express", metadata: { type: "technology" } },
    { userId: "u", workspaceId: "ws" },
    deps
  );
  assert.equal(res.routedTo, "entity");
  assert.equal(deps.state.entities.length, 1);
});

test("unifiedStore: rejects missing text", async () => {
  const deps = createMockDeps();
  const res = await unifiedStore({ text: "" }, { userId: "u", workspaceId: "ws" }, deps);
  assert.ok(res.error);
  assert.equal(res.routedTo, "none");
});

// ---------------------------------------------------------------------------
// getUnifiedStats
// ---------------------------------------------------------------------------

test("getUnifiedStats: aggregates across subsystems", async () => {
  const deps = createMockDeps();
  deps.state.facts.push(
    { id: "f1", content: "a", importance: 3, createdAt: "2024-01-01T00:00:00Z" },
    { id: "f2", content: "b", importance: 3, createdAt: "2024-06-01T00:00:00Z" }
  );
  deps.state.docs.push({ id: "d1", title: "T", content: "x", createdAt: "2024-03-01T00:00:00Z" });
  deps.state.entities.push({ id: "e1", name: "X", type: "concept" });
  deps.state.reasoningSteps.push({ id: "r1", conversationId: "c1", premise: "p", inference: "i", conclusion: "c" });
  deps.state.toolStats = { search_context: { uses: 5, successRate: 0.8 } };

  const stats = await getUnifiedStats("ws", {}, deps);
  assert.equal(stats.totalFacts, 2);
  assert.equal(stats.totalDocs, 1);
  assert.equal(stats.totalEntities, 1);
  assert.equal(stats.totalReasoning, 1);
  assert.equal(stats.totalConversations, 1);
  assert.equal(stats.totalToolRecords, 1);
  assert.ok(stats.memorySizeBytes > 0);
  assert.ok(stats.oldestEntry);
  assert.ok(stats.newestEntry);
});

// ---------------------------------------------------------------------------
// forgetOldMemory
// ---------------------------------------------------------------------------

test("forgetOldMemory: removes old facts and keeps important ones", async () => {
  const deps = createMockDeps();
  const old = "2023-01-01T00:00:00Z";
  const recent = new Date().toISOString();
  deps.state.facts.push(
    { id: "f1", content: "old fact", importance: 2, createdAt: old },
    { id: "f2", content: "old important", importance: 5, createdAt: old },
    { id: "f3", content: "new fact", importance: 2, createdAt: recent }
  );

  const res = await forgetOldMemory(
    "ws",
    { olderThan: "2024-01-01T00:00:00Z", keepImportant: true },
    deps
  );
  assert.equal(res.forgotten.facts, 1);
  // Important one and the recent one survived.
  assert.equal(deps.state.facts.length, 2);
  assert.ok(deps.state.facts.find((f) => f.id === "f2"));
  assert.ok(deps.state.facts.find((f) => f.id === "f3"));
});

test("forgetOldMemory: dryRun reports count without deleting", async () => {
  const deps = createMockDeps();
  deps.state.facts.push({ id: "f1", content: "x", importance: 1, createdAt: "2023-01-01T00:00:00Z" });
  const res = await forgetOldMemory(
    "ws",
    { olderThan: "2024-01-01T00:00:00Z", dryRun: true },
    deps
  );
  assert.equal(res.forgotten.facts, 1);
  assert.equal(deps.state.facts.length, 1, "dry run must not delete");
});

// ---------------------------------------------------------------------------
// buildContextForPrompt
// ---------------------------------------------------------------------------

test("buildContextForPrompt: assembles context under token budget", async () => {
  const deps = createMockDeps();
  deps.state.facts.push({
    id: "f1",
    content: "The deploy uses Kubernetes",
    importance: 4,
    createdAt: new Date().toISOString(),
  });
  deps.state.docs.push({
    id: "d1",
    title: "K8s runbook",
    content: "Kubernetes cluster lives in us-east-1",
    createdAt: new Date().toISOString(),
  });

  const out = await buildContextForPrompt(
    "tell me about kubernetes",
    { userId: "u", workspaceId: "ws", maxTokens: 200 },
    deps
  );
  assert.ok(out.contextText.includes("Relevant memory"));
  assert.ok(out.totalTokens > 0);
  assert.ok(out.totalTokens <= 300, "should respect token budget approximately");
  assert.ok(out.sourcesUsed.length >= 1);
});

test("buildContextForPrompt: zero budget returns empty", async () => {
  const deps = createMockDeps();
  const out = await buildContextForPrompt("hello", { maxTokens: 0 }, deps);
  assert.equal(out.contextText, "");
  assert.equal(out.totalTokens, 0);
});

test("buildContextForPrompt: includeReasoning=false drops reasoning entries", async () => {
  const deps = createMockDeps();
  deps.state.facts.push({
    id: "f1",
    content: "Kubernetes cluster is healthy",
    importance: 4,
    createdAt: new Date().toISOString(),
  });
  deps.state.reasoningSteps.push({
    id: "r1",
    conversationId: "c1",
    premise: "Kubernetes was upgraded",
    inference: "no pods crashed",
    conclusion: "Kubernetes cluster is healthy",
  });

  const out = await buildContextForPrompt(
    "kubernetes",
    { userId: "u", workspaceId: "ws", maxTokens: 400, includeReasoning: false },
    deps
  );
  assert.ok(!out.sourcesUsed.includes("reasoning"));
});

// ---------------------------------------------------------------------------
// consolidateMemory
// ---------------------------------------------------------------------------

test("consolidateMemory: links facts to entities that are mentioned", async () => {
  const deps = createMockDeps();
  deps.state.entities.push({ id: "e1", name: "Postgres", type: "technology" });
  deps.state.facts.push({
    id: "f1",
    content: "We rely heavily on Postgres for primary storage",
    importance: 3,
    createdAt: new Date().toISOString(),
  });

  const res = await consolidateMemory("ws", {}, deps);
  assert.ok(res.consolidated >= 1);
  assert.ok(res.links >= 1);
});

test("consolidateMemory: no entities -> nothing to link", async () => {
  const deps = createMockDeps();
  deps.state.facts.push({
    id: "f1",
    content: "A standalone fact",
    importance: 3,
    createdAt: new Date().toISOString(),
  });
  const res = await consolidateMemory("ws", {}, deps);
  assert.equal(res.consolidated, 0);
  assert.equal(res.links, 0);
});

// ---------------------------------------------------------------------------
// linkMemories / getRelatedMemories (disk-backed)
// ---------------------------------------------------------------------------

test("linkMemories + getRelatedMemories: round trip", async () => {
  const ws = "link-test-ws-" + Date.now();
  const link = await linkMemories(
    { id: "fact-1", source: "fact" },
    { id: "ent-1", source: "entity" },
    "mentions",
    { workspaceId: ws }
  );
  assert.ok(link.id);

  const related = await getRelatedMemories("fact-1", { workspaceId: ws });
  assert.equal(related.length, 1);
  assert.equal(related[0].related.id, "ent-1");
  assert.equal(related[0].relationType, "mentions");
});

test("linkMemories: rejects missing ids", async () => {
  await assert.rejects(
    () => linkMemories({}, { id: "x", source: "fact" }, "rel"),
    /memoryA.id and memoryB.id are required/
  );
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

test("rankByRelevance: orders by keyword overlap", () => {
  const memories = [
    { content: "The project uses Postgres as database", _gbrainSource: "fact" },
    { content: "The moon is a natural satellite", _gbrainSource: "fact" },
    { content: "Postgres has JSONB support for Postgres queries", _gbrainSource: "fact" },
  ];
  const ranked = rankByRelevance("postgres database", memories);
  assert.equal(ranked.length, 3);
  // The top result should mention both query terms.
  assert.ok(ranked[0].content.toLowerCase().includes("postgres"));
  assert.ok(ranked[0]._gbrainScore >= ranked[2]._gbrainScore);
});

test("rankByRelevance: empty query -> empty result", () => {
  const ranked = rankByRelevance("", [{ content: "x" }]);
  assert.deepEqual(ranked, []);
});

test("rankByRelevance: honors minScore and limit", () => {
  const memories = [
    { content: "apple banana", _gbrainSource: "fact" },
    { content: "banana cherry", _gbrainSource: "fact" },
    { content: "zebra stripes", _gbrainSource: "fact" },
  ];
  const ranked = rankByRelevance("banana", memories, { minScore: 0.01, limit: 2 });
  assert.ok(ranked.length <= 2);
  for (const m of ranked) {
    assert.ok(m._gbrainScore > 0);
  }
});

test("scoreMemoryImportance: respects explicit importance", () => {
  assert.ok(scoreMemoryImportance({ importance: 5 }) > scoreMemoryImportance({ importance: 1 }));
});

test("scoreMemoryImportance: pinned memories score highly", () => {
  assert.ok(scoreMemoryImportance({ pinned: true }) >= 0.9);
});

test("scoreMemoryImportance: user source outranks observation", () => {
  assert.ok(
    scoreMemoryImportance({ source: "user" }) >
    scoreMemoryImportance({ source: "observation" })
  );
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test("deduplicateAcrossSystems: drops duplicate content keeping higher-authority source", () => {
  const memories = [
    { content: "Postgres is the primary database", _gbrainSource: "document", _gbrainScore: 0.5 },
    { content: "Postgres is the primary database", _gbrainSource: "fact", _gbrainScore: 0.4 },
  ];
  const deduped = deduplicateAcrossSystems(memories);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]._gbrainSource, "fact", "fact outranks document");
});

test("deduplicateAcrossSystems: keeps dissimilar items", () => {
  const memories = [
    { content: "Postgres is the database", _gbrainSource: "fact" },
    { content: "Redis is the cache", _gbrainSource: "fact" },
    { content: "Slack is the chat tool", _gbrainSource: "fact" },
  ];
  const deduped = deduplicateAcrossSystems(memories);
  assert.equal(deduped.length, 3);
});

test("deduplicateAcrossSystems: empty input", () => {
  assert.deepEqual(deduplicateAcrossSystems([]), []);
});

// ---------------------------------------------------------------------------
// memoryText helper
// ---------------------------------------------------------------------------

test("memoryText: extracts text from various memory shapes", () => {
  assert.equal(memoryText({ content: "hello" }), "hello");
  assert.equal(memoryText({ snippet: "world", title: "doc" }), "doc world");
  assert.equal(memoryText({ step: { premise: "p", inference: "i", conclusion: "c" } }), "p i c");
  assert.equal(memoryText({ name: "Postgres", type: "technology" }), "Postgres (technology)");
  assert.equal(memoryText({ tool: "search_context" }), "search_context");
  assert.equal(memoryText(null), "");
});

test("estimateTokens: rough char-based estimate", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.ok(estimateTokens("abcdefghij") >= 2);
});
