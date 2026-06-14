/**
 * Phase 47.1: Worker agent registry.
 * Defines built-in worker types used by hierarchical manager agents
 * and exposes registration helpers for custom workers.
 */

export const BUILTIN_WORKERS = {
  researcher: {
    id: "researcher",
    description: "Researches topics by searching the workspace knowledge base and the web.",
    systemPrompt: `You research topics thoroughly. Gather evidence from the workspace knowledge base and external sources when allowed.
- Prefer search_context and semantic_search_context for keyword and conceptual lookups.
- Use web_search only when the workspace has no relevant material.
Return concise, sourced findings with document ids or URLs.`,
    tools: ["web_search", "search_context", "semantic_search_context", "list_context", "get_context_document"],
    maxIterations: 5,
    color: "#3b82f6",
  },
  coder: {
    id: "coder",
    description: "Writes and executes code in a sandbox.",
    systemPrompt: `You write code. Produce minimal, correct programs that solve the assigned subtask.
- Use workspace_read_file to inspect existing source before editing.
- Use code_execute when the task requires running or validating the code.
Return the code and any execution output succinctly.`,
    tools: ["code_execute", "workspace_read_file"],
    maxIterations: 5,
    color: "#10b981",
  },
  analyst: {
    id: "analyst",
    description: "Analyzes data from the storage backend and knowledge base.",
    systemPrompt: `You analyze data. Look at structured data and prior findings to extract insights.
- Use query_database for read-only queries against the storage backend.
- Use search_context to find supporting documents.
Return clear conclusions with the metrics or evidence that support them.`,
    tools: ["query_database", "search_context"],
    maxIterations: 5,
    color: "#f59e0b",
  },
  writer: {
    id: "writer",
    description: "Writes clear, concise content based on workspace material.",
    systemPrompt: `You write clear, concise content. Compose the assigned text grounded in workspace knowledge.
- Use search_context to ground claims in workspace documents.
- Avoid speculation; cite sources when possible.
Return only the requested prose.`,
    tools: ["search_context"],
    maxIterations: 4,
    color: "#a855f7",
  },
  executor: {
    id: "executor",
    description: "Executes recipe steps and runs automations.",
    systemPrompt: `You execute tasks using tools.
- Use list_recipes or get_recipe to discover the right automation.
- Use execute_step only when execution is allowed.
Return what was executed and the resulting status.`,
    tools: ["execute_step", "get_recipe", "list_recipes"],
    maxIterations: 5,
    color: "#ef4444",
  },
};

/** @type {Map<string, object>} */
const customWorkers = new Map();

function normalizeWorker(id, config) {
  if (!id || typeof id !== "string") throw new Error("worker id is required");
  if (!config || typeof config !== "object") throw new Error("worker config is required");
  const systemPrompt = config.systemPrompt;
  if (!systemPrompt || typeof systemPrompt !== "string") {
    throw new Error("worker systemPrompt is required");
  }
  const tools = Array.isArray(config.tools) ? config.tools.map((t) => String(t)).filter(Boolean) : [];
  const maxIterations = Number.isFinite(config.maxIterations)
    ? Math.max(1, Math.min(20, Math.floor(config.maxIterations)))
    : 5;
  return {
    id: String(id).trim().slice(0, 64),
    description: typeof config.description === "string" ? config.description : "",
    systemPrompt,
    tools,
    maxIterations,
    color: typeof config.color === "string" ? config.color : "#64748b",
  };
}

/**
 * Register a custom worker. Overwrites an existing custom worker with the same id.
 * Built-in workers cannot be overridden.
 * @param {string} id
 * @param {object} config
 * @returns {object}
 */
export function registerWorker(id, config) {
  const normalized = normalizeWorker(id, config);
  if (Object.prototype.hasOwnProperty.call(BUILTIN_WORKERS, normalized.id)) {
    throw new Error(`cannot override built-in worker: ${normalized.id}`);
  }
  customWorkers.set(normalized.id, normalized);
  return { ...normalized };
}

/**
 * Remove a previously registered custom worker.
 * @param {string} id
 * @returns {boolean}
 */
export function unregisterWorker(id) {
  return customWorkers.delete(String(id || ""));
}

/**
 * Get a worker definition by id. Returns null if no such worker exists.
 * @param {string} id
 * @returns {object | null}
 */
export function getWorker(id) {
  if (!id) return null;
  if (Object.prototype.hasOwnProperty.call(BUILTIN_WORKERS, id)) {
    return { ...BUILTIN_WORKERS[id] };
  }
  const custom = customWorkers.get(id);
  return custom ? { ...custom } : null;
}

/**
 * List every registered worker (built-in and custom).
 * @returns {object[]}
 */
export function listWorkers() {
  const builtins = Object.values(BUILTIN_WORKERS).map((w) => ({ ...w, builtin: true }));
  const customs = [...customWorkers.values()].map((w) => ({ ...w, builtin: false }));
  return [...builtins, ...customs];
}

/** Test helper. Clears all custom worker registrations. */
export function _resetCustomWorkers() {
  customWorkers.clear();
}
