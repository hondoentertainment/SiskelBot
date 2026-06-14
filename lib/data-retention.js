/**
 * Phase 25: Data retention policies and enforcement.
 * Per-workspace retention TTL for conversations, documents, audit logs, and memory.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";
import * as storage from "./storage.js";

const DEFAULT_POLICY = {
  conversationsTTLDays: null,
  documentsTTLDays: null,
  auditTTLDays: null,
  memoryTTLDays: null,
};

function getPolicyPath(workspaceId) {
  const ws = storage.sanitizeWorkspace(workspaceId);
  return join(getDataDir(), "retention", `${ws}.json`);
}

/**
 * Set the retention policy for a workspace.
 * @param {string} workspaceId
 * @param {object} policy - { conversationsTTLDays, documentsTTLDays, auditTTLDays, memoryTTLDays }
 * @returns {Promise<object>}
 */
export async function setRetentionPolicy(workspaceId, policy) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  const sanitized = {};
  for (const key of Object.keys(DEFAULT_POLICY)) {
    const val = policy?.[key];
    if (val === null || val === undefined) {
      sanitized[key] = null;
    } else {
      const num = Number(val);
      if (!Number.isFinite(num) || num < 0) {
        throw new Error(`${key} must be a non-negative number or null`);
      }
      sanitized[key] = num;
    }
  }
  const stored = {
    workspaceId: storage.sanitizeWorkspace(workspaceId),
    ...sanitized,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonPath(getPolicyPath(workspaceId), stored);
  return stored;
}

/**
 * Get the retention policy for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<object>}
 */
export async function getRetentionPolicy(workspaceId) {
  if (!workspaceId || typeof workspaceId !== "string") {
    return { ...DEFAULT_POLICY, workspaceId: "default" };
  }
  const data = await readJsonPath(getPolicyPath(workspaceId), null);
  if (!data || !data.workspaceId) {
    return { ...DEFAULT_POLICY, workspaceId: storage.sanitizeWorkspace(workspaceId) };
  }
  return data;
}

/**
 * Delete items older than a TTL cutoff from a list.
 * @param {Array} items
 * @param {number} ttlDays
 * @returns {{ kept: Array, deletedCount: number }}
 */
function filterByTTL(items, ttlDays) {
  if (!Array.isArray(items) || ttlDays == null || ttlDays <= 0) {
    return { kept: items || [], deletedCount: 0 };
  }
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const kept = [];
  let deletedCount = 0;
  for (const item of items) {
    const ts = item.createdAt || item.timestamp || item.updatedAt;
    const time = ts ? Date.parse(ts) : NaN;
    if (!Number.isNaN(time) && time < cutoff) {
      deletedCount++;
    } else {
      kept.push(item);
    }
  }
  return { kept, deletedCount };
}

/**
 * Enforce retention policy for a workspace. Deletes expired data.
 * @param {string} workspaceId
 * @param {string} [userId] - defaults to "anonymous"
 * @returns {Promise<{ deleted: { conversations: number, documents: number, audit: number, memory: number } }>}
 */
export async function enforceRetention(workspaceId, userId = "anonymous") {
  const policy = await getRetentionPolicy(workspaceId);
  const deleted = { conversations: 0, documents: 0, audit: 0, memory: 0 };

  // Enforce conversations TTL
  if (policy.conversationsTTLDays != null && policy.conversationsTTLDays > 0) {
    const conversations = await storage.list("conversations", workspaceId, userId);
    const result = filterByTTL(conversations, policy.conversationsTTLDays);
    if (result.deletedCount > 0) {
      await storage.replace("conversations", result.kept, workspaceId, userId);
      deleted.conversations = result.deletedCount;
    }
  }

  // Enforce documents TTL
  if (policy.documentsTTLDays != null && policy.documentsTTLDays > 0) {
    const documents = await storage.list("context", workspaceId, userId);
    const result = filterByTTL(documents, policy.documentsTTLDays);
    if (result.deletedCount > 0) {
      await storage.replace("context", result.kept, workspaceId, userId);
      deleted.documents = result.deletedCount;
    }
  }

  // Enforce audit TTL
  if (policy.auditTTLDays != null && policy.auditTTLDays > 0) {
    const auditPath = join(getDataDir(), "audit", `${storage.sanitizeWorkspace(workspaceId)}.json`);
    const auditData = await readJsonPath(auditPath, { entries: [] });
    const entries = Array.isArray(auditData.entries) ? auditData.entries : [];
    const result = filterByTTL(entries, policy.auditTTLDays);
    if (result.deletedCount > 0) {
      await writeJsonPath(auditPath, { ...auditData, entries: result.kept });
      deleted.audit = result.deletedCount;
    }
  }

  // Enforce memory TTL
  if (policy.memoryTTLDays != null && policy.memoryTTLDays > 0) {
    const memoryPath = join(getDataDir(), "memory", storage.sanitizeUserId(userId), storage.sanitizeWorkspace(workspaceId), "memories.json");
    const memories = await readJsonPath(memoryPath, []);
    const arr = Array.isArray(memories) ? memories : [];
    const result = filterByTTL(arr, policy.memoryTTLDays);
    if (result.deletedCount > 0) {
      await writeJsonPath(memoryPath, result.kept);
      deleted.memory = result.deletedCount;
    }
  }

  return { deleted };
}

/**
 * Run retention enforcement across all workspaces that have a retention policy.
 * @returns {Promise<{ results: Array<{ workspaceId: string, deleted: object }> }>}
 */
export async function runRetentionSweep() {
  const results = [];
  const retentionDir = join(getDataDir(), "retention");
  let policyFiles = [];
  try {
    const { readdirSync } = await import("fs");
    if ((await import("fs")).existsSync(retentionDir)) {
      policyFiles = readdirSync(retentionDir).filter((f) => f.endsWith(".json"));
    }
  } catch {
    // no retention directory yet
  }

  for (const file of policyFiles) {
    const workspaceId = file.replace(/\.json$/, "");
    try {
      const result = await enforceRetention(workspaceId);
      results.push({ workspaceId, deleted: result.deleted });
    } catch (err) {
      console.error(`[data-retention] Sweep failed for workspace ${workspaceId}:`, err.message);
      results.push({ workspaceId, error: err.message });
    }
  }

  return { results };
}
