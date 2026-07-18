/**
 * Phase 20: Agent long-term memory persistence.
 * Persistent, searchable memory system for agents.
 * Storage: data/memory/{userId}/{workspaceId}/memories.json
 *
 * Categories: 'fact', 'preference', 'context', 'instruction', 'observation'
 * Importance: 1-5 (5 = critical)
 */
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const VALID_CATEGORIES = ["fact", "preference", "context", "instruction", "observation"];
const MAX_MEMORIES = 1000;

function getDataDir() {
  return process.env.STORAGE_PATH || join(process.cwd(), "data");
}

function getMemoryFilePath(userId, workspaceId) {
  const uid = sanitize(userId, "anonymous");
  const ws = sanitize(workspaceId, "default");
  return join(getDataDir(), "memory", uid, ws, "memories.json");
}

function sanitize(val, fallback) {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadAll(userId, workspaceId) {
  const filePath = getMemoryFilePath(userId, workspaceId);
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf8"));
    }
  } catch {
    // corrupted file, start fresh
  }
  return [];
}

function saveAll(userId, workspaceId, memories) {
  const filePath = getMemoryFilePath(userId, workspaceId);
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(memories, null, 2), "utf8");
}

/**
 * Store a memory.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {object} memory - { content, category?, importance?, source?, metadata? }
 * @returns {Promise<{ id: string, createdAt: string }>}
 */
export async function remember(userId, workspaceId, memory) {
  const content = typeof memory.content === "string" ? memory.content.trim() : "";
  if (!content) {
    throw new Error("content is required");
  }

  const category = memory.category || "fact";
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);
  }

  const importance = memory.importance != null ? Number(memory.importance) : 3;
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new Error("importance must be an integer between 1 and 5");
  }

  let memories = loadAll(userId, workspaceId);

  // Opportunistic consolidation: when near the cap, fold near-duplicates into
  // summaries so we don't wedge. No-op unless AGENT_MEMORY_CONSOLIDATE=1 and
  // count is >= 80% of cap. Safe to ignore the source flag here because the
  // module's own gate handles it.
  if (memories.filter((m) => !m.deleted).length >= Math.floor(MAX_MEMORIES * 0.8)) {
    try {
      const { consolidateIfNeeded } = await import("./agent-memory-consolidate.js");
      await consolidateIfNeeded(userId, workspaceId);
      memories = loadAll(userId, workspaceId);
    } catch { /* consolidation is best-effort */ }
  }

  if (memories.filter((m) => !m.deleted).length >= MAX_MEMORIES) {
    throw new Error(`Maximum memory limit reached (${MAX_MEMORIES})`);
  }

  const now = new Date().toISOString();
  const entry = {
    id: randomUUID(),
    content,
    category,
    importance,
    source: memory.source || null,
    metadata: memory.metadata && typeof memory.metadata === "object" ? memory.metadata : {},
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };

  memories.push(entry);
  saveAll(userId, workspaceId, memories);

  return { id: entry.id, createdAt: entry.createdAt };
}

const MIN_SEMANTIC_RELEVANCE = 0.15;

function keywordRelevance(content, words) {
  if (!words.length) return 0;
  const text = (content || "").toLowerCase();
  let matchCount = 0;
  for (const w of words) {
    if (text.includes(w)) matchCount++;
  }
  return matchCount / words.length;
}

/**
 * Rank recall candidates. When `semanticScores` (parallel to `filtered`) is
 * provided, blend cosine similarity with keyword overlap so semantically
 * related memories surface even without exact word matches; otherwise fall
 * back to pure keyword scoring (matches only).
 * Pure function — exported for testing.
 */
export function rankRecallCandidates(filtered, words, semanticScores) {
  const useSemantic = Array.isArray(semanticScores) && semanticScores.length === filtered.length;
  const now = Date.now();
  const halfLifeDays = Math.max(1, Number(process.env.AGENT_MEMORY_DECAY_HALF_LIFE_DAYS) || 30);
  const scored = [];
  for (let i = 0; i < filtered.length; i++) {
    const m = filtered[i];
    const kw = keywordRelevance(m.content, words);
    let relevance;
    if (useSemantic) {
      const sem = Math.max(0, Number(semanticScores[i]) || 0);
      relevance = 0.7 * sem + 0.3 * kw;
      if (relevance < MIN_SEMANTIC_RELEVANCE) continue;
    } else {
      if (kw === 0) continue;
      relevance = kw;
    }
    const ageMs = Math.max(0, now - Date.parse(m.createdAt || m.updatedAt || now));
    const ageDays = ageMs / (86400 * 1000);
    const decay = Math.pow(0.5, ageDays / halfLifeDays);
    const importanceBoost = (Number(m.importance) || 3) / 5;
    const effective = relevance * (0.55 + 0.45 * decay) * (0.7 + 0.3 * importanceBoost);
    scored.push({
      id: m.id,
      content: m.content,
      category: m.category,
      importance: m.importance,
      createdAt: m.createdAt,
      relevance: Math.round(effective * 100) / 100,
      decay: Math.round(decay * 100) / 100,
    });
  }
  scored.sort((a, b) => b.relevance - a.relevance || (b.importance || 3) - (a.importance || 3));
  return scored;
}

/**
 * Search memories by query. Uses embedding-based semantic similarity when
 * enabled (AGENT_MEMORY_SEMANTIC=1 + embeddings available), otherwise
 * keyword matching. Pass options.semantic=false to force keyword-only.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} query
 * @param {object} options - { category?, limit?, minImportance?, dateFrom?, dateTo?, semantic? }
 * @returns {Promise<{ memories: Array<{ id, content, category, importance, createdAt, relevance }>, mode: string }>}
 */
export async function recall(userId, workspaceId, query, options = {}) {
  if (!query || typeof query !== "string" || !query.trim()) {
    return { memories: [], mode: "none" };
  }

  const memories = loadAll(userId, workspaceId);
  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);

  let filtered = memories.filter((m) => !m.deleted);

  if (options.category) {
    filtered = filtered.filter((m) => m.category === options.category);
  }
  if (options.minImportance) {
    const min = Number(options.minImportance);
    filtered = filtered.filter((m) => (m.importance || 3) >= min);
  }
  if (options.dateFrom) {
    filtered = filtered.filter((m) => m.createdAt >= options.dateFrom);
  }
  if (options.dateTo) {
    filtered = filtered.filter((m) => m.createdAt <= options.dateTo);
  }

  // Optional embedding-based scoring; falls back to keyword on any failure.
  let semanticScores = null;
  let mode = "keyword";
  if (options.semantic !== false && filtered.length > 0) {
    try {
      const { semanticMemoryEnabled, scoreMemoriesSemantic } = await import("./agent-memory-semantic.js");
      if (semanticMemoryEnabled()) {
        const s = await scoreMemoriesSemantic(filtered, query);
        if (Array.isArray(s) && s.length === filtered.length) {
          semanticScores = s;
          mode = "semantic";
        }
      }
    } catch {
      /* fall back to keyword */
    }
  }

  const scored = rankRecallCandidates(filtered, words, semanticScores);
  const limit = Math.min(Math.max(1, Number(options.limit) || 20), 100);
  return { memories: scored.slice(0, limit), mode };
}

/**
 * Remove a memory by ID.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} memoryId
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function forget(userId, workspaceId, memoryId) {
  if (!memoryId) return { ok: false, error: "memoryId is required" };

  const memories = loadAll(userId, workspaceId);
  const idx = memories.findIndex((m) => m.id === memoryId && !m.deleted);
  if (idx === -1) {
    return { ok: false, error: "Memory not found" };
  }

  memories[idx].deleted = true;
  memories[idx].updatedAt = new Date().toISOString();
  saveAll(userId, workspaceId, memories);
  return { ok: true };
}

/**
 * List memories with filtering and sorting.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {object} options - { category?, limit?, offset?, sortBy? }
 * @returns {Promise<{ memories: Array, total: number }>}
 */
export async function listMemories(userId, workspaceId, options = {}) {
  const memories = loadAll(userId, workspaceId);
  let active = memories.filter((m) => !m.deleted);

  if (options.category) {
    active = active.filter((m) => m.category === options.category);
  }

  const sortBy = options.sortBy || "createdAt";
  if (sortBy === "importance") {
    active.sort((a, b) => (b.importance || 3) - (a.importance || 3));
  } else {
    active.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  const total = active.length;
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.min(Math.max(1, Number(options.limit) || 50), 200);

  return { memories: active.slice(offset, offset + limit), total };
}

/**
 * Compile memories into a concise summary for system prompt injection.
 * @param {string} userId
 * @param {string} workspaceId
 * @param {string} [category] - Optional category filter
 * @returns {Promise<string>}
 */
export async function summarizeMemories(userId, workspaceId, category) {
  const memories = loadAll(userId, workspaceId);
  let active = memories.filter((m) => !m.deleted);

  if (category) {
    active = active.filter((m) => m.category === category);
  }

  // Sort by importance desc, then recency
  active.sort((a, b) => (b.importance || 3) - (a.importance || 3) || (b.createdAt || "").localeCompare(a.createdAt || ""));

  if (active.length === 0) return "";

  const grouped = {};
  for (const m of active) {
    const cat = m.category || "fact";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m);
  }

  const lines = [];
  for (const cat of VALID_CATEGORIES) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;
    lines.push(`**${cat.charAt(0).toUpperCase() + cat.slice(1)}s:**`);
    for (const m of items.slice(0, 10)) {
      lines.push(`- ${m.content}`);
    }
    if (items.length > 10) {
      lines.push(`- ... and ${items.length - 10} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Get memory statistics for a user+workspace.
 * @param {string} userId
 * @param {string} workspaceId
 * @returns {Promise<{ total: number, byCategory: object, oldest: string|null, newest: string|null }>}
 */
export async function getMemoryStats(userId, workspaceId) {
  const memories = loadAll(userId, workspaceId);
  const active = memories.filter((m) => !m.deleted);

  const byCategory = {};
  for (const cat of VALID_CATEGORIES) {
    byCategory[cat] = 0;
  }
  let oldest = null;
  let newest = null;

  for (const m of active) {
    const cat = m.category || "fact";
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    if (!oldest || m.createdAt < oldest) oldest = m.createdAt;
    if (!newest || m.createdAt > newest) newest = m.createdAt;
  }

  return { total: active.length, byCategory, oldest, newest };
}

// --- Backward-compatible exports for existing tests/code ---

/**
 * @deprecated Use remember() instead. Kept for backward compatibility.
 */
export async function storeMemory(workspaceId, userId, memory) {
  if (!memory.consent) {
    return { ok: false, error: "User consent is required to store memories" };
  }
  if (!memory.content || typeof memory.content !== "string" || !memory.content.trim()) {
    return { ok: false, error: "content is required" };
  }
  const LEGACY_CATEGORIES = ["preference", "fact", "project", "instruction"];
  if (memory.category && !LEGACY_CATEGORIES.includes(memory.category) && !VALID_CATEGORIES.includes(memory.category)) {
    return { ok: false, error: `category must be one of: ${LEGACY_CATEGORIES.join(", ")}` };
  }
  if (memory.confidence !== undefined && (typeof memory.confidence !== "number" || memory.confidence < 0 || memory.confidence > 1)) {
    return { ok: false, error: "confidence must be a number between 0 and 1" };
  }

  try {
    const importance = memory.confidence != null ? Math.max(1, Math.round(memory.confidence * 5)) : 3;
    const result = await remember(userId, workspaceId, {
      content: memory.content,
      category: VALID_CATEGORIES.includes(memory.category) ? memory.category : "fact",
      importance,
      source: memory.source || null,
    });
    return {
      ok: true,
      memory: {
        id: result.id,
        workspaceId: String(workspaceId),
        userId: String(userId),
        category: memory.category || "fact",
        content: memory.content.trim(),
        source: memory.source || null,
        confidence: typeof memory.confidence === "number" ? memory.confidence : 0.8,
        createdAt: result.createdAt,
        updatedAt: result.createdAt,
        active: true,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * @deprecated Use listMemories() instead.
 */
export async function getMemories(workspaceId, userId, options = {}) {
  const result = await listMemories(userId, workspaceId, {
    category: options.category,
    limit: options.limit || 100,
    offset: options.offset || 0,
  });
  // Map to legacy format with active field
  let items = result.memories.map((m) => ({
    ...m,
    active: !m.deleted,
    workspaceId,
    userId,
    confidence: (m.importance || 3) / 5,
    updatedAt: m.updatedAt || m.createdAt,
  }));
  if (options.activeOnly !== false) {
    items = items.filter((m) => m.active !== false);
  }
  return items;
}

/**
 * @deprecated Use recall() instead.
 */
export async function searchMemories(workspaceId, userId, query) {
  if (!query || typeof query !== "string") return [];
  const result = await recall(userId, workspaceId, query);
  return result.memories.map((m) => ({
    ...m,
    active: true,
    workspaceId,
    userId,
    confidence: (m.importance || 3) / 5,
    updatedAt: m.updatedAt || m.createdAt,
  }));
}

/**
 * @deprecated Use forget() + remember() instead.
 */
export async function updateMemory(memoryId, updates, workspaceId, userId) {
  const memories = loadAll(userId, workspaceId);
  const existing = memories.find((m) => m.id === memoryId && !m.deleted);
  if (!existing) {
    return { ok: false, error: "Memory not found" };
  }
  if (updates.content !== undefined) existing.content = updates.content.trim();
  if (updates.category !== undefined) existing.category = updates.category;
  if (updates.active !== undefined) existing.deleted = !updates.active;
  existing.updatedAt = new Date().toISOString();
  saveAll(userId, workspaceId, memories);
  return {
    ok: true,
    memory: {
      ...existing,
      active: !existing.deleted,
      workspaceId,
      userId,
      confidence: (existing.importance || 3) / 5,
    },
  };
}

/**
 * @deprecated Use forget() instead.
 */
export async function deleteMemory(memoryId, workspaceId, userId) {
  return forget(userId, workspaceId, memoryId);
}

/**
 * Phase 74.4: Detect contradictory fact memories (simple negation / opposite claims).
 * @param {Array<{ id: string, content: string, category?: string }>} memories
 */
export function findMemoryConflicts(memories) {
  const facts = (memories || []).filter((m) => (m.category || "fact") === "fact");
  const conflicts = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = String(facts[i].content || "").toLowerCase().trim();
      const b = String(facts[j].content || "").toLowerCase().trim();
      if (!a || !b) continue;
      const negA = a.startsWith("not ") || a.includes(" is not ") || a.includes(" isn't ");
      const negB = b.startsWith("not ") || b.includes(" is not ") || b.includes(" isn't ");
      const coreA = a.replace(/\b(not|n't|no longer)\b/g, "").replace(/\s+/g, " ").trim();
      const coreB = b.replace(/\b(not|n't|no longer)\b/g, "").replace(/\s+/g, " ").trim();
      if (coreA && coreA === coreB && negA !== negB) {
        conflicts.push({
          a: { id: facts[i].id, content: facts[i].content },
          b: { id: facts[j].id, content: facts[j].content },
          reason: "negation_conflict",
        });
      }
    }
  }
  return conflicts;
}

/**
 * Extract potential memories from a conversation turn.
 * Returns suggested memories for user approval.
 */
export function extractPotentialMemories(messages, context = {}) {
  const suggestions = [];
  if (!Array.isArray(messages) || messages.length === 0) return suggestions;

  const preferencePatterns = [
    /(?:i prefer|i like|i always|my preference is|i'd rather|i want)\s+(.{5,120})/i,
    /(?:please always|from now on|going forward)\s+(.{5,120})/i,
  ];
  const factPatterns = [
    /(?:my name is|i'm called|call me)\s+(.{2,60})/i,
    /(?:i work (?:at|for|on)|my (?:company|team|project) is)\s+(.{2,80})/i,
    /(?:my (?:email|phone|timezone|location) is)\s+(.{3,80})/i,
  ];
  const instructionPatterns = [
    /(?:always remember|don't forget|keep in mind|note that)\s+(.{5,120})/i,
    /(?:when (?:i|you) .{3,40},?\s*(?:always|please|make sure))\s+(.{5,120})/i,
  ];

  for (const msg of messages) {
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const text = msg.content;

    for (const pat of preferencePatterns) {
      const m = text.match(pat);
      if (m) {
        suggestions.push({
          category: "preference",
          content: m[0].trim(),
          confidence: 0.7,
          source: context.conversationId || null,
        });
      }
    }
    for (const pat of factPatterns) {
      const m = text.match(pat);
      if (m) {
        suggestions.push({
          category: "fact",
          content: m[0].trim(),
          confidence: 0.8,
          source: context.conversationId || null,
        });
      }
    }
    for (const pat of instructionPatterns) {
      const m = text.match(pat);
      if (m) {
        suggestions.push({
          category: "instruction",
          content: m[0].trim(),
          confidence: 0.6,
          source: context.conversationId || null,
        });
      }
    }
  }

  return suggestions;
}
