/**
 * GBrain unified memory cortex.
 *
 * A single interface over every memory subsystem in SiskelBot. GBrain never
 * owns the underlying data; it delegates to:
 *
 *   - lib/agent-memory.js         (structured facts / preferences / instructions)
 *   - lib/reasoning-memory.js     (multi-turn reasoning chains)
 *   - lib/knowledge-store.js      (documents via keyword + semantic search)
 *   - lib/knowledge-graph-store.js + lib/knowledge-graph.js (entities + relations)
 *   - lib/conversation-search.js  (past conversation history)
 *   - lib/tool-discovery.js       (tool effectiveness stats)
 *
 * Functions accept an optional `deps` parameter so tests can swap in mocks
 * without touching global module state. In production `resolveDeps()` loads
 * the real subsystem modules on demand.
 */
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import {
  rankByRelevance,
  deduplicateAcrossSystems,
  scoreMemoryImportance,
  estimateTokens,
  memoryText,
} from "./gbrain-memory-rank.js";

/** Lazy default dependency bundle. Uses dynamic imports so tests can override. */
async function resolveDeps(deps) {
  if (deps && typeof deps === "object") return deps;
  // tool-discovery exports a factory (createToolDiscovery) rather than shared
  // singletons, so the default dependency bundle simply provides a no-op shim.
  // Callers with a live tracker should pass it via deps.toolDiscovery.
  const [
    agentMem,
    reasoningMem,
    knowledgeStore,
    knowledgeGraphStore,
    conversationSearch,
  ] = await Promise.all([
    import("./agent-memory.js"),
    import("./reasoning-memory.js"),
    import("./knowledge-store.js"),
    import("./knowledge-graph-store.js"),
    import("./conversation-search.js"),
  ]);

  return {
    agentMemory: {
      remember: agentMem.remember,
      recall: agentMem.recall,
      forget: agentMem.forget,
      listMemories: agentMem.listMemories,
      getMemoryStats: agentMem.getMemoryStats,
    },
    reasoningMemory: {
      recordReasoningStep: reasoningMem.recordReasoningStep,
      findRelatedReasoning: reasoningMem.findRelatedReasoning,
      listReasoningConversations: reasoningMem.listReasoningConversations,
      getReasoningChain: reasoningMem.getReasoningChain,
    },
    knowledgeStore: {
      search: knowledgeStore.search,
      semanticSearch: knowledgeStore.semanticSearch,
      list: knowledgeStore.list,
      indexDocument: knowledgeStore.indexDocument,
    },
    knowledgeGraph: {
      getWorkspaceKnowledgeGraph: knowledgeGraphStore.getWorkspaceKnowledgeGraph,
      persistWorkspaceKnowledgeGraph: knowledgeGraphStore.persistWorkspaceKnowledgeGraph,
    },
    conversationSearch: {
      searchConversations: conversationSearch.searchConversations,
    },
    toolDiscovery: {
      // Consumers of GBrain may share a long-lived tracker; the default here
      // is a no-op shim that returns nothing. Agent code can pass its own
      // tracker via deps.toolDiscovery.
      recommendToolsForTask: () => [],
      getAllStats: () => ({}),
      recordToolUsage: () => {},
    },
  };
}

function safeString(v) {
  return typeof v === "string" ? v : "";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify what kind of memory a raw observation represents. Used by
 * unifiedStore() to route the observation to the right subsystem.
 *
 * @param {string} text
 * @returns {'fact'|'reasoning'|'document'|'entity'|'conversation'|'preference'}
 */
export function classifyObservation(text) {
  const t = safeString(text).trim();
  if (!t) return "fact";

  const lower = t.toLowerCase();

  // Preferences come first because "I prefer X" is also a fact.
  if (/\b(i prefer|i like|i always|i'd rather|my preference|please always|from now on)\b/.test(lower)) {
    return "preference";
  }

  // Reasoning chains: presence of premise/inference/conclusion wording or
  // therefore/because glue.
  if (/\b(therefore|thus|hence|because|so we|we can infer|this implies|we conclude)\b/.test(lower)) {
    return "reasoning";
  }

  // Long-form prose => document.
  if (t.length > 500 || t.split(/\n/).length > 3) {
    return "document";
  }

  // Entity/relation style: "X uses Y", "X depends on Y", "X is part of Y",
  // "X was created by Y".
  if (/\b(uses|depends on|part of|created by|mentioned in|relates to|is a|is an)\b/.test(lower) &&
      /[A-Z][\w-]+/.test(t)) {
    return "entity";
  }

  // Conversation turns: starts with a role prefix or looks like dialogue.
  if (/^(user|assistant|system)\s*[:>-]/i.test(t) || /\?\s*$/.test(t)) {
    return "conversation";
  }

  return "fact";
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

async function recallFacts(query, context, deps) {
  const { userId, workspaceId, limit } = context;
  try {
    const result = await deps.agentMemory.recall(userId, workspaceId, query, { limit });
    const memories = Array.isArray(result?.memories) ? result.memories : [];
    return memories.map((m) => ({
      ...m,
      _gbrainSource: m.category === "preference" ? "preference" : "fact",
    }));
  } catch {
    return [];
  }
}

async function recallReasoning(query, context, deps) {
  const { workspaceId, limit } = context;
  try {
    const rows = await deps.reasoningMemory.findRelatedReasoning(query, workspaceId, { limit });
    const out = Array.isArray(rows) ? rows : [];
    return out.map((r) => ({
      ...r,
      _gbrainSource: "reasoning",
      createdAt: r.step?.createdAt,
    }));
  } catch {
    return [];
  }
}

async function recallDocuments(query, context, deps) {
  const { workspaceId } = context;
  try {
    const kw = await deps.knowledgeStore.search({ query, workspace: workspaceId });
    const snippets = kw && Array.isArray(kw.snippets) ? kw.snippets : [];
    return snippets.map((s) => ({ ...s, _gbrainSource: "document" }));
  } catch {
    return [];
  }
}

async function recallEntities(query, context, deps) {
  const { workspaceId, limit } = context;
  try {
    const graph = await deps.knowledgeGraph.getWorkspaceKnowledgeGraph(workspaceId);
    if (!graph || typeof graph.findEntities !== "function") return [];
    const entities = graph.findEntities({ name: query }) || [];
    const capped = entities.slice(0, limit || 20);
    return capped.map((e) => ({ ...e, _gbrainSource: "entity" }));
  } catch {
    return [];
  }
}

async function recallConversations(query, context, deps) {
  const { userId, workspaceId, limit } = context;
  try {
    const result = await deps.conversationSearch.searchConversations(
      query,
      userId,
      workspaceId,
      { limit }
    );
    const results = Array.isArray(result?.results) ? result.results : [];
    return results.map((r) => ({ ...r, _gbrainSource: "conversation" }));
  } catch {
    return [];
  }
}

async function recallToolInsights(query, context, deps) {
  try {
    const taskHint = context.taskType || query;
    const recs = deps.toolDiscovery.recommendToolsForTask(taskHint) || [];
    return recs.map((r) => ({ ...r, _gbrainSource: "toolInsight" }));
  } catch {
    return [];
  }
}

/**
 * Query every memory system in parallel and return per-system results plus
 * a merged, re-ranked "combined" list.
 *
 * @param {string} query
 * @param {object} context - { userId, workspaceId, taskType?, limit? }
 * @param {object} [deps] - optional dependency overrides for tests
 * @returns {Promise<{
 *   facts: object[],
 *   reasoning: object[],
 *   documents: object[],
 *   entities: object[],
 *   conversations: object[],
 *   toolInsights: object[],
 *   combined: object[]
 * }>}
 */
export async function unifiedRecall(query, context = {}, deps) {
  const resolved = await resolveDeps(deps);
  const ctx = {
    userId: context.userId || "anonymous",
    workspaceId: context.workspaceId || "default",
    taskType: context.taskType || null,
    limit: Math.max(1, Math.min(Number(context.limit) || 10, 100)),
  };

  if (typeof query !== "string" || !query.trim()) {
    return {
      facts: [],
      reasoning: [],
      documents: [],
      entities: [],
      conversations: [],
      toolInsights: [],
      combined: [],
    };
  }

  const [facts, reasoning, documents, entities, conversations, toolInsights] = await Promise.all([
    recallFacts(query, ctx, resolved),
    recallReasoning(query, ctx, resolved),
    recallDocuments(query, ctx, resolved),
    recallEntities(query, ctx, resolved),
    recallConversations(query, ctx, resolved),
    recallToolInsights(query, ctx, resolved),
  ]);

  // Split preferences out of facts for the caller's convenience while keeping
  // them in the combined rank.
  const allMemories = [
    ...facts,
    ...reasoning,
    ...documents,
    ...entities,
    ...conversations,
    ...toolInsights,
  ];

  const ranked = rankByRelevance(query, allMemories);
  const deduped = deduplicateAcrossSystems(ranked);
  const combined = deduped.slice(0, ctx.limit);

  return {
    facts,
    reasoning,
    documents,
    entities,
    conversations,
    toolInsights,
    combined,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Route a raw observation to the most appropriate memory subsystem.
 *
 * @param {{ text: string, classification?: string, metadata?: object }} observation
 * @param {object} context - { userId, workspaceId, conversationId? }
 * @param {object} [deps]
 * @returns {Promise<{ routedTo: string, id?: string, error?: string }>}
 */
export async function unifiedStore(observation, context = {}, deps) {
  if (!observation || typeof observation !== "object") {
    return { routedTo: "none", error: "observation is required" };
  }
  const text = safeString(observation.text).trim();
  if (!text) return { routedTo: "none", error: "text is required" };

  const resolved = await resolveDeps(deps);
  const userId = context.userId || "anonymous";
  const workspaceId = context.workspaceId || "default";
  const kind = observation.classification || classifyObservation(text);

  try {
    if (kind === "fact" || kind === "preference") {
      const res = await resolved.agentMemory.remember(userId, workspaceId, {
        content: text,
        category: kind === "preference" ? "preference" : "fact",
        importance: observation.metadata?.importance ?? 3,
        source: observation.metadata?.source || null,
        metadata: observation.metadata || {},
      });
      return { routedTo: kind === "preference" ? "preference" : "fact", id: res.id };
    }

    if (kind === "reasoning") {
      const res = await resolved.reasoningMemory.recordReasoningStep(
        context.conversationId || "gbrain-default",
        {
          workspaceId,
          premise: observation.metadata?.premise || "",
          inference: observation.metadata?.inference || text,
          conclusion: observation.metadata?.conclusion || text,
          confidence: observation.metadata?.confidence,
          sources: observation.metadata?.sources || [],
          toolsUsed: observation.metadata?.toolsUsed || [],
        }
      );
      return { routedTo: "reasoning", id: res.id };
    }

    if (kind === "document") {
      const title = observation.metadata?.title || text.slice(0, 60);
      const res = await resolved.knowledgeStore.indexDocument({
        title,
        content: text,
        workspace: workspaceId,
      });
      return { routedTo: "document", id: res?.id };
    }

    if (kind === "entity") {
      const graph = await resolved.knowledgeGraph.getWorkspaceKnowledgeGraph(workspaceId);
      if (!graph || typeof graph.addEntity !== "function") {
        return { routedTo: "entity", error: "knowledge graph unavailable" };
      }
      const name = observation.metadata?.name || text.slice(0, 80);
      const added = graph.addEntity({
        name,
        type: observation.metadata?.type || "concept",
        properties: observation.metadata?.properties || {},
        sourceDocId: observation.metadata?.sourceDocId || null,
      });
      if (added.ok) {
        try {
          await resolved.knowledgeGraph.persistWorkspaceKnowledgeGraph(workspaceId, graph);
        } catch {
          /* persistence failure is non-fatal for the in-memory graph */
        }
      }
      return { routedTo: "entity", id: added.id, error: added.ok ? undefined : added.error };
    }

    if (kind === "conversation") {
      // Conversations are stored by the chat pipeline, not by us. We just
      // fall back to persisting as a low-importance fact so the observation
      // is not lost.
      const res = await resolved.agentMemory.remember(userId, workspaceId, {
        content: text,
        category: "context",
        importance: 2,
        source: "conversation",
      });
      return { routedTo: "conversation", id: res.id };
    }

    // Unknown classification => treat as a fact.
    const fallback = await resolved.agentMemory.remember(userId, workspaceId, {
      content: text,
      category: "fact",
      importance: 2,
    });
    return { routedTo: "fact", id: fallback.id };
  } catch (err) {
    return { routedTo: kind, error: err?.message || "store failed" };
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * Aggregate stats from every memory subsystem for a workspace.
 *
 * @param {string} workspaceId
 * @param {object} [options] - { userId? }
 * @param {object} [deps]
 */
export async function getUnifiedStats(workspaceId, options = {}, deps) {
  const resolved = await resolveDeps(deps);
  const userId = options.userId || "anonymous";
  const ws = workspaceId || "default";

  const [factStats, docList, graph, reasoningConvs] = await Promise.all([
    safeCall(() => resolved.agentMemory.getMemoryStats(userId, ws), { total: 0, oldest: null, newest: null }),
    safeCall(() => resolved.knowledgeStore.list({ workspace: ws }), { items: [] }),
    safeCall(() => resolved.knowledgeGraph.getWorkspaceKnowledgeGraph(ws), null),
    safeCall(() => resolved.reasoningMemory.listReasoningConversations(ws), []),
  ]);

  let totalEntities = 0;
  let totalRelations = 0;
  if (graph && typeof graph.getStats === "function") {
    try {
      const gs = graph.getStats();
      totalEntities = gs.entityCount || 0;
      totalRelations = gs.relationCount || 0;
    } catch {
      /* ignore */
    }
  }

  let totalReasoning = 0;
  if (Array.isArray(reasoningConvs)) {
    for (const cid of reasoningConvs) {
      try {
        const chain = await resolved.reasoningMemory.getReasoningChain(cid, ws);
        totalReasoning += Array.isArray(chain?.steps) ? chain.steps.length : 0;
      } catch {
        /* ignore individual chain load errors */
      }
    }
  }

  const toolStats = (() => {
    try { return resolved.toolDiscovery.getAllStats() || {}; } catch { return {}; }
  })();

  const docs = docList && Array.isArray(docList.items) ? docList.items : [];
  const oldestDoc = docs.reduce((acc, d) => {
    if (!d.createdAt) return acc;
    return !acc || d.createdAt < acc ? d.createdAt : acc;
  }, null);
  const newestDoc = docs.reduce((acc, d) => {
    if (!d.createdAt) return acc;
    return !acc || d.createdAt > acc ? d.createdAt : acc;
  }, null);

  const candidates = [
    factStats.oldest,
    oldestDoc,
  ].filter(Boolean);
  const oldest = candidates.length ? candidates.sort()[0] : null;
  const newestCandidates = [
    factStats.newest,
    newestDoc,
  ].filter(Boolean);
  const newest = newestCandidates.length
    ? newestCandidates.sort().reverse()[0]
    : null;

  return {
    totalFacts: factStats.total || 0,
    totalReasoning,
    totalDocs: docs.length,
    totalEntities,
    totalRelations,
    totalConversations: Array.isArray(reasoningConvs) ? reasoningConvs.length : 0,
    totalToolRecords: Object.keys(toolStats).length,
    memorySizeBytes: estimateMemorySizeBytes({ factStats, docs, totalEntities, totalReasoning }),
    oldestEntry: oldest,
    newestEntry: newest,
  };
}

function estimateMemorySizeBytes({ factStats, docs, totalEntities, totalReasoning }) {
  // Rough heuristic; storage backends report actual sizes elsewhere.
  const perFact = 200;
  const perDoc = 2048;
  const perEntity = 150;
  const perReasoning = 400;
  return (
    (factStats.total || 0) * perFact +
    (docs.length || 0) * perDoc +
    totalEntities * perEntity +
    totalReasoning * perReasoning
  );
}

async function safeCall(fn, fallback) {
  try {
    const v = await fn();
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

/**
 * Walk the fact store and the knowledge graph to link facts that mention an
 * entity to that entity. Light-touch: creates cross-system links, never
 * mutates source records.
 *
 * @param {string} workspaceId
 * @param {object} [options] - { userId? }
 * @param {object} [deps]
 * @returns {Promise<{ consolidated: number, links: number }>}
 */
export async function consolidateMemory(workspaceId, options = {}, deps) {
  const resolved = await resolveDeps(deps);
  const userId = options.userId || "anonymous";
  const ws = workspaceId || "default";

  let graph;
  try {
    graph = await resolved.knowledgeGraph.getWorkspaceKnowledgeGraph(ws);
  } catch {
    return { consolidated: 0, links: 0 };
  }

  let facts;
  try {
    const f = await resolved.agentMemory.listMemories(userId, ws, { limit: 200 });
    facts = Array.isArray(f?.memories) ? f.memories : [];
  } catch {
    facts = [];
  }

  if (!graph || typeof graph.findEntities !== "function") {
    return { consolidated: 0, links: 0 };
  }

  let allEntities;
  try {
    allEntities = graph.findEntities({}) || [];
  } catch {
    allEntities = [];
  }

  let consolidated = 0;
  let links = 0;
  for (const fact of facts) {
    const text = safeString(fact.content).toLowerCase();
    if (!text) continue;
    for (const ent of allEntities) {
      const name = safeString(ent.name).toLowerCase();
      if (!name || name.length < 3) continue;
      if (text.includes(name)) {
        try {
          await linkMemories(
            { id: fact.id, source: "fact" },
            { id: ent.id, source: "entity" },
            "mentions",
            { workspaceId: ws }
          );
          links++;
        } catch {
          /* ignore link failures */
        }
        consolidated++;
        break;
      }
    }
  }

  return { consolidated, links };
}

// ---------------------------------------------------------------------------
// Retention / forget
// ---------------------------------------------------------------------------

/**
 * Apply a TTL across every memory subsystem.
 *
 * @param {string} workspaceId
 * @param {object} options - { olderThan: ISO string, keepImportant?: boolean, dryRun?: boolean, userId? }
 * @param {object} [deps]
 */
export async function forgetOldMemory(workspaceId, options = {}, deps) {
  const resolved = await resolveDeps(deps);
  const userId = options.userId || "anonymous";
  const ws = workspaceId || "default";
  const cutoff = options.olderThan;
  const dryRun = !!options.dryRun;
  const keepImportant = options.keepImportant !== false;

  const forgotten = { facts: 0, reasoning: 0, documents: 0, entities: 0, conversations: 0 };
  if (!cutoff) return { forgotten };

  // Facts
  try {
    const f = await resolved.agentMemory.listMemories(userId, ws, { limit: 200 });
    const mems = Array.isArray(f?.memories) ? f.memories : [];
    for (const m of mems) {
      if (m.createdAt && m.createdAt < cutoff) {
        if (keepImportant && (m.importance || 0) >= 4) continue;
        if (!dryRun) {
          try { await resolved.agentMemory.forget(userId, ws, m.id); } catch { /* ignore */ }
        }
        forgotten.facts++;
      }
    }
  } catch {
    /* ignore */
  }

  return { forgotten };
}

// ---------------------------------------------------------------------------
// Context assembly for prompts
// ---------------------------------------------------------------------------

/**
 * Assemble a bounded context string to inject into an LLM prompt.
 *
 * @param {string} prompt - the upcoming user prompt; used as a recall query
 * @param {object} options - { userId, workspaceId, maxTokens?, includeReasoning? }
 * @param {object} [deps]
 * @returns {Promise<{ contextText: string, sourcesUsed: string[], totalTokens: number }>}
 */
export async function buildContextForPrompt(prompt, options = {}, deps) {
  const maxTokens = Math.max(0, Number(options.maxTokens) || 800);
  const includeReasoning = options.includeReasoning !== false;

  if (maxTokens === 0 || typeof prompt !== "string" || !prompt.trim()) {
    return { contextText: "", sourcesUsed: [], totalTokens: 0 };
  }

  const recall = await unifiedRecall(
    prompt,
    {
      userId: options.userId,
      workspaceId: options.workspaceId,
      limit: 20,
    },
    deps
  );

  const lines = [];
  const sourcesUsed = new Set();
  let totalTokens = 0;

  function push(label, text, src) {
    if (!text) return false;
    const line = `- [${label}] ${text}`;
    const cost = estimateTokens(line);
    if (totalTokens + cost > maxTokens) return false;
    lines.push(line);
    totalTokens += cost;
    sourcesUsed.add(src);
    return true;
  }

  for (const m of recall.combined) {
    if (!includeReasoning && m._gbrainSource === "reasoning") continue;
    const label = m._gbrainSource || "memory";
    const text = memoryText(m).replace(/\s+/g, " ").trim().slice(0, 400);
    if (!push(label, text, m._gbrainSource || "memory")) break;
  }

  const contextText = lines.length > 0
    ? `# Relevant memory\n${lines.join("\n")}`
    : "";
  if (contextText) totalTokens = estimateTokens(contextText);

  return {
    contextText,
    sourcesUsed: [...sourcesUsed],
    totalTokens,
  };
}

// ---------------------------------------------------------------------------
// Cross-system links
// ---------------------------------------------------------------------------

function getLinksFilePath(workspaceId) {
  const root = process.env.STORAGE_PATH || join(process.cwd(), "data");
  const safe = String(workspaceId || "default").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
  return join(root, "gbrain", safe, "links.json");
}

function loadLinksFile(workspaceId) {
  const p = getLinksFilePath(workspaceId);
  try {
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* corrupt -> fresh */
  }
  return [];
}

function saveLinksFile(workspaceId, links) {
  const p = getLinksFilePath(workspaceId);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(links, null, 2), "utf8");
}

/**
 * Create a cross-subsystem link between two memory entries. Both ends are
 * identified by `{ id, source }` descriptors so the link layer can point at
 * anything GBrain knows about.
 *
 * @param {{ id: string, source: string }} memoryA
 * @param {{ id: string, source: string }} memoryB
 * @param {string} relationType
 * @param {{ workspaceId?: string }} [options]
 */
export async function linkMemories(memoryA, memoryB, relationType, options = {}) {
  if (!memoryA?.id || !memoryB?.id) {
    throw new Error("memoryA.id and memoryB.id are required");
  }
  if (typeof relationType !== "string" || !relationType.trim()) {
    throw new Error("relationType is required");
  }
  const workspaceId = options.workspaceId || "default";
  const links = loadLinksFile(workspaceId);
  const entry = {
    id: randomUUID(),
    a: { id: String(memoryA.id), source: String(memoryA.source || "unknown") },
    b: { id: String(memoryB.id), source: String(memoryB.source || "unknown") },
    relationType: relationType.trim(),
    createdAt: new Date().toISOString(),
  };
  links.push(entry);
  saveLinksFile(workspaceId, links);
  return entry;
}

/**
 * Find every cross-system link that touches a given memory id.
 *
 * @param {string} memoryId
 * @param {{ workspaceId?: string }} [options]
 */
export async function getRelatedMemories(memoryId, options = {}) {
  if (!memoryId) return [];
  const workspaceId = options.workspaceId || "default";
  const links = loadLinksFile(workspaceId);
  return links
    .filter((l) => l.a.id === memoryId || l.b.id === memoryId)
    .map((l) => ({
      related: l.a.id === memoryId ? l.b : l.a,
      relationType: l.relationType,
      linkId: l.id,
      createdAt: l.createdAt,
    }));
}

// Re-export ranking helpers so consumers can import everything from one module.
export { rankByRelevance, deduplicateAcrossSystems, scoreMemoryImportance };
