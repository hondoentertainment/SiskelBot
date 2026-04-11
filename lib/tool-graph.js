/**
 * Phase 53.2: Tool dependency graph — type inference + topological sort for
 * multi-tool pipelines.
 *
 * Each tool is modeled as a node with typed inputs and a typed output
 * (derived from a JSON schema). Edges represent "tool A's output feeds
 * tool B's input" where the types are compatible. The graph exposes
 *
 *   - autoConnect() — infers all valid edges from the registered tools
 *   - topoSort()    — Kahn's algorithm for execution ordering
 *   - hasCycle()    — detects circular dependencies
 *
 * Plus helpers to build a shortest-chain pipeline toward a goal type,
 * validate pipelines, execute them via a user-supplied executor, and
 * persist named pipelines to disk (via the json-path-store).
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";

// ---------------------------------------------------------------------------
// Schema parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract the input and output type descriptors from a JSON schema-like
 * definition. Accepts either an OpenAI-style function tool schema or a plain
 * { inputs, outputs } structure.
 *
 * @param {object} schema
 * @returns {{ inputs: object, outputs: object }}
 */
export function extractIoTypes(schema) {
  if (!schema || typeof schema !== "object") return { inputs: {}, outputs: { type: "any" } };

  // Already normalized
  if (schema.inputs && schema.outputs) {
    return {
      inputs: normalizeInputs(schema.inputs),
      outputs: normalizeType(schema.outputs),
    };
  }

  // OpenAI function-style: { parameters: { properties: { ... } }, returns: { ... } }
  const params = schema.parameters || schema.input_schema || {};
  const props = params.properties || {};
  const inputs = {};
  for (const [name, def] of Object.entries(props)) {
    inputs[name] = normalizeType(def);
  }

  const out = schema.returns || schema.output_schema || schema.output || { type: "any" };
  return { inputs, outputs: normalizeType(out) };
}

function normalizeInputs(inputs) {
  const result = {};
  if (!inputs || typeof inputs !== "object") return result;
  for (const [name, def] of Object.entries(inputs)) {
    result[name] = normalizeType(def);
  }
  return result;
}

function normalizeType(def) {
  if (!def || typeof def !== "object") {
    return { type: typeof def === "string" ? def : "any" };
  }
  const t = typeof def.type === "string" ? def.type.toLowerCase() : "any";
  const out = { type: t };
  if (def.format) out.format = def.format;
  if (def.items) out.items = normalizeType(def.items);
  return out;
}

// ---------------------------------------------------------------------------
// Type matching and coercion
// ---------------------------------------------------------------------------

/**
 * Strict type equality, ignoring nullability. Formats must also match when
 * both sides declare one.
 */
export function typeMatches(a, b) {
  if (!a || !b) return false;
  const at = String(a.type || "any").toLowerCase();
  const bt = String(b.type || "any").toLowerCase();
  if (at === "any" || bt === "any") return true;
  if (at !== bt) return false;
  if (a.format && b.format && a.format !== b.format) return false;
  if (at === "array" && a.items && b.items) {
    return typeMatches(a.items, b.items);
  }
  return true;
}

/**
 * Infer whether an output type can feed an input type, either directly or
 * via a recognized coercion. Returns `{ compatible, conversion? }`.
 */
export function inferTypeCompatibility(outputType, inputType) {
  const a = normalizeType(outputType);
  const b = normalizeType(inputType);

  if (typeMatches(a, b)) return { compatible: true };

  const at = a.type;
  const bt = b.type;

  // any wildcard
  if (at === "any" || bt === "any") return { compatible: true };

  // string <-> number
  if (at === "string" && bt === "number") return { compatible: true, conversion: "string->number" };
  if (at === "number" && bt === "string") return { compatible: true, conversion: "number->string" };
  if (at === "string" && bt === "integer") return { compatible: true, conversion: "string->integer" };
  if (at === "integer" && bt === "string") return { compatible: true, conversion: "integer->string" };
  if (at === "integer" && bt === "number") return { compatible: true };
  if (at === "number" && bt === "integer") return { compatible: true, conversion: "number->integer" };

  // boolean <-> string
  if (at === "boolean" && bt === "string") return { compatible: true, conversion: "boolean->string" };
  if (at === "string" && bt === "boolean") return { compatible: true, conversion: "string->boolean" };

  // array -> item (take first element)
  if (at === "array" && a.items) {
    const inner = inferTypeCompatibility(a.items, b);
    if (inner.compatible) {
      return { compatible: true, conversion: `array-first${inner.conversion ? "+" + inner.conversion : ""}` };
    }
  }

  // item -> array (wrap)
  if (bt === "array" && b.items) {
    const inner = inferTypeCompatibility(a, b.items);
    if (inner.compatible) {
      return { compatible: true, conversion: `wrap-array${inner.conversion ? "+" + inner.conversion : ""}` };
    }
  }

  // object <-> string (json stringify / parse)
  if (at === "object" && bt === "string") return { compatible: true, conversion: "object->json" };
  if (at === "string" && bt === "object") return { compatible: true, conversion: "json->object" };

  return { compatible: false };
}

/**
 * Apply a recognized conversion to a runtime value. Unknown conversions pass
 * the value through unchanged.
 */
export function coerceTypes(value, fromType, toType) {
  const compat = inferTypeCompatibility(fromType, toType);
  if (!compat.compatible) return value;
  if (!compat.conversion) return value;

  const parts = compat.conversion.split("+");
  let v = value;
  for (const step of parts) {
    v = applyConversion(v, step);
  }
  return v;
}

function applyConversion(value, step) {
  switch (step) {
    case "string->number":
    case "string->integer": {
      const n = Number(value);
      return Number.isFinite(n) ? (step === "string->integer" ? Math.trunc(n) : n) : value;
    }
    case "number->string":
    case "integer->string":
      return String(value);
    case "number->integer":
      return Math.trunc(Number(value));
    case "boolean->string":
      return value ? "true" : "false";
    case "string->boolean":
      return value === "true" || value === "1" || value === true;
    case "array-first":
      return Array.isArray(value) ? value[0] : value;
    case "wrap-array":
      return Array.isArray(value) ? value : [value];
    case "object->json":
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    case "json->object":
      try {
        return typeof value === "string" ? JSON.parse(value) : value;
      } catch {
        return value;
      }
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// ToolGraph class
// ---------------------------------------------------------------------------

/**
 * A directed graph of tools connected by type-compatible input/output edges.
 * Designed for small-to-medium tool catalogs (hundreds of tools), not
 * millions. All operations are O(V+E) or better.
 */
export class ToolGraph {
  constructor() {
    /** @type {Map<string, { name: string, inputs: object, outputs: object }>} */
    this.tools = new Map();
    /** @type {Array<{ from: string, to: string, fromOutput: string, toInput: string, conversion?: string }>} */
    this.edges = [];
  }

  /**
   * Register a tool in the graph.
   * @param {{ name: string, inputs?: object, outputs?: object, parameters?: object, returns?: object }} toolDef
   */
  addTool(toolDef) {
    if (!toolDef || typeof toolDef.name !== "string" || !toolDef.name) {
      throw new Error("tool must have a name");
    }
    const { inputs, outputs } = extractIoTypes(toolDef);
    this.tools.set(toolDef.name, {
      name: toolDef.name,
      inputs,
      outputs,
    });
  }

  /** Remove a tool and any edges touching it. */
  removeTool(name) {
    this.tools.delete(name);
    this.edges = this.edges.filter((e) => e.from !== name && e.to !== name);
  }

  /**
   * Manually add an edge between two tools. Throws if either side is
   * unknown or the connected types are incompatible.
   */
  addEdge(fromTool, toTool, fromOutput = "output", toInput) {
    const a = this.tools.get(fromTool);
    const b = this.tools.get(toTool);
    if (!a) throw new Error(`unknown tool ${fromTool}`);
    if (!b) throw new Error(`unknown tool ${toTool}`);

    // If toInput not provided, use the first compatible input.
    let inputName = toInput;
    let compat;
    if (!inputName) {
      for (const [name, def] of Object.entries(b.inputs)) {
        const c = inferTypeCompatibility(a.outputs, def);
        if (c.compatible) {
          inputName = name;
          compat = c;
          break;
        }
      }
      if (!inputName) throw new Error(`no compatible input on ${toTool} for output of ${fromTool}`);
    } else {
      const def = b.inputs[inputName];
      if (!def) throw new Error(`input ${inputName} not found on ${toTool}`);
      compat = inferTypeCompatibility(a.outputs, def);
      if (!compat.compatible) {
        throw new Error(`types incompatible: ${fromTool}.${fromOutput} -> ${toTool}.${inputName}`);
      }
    }

    // Avoid duplicate edges.
    if (this.edges.some((e) => e.from === fromTool && e.to === toTool && e.toInput === inputName)) {
      return;
    }
    this.edges.push({
      from: fromTool,
      to: toTool,
      fromOutput,
      toInput: inputName,
      conversion: compat.conversion,
    });
  }

  /**
   * Infer every valid edge between currently registered tools using type
   * compatibility. Returns the number of edges added.
   */
  autoConnect() {
    this.edges = [];
    let added = 0;
    for (const [fromName, fromDef] of this.tools) {
      for (const [toName, toDef] of this.tools) {
        if (fromName === toName) continue;
        for (const [inputName, inputType] of Object.entries(toDef.inputs)) {
          const compat = inferTypeCompatibility(fromDef.outputs, inputType);
          if (compat.compatible) {
            this.edges.push({
              from: fromName,
              to: toName,
              fromOutput: "output",
              toInput: inputName,
              conversion: compat.conversion,
            });
            added++;
          }
        }
      }
    }
    return added;
  }

  hasEdge(from, to) {
    return this.edges.some((e) => e.from === from && e.to === to);
  }

  /** Tools whose outputs feed into `toolName`. */
  getDependencies(toolName) {
    const set = new Set();
    for (const e of this.edges) {
      if (e.to === toolName) set.add(e.from);
    }
    return [...set];
  }

  /** Tools that consume `toolName`'s output. */
  getDependents(toolName) {
    const set = new Set();
    for (const e of this.edges) {
      if (e.from === toolName) set.add(e.to);
    }
    return [...set];
  }

  /**
   * Kahn's topological sort. Throws on cycles.
   * @returns {string[]} tool names in execution order
   */
  topoSort() {
    const inDegree = new Map();
    for (const name of this.tools.keys()) inDegree.set(name, 0);
    for (const e of this.edges) {
      if (e.from === e.to) continue; // self loops ignored for topo
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    }

    const queue = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name);
    }
    queue.sort();

    const order = [];
    while (queue.length > 0) {
      const n = queue.shift();
      order.push(n);
      const next = [];
      for (const e of this.edges) {
        if (e.from !== n || e.from === e.to) continue;
        const remaining = (inDegree.get(e.to) || 0) - 1;
        inDegree.set(e.to, remaining);
        if (remaining === 0) next.push(e.to);
      }
      next.sort();
      queue.push(...next);
    }

    if (order.length !== this.tools.size) {
      throw new Error("graph contains a cycle");
    }
    return order;
  }

  /** Quick cycle detection via depth-first search. */
  hasCycle() {
    const white = new Set(this.tools.keys());
    const gray = new Set();
    const black = new Set();

    const adj = new Map();
    for (const name of this.tools.keys()) adj.set(name, []);
    for (const e of this.edges) {
      if (e.from === e.to) return true;
      adj.get(e.from)?.push(e.to);
    }

    const visit = (node) => {
      if (black.has(node)) return false;
      if (gray.has(node)) return true;
      white.delete(node);
      gray.add(node);
      for (const nb of adj.get(node) || []) {
        if (visit(nb)) return true;
      }
      gray.delete(node);
      black.add(node);
      return false;
    };

    for (const name of [...white]) {
      if (visit(name)) return true;
    }
    return false;
  }

  /** Tool count. */
  size() {
    return this.tools.size;
  }

  /** Serialize to a plain object for persistence. */
  toJSON() {
    return {
      tools: [...this.tools.values()],
      edges: this.edges.slice(),
    };
  }

  /** Rehydrate a graph from `toJSON` output. */
  static fromJSON(obj) {
    const g = new ToolGraph();
    if (!obj || typeof obj !== "object") return g;
    for (const t of obj.tools || []) {
      g.tools.set(t.name, {
        name: t.name,
        inputs: t.inputs || {},
        outputs: t.outputs || { type: "any" },
      });
    }
    for (const e of obj.edges || []) g.edges.push({ ...e });
    return g;
  }
}

// ---------------------------------------------------------------------------
// Pipeline building / validation / execution
// ---------------------------------------------------------------------------

/**
 * Build the shortest pipeline whose terminal tool produces a value
 * compatible with `goal`. Uses breadth-first search over edges.
 *
 * @param {{ type: string, format?: string } | string} goal
 * @param {Array<object> | ToolGraph} availableTools
 * @returns {string[] | null}
 */
export function buildPipeline(goal, availableTools) {
  const graph = availableTools instanceof ToolGraph ? availableTools : toolGraphFromDefs(availableTools);
  if (graph.size() === 0) return null;
  if (graph.hasCycle()) {
    // BFS is still safe, cycles just waste edges
  }

  const goalType = typeof goal === "string" ? { type: goal } : goal || { type: "any" };

  // Find all tools whose output satisfies the goal. Among those, return the
  // one reachable from a source in the fewest hops.
  const sources = [];
  for (const [name, def] of graph.tools) {
    const inputCount = Object.keys(def.inputs).length;
    if (inputCount === 0) sources.push(name);
  }
  if (sources.length === 0) {
    // Allow any tool as entry if none are zero-input
    sources.push(...graph.tools.keys());
  }

  let best = null;
  for (const source of sources) {
    const visited = new Map(); // name -> path
    visited.set(source, [source]);
    const queue = [source];
    while (queue.length > 0) {
      const current = queue.shift();
      const path = visited.get(current);
      const def = graph.tools.get(current);
      if (def && inferTypeCompatibility(def.outputs, goalType).compatible) {
        if (!best || path.length < best.length) best = path;
        continue;
      }
      for (const e of graph.edges) {
        if (e.from !== current) continue;
        if (visited.has(e.to)) continue;
        const next = [...path, e.to];
        visited.set(e.to, next);
        queue.push(e.to);
      }
    }
  }

  return best;
}

function toolGraphFromDefs(defs) {
  const g = new ToolGraph();
  if (!Array.isArray(defs)) return g;
  for (const d of defs) g.addTool(d);
  g.autoConnect();
  return g;
}

/**
 * Validate a proposed pipeline against a graph. Checks existence of each
 * tool, that each adjacent pair has a compatible edge, and that the
 * pipeline contains no cycles.
 */
export function validatePipeline(pipeline, graph) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return { valid: false, errors: ["pipeline is empty"] };
  }
  const errors = [];
  const seen = new Set();
  for (const name of pipeline) {
    if (!graph.tools.has(name)) errors.push(`unknown tool: ${name}`);
    if (seen.has(name)) errors.push(`cycle: ${name} appears more than once`);
    seen.add(name);
  }
  for (let i = 0; i < pipeline.length - 1; i++) {
    const a = pipeline[i];
    const b = pipeline[i + 1];
    const aDef = graph.tools.get(a);
    const bDef = graph.tools.get(b);
    if (!aDef || !bDef) continue;
    let ok = false;
    for (const def of Object.values(bDef.inputs)) {
      if (inferTypeCompatibility(aDef.outputs, def).compatible) {
        ok = true;
        break;
      }
    }
    if (!ok && Object.keys(bDef.inputs).length > 0) {
      errors.push(`incompatible edge: ${a} -> ${b}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Execute a pipeline by invoking `executor(toolName, input)` for each step.
 * Each step receives the previous step's output as its input.
 *
 * @param {string[]} pipeline
 * @param {*} input
 * @param {(toolName: string, input: any) => Promise<any>} executor
 */
export async function executePipeline(pipeline, input, executor) {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return { output: input, steps: [] };
  }
  if (typeof executor !== "function") {
    throw new Error("executor must be a function");
  }
  const steps = [];
  let current = input;
  for (const tool of pipeline) {
    const started = Date.now();
    const out = await executor(tool, current);
    const durationMs = Date.now() - started;
    steps.push({ tool, input: current, output: out, durationMs });
    current = out;
  }
  return { output: current, steps };
}

// ---------------------------------------------------------------------------
// Visualization
// ---------------------------------------------------------------------------

/** Convert a graph to a Mermaid flowchart representation. */
export function graphToMermaid(graph) {
  if (!(graph instanceof ToolGraph)) {
    throw new Error("graphToMermaid requires a ToolGraph");
  }
  const lines = ["graph LR"];
  for (const name of graph.tools.keys()) {
    const id = mermaidId(name);
    lines.push(`  ${id}["${name}"]`);
  }
  for (const e of graph.edges) {
    const a = mermaidId(e.from);
    const b = mermaidId(e.to);
    const label = e.conversion ? `|${e.conversion}|` : "";
    lines.push(`  ${a} -->${label} ${b}`);
  }
  return lines.join("\n");
}

function mermaidId(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, "_");
}

// ---------------------------------------------------------------------------
// Cached pipelines (persistence)
// ---------------------------------------------------------------------------

function pipelinesPath() {
  return join(getDataDir(), "tool-graph", "pipelines.json");
}

async function loadPipelinesFile() {
  const data = await readJsonPath(pipelinesPath(), { _version: 1, items: {} });
  return data && typeof data.items === "object" && data.items !== null ? data.items : {};
}

async function savePipelinesFile(items) {
  await writeJsonPath(pipelinesPath(), { _version: 1, items });
}

/**
 * Persist a named pipeline for later retrieval. If a ToolGraph is provided,
 * its serialized form is stored alongside the pipeline for replay.
 */
export async function savePipeline(name, pipeline, graph = null) {
  if (!name || typeof name !== "string") throw new Error("name is required");
  if (!Array.isArray(pipeline)) throw new Error("pipeline must be an array");
  const items = await loadPipelinesFile();
  items[name] = {
    name,
    pipeline: [...pipeline],
    graph: graph instanceof ToolGraph ? graph.toJSON() : null,
    updatedAt: new Date().toISOString(),
  };
  await savePipelinesFile(items);
  return items[name];
}

export async function getPipeline(name) {
  const items = await loadPipelinesFile();
  return items[name] || null;
}

export async function listPipelines() {
  const items = await loadPipelinesFile();
  return Object.values(items);
}

export async function deletePipeline(name) {
  const items = await loadPipelinesFile();
  if (!(name in items)) return false;
  delete items[name];
  await savePipelinesFile(items);
  return true;
}
