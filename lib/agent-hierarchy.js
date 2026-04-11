/**
 * Phase 47.1: Hierarchical agent orchestration.
 * Manager agents break down a root task into subtasks and delegate
 * each subtask to a specialized worker agent. Results bubble back up
 * the tree and are synthesized into a final response.
 */
import { randomUUID } from "crypto";
import { getWorker, listWorkers } from "./worker-agents.js";
import { getToolsForNames, runTool } from "./agent-tools.js";

const DEFAULT_MAX_DEPTH = Math.max(1, Number(process.env.AGENT_HIERARCHY_MAX_DEPTH) || 3);
const DEFAULT_TIMEOUT_MS = Math.max(1_000, Number(process.env.AGENT_HIERARCHY_TIMEOUT_MS) || 60_000);
const DEFAULT_WORKER_ITERATIONS = Math.max(1, Number(process.env.AGENT_HIERARCHY_WORKER_ITERATIONS) || 5);

/** In-memory store of finished hierarchy runs (root TaskNode keyed by runId). */
const RUN_STORE = new Map();
const RUN_STORE_LIMIT = Math.max(10, Number(process.env.AGENT_HIERARCHY_STORE_MAX) || 50);

export const MANAGER_SYSTEM_PROMPT = `You are a manager agent that coordinates specialized worker agents.
When given a task:
1. Break it into subtasks
2. Assign each subtask to the most appropriate worker agent
3. Collect results from workers
4. Synthesize final response
Available workers will be listed in each message.`;

/**
 * A node in the hierarchical execution tree.
 * Represents a task assigned to a manager (root or intermediate) or a worker (leaf).
 */
export class TaskNode {
  /**
   * @param {string} task - Task description
   * @param {TaskNode | null} parent - Parent node (null for the root)
   */
  constructor(task, parent = null) {
    this.id = randomUUID();
    this.task = task;
    this.parent = parent;
    this.children = [];
    this.workerId = null;
    this.result = null;
    this.error = null;
    this.startedAt = Date.now();
    this.finishedAt = null;
  }

  assignWorker(workerId) {
    this.workerId = workerId || null;
  }

  setResult(result) {
    this.result = typeof result === "string" ? result : result == null ? null : String(result);
    this.finishedAt = Date.now();
  }

  setError(message) {
    this.error = typeof message === "string" ? message : String(message || "unknown error");
    this.finishedAt = Date.now();
  }

  addChild(child) {
    if (!(child instanceof TaskNode)) {
      throw new Error("addChild requires a TaskNode");
    }
    child.parent = this;
    this.children.push(child);
    return child;
  }

  getDepth() {
    let depth = 0;
    let cursor = this.parent;
    while (cursor) {
      depth++;
      cursor = cursor.parent;
    }
    return depth;
  }

  getAncestors() {
    const out = [];
    let cursor = this.parent;
    while (cursor) {
      out.push(cursor);
      cursor = cursor.parent;
    }
    return out;
  }

  /** Serializes the node and its children to a plain object (no parent cycles). */
  toJSON() {
    return {
      id: this.id,
      task: this.task,
      workerId: this.workerId,
      result: this.result,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.finishedAt ? this.finishedAt - this.startedAt : null,
      children: this.children.map((c) => c.toJSON()),
    };
  }
}

/**
 * Create a manager agent configuration.
 * Validates worker ids, applies defaults for depth and timeout.
 * @param {{ name?: string, workers?: string[], maxDepth?: number, timeoutMs?: number }} config
 * @returns {{ id: string, name: string, workers: string[], maxDepth: number, timeoutMs: number }}
 */
export async function createManagerAgent(config = {}) {
  const workers = Array.isArray(config.workers) && config.workers.length > 0
    ? config.workers
    : listWorkers().map((w) => w.id);

  for (const wid of workers) {
    if (!getWorker(wid)) {
      throw new Error(`unknown worker id: ${wid}`);
    }
  }

  const maxDepth = Number.isFinite(config.maxDepth)
    ? Math.max(1, Math.min(10, Math.floor(config.maxDepth)))
    : DEFAULT_MAX_DEPTH;
  const timeoutMs = Number.isFinite(config.timeoutMs)
    ? Math.max(1_000, Math.floor(config.timeoutMs))
    : DEFAULT_TIMEOUT_MS;

  return {
    id: randomUUID(),
    name: typeof config.name === "string" && config.name.trim() ? config.name.trim() : "manager",
    workers,
    maxDepth,
    timeoutMs,
  };
}

function buildAvailableWorkersMessage(workerIds) {
  const lines = workerIds.map((wid) => {
    const w = getWorker(wid);
    if (!w) return `- ${wid}`;
    const desc = w.description || w.systemPrompt.split("\n")[0];
    return `- ${w.id}: ${desc}`;
  });
  return `Available workers:\n${lines.join("\n")}`;
}

/**
 * Ask the manager LLM how to split a task into subtasks and which worker to assign each one to.
 * Falls back to a deterministic plan when no backend is available so the function can be exercised
 * in tests and dry runs.
 *
 * @param {string} managerId
 * @param {string} task
 * @param {object} context
 * @returns {Promise<{ subtasks: string[], assignments: { task: string, workerId: string }[] }>}
 */
export async function delegateTask(managerId, task, context = {}) {
  const workerIds = Array.isArray(context.workers) && context.workers.length > 0
    ? context.workers
    : listWorkers().map((w) => w.id);

  const systemMessage = `${MANAGER_SYSTEM_PROMPT}\n\n${buildAvailableWorkersMessage(workerIds)}`;

  if (typeof context.backendFetch === "function" && typeof context.buildProxyConfig === "function") {
    const config = context.buildProxyConfig(context.model || "default");
    const url = `${config.baseUrl}${config.path}`;
    const body = {
      model: context.model || "default",
      messages: [
        { role: "system", content: systemMessage },
        {
          role: "user",
          content: `Manager id: ${managerId}\nTask: ${task}\n\nReply with a JSON object of the form {"subtasks":[{"task":"...","worker":"researcher"}, ...]}. Do not include prose outside the JSON.`,
        },
      ],
      stream: false,
    };

    try {
      const resp = await context.backendFetch(url, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content || "";
        const parsed = parsePlanFromText(content, workerIds);
        if (parsed) return parsed;
      }
    } catch {
      // fall through to heuristic plan
    }
  }

  // Heuristic fallback: assign the whole task to the first available worker.
  const fallbackWorker = workerIds[0] || "researcher";
  return {
    subtasks: [task],
    assignments: [{ task, workerId: fallbackWorker }],
  };
}

function parsePlanFromText(text, workerIds) {
  if (typeof text !== "string" || !text.trim()) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = Array.isArray(parsed?.subtasks) ? parsed.subtasks : null;
  if (!list || list.length === 0) return null;
  const allowed = new Set(workerIds);
  const assignments = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const t = typeof item.task === "string" ? item.task.trim() : "";
    const w = typeof item.worker === "string" ? item.worker.trim() : "";
    if (!t || !w) continue;
    const worker = allowed.has(w) ? w : workerIds[0];
    assignments.push({ task: t, workerId: worker });
  }
  if (assignments.length === 0) return null;
  return {
    subtasks: assignments.map((a) => a.task),
    assignments,
  };
}

/**
 * Run a worker agent on a single subtask. Uses the worker's allowed tools.
 * Falls back to a dry-run response when no backend is available.
 *
 * @param {object} worker - Worker definition from worker-agents.js
 * @param {string} task
 * @param {object} context
 */
async function runWorker(worker, task, context = {}) {
  const maxIterations = Math.min(
    DEFAULT_WORKER_ITERATIONS,
    Number.isFinite(worker.maxIterations) ? worker.maxIterations : DEFAULT_WORKER_ITERATIONS
  );

  if (typeof context.backendFetch !== "function" || typeof context.buildProxyConfig !== "function") {
    return {
      response: `[dry-run] worker ${worker.id} would handle: ${task.slice(0, 200)}`,
      toolCalls: [],
    };
  }

  const config = context.buildProxyConfig(context.model || "default");
  const url = `${config.baseUrl}${config.path}`;
  const toolSchemas = worker.tools.length > 0 ? getToolsForNames(worker.tools) : [];
  const toolCalls = [];

  const messages = [
    { role: "system", content: worker.systemPrompt },
    { role: "user", content: task },
  ];

  const toolCtx = {
    allowExecution: false,
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    workspace: context.workspaceId || "default",
  };

  let iteration = 0;
  let response = "";
  while (iteration < maxIterations) {
    iteration++;
    const body = {
      model: context.model || "default",
      messages,
      stream: false,
      ...(toolSchemas.length > 0 ? { tools: toolSchemas, tool_choice: "auto" } : {}),
    };
    let data;
    try {
      const resp = await context.backendFetch(url, {
        method: "POST",
        headers: config.headers,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        return { response: `[backend-error] ${resp.status}`, toolCalls };
      }
      data = await resp.json();
    } catch (err) {
      return { response: `[worker-error] ${err.message}`, toolCalls };
    }
    const msg = data?.choices?.[0]?.message;
    if (!msg) {
      return { response: "(no response from worker)", toolCalls };
    }
    const content = typeof msg.content === "string" ? msg.content : "";
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (calls.length === 0) {
      response = content || "(empty worker response)";
      break;
    }
    messages.push(msg);
    for (const tc of calls) {
      const name = tc.function?.name;
      let args;
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        args = {};
      }
      let result;
      try {
        result = await runTool(name, args, toolCtx);
        toolCalls.push({ name, args, ok: true });
      } catch (err) {
        result = { content: JSON.stringify({ error: err.message }), ok: false };
        toolCalls.push({ name, args, ok: false, error: err.message });
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: typeof result.content === "string" ? result.content : JSON.stringify(result),
      });
    }
  }
  if (!response) response = "(worker reached max iterations without final response)";
  return { response, toolCalls };
}

/**
 * Execute a hierarchical agent run.
 *
 * @param {string} rootTask
 * @param {{
 *   manager?: object,
 *   workers?: string[],
 *   maxDepth?: number,
 *   timeoutMs?: number,
 *   model?: string,
 *   workspaceId?: string,
 *   backendFetch?: Function,
 *   buildProxyConfig?: Function,
 * }} options
 */
export async function executeHierarchy(rootTask, options = {}) {
  if (!rootTask || typeof rootTask !== "string" || !rootTask.trim()) {
    throw new Error("rootTask is required");
  }

  const manager = options.manager || (await createManagerAgent({
    workers: options.workers,
    maxDepth: options.maxDepth,
    timeoutMs: options.timeoutMs,
  }));

  const startedAt = Date.now();
  const root = new TaskNode(rootTask, null);
  let agentCount = 0;
  let timedOut = false;

  const deadline = startedAt + manager.timeoutMs;

  const recurse = async (node) => {
    if (timedOut) return;
    if (Date.now() > deadline) {
      timedOut = true;
      node.setError("timeout");
      return;
    }
    const depth = node.getDepth();
    if (depth >= manager.maxDepth) {
      // At the leaf manager level: assign the node directly to the first allowed worker.
      const workerId = manager.workers[0];
      const worker = getWorker(workerId);
      if (!worker) {
        node.setError(`unknown worker: ${workerId}`);
        return;
      }
      node.assignWorker(workerId);
      const { response } = await runWorker(worker, node.task, options);
      agentCount++;
      node.setResult(response);
      return;
    }

    let plan;
    try {
      plan = await delegateTask(manager.id, node.task, {
        ...options,
        workers: manager.workers,
      });
    } catch (err) {
      node.setError(`delegation failed: ${err.message}`);
      return;
    }

    // If the manager assigns the entire task to a single worker, run it as a leaf.
    if (plan.assignments.length === 1 && plan.assignments[0].task === node.task) {
      const { workerId } = plan.assignments[0];
      const worker = getWorker(workerId);
      if (!worker) {
        node.setError(`unknown worker: ${workerId}`);
        return;
      }
      node.assignWorker(workerId);
      const { response } = await runWorker(worker, node.task, options);
      agentCount++;
      node.setResult(response);
      return;
    }

    for (const assignment of plan.assignments) {
      if (timedOut || Date.now() > deadline) {
        timedOut = true;
        break;
      }
      const child = node.addChild(new TaskNode(assignment.task, node));
      const worker = getWorker(assignment.workerId);
      if (!worker) {
        child.setError(`unknown worker: ${assignment.workerId}`);
        continue;
      }
      child.assignWorker(assignment.workerId);
      const { response } = await runWorker(worker, assignment.task, options);
      agentCount++;
      child.setResult(response);
    }

    if (timedOut) {
      node.setError("timeout");
      return;
    }

    // Synthesize the manager-level response from child results.
    const synthesized = node.children
      .map((c, i) => `(${i + 1}) [${c.workerId || "?"}] ${c.result || c.error || ""}`)
      .join("\n");
    node.setResult(synthesized || "(no child results)");
  };

  await recurse(root);

  const totalTime = Date.now() - startedAt;
  const runId = root.id;

  storeRun(runId, root);

  return {
    runId,
    result: root.result,
    error: root.error,
    tree: root.toJSON(),
    totalTime,
    agentCount,
    timedOut,
  };
}

function storeRun(runId, root) {
  RUN_STORE.set(runId, root);
  if (RUN_STORE.size > RUN_STORE_LIMIT) {
    const oldest = RUN_STORE.keys().next().value;
    if (oldest) RUN_STORE.delete(oldest);
  }
}

/**
 * Reconstruct the execution tree for a previous hierarchical run.
 * Returns null when the run is unknown (e.g., evicted from the in-memory cache).
 * @param {string} rootRunId
 */
export async function getHierarchyTree(rootRunId) {
  const root = RUN_STORE.get(rootRunId);
  if (!root) return null;
  return root.toJSON();
}

/**
 * Format a serialized hierarchy tree for display.
 * @param {object} tree - Result of TaskNode.toJSON()
 * @param {"markdown" | "json"} [format]
 */
export function formatHierarchyResult(tree, format = "markdown") {
  if (!tree) return "";
  if (format === "json") return JSON.stringify(tree, null, 2);

  const lines = [];
  const walk = (node, depth) => {
    const indent = "  ".repeat(depth);
    const tag = node.workerId ? `[${node.workerId}]` : "[manager]";
    lines.push(`${indent}- ${tag} ${node.task}`);
    if (node.result) {
      lines.push(`${indent}  -> ${node.result}`);
    } else if (node.error) {
      lines.push(`${indent}  !! ${node.error}`);
    }
    for (const child of node.children || []) walk(child, depth + 1);
  };
  walk(tree, 0);
  return lines.join("\n");
}

/** Test helper. Clears the run store. */
export function _clearRunStore() {
  RUN_STORE.clear();
}
