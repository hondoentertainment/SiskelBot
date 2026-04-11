/**
 * Phase 53.4: Tool composition.
 *
 * Auto-pipeline tools via schema matching. Given a set of tools with typed
 * inputs and outputs, compose them into larger "macro tools" that perform
 * multi-step operations. Supports sequential, parallel, and conditional
 * composition, with retry wrappers and validation.
 *
 * Storage: persistent macros are saved via json-path-store so the module
 * works across file/SQLite/Postgres KV backends.
 *
 * @module tool-composition
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 25;

function macrosStorePath() {
  return join(getDataDir(), "tool-composition-macros.json");
}

async function readMacrosStore() {
  const raw = await readJsonPath(macrosStorePath(), { _version: STORE_VERSION, macros: {} });
  if (!raw || typeof raw !== "object") return { _version: STORE_VERSION, macros: {} };
  if (!raw.macros || typeof raw.macros !== "object") raw.macros = {};
  return raw;
}

async function writeMacrosStore(store) {
  await writeJsonPath(macrosStorePath(), store);
}

/**
 * Normalize a JSON-schema-lite representation of input/output types into
 * something comparable. We accept either a string shorthand ("string",
 * "number", "object") or a JSON-schema-style object with a `type` field.
 */
function typeKey(schema) {
  if (schema == null) return "any";
  if (typeof schema === "string") return schema.toLowerCase();
  if (typeof schema === "object") {
    if (typeof schema.type === "string") return schema.type.toLowerCase();
    if (Array.isArray(schema.type)) return schema.type.map((t) => String(t).toLowerCase()).join("|");
  }
  return "any";
}

function typesCompatible(fromSchema, toSchema) {
  const a = typeKey(fromSchema);
  const b = typeKey(toSchema);
  if (a === "any" || b === "any") return true;
  if (a === b) return true;
  // Allow union types on either side.
  const aParts = a.split("|");
  const bParts = b.split("|");
  return aParts.some((p) => bParts.includes(p));
}

/**
 * Registry for tools and composed "macro" tools.
 */
export class ToolComposer {
  constructor() {
    this.tools = new Map();
    this.macros = new Map();
  }

  registerTool(toolDef) {
    if (!toolDef || typeof toolDef !== "object") {
      throw new Error("toolDef must be an object");
    }
    if (!toolDef.name || typeof toolDef.name !== "string") {
      throw new Error("toolDef.name is required");
    }
    const normalized = {
      name: toolDef.name,
      description: toolDef.description || "",
      inputSchema: toolDef.inputSchema || { type: "any" },
      outputSchema: toolDef.outputSchema || { type: "any" },
      handler: typeof toolDef.handler === "function" ? toolDef.handler : null,
    };
    this.tools.set(normalized.name, normalized);
    return normalized;
  }

  unregisterTool(name) {
    return this.tools.delete(name);
  }

  listTools() {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    }));
  }

  addComposition(macro) {
    if (!macro || typeof macro !== "object") throw new Error("macro must be an object");
    if (!macro.name) throw new Error("macro.name is required");
    this.macros.set(macro.name, macro);
    return macro;
  }

  getComposition(macroName) {
    return this.macros.get(macroName) || null;
  }

  listMacros() {
    return Array.from(this.macros.values()).map((m) => ({
      name: m.name,
      steps: m.steps || [],
      inputSchema: m.inputSchema,
      outputSchema: m.outputSchema,
      description: m.description || "",
    }));
  }

  /**
   * Expose the internal tool map as a plain object (used by composeTools / inferPipeline).
   */
  toolsAsMap() {
    const out = {};
    for (const [name, def] of this.tools) out[name] = def;
    return out;
  }
}

function toolsAsArray(tools) {
  if (!tools) return [];
  if (Array.isArray(tools)) return tools.filter(Boolean);
  if (tools instanceof Map) return Array.from(tools.values());
  if (typeof tools === "object") return Object.values(tools);
  return [];
}

function toolsAsLookup(tools) {
  const map = new Map();
  for (const t of toolsAsArray(tools)) {
    if (t && t.name) map.set(t.name, t);
  }
  return map;
}

/**
 * Breadth-first search for a pipeline that transforms `inputs` → `target`.
 * Each node is a tool whose input matches the current output type. The search
 * stops as soon as a compatible output is produced.
 *
 * @param {object|string} inputs - starting input schema
 * @param {object|string} target - desired output schema
 * @param {Array|Map|Object} tools - available tools
 * @param {{ maxDepth?: number }} [options]
 * @returns {Array<string>|null} - list of tool names (pipeline), or null if none
 */
export function inferPipeline(inputs, target, tools, options = {}) {
  const maxDepth = Number(options.maxDepth) > 0 ? Number(options.maxDepth) : DEFAULT_MAX_DEPTH;
  const lookup = toolsAsLookup(tools);
  if (lookup.size === 0) return null;
  if (!options.forceMultiStep && typesCompatible(inputs, target)) return [];

  const seenTypes = new Set([typeKey(inputs)]);
  /** @type {Array<{ type: any, path: string[], usedNames: Set<string> }>} */
  const queue = [{ type: inputs, path: [], usedNames: new Set() }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.path.length >= maxDepth) continue;
    for (const tool of lookup.values()) {
      if (!typesCompatible(current.type, tool.inputSchema)) continue;
      if (current.usedNames.has(tool.name)) continue; // prevent cycles
      const nextPath = [...current.path, tool.name];
      if (typesCompatible(tool.outputSchema, target)) {
        return nextPath;
      }
      const nextKey = typeKey(tool.outputSchema);
      const visitedKey = `${nextKey}::${nextPath.join(">")}`;
      if (seenTypes.has(visitedKey)) continue;
      seenTypes.add(visitedKey);
      const usedNames = new Set(current.usedNames);
      usedNames.add(tool.name);
      queue.push({ type: tool.outputSchema, path: nextPath, usedNames });
    }
  }
  return null;
}

/**
 * Find combinations that transform `inputSchema` → `goal`. Returns an array
 * of candidate compositions. At minimum this returns the BFS pipeline, plus
 * direct single-tool matches.
 *
 * @param {Array|Map|Object} tools
 * @param {{ goal?: any, inputSchema?: any, maxDepth?: number, name?: string }} [options]
 * @returns {Array<{ name: string, steps: string[], inputSchema: any, outputSchema: any }>}
 */
export function composeTools(tools, options = {}) {
  const { goal, inputSchema, maxDepth } = options || {};
  const lookup = toolsAsLookup(tools);
  const results = [];

  // Single-tool direct matches (highest priority).
  for (const tool of lookup.values()) {
    const inputOk = inputSchema == null || typesCompatible(inputSchema, tool.inputSchema);
    const outputOk = goal == null || typesCompatible(tool.outputSchema, goal);
    if (inputOk && outputOk) {
      results.push({
        name: options.name || `macro_${tool.name}`,
        steps: [tool.name],
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      });
    }
  }

  if (goal != null && inputSchema != null) {
    const pipeline = inferPipeline(inputSchema, goal, lookup, { maxDepth, forceMultiStep: true });
    if (pipeline && pipeline.length > 0 && !results.some((r) => r.steps.join(">") === pipeline.join(">"))) {
      const first = lookup.get(pipeline[0]);
      const last = lookup.get(pipeline[pipeline.length - 1]);
      results.push({
        name: options.name || `macro_${pipeline.join("_")}`,
        steps: pipeline,
        inputSchema: first?.inputSchema ?? inputSchema,
        outputSchema: last?.outputSchema ?? goal,
      });
    }
  }

  return results;
}

/**
 * Build a macro-tool definition that wraps a pipeline of existing tools.
 *
 * @param {string} name
 * @param {Array<string>} pipeline - tool names in execution order
 * @param {Array|Map|Object} tools
 * @returns {{ name: string, steps: string[], inputSchema: any, outputSchema: any, description: string, kind: string }}
 */
export function createMacroTool(name, pipeline, tools) {
  if (!name || typeof name !== "string") throw new Error("name is required");
  if (!Array.isArray(pipeline)) throw new Error("pipeline must be an array");
  const lookup = toolsAsLookup(tools);
  if (pipeline.length === 0) {
    return {
      name,
      steps: [],
      inputSchema: { type: "any" },
      outputSchema: { type: "any" },
      description: `Empty macro ${name}`,
      kind: "sequential",
    };
  }
  for (const step of pipeline) {
    if (!lookup.has(step)) throw new Error(`unknown tool in pipeline: ${step}`);
  }
  const first = lookup.get(pipeline[0]);
  const last = lookup.get(pipeline[pipeline.length - 1]);
  // Verify adjacent types are compatible.
  for (let i = 1; i < pipeline.length; i += 1) {
    const prev = lookup.get(pipeline[i - 1]);
    const curr = lookup.get(pipeline[i]);
    if (!typesCompatible(prev.outputSchema, curr.inputSchema)) {
      throw new Error(
        `type mismatch between ${prev.name}(${typeKey(prev.outputSchema)}) and ${curr.name}(${typeKey(curr.inputSchema)})`,
      );
    }
  }
  return {
    name,
    steps: pipeline.slice(),
    inputSchema: first.inputSchema,
    outputSchema: last.outputSchema,
    description: `Sequential macro: ${pipeline.join(" -> ")}`,
    kind: "sequential",
  };
}

/**
 * Execute a macro tool by invoking each step via the provided executor.
 *
 * @param {object} macro
 * @param {*} input
 * @param {(toolName: string, input: *) => Promise<*>} executor
 * @returns {Promise<{ output: *, steps: Array<{ name: string, input: *, output: *, durationMs: number }> }>}
 */
export async function executeMacro(macro, input, executor) {
  if (!macro || typeof macro !== "object") throw new Error("macro is required");
  if (typeof executor !== "function") throw new Error("executor must be a function");
  const steps = Array.isArray(macro.steps) ? macro.steps : [];
  const trace = [];
  let current = input;
  for (const stepName of steps) {
    const started = Date.now();
    const output = await executor(stepName, current);
    trace.push({
      name: stepName,
      input: current,
      output,
      durationMs: Date.now() - started,
    });
    current = output;
  }
  return { output: current, steps: trace };
}

/**
 * Run multiple tools on the same input and merge the outputs into one
 * object keyed by tool name.
 *
 * @param {Array<string|object>} tools - tool names or tool defs
 * @param {*} input - shared input
 * @param {(toolName: string, input: *) => Promise<*>} executor
 */
export async function parallelCompose(tools, input, executor) {
  const names = toolsAsArray(tools).map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean);
  if (typeof executor !== "function") {
    // Treat as a static description — return a macro description.
    return {
      kind: "parallel",
      tools: names,
      description: `Parallel composition of ${names.join(", ")}`,
    };
  }
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        const output = await executor(name, input);
        return { name, ok: true, output };
      } catch (err) {
        return { name, ok: false, error: err?.message || String(err) };
      }
    }),
  );
  const merged = {};
  for (const r of results) merged[r.name] = r.ok ? r.output : { error: r.error };
  return { merged, results };
}

/**
 * Sequential composition with optional mapper functions between steps.
 *
 * @param {Array<string|object>} tools
 * @param {{ mappers?: Array<(val: *, index: number) => *>, name?: string }} [options]
 */
export function sequentialCompose(tools, options = {}) {
  const names = toolsAsArray(tools).map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean);
  const mappers = Array.isArray(options.mappers) ? options.mappers : [];
  return {
    kind: "sequential",
    name: options.name || `seq_${names.join("_")}`,
    steps: names,
    mappers,
    async run(input, executor) {
      if (typeof executor !== "function") throw new Error("executor must be a function");
      const trace = [];
      let current = input;
      for (let i = 0; i < names.length; i += 1) {
        const mapper = mappers[i];
        const mapped = typeof mapper === "function" ? mapper(current, i) : current;
        const started = Date.now();
        const output = await executor(names[i], mapped);
        trace.push({ name: names[i], input: mapped, output, durationMs: Date.now() - started });
        current = output;
      }
      return { output: current, steps: trace };
    },
  };
}

/**
 * Branch based on a predicate. Returns a composite that, when run, picks
 * `ifBranch` or `elseBranch` depending on the predicate's result.
 *
 * @param {(input: *) => boolean | Promise<boolean>} condition
 * @param {object|string|Array} ifBranch
 * @param {object|string|Array} elseBranch
 */
export function conditionalCompose(condition, ifBranch, elseBranch) {
  if (typeof condition !== "function") throw new Error("condition must be a function");
  return {
    kind: "conditional",
    async run(input, executor) {
      const verdict = await Promise.resolve(condition(input));
      const branch = verdict ? ifBranch : elseBranch;
      if (branch == null) return { output: input, branch: verdict ? "if" : "else", steps: [] };
      if (typeof branch === "string") {
        const started = Date.now();
        const output = await executor(branch, input);
        return {
          output,
          branch: verdict ? "if" : "else",
          steps: [{ name: branch, input, output, durationMs: Date.now() - started }],
        };
      }
      if (branch && typeof branch.run === "function") {
        const result = await branch.run(input, executor);
        return { ...result, branch: verdict ? "if" : "else" };
      }
      if (branch && Array.isArray(branch.steps)) {
        const result = await executeMacro(branch, input, executor);
        return { ...result, branch: verdict ? "if" : "else" };
      }
      if (Array.isArray(branch)) {
        const pseudo = { steps: branch };
        const result = await executeMacro(pseudo, input, executor);
        return { ...result, branch: verdict ? "if" : "else" };
      }
      throw new Error("invalid branch type");
    },
  };
}

/**
 * Wrap a tool (or macro) so it is retried on failure with exponential-ish backoff.
 *
 * @param {string|object} tool - tool name, tool def, or composite with `run`
 * @param {{ maxRetries?: number, backoffMs?: number }} [options]
 */
export function withRetry(tool, options = {}) {
  const maxRetries = Number.isFinite(options.maxRetries) ? Math.max(0, options.maxRetries) : DEFAULT_MAX_RETRIES;
  const backoffMs = Number.isFinite(options.backoffMs) ? Math.max(0, options.backoffMs) : DEFAULT_BACKOFF_MS;
  const name = typeof tool === "string" ? tool : tool?.name || "retry_wrapper";
  return {
    kind: "retry",
    name,
    target: tool,
    maxRetries,
    backoffMs,
    async run(input, executor) {
      let lastErr;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          if (typeof tool === "string") {
            const output = await executor(tool, input);
            return { output, attempts: attempt + 1 };
          }
          if (tool && typeof tool.run === "function") {
            const result = await tool.run(input, executor);
            return { ...result, attempts: attempt + 1 };
          }
          if (tool && Array.isArray(tool.steps)) {
            const result = await executeMacro(tool, input, executor);
            return { ...result, attempts: attempt + 1 };
          }
          throw new Error("unsupported tool form for withRetry");
        } catch (err) {
          lastErr = err;
          if (attempt >= maxRetries) break;
          if (backoffMs > 0) {
            // Scale backoff by attempt; keep it small so tests stay fast.
            const delay = backoffMs * (attempt + 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
      const err = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      err.attempts = maxRetries + 1;
      throw err;
    },
  };
}

/**
 * Validate a composition: checks all referenced tools exist, that types match
 * between adjacent steps, and that the composition has no cycles.
 *
 * @param {object} composition - { steps: [toolName...] } or { kind, steps }
 * @param {Array|Map|Object} tools
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateComposition(composition, tools) {
  const errors = [];
  if (!composition || typeof composition !== "object") {
    return { ok: false, errors: ["composition must be an object"] };
  }
  const steps = Array.isArray(composition.steps) ? composition.steps : [];
  if (steps.length === 0) {
    return { ok: true, errors: [] };
  }
  const lookup = toolsAsLookup(tools);
  const seen = new Set();
  for (const step of steps) {
    const name = typeof step === "string" ? step : step?.name;
    if (!name) {
      errors.push("step missing name");
      continue;
    }
    if (!lookup.has(name)) {
      errors.push(`missing tool: ${name}`);
    }
    if (seen.has(name)) {
      errors.push(`cycle detected at ${name}`);
    }
    seen.add(name);
  }
  // Type compatibility between adjacent steps.
  for (let i = 1; i < steps.length; i += 1) {
    const prevName = typeof steps[i - 1] === "string" ? steps[i - 1] : steps[i - 1]?.name;
    const currName = typeof steps[i] === "string" ? steps[i] : steps[i]?.name;
    const prev = lookup.get(prevName);
    const curr = lookup.get(currName);
    if (!prev || !curr) continue;
    if (!typesCompatible(prev.outputSchema, curr.inputSchema)) {
      errors.push(
        `type mismatch: ${prevName}(${typeKey(prev.outputSchema)}) -> ${currName}(${typeKey(curr.inputSchema)})`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Persistence: save/load macros
// ---------------------------------------------------------------------------

/**
 * Persist a macro definition.
 *
 * @param {string} name
 * @param {object} macro
 */
export async function saveMacro(name, macro) {
  if (!name || typeof name !== "string") throw new Error("name is required");
  if (!macro || typeof macro !== "object") throw new Error("macro must be an object");
  const clean = {
    name,
    steps: Array.isArray(macro.steps) ? macro.steps.slice() : [],
    inputSchema: macro.inputSchema ?? { type: "any" },
    outputSchema: macro.outputSchema ?? { type: "any" },
    description: macro.description || "",
    kind: macro.kind || "sequential",
    createdAt: macro.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return withPathLock(macrosStorePath(), async () => {
    const store = await readMacrosStore();
    store.macros[name] = clean;
    await writeMacrosStore(store);
    return clean;
  });
}

/**
 * Load a saved macro by name.
 * @param {string} name
 */
export async function loadMacro(name) {
  if (!name) return null;
  const store = await readMacrosStore();
  return store.macros[name] || null;
}

/**
 * List all saved macros.
 */
export async function listSavedMacros() {
  const store = await readMacrosStore();
  return Object.values(store.macros || {});
}

/**
 * Delete a saved macro.
 */
export async function deleteMacro(name) {
  if (!name) return false;
  return withPathLock(macrosStorePath(), async () => {
    const store = await readMacrosStore();
    if (!store.macros[name]) return false;
    delete store.macros[name];
    await writeMacrosStore(store);
    return true;
  });
}

export const _internals = {
  typeKey,
  typesCompatible,
  macrosStorePath,
};
