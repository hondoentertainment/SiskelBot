/**
 * Phase 61–62: Per-workspace agent instructions and approved memory snippets.
 * Stored at data/users/{storageUserId}/workspaces/{workspaceId}/agent-settings.json
 * (storageUserId = resolveStorageUserId for team workspaces).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { sanitizeWorkspace, sanitizeUserId } from "./storage.js";
import * as storage from "./storage.js";
import { canAccessWorkspace } from "./teams.js";

const SETTINGS_VERSION = 1;
const MAX_WORKSPACE_SYSTEM_CHARS = Math.min(
  32_000,
  Math.max(256, Number(process.env.WORKSPACE_AGENT_SYSTEM_MAX_CHARS) || 8000)
);
const MAX_MEMORY_SNIPPETS = Math.min(100, Math.max(1, Number(process.env.WORKSPACE_AGENT_MEMORY_MAX_ITEMS) || 50));
const MAX_SNIPPET_CHARS = Math.min(8000, Math.max(100, Number(process.env.WORKSPACE_AGENT_MEMORY_SNIPPET_MAX) || 2000));
const MAX_MEMORY_TOTAL_CHARS = Math.min(64_000, Math.max(1000, Number(process.env.WORKSPACE_AGENT_MEMORY_TOTAL_MAX) || 16_000));

function getDataDir() {
  const dir = process.env.STORAGE_PATH || join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

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
export function loadWorkspaceAgentSettings(storageUserId, workspaceId) {
  const path = getWorkspaceAgentSettingsPath(storageUserId, workspaceId);
  try {
    if (!existsSync(path)) return { defaultSystemPrompt: "", memorySnippets: [] };
    const raw = JSON.parse(readFileSync(path, "utf8"));
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
export function saveWorkspaceAgentSettings(storageUserId, workspaceId, body) {
  const normalized = normalizeWorkspaceAgentSettings({
    defaultSystemPrompt: body?.defaultSystemPrompt,
    memorySnippets: body?.memorySnippets,
  });
  const path = getWorkspaceAgentSettingsPath(storageUserId, workspaceId);
  ensureDir(dirname(path));
  const payload = {
    _version: SETTINGS_VERSION,
    defaultSystemPrompt: normalized.defaultSystemPrompt,
    memorySnippets: normalized.memorySnippets,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 0), "utf8");
  return normalized;
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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
 * @param {Array<{ role?: string; content?: string }>} messages
 * @param {string} storageUserId
 * @param {string} workspaceId
 */
export function augmentMessagesWithWorkspaceAgent(messages, storageUserId, workspaceId) {
  const settings = loadWorkspaceAgentSettings(storageUserId, workspaceId);
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
 * @param {string} userId
 * @param {string} workspaceId
 */
export function userHasWorkspaceAccess(userId, workspaceId) {
  const ws = sanitizeWorkspace(workspaceId);
  const uid = sanitizeUserId(userId);
  try {
    const list = storage.listWorkspaces(uid);
    return list.some((w) => String(w.id) === String(ws));
  } catch {
    return false;
  }
}

/**
 * @returns {{ allowed: boolean; role?: string; ownerId?: string }}
 */
export function getWorkspaceAgentAccess(userId, workspaceId) {
  if (!userHasWorkspaceAccess(userId, workspaceId)) return { allowed: false };
  const ws = sanitizeWorkspace(workspaceId);
  const team = canAccessWorkspace(ws, userId);
  if (team.allowed) return { allowed: true, role: team.role, ownerId: team.ownerId };
  return { allowed: true, role: "admin", ownerId: userId };
}

export function canEditWorkspaceAgentSettings(role) {
  return role === "admin" || role === "member";
}
