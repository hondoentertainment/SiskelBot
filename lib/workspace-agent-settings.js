/**
 * Phase 61–62: Per-workspace agent instructions and approved memory snippets.
 * Phase 68: Durable store via json-path-store (Postgres / SQLite / file).
 * Stored at data/users/{storageUserId}/workspaces/{workspaceId}/agent-settings.json
 */
import { join } from "path";
import { sanitizeWorkspace, sanitizeUserId } from "./storage.js";
import * as storage from "./storage.js";
import { canAccessWorkspace } from "./teams.js";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";

const SETTINGS_VERSION = 1;
const MAX_WORKSPACE_SYSTEM_CHARS = Math.min(
  32_000,
  Math.max(256, Number(process.env.WORKSPACE_AGENT_SYSTEM_MAX_CHARS) || 8000)
);
const MAX_MEMORY_SNIPPETS = Math.min(100, Math.max(1, Number(process.env.WORKSPACE_AGENT_MEMORY_MAX_ITEMS) || 50));
const MAX_SNIPPET_CHARS = Math.min(8000, Math.max(100, Number(process.env.WORKSPACE_AGENT_MEMORY_SNIPPET_MAX) || 2000));
const MAX_MEMORY_TOTAL_CHARS = Math.min(64_000, Math.max(1000, Number(process.env.WORKSPACE_AGENT_MEMORY_TOTAL_MAX) || 16_000));

/**
 * @param {string} storageUserId
 * @param {string} workspaceId
 */
export function getWorkspaceAgentSettingsPath(storageUserId, workspaceId) {
  const uid = sanitizeUserId(storageUserId);
  const ws = sanitizeWorkspace(workspaceId);
  return join(getDataDir(), "users", uid, "workspaces", ws, "agent-settings.json");
}

/**
 * @returns {{ defaultSystemPrompt: string, memorySnippets: string[] }}
 */
export function normalizeWorkspaceAgentSettings(raw) {
  let defaultSystemPrompt = "";
  if (raw && typeof raw.defaultSystemPrompt === "string") {
    defaultSystemPrompt = raw.defaultSystemPrompt.trim().slice(0, MAX_WORKSPACE_SYSTEM_CHARS);
  }
  let memorySnippets = [];
  if (raw && Array.isArray(raw.memorySnippets)) {
    memorySnippets = raw.memorySnippets
      .map((s) => (typeof s === "string" ? s.trim().slice(0, MAX_SNIPPET_CHARS) : ""))
      .filter(Boolean)
      .slice(0, MAX_MEMORY_SNIPPETS);
    let total = 0;
    const capped = [];
    for (const s of memorySnippets) {
      if (total + s.length > MAX_MEMORY_TOTAL_CHARS) break;
      capped.push(s);
      total += s.length;
    }
    memorySnippets = capped;
  }
  return { defaultSystemPrompt, memorySnippets };
}

/**
 * @param {string} storageUserId
 * @param {string} workspaceId
 */
export async function loadWorkspaceAgentSettings(storageUserId, workspaceId) {
  const path = getWorkspaceAgentSettingsPath(storageUserId, workspaceId);
  try {
    const raw = await readJsonPath(path, {});
    if (raw == null || typeof raw !== "object") return { defaultSystemPrompt: "", memorySnippets: [] };
    return normalizeWorkspaceAgentSettings(raw);
  } catch (e) {
    console.warn("[workspace-agent-settings] load failed:", e.message);
    return { defaultSystemPrompt: "", memorySnippets: [] };
  }
}

/**
 * @param {string} storageUserId
 * @param {string} workspaceId
 * @param {{ defaultSystemPrompt?: string, memorySnippets?: unknown }} body
 */
export async function saveWorkspaceAgentSettings(storageUserId, workspaceId, body) {
  const normalized = normalizeWorkspaceAgentSettings({
    defaultSystemPrompt: body?.defaultSystemPrompt,
    memorySnippets: body?.memorySnippets,
  });
  const path = getWorkspaceAgentSettingsPath(storageUserId, workspaceId);
  const payload = {
    _version: SETTINGS_VERSION,
    defaultSystemPrompt: normalized.defaultSystemPrompt,
    memorySnippets: normalized.memorySnippets,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonPath(path, payload);
  return normalized;
}

/**
 * Build extra system text from workspace prompt + memory list.
 */
export function buildWorkspaceAgentAugmentation(settings) {
  const parts = [];
  if (settings.defaultSystemPrompt) {
    parts.push(settings.defaultSystemPrompt);
  }
  if (settings.memorySnippets.length > 0) {
    const bullets = settings.memorySnippets.map((s) => `- ${s}`).join("\n");
    parts.push(
      "## Approved workspace memory\n" +
        "Use when relevant; do not contradict these facts without confirming with the user.\n\n" +
        bullets
    );
  }
  if (parts.length === 0) return "";
  return parts.join("\n\n");
}

/**
 * Append workspace augmentation to first system message or insert one.
 */
export async function augmentMessagesWithWorkspaceAgent(messages, storageUserId, workspaceId) {
  const settings = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
  const extra = buildWorkspaceAgentAugmentation(settings);
  if (!extra) return Array.isArray(messages) ? [...messages] : [];
  const out = Array.isArray(messages) ? [...messages] : [];
  if (out.length === 0) {
    return [{ role: "system", content: extra }];
  }
  const first = out[0];
  if (first && first.role === "system" && typeof first.content === "string") {
    const base = first.content.trimEnd();
    out[0] = { ...first, content: base ? `${base}\n\n${extra}` : extra };
  } else {
    out.unshift({ role: "system", content: extra });
  }
  return out;
}

/**
 * User may access workspace if it appears in their list (personal + team).
 */
export async function userHasWorkspaceAccess(userId, workspaceId) {
  const ws = sanitizeWorkspace(workspaceId);
  const uid = sanitizeUserId(userId);
  try {
    const list = await storage.listWorkspaces(uid);
    return list.some((w) => String(w.id) === String(ws));
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ allowed: boolean; role?: string; ownerId?: string }>}
 */
export async function getWorkspaceAgentAccess(userId, workspaceId) {
  if (!(await userHasWorkspaceAccess(userId, workspaceId))) return { allowed: false };
  const ws = sanitizeWorkspace(workspaceId);
  const team = await canAccessWorkspace(ws, userId);
  if (team.allowed) return { allowed: true, role: team.role, ownerId: team.ownerId };
  return { allowed: true, role: "admin", ownerId: userId };
}

export function canEditWorkspaceAgentSettings(role) {
  return role === "admin" || role === "member";
}
