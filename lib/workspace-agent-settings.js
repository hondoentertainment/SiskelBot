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
const MAX_ALLOWED_TOOLS = Math.min(48, Math.max(1, Number(process.env.WORKSPACE_AGENT_ALLOWED_TOOLS_MAX) || 32));
const MAX_POLICY_CAP = Math.min(500, Math.max(1, Number(process.env.WORKSPACE_AGENT_POLICY_MAX_CAP) || 200));
const MAX_DENIED_TOOLS = Math.min(48, Math.max(1, Number(process.env.WORKSPACE_AGENT_DENIED_TOOLS_MAX) || 32));

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
 * @returns {{ defaultSystemPrompt: string, memorySnippets: string[], allowedTools: string[], agentPolicy: object }}
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
  let allowedTools = [];
  if (raw && Array.isArray(raw.allowedTools)) {
    allowedTools = raw.allowedTools
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_ALLOWED_TOOLS);
  }
  const apRaw = raw && typeof raw.agentPolicy === "object" ? raw.agentPolicy : {};
  const apCaps = apRaw && typeof apRaw.toolCategoryCaps === "object" ? apRaw.toolCategoryCaps : {};
  let deniedTools = [];
  if (apRaw && Array.isArray(apRaw.deniedTools)) {
    deniedTools = apRaw.deniedTools
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_DENIED_TOOLS);
  }
  const agentPolicy = {
    maxExternalFetches: capPositive(apRaw.maxExternalFetches, 0, MAX_POLICY_CAP),
    maxTotalToolMs: capPositive(apRaw.maxTotalToolMs, 0, 60 * 60 * 1000),
    requireMemoryCitations: apRaw.requireMemoryCitations === true,
    toolCategoryCaps: {
      read: capPositive(apCaps.read, 0, MAX_POLICY_CAP),
      write: capPositive(apCaps.write, 0, MAX_POLICY_CAP),
      network: capPositive(apCaps.network, 0, MAX_POLICY_CAP),
    },
    deniedTools,
  };
  return { defaultSystemPrompt, memorySnippets, allowedTools, agentPolicy };
}

/**
 * @param {string} storageUserId
 * @param {string} workspaceId
 */
export async function loadWorkspaceAgentSettings(storageUserId, workspaceId) {
  const path = getWorkspaceAgentSettingsPath(storageUserId, workspaceId);
  try {
    const raw = await readJsonPath(path, {});
    if (raw == null || typeof raw !== "object") {
      return {
        defaultSystemPrompt: "",
        memorySnippets: [],
        allowedTools: [],
        agentPolicy: {
          maxExternalFetches: 0,
          maxTotalToolMs: 0,
          requireMemoryCitations: false,
          toolCategoryCaps: {},
          deniedTools: [],
        },
      };
    }
    const norm = normalizeWorkspaceAgentSettings(raw);
    const { getRegisteredToolNames } = await import("./agent-tools.js");
    const known = new Set(getRegisteredToolNames());
    norm.allowedTools = norm.allowedTools.filter((n) => known.has(n));
    return norm;
  } catch (e) {
    console.warn("[workspace-agent-settings] load failed:", e.message);
    return {
      defaultSystemPrompt: "",
      memorySnippets: [],
      allowedTools: [],
      agentPolicy: {
        maxExternalFetches: 0,
        maxTotalToolMs: 0,
        requireMemoryCitations: false,
        toolCategoryCaps: {},
        deniedTools: [],
      },
    };
  }
}

/**
 * @param {string} storageUserId
 * @param {string} workspaceId
 * @param {{ defaultSystemPrompt?: string, memorySnippets?: unknown }} body
 */
export async function saveWorkspaceAgentSettings(storageUserId, workspaceId, body) {
  const prelim = normalizeWorkspaceAgentSettings({
    defaultSystemPrompt: body?.defaultSystemPrompt,
    memorySnippets: body?.memorySnippets,
    allowedTools: body?.allowedTools,
    agentPolicy: body?.agentPolicy,
  });
  const { getRegisteredToolNames } = await import("./agent-tools.js");
  const known = new Set(getRegisteredToolNames());
  prelim.allowedTools = prelim.allowedTools.filter((n) => known.has(n));
  const normalized = prelim;
  const path = getWorkspaceAgentSettingsPath(storageUserId, workspaceId);
  const payload = {
    _version: SETTINGS_VERSION,
    defaultSystemPrompt: normalized.defaultSystemPrompt,
    memorySnippets: normalized.memorySnippets,
    allowedTools: normalized.allowedTools,
    agentPolicy: normalized.agentPolicy,
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
    const requireMemoryIds =
      settings?.agentPolicy?.requireMemoryCitations === true ||
      process.env.WORKSPACE_MEMORY_REQUIRE_CITATIONS === "1";
    const bullets = settings.memorySnippets
      .map((s, i) => (requireMemoryIds ? `- [mem-${i + 1}] ${s}` : `- ${s}`))
      .join("\n");
    parts.push(
      "## Approved workspace memory\n" +
        "Use when relevant; do not contradict these facts without confirming with the user.\n\n" +
        bullets
    );
    if (requireMemoryIds) {
      parts.push(
        "When using approved memory in your final answer, include at least one memory citation id such as [mem-1]."
      );
    }
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

/**
 * Human-readable stats for settings panel diagnostics.
 * @param {{ memorySnippets?: string[] }} settings
 */
export function getWorkspaceMemoryStats(settings) {
  const snippets = Array.isArray(settings?.memorySnippets) ? settings.memorySnippets : [];
  const totalChars = snippets.reduce((n, s) => n + String(s || "").length, 0);
  const maxAllowed = MAX_MEMORY_TOTAL_CHARS;
  const pct = maxAllowed > 0 ? Math.round((totalChars / maxAllowed) * 100) : 0;
  return {
    snippets: snippets.length,
    totalChars,
    maxTotalChars: maxAllowed,
    usagePercent: Math.min(100, Math.max(0, pct)),
    truncationHint:
      totalChars >= maxAllowed
        ? "memory total reached cap; additional lines are trimmed"
        : snippets.length >= MAX_MEMORY_SNIPPETS
          ? "memory snippet count reached cap"
          : "",
  };
}

function capPositive(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return min;
  return Math.min(max, Math.floor(n));
}
