/**
 * Workspace migration tooling: export and import complete workspace state
 * for portability between deployments.
 * Builds on top of workspace-lifecycle.js exportWorkspaceBundle.
 */
import * as storage from "./storage.js";
import { loadWorkspaceAgentSettings, saveWorkspaceAgentSettings } from "./workspace-agent-settings.js";
import { resolveStorageUserId } from "./teams.js";
import { listWebhooks } from "./webhooks.js";
import { getWorkspaceQuota } from "./quotas.js";

const BUNDLE_VERSION = "2.0";

/**
 * @typedef {object} WorkspaceBundle
 * @property {string} version - Bundle format version
 * @property {string} exportedAt - ISO timestamp
 * @property {string} sourceInstance - Instance identifier
 * @property {object} workspace - Workspace metadata
 * @property {object[]} conversations - All conversations with messages
 * @property {object} settings - Agent settings, chunking config
 * @property {object[]} recipes - Recipes and schedules
 * @property {object[]} knowledge - Knowledge base documents (text only, not embeddings)
 * @property {object[]} memories - Agent memories
 * @property {object[]} webhooks - Webhook subscriptions
 * @property {object} quotas - Quota settings
 */

/**
 * Export a complete workspace bundle.
 * @param {string} workspaceId
 * @param {object} options - { includeConversations, includeKnowledge, includeMemories, includeWebhooks }
 * @returns {Promise<WorkspaceBundle>}
 */
export async function exportWorkspace(workspaceId, options = {}) {
  const {
    userId = "anonymous",
    includeConversations = true,
    includeKnowledge = true,
    includeMemories = true,
    includeWebhooks = true,
  } = options;

  const su = await resolveStorageUserId(userId, workspaceId);

  const [context, recipes, conversations, agentSettings] = await Promise.all([
    storage.list("context", workspaceId, su),
    storage.list("recipes", workspaceId, su),
    includeConversations ? storage.list("conversations", workspaceId, su) : Promise.resolve([]),
    loadWorkspaceAgentSettings(su, workspaceId),
  ]);

  // Separate knowledge items from agent memory items in context
  const knowledge = includeKnowledge ? context.filter((i) => !i._memoryStore) : [];
  const memories = includeMemories ? context.filter((i) => i._memoryStore === true) : [];

  let webhooks = [];
  if (includeWebhooks) {
    try {
      const wh = await listWebhooks(workspaceId);
      webhooks = Array.isArray(wh) ? wh : [];
    } catch { webhooks = []; }
  }

  let quotas = null;
  try {
    const q = await getWorkspaceQuota(workspaceId, userId);
    if (q) quotas = q;
  } catch { /* quotas remain null */ }

  const ws = await storage.getWorkspaceById(su, workspaceId);

  return {
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    sourceInstance: process.env.INSTANCE_ID || "default",
    workspace: ws || { id: workspaceId, name: workspaceId },
    conversations,
    settings: {
      defaultSystemPrompt: agentSettings.defaultSystemPrompt || "",
      memorySnippets: agentSettings.memorySnippets || [],
      allowedTools: agentSettings.allowedTools || [],
    },
    recipes,
    knowledge,
    memories,
    webhooks,
    quotas,
  };
}

/**
 * Validate a workspace bundle for correctness.
 * @param {object} bundle
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBundle(bundle) {
  const errors = [];

  if (!bundle || typeof bundle !== "object") {
    return { valid: false, errors: ["Bundle must be a non-null object"] };
  }
  if (!bundle.version) {
    errors.push("Missing version field");
  }
  if (!bundle.exportedAt) {
    errors.push("Missing exportedAt timestamp");
  }
  if (!bundle.workspace || typeof bundle.workspace !== "object") {
    errors.push("Missing or invalid workspace metadata");
  }
  if (bundle.conversations && !Array.isArray(bundle.conversations)) {
    errors.push("conversations must be an array");
  }
  if (bundle.recipes && !Array.isArray(bundle.recipes)) {
    errors.push("recipes must be an array");
  }
  if (bundle.knowledge && !Array.isArray(bundle.knowledge)) {
    errors.push("knowledge must be an array");
  }
  if (bundle.memories && !Array.isArray(bundle.memories)) {
    errors.push("memories must be an array");
  }
  if (bundle.webhooks && !Array.isArray(bundle.webhooks)) {
    errors.push("webhooks must be an array");
  }
  if (bundle.settings && typeof bundle.settings !== "object") {
    errors.push("settings must be an object");
  }

  // Validate individual items have ids
  for (const key of ["conversations", "recipes", "knowledge", "memories"]) {
    const items = bundle[key];
    if (Array.isArray(items)) {
      const missing = items.filter((i) => !i.id);
      if (missing.length > 0) {
        errors.push(`${missing.length} ${key} item(s) missing id field`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Import a workspace bundle into a target workspace.
 * @param {object} bundle - The workspace bundle to import
 * @param {string} targetUserId - User performing the import
 * @param {object} options - { targetWorkspaceId, strategy: 'overwrite'|'merge'|'skip' }
 * @returns {Promise<{ ok: boolean, stats: object, error?: string }>}
 */
export async function importWorkspace(bundle, targetUserId, options = {}) {
  const validation = validateBundle(bundle);
  if (!validation.valid) {
    return { ok: false, error: `Invalid bundle: ${validation.errors.join(", ")}`, stats: {} };
  }

  const {
    targetWorkspaceId = bundle.workspace?.id || "default",
    strategy = "merge",
  } = options;

  const su = await resolveStorageUserId(targetUserId, targetWorkspaceId);
  const stats = { conversations: 0, recipes: 0, knowledge: 0, memories: 0, settings: false };

  try {
    // Import conversations
    if (Array.isArray(bundle.conversations) && bundle.conversations.length > 0) {
      if (strategy === "overwrite") {
        await storage.replace("conversations", bundle.conversations, targetWorkspaceId, su);
        stats.conversations = bundle.conversations.length;
      } else if (strategy === "merge") {
        await storage.mergeSync("conversations", bundle.conversations, targetWorkspaceId, su);
        stats.conversations = bundle.conversations.length;
      } else {
        // skip - only add items that don't exist
        const existing = await storage.list("conversations", targetWorkspaceId, su);
        const existingIds = new Set(existing.map((i) => String(i.id)));
        const newItems = bundle.conversations.filter((i) => !existingIds.has(String(i.id)));
        if (newItems.length > 0) {
          for (const item of newItems) {
            await storage.add("conversations", item, targetWorkspaceId, false, su);
          }
        }
        stats.conversations = newItems.length;
      }
    }

    // Import recipes
    if (Array.isArray(bundle.recipes) && bundle.recipes.length > 0) {
      if (strategy === "overwrite") {
        await storage.replace("recipes", bundle.recipes, targetWorkspaceId, su);
        stats.recipes = bundle.recipes.length;
      } else if (strategy === "merge") {
        await storage.mergeSync("recipes", bundle.recipes, targetWorkspaceId, su);
        stats.recipes = bundle.recipes.length;
      } else {
        const existing = await storage.list("recipes", targetWorkspaceId, su);
        const existingIds = new Set(existing.map((i) => String(i.id)));
        const newItems = bundle.recipes.filter((i) => !existingIds.has(String(i.id)));
        if (newItems.length > 0) {
          for (const item of newItems) {
            await storage.add("recipes", item, targetWorkspaceId, false, su);
          }
        }
        stats.recipes = newItems.length;
      }
    }

    // Import knowledge + memories (both stored in context)
    const contextItems = [];
    if (Array.isArray(bundle.knowledge)) {
      contextItems.push(...bundle.knowledge);
      stats.knowledge = bundle.knowledge.length;
    }
    if (Array.isArray(bundle.memories)) {
      contextItems.push(...bundle.memories);
      stats.memories = bundle.memories.length;
    }

    if (contextItems.length > 0) {
      if (strategy === "overwrite") {
        await storage.replace("context", contextItems, targetWorkspaceId, su);
      } else if (strategy === "merge") {
        await storage.mergeSync("context", contextItems, targetWorkspaceId, su);
      } else {
        const existing = await storage.list("context", targetWorkspaceId, su);
        const existingIds = new Set(existing.map((i) => String(i.id)));
        const newItems = contextItems.filter((i) => !existingIds.has(String(i.id)));
        if (newItems.length > 0) {
          for (const item of newItems) {
            await storage.add("context", item, targetWorkspaceId, false, su);
          }
        }
        stats.knowledge = (bundle.knowledge || []).filter((i) => !existingIds.has(String(i.id))).length;
        stats.memories = (bundle.memories || []).filter((i) => !existingIds.has(String(i.id))).length;
      }
    }

    // Import settings
    if (bundle.settings && typeof bundle.settings === "object") {
      if (strategy === "overwrite" || strategy === "merge") {
        await saveWorkspaceAgentSettings(su, targetWorkspaceId, {
          defaultSystemPrompt: bundle.settings.defaultSystemPrompt || "",
          memorySnippets: bundle.settings.memorySnippets || [],
        });
        stats.settings = true;
      }
    }

    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: err.message, stats };
  }
}

/**
 * Compare two workspace bundles and show differences.
 * @param {object} bundleA
 * @param {object} bundleB
 * @returns {{ diffs: object[] }}
 */
export function diffWorkspaces(bundleA, bundleB) {
  const diffs = [];

  // Compare array collections
  const collections = ["conversations", "recipes", "knowledge", "memories", "webhooks"];

  for (const key of collections) {
    const itemsA = Array.isArray(bundleA[key]) ? bundleA[key] : [];
    const itemsB = Array.isArray(bundleB[key]) ? bundleB[key] : [];

    const idsA = new Set(itemsA.map((i) => String(i.id)));
    const idsB = new Set(itemsB.map((i) => String(i.id)));

    const onlyInA = itemsA.filter((i) => !idsB.has(String(i.id)));
    const onlyInB = itemsB.filter((i) => !idsA.has(String(i.id)));
    const inBoth = itemsA.filter((i) => idsB.has(String(i.id)));

    // Check for modified items (by updatedAt)
    const modified = [];
    for (const itemA of inBoth) {
      const itemB = itemsB.find((i) => String(i.id) === String(itemA.id));
      if (itemB) {
        const tsA = itemA.updatedAt || itemA.createdAt || "";
        const tsB = itemB.updatedAt || itemB.createdAt || "";
        if (tsA !== tsB) {
          modified.push({ id: itemA.id, timestampA: tsA, timestampB: tsB });
        }
      }
    }

    if (onlyInA.length || onlyInB.length || modified.length) {
      diffs.push({
        collection: key,
        onlyInA: onlyInA.length,
        onlyInB: onlyInB.length,
        modified: modified.length,
        unchanged: inBoth.length - modified.length,
        details: {
          addedIds: onlyInB.map((i) => i.id),
          removedIds: onlyInA.map((i) => i.id),
          modifiedIds: modified.map((m) => m.id),
        },
      });
    }
  }

  // Compare settings
  const settingsA = bundleA.settings || {};
  const settingsB = bundleB.settings || {};
  if ((settingsA.defaultSystemPrompt || "") !== (settingsB.defaultSystemPrompt || "")) {
    diffs.push({ collection: "settings", field: "defaultSystemPrompt", changed: true });
  }
  const snippetsA = JSON.stringify(settingsA.memorySnippets || []);
  const snippetsB = JSON.stringify(settingsB.memorySnippets || []);
  if (snippetsA !== snippetsB) {
    diffs.push({ collection: "settings", field: "memorySnippets", changed: true });
  }

  return { diffs };
}
