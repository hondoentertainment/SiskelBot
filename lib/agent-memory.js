/**
 * Long-term agent memory store.
 * Stores factual knowledge about users, projects, and preferences
 * that persists across conversations within a workspace.
 * Requires explicit user consent to store memories.
 */
import { randomUUID } from "crypto";
import * as storage from "./storage.js";

const STORAGE_TYPE = "context"; // reuse context storage file namespace

/**
 * @typedef {object} Memory
 * @property {string} id - Unique memory ID
 * @property {string} workspaceId
 * @property {string} userId - User who consented to this memory
 * @property {string} category - 'preference' | 'fact' | 'project' | 'instruction'
 * @property {string} content - The memory text
 * @property {string} source - conversationId that created it
 * @property {number} confidence - 0-1, how confident the agent is
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {boolean} active - soft delete support
 */

const VALID_CATEGORIES = ["preference", "fact", "project", "instruction"];
const MAX_MEMORIES_PER_USER = 500;

function validateMemory(mem) {
  if (!mem.content || typeof mem.content !== "string" || !mem.content.trim()) {
    return { valid: false, error: "content is required" };
  }
  if (mem.category && !VALID_CATEGORIES.includes(mem.category)) {
    return { valid: false, error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` };
  }
  if (mem.confidence !== undefined && (typeof mem.confidence !== "number" || mem.confidence < 0 || mem.confidence > 1)) {
    return { valid: false, error: "confidence must be a number between 0 and 1" };
  }
  return { valid: true };
}

/**
 * Internal: load all memories for a workspace+user from storage.
 */
async function loadMemories(workspaceId, storageUserId) {
  const items = await storage.list(STORAGE_TYPE, workspaceId, storageUserId);
  return items.filter((i) => i._memoryStore === true);
}

/**
 * Internal: save memory item to storage (uses context storage with a marker flag).
 */
async function saveMemoryItem(workspaceId, storageUserId, memoryItem) {
  return storage.add(STORAGE_TYPE, { ...memoryItem, _memoryStore: true }, workspaceId, true, storageUserId);
}

/**
 * Store a new memory. Requires consent flag.
 * @param {string} workspaceId
 * @param {string} userId
 * @param {object} memory - { content, category, source, confidence, consent }
 * @returns {Promise<{ok: boolean, memory?: Memory, error?: string}>}
 */
export async function storeMemory(workspaceId, userId, memory) {
  if (!memory.consent) {
    return { ok: false, error: "User consent is required to store memories" };
  }
  const validation = validateMemory(memory);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  const existing = await loadMemories(workspaceId, userId);
  if (existing.filter((m) => m.active !== false).length >= MAX_MEMORIES_PER_USER) {
    return { ok: false, error: `Maximum memories limit reached (${MAX_MEMORIES_PER_USER})` };
  }

  const now = new Date().toISOString();
  const item = {
    id: randomUUID(),
    workspaceId: String(workspaceId),
    userId: String(userId),
    category: memory.category || "fact",
    content: memory.content.trim(),
    source: memory.source || null,
    confidence: typeof memory.confidence === "number" ? memory.confidence : 0.8,
    createdAt: now,
    updatedAt: now,
    active: true,
    _memoryStore: true,
  };

  await saveMemoryItem(workspaceId, userId, item);
  return { ok: true, memory: item };
}

/**
 * Get memories for a workspace+user.
 * @param {string} workspaceId
 * @param {string} userId
 * @param {object} options - { category?, activeOnly?, limit?, offset? }
 * @returns {Promise<Memory[]>}
 */
export async function getMemories(workspaceId, userId, options = {}) {
  let items = await loadMemories(workspaceId, userId);

  if (options.activeOnly !== false) {
    items = items.filter((m) => m.active !== false);
  }
  if (options.category) {
    items = items.filter((m) => m.category === options.category);
  }

  // Sort by creation date, newest first
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const offset = options.offset || 0;
  const limit = options.limit || 100;
  return items.slice(offset, offset + limit);
}

/**
 * Search memories by text query (simple substring match).
 * @param {string} workspaceId
 * @param {string} userId
 * @param {string} query
 * @returns {Promise<Memory[]>}
 */
export async function searchMemories(workspaceId, userId, query) {
  if (!query || typeof query !== "string") return [];
  const items = await loadMemories(workspaceId, userId);
  const q = query.toLowerCase().trim();
  return items
    .filter((m) => m.active !== false && m.content && m.content.toLowerCase().includes(q))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

/**
 * Update an existing memory.
 * @param {string} memoryId
 * @param {object} updates - { content?, category?, confidence?, active? }
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {Promise<{ok: boolean, memory?: Memory, error?: string}>}
 */
export async function updateMemory(memoryId, updates, workspaceId, userId) {
  if (updates.content !== undefined) {
    const v = validateMemory({ content: updates.content, category: updates.category });
    if (!v.valid) return { ok: false, error: v.error };
  }
  if (updates.category && !VALID_CATEGORIES.includes(updates.category)) {
    return { ok: false, error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` };
  }

  const items = await loadMemories(workspaceId, userId);
  const existing = items.find((m) => m.id === memoryId);
  if (!existing) {
    return { ok: false, error: "Memory not found" };
  }

  const allowed = {};
  if (updates.content !== undefined) allowed.content = updates.content.trim();
  if (updates.category !== undefined) allowed.category = updates.category;
  if (updates.confidence !== undefined) allowed.confidence = updates.confidence;
  if (updates.active !== undefined) allowed.active = updates.active;
  allowed.updatedAt = new Date().toISOString();

  const updated = await storage.update(STORAGE_TYPE, memoryId, allowed, workspaceId, userId);
  if (!updated) {
    return { ok: false, error: "Failed to update memory" };
  }
  return { ok: true, memory: updated };
}

/**
 * Delete (soft-delete) a memory.
 * @param {string} memoryId
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function deleteMemory(memoryId, workspaceId, userId) {
  const items = await loadMemories(workspaceId, userId);
  const existing = items.find((m) => m.id === memoryId);
  if (!existing) {
    return { ok: false, error: "Memory not found" };
  }

  const updated = await storage.update(
    STORAGE_TYPE,
    memoryId,
    { active: false, updatedAt: new Date().toISOString() },
    workspaceId,
    userId
  );
  return updated ? { ok: true } : { ok: false, error: "Failed to delete memory" };
}

/**
 * Get memory statistics for a workspace+user.
 * @param {string} workspaceId
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function getMemoryStats(workspaceId, userId) {
  const items = await loadMemories(workspaceId, userId);
  const active = items.filter((m) => m.active !== false);
  const byCategory = {};
  for (const m of active) {
    const cat = m.category || "uncategorized";
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  return {
    total: items.length,
    active: active.length,
    inactive: items.length - active.length,
    byCategory,
    limit: MAX_MEMORIES_PER_USER,
  };
}

/**
 * Extract potential memories from a conversation turn.
 * Returns suggested memories for user approval.
 * @param {object[]} messages - Array of { role, content } messages
 * @param {object} context - { workspaceId, userId, conversationId }
 * @returns {object[]} - Array of suggested memory objects
 */
export function extractPotentialMemories(messages, context = {}) {
  const suggestions = [];
  if (!Array.isArray(messages) || messages.length === 0) return suggestions;

  // Patterns that indicate memorable facts
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
