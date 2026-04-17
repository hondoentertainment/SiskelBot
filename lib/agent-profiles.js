/**
 * Agent profile store — named persona configurations with system prompt,
 * tool allowlist/denylist, model override, and budgets.
 *
 * Built-in profiles are always available in memory. Workspace-scoped overrides
 * and custom profiles are persisted via json-path-store under
 * data/agent-profiles/<workspace>.json.
 */
import { join } from "path";
import { getDataDir, readJsonPath, writeJsonPath, withPathLock } from "./json-path-store.js";

// ── ID format ───────────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

// ── Built-in profiles ───────────────────────────────────────────────────────

const now = new Date().toISOString();

const BUILT_IN_PROFILES = [
  {
    id: "researcher",
    name: "Researcher",
    systemPrompt:
      "You are a research agent. Search and summarize findings. Never modify data.",
    model: null,
    toolAllowlist: [
      "search_context",
      "semantic_search_context",
      "fetch_allowed_url",
      "web_search",
      "list_context",
      "get_context_document",
      "search_knowledge_graph",
    ],
    toolDenylist: null,
    budgets: { maxIterations: 15, maxCostUsd: 0.5, maxWallTimeMs: null, maxToolCalls: null },
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "executor",
    name: "Executor",
    systemPrompt:
      "You are an execution agent. Carry out the plan step by step.",
    model: null,
    toolAllowlist: null,
    toolDenylist: null,
    budgets: { maxIterations: 25, maxCostUsd: 2.0, maxWallTimeMs: null, maxToolCalls: null },
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "synthesizer",
    name: "Synthesizer",
    systemPrompt:
      "You are a synthesis agent. Combine inputs into coherent output.",
    model: null,
    toolAllowlist: ["search_context", "get_context_document", "create_document"],
    toolDenylist: null,
    budgets: { maxIterations: 5, maxCostUsd: 0.2, maxWallTimeMs: null, maxToolCalls: null },
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "code_writer",
    name: "Code Writer",
    systemPrompt:
      "You are a code-writing agent. Write clean, tested code.",
    model: null,
    toolAllowlist: ["workspace_read_file", "code_execute", "search_context"],
    toolDenylist: null,
    budgets: { maxIterations: 20, maxCostUsd: 1.0, maxWallTimeMs: null, maxToolCalls: null },
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "reviewer",
    name: "Reviewer",
    systemPrompt:
      "You are a review agent. Analyze for correctness, security, and quality. Do not modify.",
    model: null,
    toolAllowlist: ["search_context", "workspace_read_file", "get_context_document"],
    toolDenylist: null,
    budgets: { maxIterations: 10, maxCostUsd: 0.3, maxWallTimeMs: null, maxToolCalls: null },
    builtIn: true,
    createdAt: now,
    updatedAt: now,
  },
];

const builtInMap = new Map(BUILT_IN_PROFILES.map((p) => [p.id, p]));

// ── Storage helpers ─────────────────────────────────────────────────────────

function storagePath(workspace) {
  return join(getDataDir(), "agent-profiles", `${workspace}.json`);
}

async function loadWorkspaceProfiles(workspace) {
  const data = await readJsonPath(storagePath(workspace), { profiles: [] });
  return Array.isArray(data.profiles) ? data.profiles : [];
}

async function saveWorkspaceProfiles(workspace, profiles) {
  await writeJsonPath(storagePath(workspace), { profiles });
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateProfile(profile) {
  const errors = [];
  if (!isValidId(profile.id)) {
    errors.push("id must be 2-64 chars of lowercase alphanumeric, hyphens, or underscores");
  }
  if (typeof profile.systemPrompt !== "string" || !profile.systemPrompt.trim()) {
    errors.push("systemPrompt is required and must be a non-empty string");
  }
  if (profile.model !== undefined && profile.model !== null && typeof profile.model !== "string") {
    errors.push("model must be a string or null");
  }
  if (profile.toolAllowlist !== undefined && profile.toolAllowlist !== null) {
    if (!Array.isArray(profile.toolAllowlist) || !profile.toolAllowlist.every((t) => typeof t === "string")) {
      errors.push("toolAllowlist must be an array of strings or null");
    }
  }
  if (profile.toolDenylist !== undefined && profile.toolDenylist !== null) {
    if (!Array.isArray(profile.toolDenylist) || !profile.toolDenylist.every((t) => typeof t === "string")) {
      errors.push("toolDenylist must be an array of strings or null");
    }
  }
  if (profile.budgets !== undefined && profile.budgets !== null) {
    if (typeof profile.budgets !== "object" || Array.isArray(profile.budgets)) {
      errors.push("budgets must be an object");
    } else {
      for (const key of ["maxIterations", "maxCostUsd", "maxWallTimeMs", "maxToolCalls"]) {
        const v = profile.budgets[key];
        if (v !== undefined && v !== null && (typeof v !== "number" || v < 0)) {
          errors.push(`budgets.${key} must be a non-negative number or null`);
        }
      }
    }
  }
  return errors;
}

function normalizeProfile(input, existing) {
  const ts = new Date().toISOString();
  return {
    id: input.id,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : input.id,
    systemPrompt: input.systemPrompt.trim(),
    model: input.model ?? null,
    toolAllowlist: input.toolAllowlist ?? null,
    toolDenylist: input.toolDenylist ?? null,
    budgets: {
      maxIterations: input.budgets?.maxIterations ?? null,
      maxCostUsd: input.budgets?.maxCostUsd ?? null,
      maxWallTimeMs: input.budgets?.maxWallTimeMs ?? null,
      maxToolCalls: input.budgets?.maxToolCalls ?? null,
    },
    builtIn: builtInMap.has(input.id),
    createdAt: existing?.createdAt || ts,
    updatedAt: ts,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the 5 built-in profiles (immutable copies).
 * @returns {object[]}
 */
export function getBuiltInProfiles() {
  return BUILT_IN_PROFILES.map((p) => ({ ...p, budgets: { ...p.budgets } }));
}

/**
 * List all profiles for a workspace (built-ins merged with workspace overrides/custom).
 * Workspace profiles override built-ins by id.
 * @param {string} workspace
 * @returns {Promise<object[]>}
 */
export async function listProfiles(workspace) {
  const wsProfiles = await loadWorkspaceProfiles(workspace);
  const merged = new Map(builtInMap.entries());
  for (const p of wsProfiles) {
    merged.set(p.id, p);
  }
  return [...merged.values()].map((p) => ({ ...p, budgets: { ...p.budgets } }));
}

/**
 * Get a single profile by id (workspace override takes precedence over built-in).
 * @param {string} workspace
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getProfile(workspace, id) {
  const wsProfiles = await loadWorkspaceProfiles(workspace);
  const wsMatch = wsProfiles.find((p) => p.id === id);
  if (wsMatch) return { ...wsMatch, budgets: { ...wsMatch.budgets } };
  const builtIn = builtInMap.get(id);
  return builtIn ? { ...builtIn, budgets: { ...builtIn.budgets } } : null;
}

/**
 * Create or update a profile in a workspace.
 * @param {string} workspace
 * @param {object} profile - Must contain at least id and systemPrompt.
 * @returns {Promise<object>} The saved profile.
 * @throws {Error} If validation fails.
 */
export async function upsertProfile(workspace, profile) {
  const errors = validateProfile(profile);
  if (errors.length > 0) {
    const err = new Error(errors.join("; "));
    err.code = "VALIDATION_ERROR";
    throw err;
  }

  const path = storagePath(workspace);
  return withPathLock(path, async () => {
    const wsProfiles = await loadWorkspaceProfiles(workspace);
    const existingIdx = wsProfiles.findIndex((p) => p.id === profile.id);
    const existing = existingIdx >= 0 ? wsProfiles[existingIdx] : null;
    const normalized = normalizeProfile(profile, existing);

    if (existingIdx >= 0) {
      wsProfiles[existingIdx] = normalized;
    } else {
      wsProfiles.push(normalized);
    }
    await saveWorkspaceProfiles(workspace, wsProfiles);
    return { ...normalized, budgets: { ...normalized.budgets } };
  });
}

/**
 * Delete a profile from a workspace.
 * Built-in profiles cannot be deleted unless they have a workspace override
 * (in which case the override is removed and the built-in resurfaces).
 * @param {string} workspace
 * @param {string} id
 * @returns {Promise<boolean>} true if deleted, false if not found.
 * @throws {Error} If attempting to delete a built-in with no workspace override.
 */
export async function deleteProfile(workspace, id) {
  const path = storagePath(workspace);
  return withPathLock(path, async () => {
    const wsProfiles = await loadWorkspaceProfiles(workspace);
    const idx = wsProfiles.findIndex((p) => p.id === id);

    if (idx < 0) {
      if (builtInMap.has(id)) {
        const err = new Error("Cannot delete a built-in profile without a workspace override");
        err.code = "BUILTIN_DELETE";
        throw err;
      }
      return false;
    }

    wsProfiles.splice(idx, 1);
    await saveWorkspaceProfiles(workspace, wsProfiles);
    return true;
  });
}
