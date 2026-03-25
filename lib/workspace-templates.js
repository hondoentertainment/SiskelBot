/**
 * Workspace Templates: Pre-configured workspace templates that new workspaces can clone from.
 * Templates are stored in data/workspace-templates/ using the json-path-store abstraction.
 * Admin-only for create/update/delete; any authenticated user can list and use them.
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { createWorkspace } from "./storage.js";
import { saveWorkspaceAgentSettings } from "./workspace-agent-settings.js";

const TEMPLATES_VERSION = 1;
const MAX_NAME_LEN = 100;
const MAX_DESCRIPTION_LEN = 500;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 50;

function templatesIndexPath() {
  return join(getDataDir(), "workspace-templates", "templates.json");
}

function defaultTemplatesDir() {
  return join(getDataDir(), "workspace-templates", "defaults");
}

/**
 * Normalize and validate template data.
 */
function normalizeTemplateData(raw) {
  const out = {};
  if (raw.name && typeof raw.name === "string") {
    out.name = raw.name.trim().slice(0, MAX_NAME_LEN);
  }
  if (raw.description && typeof raw.description === "string") {
    out.description = raw.description.trim().slice(0, MAX_DESCRIPTION_LEN);
  }
  if (typeof raw.defaultSystemPrompt === "string") {
    out.defaultSystemPrompt = raw.defaultSystemPrompt.trim().slice(0, 32_000);
  }
  if (Array.isArray(raw.memorySnippets)) {
    out.memorySnippets = raw.memorySnippets
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean)
      .slice(0, 50);
  }
  if (Array.isArray(raw.toolAllowlist)) {
    out.toolAllowlist = raw.toolAllowlist
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean)
      .slice(0, 32);
  }
  if (raw.quotaSettings && typeof raw.quotaSettings === "object") {
    const qs = {};
    if (typeof raw.quotaSettings.tokensPerWorkspace === "number" && raw.quotaSettings.tokensPerWorkspace > 0) {
      qs.tokensPerWorkspace = Math.floor(raw.quotaSettings.tokensPerWorkspace);
    }
    if (typeof raw.quotaSettings.periodDays === "number" && raw.quotaSettings.periodDays > 0) {
      qs.periodDays = Math.floor(raw.quotaSettings.periodDays);
    }
    if (Object.keys(qs).length > 0) {
      out.quotaSettings = qs;
    }
  }
  if (Array.isArray(raw.tags)) {
    out.tags = raw.tags
      .map((s) => (typeof s === "string" ? s.trim().toLowerCase().slice(0, MAX_TAG_LEN) : ""))
      .filter(Boolean)
      .slice(0, MAX_TAGS);
  }
  return out;
}

/**
 * Load templates index.
 * @returns {Promise<object[]>}
 */
async function loadTemplatesIndex() {
  const data = await readJsonPath(templatesIndexPath(), { _version: TEMPLATES_VERSION, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

/**
 * Save templates index.
 * @param {object[]} items
 */
async function saveTemplatesIndex(items) {
  await writeJsonPath(templatesIndexPath(), { _version: TEMPLATES_VERSION, items });
}

/**
 * Load built-in default templates from data/workspace-templates/defaults/.
 * These are always available and have isDefault: true.
 * @returns {Promise<object[]>}
 */
async function loadDefaultTemplates() {
  const defaults = [];
  const defaultFiles = ["coding-assistant.json", "research-analyst.json", "team-default.json"];
  for (const file of defaultFiles) {
    try {
      const path = join(defaultTemplatesDir(), file);
      const data = await readJsonPath(path, null);
      if (data && typeof data === "object" && data.id) {
        defaults.push({ ...data, isDefault: true });
      }
    } catch {
      // skip missing defaults
    }
  }
  return defaults;
}

/**
 * Create a new workspace template.
 * @param {object} templateData - { name, description, defaultSystemPrompt, memorySnippets, toolAllowlist, quotaSettings, tags }
 * @returns {Promise<object>} The created template
 */
export async function createTemplate(templateData) {
  if (!templateData || !templateData.name || typeof templateData.name !== "string" || !templateData.name.trim()) {
    throw new Error("Template name is required");
  }
  const normalized = normalizeTemplateData(templateData);
  const template = {
    id: randomUUID(),
    ...normalized,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const path = templatesIndexPath();
  return withPathLock(path, async () => {
    const items = await loadTemplatesIndex();
    items.push(template);
    await saveTemplatesIndex(items);
    return template;
  });
}

/**
 * List all available templates (defaults + custom).
 * @returns {Promise<object[]>}
 */
export async function listTemplates() {
  const [defaults, custom] = await Promise.all([loadDefaultTemplates(), loadTemplatesIndex()]);
  // Merge: defaults first, then custom; skip custom entries that shadow a default id
  const defaultIds = new Set(defaults.map((d) => d.id));
  const filtered = custom.filter((c) => !defaultIds.has(c.id));
  return [...defaults, ...filtered];
}

/**
 * Get a specific template by ID.
 * @param {string} templateId
 * @returns {Promise<object|null>}
 */
export async function getTemplate(templateId) {
  if (!templateId) return null;
  const all = await listTemplates();
  return all.find((t) => t.id === templateId) || null;
}

/**
 * Update a template (custom only; cannot update defaults).
 * @param {string} templateId
 * @param {object} updates
 * @returns {Promise<object|null>}
 */
export async function updateTemplate(templateId, updates) {
  if (!templateId) return null;
  const path = templatesIndexPath();
  return withPathLock(path, async () => {
    const items = await loadTemplatesIndex();
    const idx = items.findIndex((t) => t.id === templateId);
    if (idx < 0) return null;
    if (items[idx].isDefault) {
      throw new Error("Cannot update a default template");
    }
    const normalized = normalizeTemplateData(updates);
    items[idx] = {
      ...items[idx],
      ...normalized,
      id: items[idx].id,
      isDefault: false,
      updatedAt: new Date().toISOString(),
    };
    await saveTemplatesIndex(items);
    return items[idx];
  });
}

/**
 * Delete a template (custom only; cannot delete defaults).
 * @param {string} templateId
 * @returns {Promise<boolean>}
 */
export async function deleteTemplate(templateId) {
  if (!templateId) return false;
  const path = templatesIndexPath();
  return withPathLock(path, async () => {
    const items = await loadTemplatesIndex();
    const idx = items.findIndex((t) => t.id === templateId);
    if (idx < 0) return false;
    if (items[idx].isDefault) {
      throw new Error("Cannot delete a default template");
    }
    items.splice(idx, 1);
    await saveTemplatesIndex(items);
    return true;
  });
}

/**
 * Apply a template's settings to an existing workspace.
 * @param {string} templateId
 * @param {string} workspaceId
 * @param {string} userId - storage user ID (owner of workspace)
 * @returns {Promise<object>} The applied settings
 */
export async function applyTemplate(templateId, workspaceId, userId) {
  const template = await getTemplate(templateId);
  if (!template) {
    throw new Error("Template not found");
  }
  const settings = {
    defaultSystemPrompt: template.defaultSystemPrompt || "",
    memorySnippets: template.memorySnippets || [],
    allowedTools: template.toolAllowlist || [],
  };
  const saved = await saveWorkspaceAgentSettings(userId, workspaceId, settings);
  return { template: template.id, workspace: workspaceId, appliedSettings: saved };
}

/**
 * Create a new workspace pre-configured with template settings.
 * @param {string} templateId
 * @param {string} workspaceName
 * @param {string} userId
 * @returns {Promise<object>} The created workspace with template info
 */
export async function createWorkspaceFromTemplate(templateId, workspaceName, userId) {
  const template = await getTemplate(templateId);
  if (!template) {
    throw new Error("Template not found");
  }
  const name = workspaceName || template.name || "Workspace";
  const ws = await createWorkspace(userId, name, "personal");
  // Apply template settings to the new workspace
  const settings = {
    defaultSystemPrompt: template.defaultSystemPrompt || "",
    memorySnippets: template.memorySnippets || [],
    allowedTools: template.toolAllowlist || [],
  };
  const saved = await saveWorkspaceAgentSettings(userId, ws.id, settings);
  return {
    ...ws,
    templateId: template.id,
    templateName: template.name,
    appliedSettings: saved,
  };
}
