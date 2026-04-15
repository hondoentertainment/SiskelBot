// @ts-check
/**
 * Phase 15: Agentic Autonomy Mode - Tool definitions for the LLM.
 * OpenAI-compatible tool schema and tool execution.
 * Phases 82, 85, 88, 89: workspace memory tools, allowlisted fetch, tool hooks, deployment tool allowlist.
 * @module agent-tools
 */
import { executeStep, appendAuditLog } from "./action-executor.js";
import { emitEvent } from "./webhooks.js";
import { recordPolicyDenial } from "./metrics.js";
import { agentSessionApiEnabled, getAgentSession, updateAgentSessionPlan } from "./agent-session.js";
import { invokeBeforeToolCall, invokeAfterToolCall } from "./agent-hooks.js";
import { appendWorkspaceMemoryFact } from "./workspace-memory-tool.js";
import { loadWorkspaceAgentSettings } from "./workspace-agent-settings.js";
import { sanitizeUserId } from "./storage.js";
import { agentFetchAllowedUrl } from "./agent-fetch-url.js";
import {
  search as knowledgeSearch,
  list as knowledgeList,
  semanticSearch as knowledgeSemanticSearch,
  getDocumentById,
} from "./knowledge-store.js";
import * as storage from "./storage.js";
import { citationsRequired } from "./grounding.js";
import { executeChainToolsMeta } from "./tool-chaining.js";
import { getWorkspaceKnowledgeGraph } from "./knowledge-graph-store.js";
import { workspaceReadFile } from "./workspace-fs-tools.js";
import { getRequestId } from "./request-context.js";
import { globalToolDiscovery } from "./tool-discovery.js";
import {
  findRelatedReasoning,
  getReasoningChain,
} from "./reasoning-memory.js";
import { executeConsensus } from "./agent-consensus.js";
import { beamSearch, dfsSearch, bfsSearch, extractAnswer as totExtractAnswer } from "./tree-of-thought.js";
import {
  verify as verificationVerify,
  defaultVerifier,
  mathVerifier,
  codeVerifier,
  formatVerifier,
  factVerifier,
} from "./verification-loop.js";
import { runSelfConsistency } from "./self-consistency.js";

const WORKSPACE = "default";
const CONTEXT_DOC_MAX_CHARS = Math.max(4096, Number(process.env.AGENT_CONTEXT_DOC_MAX_CHARS) || 48_000);
let warnedEmptyToolsAllowlist = false;

/** @type {SiskelBot.ToolDefinition[]} OpenAI-compatible tools array for function calling. */
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "execute_step",
      description: "Execute a build, deploy, or other recipe step. Use for running npm build, Vercel deploy, etc.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "Action type: build, deploy, or copy" },
          payload: {
            type: "object",
            description: "Action-specific payload (e.g. { command: 'npm run build' } for build)",
            additionalProperties: true,
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_context",
      description: "Search the knowledge base / indexed context documents by query. Returns relevant snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for context documents" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_context",
      description: "List titles of all indexed context documents. Use to see what's available before searching.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "semantic_search_context",
      description:
        "Semantic / meaning-based search over indexed documents (requires embeddings on docs and OPENAI_API_KEY). Use for paraphrases, concepts, or when keyword search returns little. Complement with search_context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query for similarity search" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_context_document",
      description:
        "Load full text of a knowledge document by id (from search_context, semantic_search_context, or list_context). Use after search when snippets are insufficient.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Document uuid from the knowledge index" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_recipes",
      description:
        "List saved recipes in the workspace (name, id, step counts). Use before get_recipe when the user did not specify an exact recipe name.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recipe",
      description: "Get a saved recipe by name. Returns the recipe's steps for execution or inspection.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Recipe name (exact or partial match)" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_workspace_fact",
      description:
        "Append one short factual line to this workspace's approved memory (persists in agent-settings). Use for durable facts the user asked to remember.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "Single concise fact (one sentence or line)" },
        },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_workspace_memory",
      description: "List current approved workspace memory snippets (including agent-remembered lines). Read-only.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_allowed_url",
      description:
        "HTTP GET a URL and return extracted text when the host is allowlisted (AGENT_FETCH_ALLOWLIST or KNOWLEDGE_URL_ALLOWLIST). For live docs, not secrets.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "https URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "chain_tools",
      description:
        "Execute a sequence of tools where each receives the previous tool's result. Use for multi-step operations that don't need LLM reasoning between steps. Reference prior output with {{tool.previous.output}} in args.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "Ordered list of tool calls. Each step can reference {{tool.previous.output}} in its args.",
            items: {
              type: "object",
              properties: {
                tool: { type: "string", description: "Tool name to invoke" },
                args: { type: "object", description: "Arguments for the tool", additionalProperties: true },
              },
              required: ["tool"],
            },
          },
        },
        required: ["steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recommend_tools",
      description:
        "Get tool recommendations for a given task based on past effectiveness learned by the tool discovery system. Returns up to five tools ranked by success rate and usage volume for the inferred task type.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Natural-language description of the task to find recommended tools for",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge_graph",
      description:
        "Search the knowledge graph for entities and their relationships across documents. Use to find connections between concepts, people, technologies, and organizations mentioned in the knowledge base.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Entity name or keyword to search for" },
          type: {
            type: "string",
            description: "Filter by entity type: person, organization, concept, tool, technology, location, event, other",
          },
          entityId: {
            type: "string",
            description: "If provided, get neighbors of this entity instead of searching by name",
          },
          depth: {
            type: "number",
            description: "Traversal depth for neighbor lookup (default 1, max 3)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_reasoning",
      description:
        "Recall the agent's own past reasoning chains from earlier conversations in this workspace. Use when you want to check how a previous conclusion was reached, whether you've already answered a similar question, or to avoid repeating investigations. Provide a query to search past steps, or a conversationId to fetch a specific chain.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword query to search past reasoning (premise + inference + conclusion).",
          },
          conversationId: {
            type: "string",
            description: "If provided, return the full reasoning chain for this conversation instead of searching.",
          },
          limit: {
            type: "number",
            description: "Maximum number of related reasoning steps to return (default 10, max 50).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consensus_query",
      description:
        "Query multiple models for consensus on an answer. Runs the same prompt against several agents and aggregates the responses via majority vote (default), weighted vote, ranked choice, or LLM judge. Use when accuracy matters more than latency, e.g. factual lookups, controversial questions, or high-stakes decisions. Returns the consensus answer and a confidence score in [0,1].",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The prompt or question to send to each agent" },
          minAgents: {
            type: "number",
            description: "Minimum number of agents that must respond successfully (quorum). Defaults to 2.",
          },
          strategy: {
            type: "string",
            description:
              "Aggregation strategy: 'majority_vote' (default), 'weighted', 'llm_judge', or 'ranked_choice'.",
          },
          models: {
            type: "array",
            description:
              "Optional list of model identifiers to use (one agent per model). If omitted, defaults to a small ensemble of the configured backend's available models.",
            items: { type: "string" },
          },
        },
        required: ["prompt"],
      },
    },
  },
  ...(agentSessionApiEnabled()
    ? [
        {
          type: "function",
          function: {
            name: "update_agent_session_plan",
            description:
              "Save or update the durable plan for this agent run's session (requires agentOptions.sessionId). Use to persist a task DAG (planDag) and/or human-readable planSummary.",
            parameters: {
              type: "object",
              properties: {
                planSummary: { type: "string", description: "Short summary of the current plan" },
                planDag: { type: "object", description: "Structured plan DAG", additionalProperties: true },
              },
            },
          },
        },
      ]
    : []),
  ...(process.env.WORKSPACE_FILE_TOOLS === "1"
    ? [
        {
          type: "function",
          function: {
            name: "workspace_read_file",
            description:
              "Read a file from the workspace filesystem (requires WORKSPACE_FILE_TOOLS=1 and WORKSPACE_ROOT). Returns file content as UTF-8 text.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Relative file path within the workspace root" },
              },
              required: ["path"],
            },
          },
        },
      ]
    : []),
  ...(process.env.AGENT_REASONING_TOOLS === "1"
    ? [
        {
          type: "function",
          function: {
            name: "tree_of_thought_plan",
            description:
              "Explore a problem by generating and scoring a tree of candidate reasoning steps (beam/dfs/bfs search). Use when the task benefits from considering multiple approaches before committing, e.g. multi-step planning, puzzles, or decomposing an ambiguous goal. Returns the best reasoning path and an extracted answer. Deterministic mock generator is used when no LLM generator is wired.",
            parameters: {
              type: "object",
              properties: {
                task: { type: "string", description: "Root task or question to reason about" },
                depth: { type: "number", description: "Maximum depth to explore (default 3, max 6)" },
                beamWidth: { type: "number", description: "Beam width when strategy=beam (default 3, max 8)" },
                k: { type: "number", description: "Candidate children per node (default 3, max 8)" },
                strategy: { type: "string", description: "Search strategy: 'beam' (default), 'dfs', or 'bfs'" },
              },
              required: ["task"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "verify_output",
            description:
              "Critique and score a candidate answer against a task using a rule-based verifier. Strategies: 'default' (coherence heuristics), 'math' (arithmetic correctness), 'code' (balanced braces / structural JS checks), 'format' (JSON schema validation, pass schema), 'fact' (substring support against a knowledge base array). Use when you need a sanity check before returning an answer to the user, or to decide whether to refine.",
            parameters: {
              type: "object",
              properties: {
                task: { type: "string", description: "The original task or question" },
                answer: { type: "string", description: "Candidate answer text to verify" },
                strategy: {
                  type: "string",
                  description: "Verifier to use: 'default' | 'math' | 'code' | 'format' | 'fact'",
                },
                schema: {
                  type: "object",
                  description: "JSON schema for strategy='format'",
                  additionalProperties: true,
                },
                knowledgeBase: {
                  type: "array",
                  description: "Array of strings or {text} entries for strategy='fact'",
                  items: { type: "object", additionalProperties: true },
                },
              },
              required: ["task", "answer"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "self_consistency",
            description:
              "Run the same task multiple times with a deterministic sampler and aggregate the answers via majority vote. Returns the winning answer with a confidence score in [0,1], vote breakdown, and uncertainty (entropy). Use for questions where sampling variance matters (e.g. numeric reasoning, multiple-choice) and you want agreement across attempts. Samples are produced by a deterministic local mock when no sampler is wired — callers should treat the confidence as a reference signal.",
            parameters: {
              type: "object",
              properties: {
                task: { type: "string", description: "Task or question to sample" },
                n: { type: "number", description: "Number of samples (default 5, max 15)" },
                format: {
                  type: "string",
                  description: "Answer format for extraction: 'auto' | 'number' | 'choice' | 'json' | 'boolean'",
                },
                samples: {
                  type: "array",
                  description:
                    "Optional pre-sampled answers. If provided, these are voted on directly (each item should be a string or {answer} object).",
                  items: { type: "object", additionalProperties: true },
                },
              },
              required: ["task"],
            },
          },
        },
      ]
    : []),
];

/**
 * Phase 89: Optional comma-separated allowlist (`AGENT_TOOLS_ALLOWLIST`). When set, only these tool names are exposed and executable.
 * @returns {Set<string>|null}
 */
export function parseAgentToolsAllowlistSet() {
  const raw = (process.env.AGENT_TOOLS_ALLOWLIST || "").trim();
  if (!raw) return null;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length ? new Set(names) : null;
}

/**
 * @param {Array<{ type: string; function: object }>} tools
 * @returns {Array<{ type: string; function: object }>}
 */
export function applyAgentToolsAllowlist(tools) {
  const allow = parseAgentToolsAllowlistSet();
  if (!allow || !Array.isArray(tools)) return Array.isArray(tools) ? tools : [];
  return tools.filter((t) => t?.function?.name && allow.has(t.function.name));
}

/** @returns {string[]|null} */
export function getAgentToolsAllowlistNames() {
  const s = parseAgentToolsAllowlistSet();
  return s ? [...s] : null;
}

/**
 * Client-supplied tools intersected with deployment allowlist (Phase 89).
 * @param {unknown} clientTools
 */
export function intersectClientToolsWithAllowlist(clientTools) {
  if (!Array.isArray(clientTools)) return [];
  return applyAgentToolsAllowlist(clientTools);
}

/**
 * Returns OpenAI-compatible tools array for chat completions.
 * @returns {Array<{ type: string; function: object }>}
 */
export function getToolsSchema() {
  const out = applyAgentToolsAllowlist(TOOLS);
  if (!warnedEmptyToolsAllowlist && parseAgentToolsAllowlistSet() && out.length === 0) {
    warnedEmptyToolsAllowlist = true;
    console.warn("[agent-tools] AGENT_TOOLS_ALLOWLIST matches no registered tools; agent mode will expose zero tools.");
  }
  return out;
}

/** @returns {string[]} */
export function getRegisteredToolNames() {
  return TOOLS.map((t) => t.function?.name).filter(Boolean);
}

/**
 * Intersect tool definitions with a workspace allowlist (empty / null = no extra filter).
 * @param {Array<{ type: string; function: object }>} tools
 * @param {string[]|null|undefined} allowedNames
 */
export function filterToolsByWorkspaceAllowlist(tools, allowedNames) {
  if (!Array.isArray(tools)) return [];
  if (!Array.isArray(allowedNames) || allowedNames.length === 0) return tools;
  const allow = new Set(allowedNames.map((x) => String(x).trim()).filter(Boolean));
  if (allow.size === 0) return tools;
  return tools.filter((t) => t?.function?.name && allow.has(t.function.name));
}

/**
 * Get tools filtered by name list (for swarm specialist subsets).
 * @param {string[]} names - Tool names (e.g. ["search_context", "list_context"])
 * @returns {Array<{ type: string; function: object }>}
 */
export function getToolsForNames(names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const set = new Set(names);
  const picked = TOOLS.filter((t) => t.function?.name && set.has(t.function.name));
  return applyAgentToolsAllowlist(picked);
}

/**
 * Execute a single tool call by name with before/after hooks.
 * @param {string} name - Registered tool name
 * @param {Record<string, any>} args - Parsed JSON arguments from the LLM
 * @param {SiskelBot.AgentContext} ctx - Execution context
 * @returns {Promise<SiskelBot.ToolResult>}
 */
export async function runTool(name, args, ctx = /** @type {any} */ ({})) {
  const before = await invokeBeforeToolCall(name, args, ctx);
  if (before.block) {
    const out = {
      content: JSON.stringify({
        ok: false,
        error: before.reason || "blocked by agent hook",
        _agent_hook: true,
      }),
    };
    await invokeAfterToolCall(name, args, out, ctx);
    return out;
  }
  const execArgs = before.args && typeof before.args === "object" ? before.args : args;

  let result;
  try {
    result = await runToolCore(name, execArgs, ctx);
  } catch (e) {
    result = { content: JSON.stringify({ ok: false, error: String(e?.message || e) }) };
  }
  await invokeAfterToolCall(name, execArgs, result, ctx);
  return result;
}

/**
 * Core tool execution logic (no hooks).
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {SiskelBot.AgentContext} ctx
 * @returns {Promise<SiskelBot.ToolResult>}
 */
async function runToolCore(name, args, ctx) {
  const allowSet = parseAgentToolsAllowlistSet();
  if (allowSet && !allowSet.has(name)) {
    return {
      content: JSON.stringify({
        ok: false,
        error: `Tool "${name}" is not allowed by AGENT_TOOLS_ALLOWLIST`,
        code: "TOOL_NOT_ALLOWED",
      }),
    };
  }

  const wsAllow = ctx.workspaceAllowedTools;
  if (wsAllow instanceof Set && wsAllow.size > 0 && !wsAllow.has(name)) {
    return {
      content: JSON.stringify({
        ok: false,
        error: `Tool "${name}" is not allowed for this workspace`,
        code: "TOOL_NOT_ALLOWED_WORKSPACE",
      }),
    };
  }

  if (ctx.workspaceDeniedTools instanceof Set && ctx.workspaceDeniedTools.has(name)) {
    recordPolicyDenial("POLICY_TOOL_DENIED");
    return {
      content: JSON.stringify({
        ok: false,
        error: `Tool "${name}" is denied by workspace agent policy`,
        code: "POLICY_TOOL_DENIED",
      }),
    };
  }

  const workspace = ctx.workspace || WORKSPACE;
  const allowExecution = ctx.allowExecution === true;

  switch (name) {
    case "execute_step": {
      const action = args?.action;
      const payload = args?.payload && typeof args.payload === "object" ? args.payload : {};
      const step = { action: String(action || "").trim(), payload };
      if (!step.action) {
        return { content: JSON.stringify({ ok: false, error: "action is required" }) };
      }
      if (!allowExecution) {
        return {
          content: JSON.stringify({
            ok: false,
            error: "Client must enable Allow recipe step execution to run execute_step. Enable in Settings.",
            hint: "Or set ALLOW_RECIPE_STEP_EXECUTION=1 on server.",
          }),
        };
      }
      const projectDir = ctx.projectDir || process.cwd();
      const vercelToken = ctx.vercelToken || process.env.VERCEL_TOKEN;
      const result = await executeStep(step, { projectDir, vercelToken });
      appendAuditLog({
        action: step.action,
        payload: step.payload,
        ok: result.ok,
        error: result.error,
        requestId: getRequestId(),
      });
      await emitEvent(
        "recipe_executed",
        { step: { action: step.action, payload: step.payload }, ok: result.ok, error: result.error },
        { workspaceId: workspace }
      );
      return {
        content: JSON.stringify({
          ok: result.ok,
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.error,
        }),
        ok: result.ok,
      };
    }

    case "search_context": {
      const query = args?.query;
      if (typeof query !== "string" || !query.trim()) {
        return { content: JSON.stringify({ error: "query is required", snippets: [] }) };
      }
      const result = await knowledgeSearch({ query: query.trim(), workspace });
      if (result.error) {
        return { content: JSON.stringify(result) };
      }
      const summary = (result.snippets || [])
        .slice(0, 5)
        .map((s) => (s.title ? `[${s.title}] ` : "") + (s.snippet || ""))
        .join("\n\n");
      const payload = {
        query: result.query,
        count: (result.snippets || []).length,
        snippets: (result.snippets || []).slice(0, 5),
        summary: summary || "(no matches)",
      };
      if (citationsRequired()) {
        payload.citationGuidance =
          "Cite sources in your reply using each snippet's `id` in brackets (e.g. [id]) or the exact `title`.";
      }
      return {
        content: JSON.stringify(payload),
      };
    }

    case "list_context": {
      const result = await knowledgeList({ workspace });
      if (result.error) {
        return { content: JSON.stringify(result) };
      }
      const titles = (result.items || []).map((i) => i.title || i.id || "(untitled)");
      return {
        content: JSON.stringify({
          items: result.items || [],
          titles,
          count: titles.length,
        }),
      };
    }

    case "semantic_search_context": {
      const query = args?.query;
      if (typeof query !== "string" || !query.trim()) {
        return { content: JSON.stringify({ error: "query is required", snippets: [] }) };
      }
      const result = await knowledgeSemanticSearch({ query: query.trim(), workspace });
      if (result.error) {
        return { content: JSON.stringify(result) };
      }
      const summary = (result.snippets || [])
        .slice(0, 5)
        .map((s) => (s.title ? `[${s.title}] ` : "") + (s.snippet || ""))
        .join("\n\n");
      const payload = {
        query: result.query,
        count: (result.snippets || []).length,
        snippets: (result.snippets || []).slice(0, 5),
        summary: summary || "(no semantic matches — try keyword search_context or index docs with embeddings)",
      };
      if (citationsRequired()) {
        payload.citationGuidance =
          "Cite sources using each snippet's `id` in brackets (e.g. [id]) or the exact `title`.";
      }
      return { content: JSON.stringify(payload) };
    }

    case "get_context_document": {
      const docId = args?.id;
      if (typeof docId !== "string" || !docId.trim()) {
        return { content: JSON.stringify({ error: "id is required" }) };
      }
      const doc = await getDocumentById({ id: docId.trim(), workspace });
      if (doc.error) {
        return { content: JSON.stringify(doc) };
      }
      const full = doc.content || "";
      const truncated = full.length > CONTEXT_DOC_MAX_CHARS;
      const content = truncated ? `${full.slice(0, CONTEXT_DOC_MAX_CHARS)}\n\n…(truncated; increase AGENT_CONTEXT_DOC_MAX_CHARS if needed)` : full;
      return {
        content: JSON.stringify({
          id: doc.id,
          title: doc.title,
          createdAt: doc.createdAt,
          content,
          truncated,
          charCount: full.length,
        }),
      };
    }

    case "list_recipes": {
      const recipes = await storage.listItems("recipes", workspace);
      const items = (recipes || [])
        .filter((r) => r)
        .map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          stepCount: Array.isArray(r.steps) ? r.steps.length : 0,
        }));
      return {
        content: JSON.stringify({
          items,
          count: items.length,
        }),
      };
    }

    case "get_recipe": {
      const recipeName = args?.name;
      if (typeof recipeName !== "string" || !recipeName.trim()) {
        return { content: JSON.stringify({ error: "name is required" }) };
      }
      const recipes = await storage.listItems("recipes", workspace);
      const q = recipeName.trim().toLowerCase();
      const recipe = recipes.find(
        (r) => r && (String(r.name || "").toLowerCase() === q || String(r.name || "").toLowerCase().includes(q))
      );
      if (!recipe) {
        const names = recipes.filter((r) => r?.name).map((r) => r.name);
        return {
          content: JSON.stringify({
            error: `Recipe "${recipeName}" not found`,
            available: names,
          }),
        };
      }
      return {
        content: JSON.stringify({
          id: recipe.id,
          name: recipe.name,
          description: recipe.description,
          steps: recipe.steps || [],
          stepCount: (recipe.steps || []).length,
        }),
      };
    }

    case "remember_workspace_fact": {
      const uid = sanitizeUserId(ctx.workspaceUserId || "anonymous");
      const fact = args?.fact;
      if (typeof fact !== "string" || !fact.trim()) {
        return { content: JSON.stringify({ ok: false, error: "fact is required" }) };
      }
      const r = await appendWorkspaceMemoryFact(uid, workspace, fact.trim());
      return { content: JSON.stringify(r) };
    }

    case "list_workspace_memory": {
      const uid = sanitizeUserId(ctx.workspaceUserId || "anonymous");
      const s = await loadWorkspaceAgentSettings(uid, workspace);
      return {
        content: JSON.stringify({
          snippets: s.memorySnippets || [],
          count: (s.memorySnippets || []).length,
        }),
      };
    }

    case "fetch_allowed_url": {
      const u = args?.url;
      if (typeof u !== "string" || !u.trim()) {
        return { content: JSON.stringify({ ok: false, error: "url is required" }) };
      }
      const fetched = await agentFetchAllowedUrl(u.trim());
      if (fetched.error) {
        return { content: JSON.stringify({ ok: false, error: fetched.error, code: fetched.code }) };
      }
      const text = fetched.text || "";
      const maxOut = Math.min(120_000, Number(process.env.AGENT_FETCH_MAX_OUTPUT_CHARS) || 24_000);
      const truncated = text.length > maxOut;
      return {
        content: JSON.stringify({
          ok: true,
          finalUrl: fetched.finalUrl,
          text: truncated ? `${text.slice(0, maxOut)}\n\n…(truncated)` : text,
          truncated,
        }),
      };
    }

    case "chain_tools": {
      const steps = args?.steps;
      if (!Array.isArray(steps) || steps.length === 0) {
        return { content: JSON.stringify({ ok: false, error: "steps array is required and must not be empty" }) };
      }
      const maxChainLen = Math.max(2, Number(process.env.AGENT_MAX_CHAIN_LENGTH) || 10);
      if (steps.length > maxChainLen) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Chain exceeds maximum length of ${maxChainLen} steps`,
            code: "CHAIN_TOO_LONG",
          }),
        };
      }
      // Bind runTool so chain steps go through full hook pipeline
      const chainResult = await executeChainToolsMeta(steps, ctx, (n, a, c) => runTool(n, a, c));
      return {
        content: JSON.stringify(chainResult),
        ok: chainResult.ok,
      };
    }

    case "update_agent_session_plan": {
      const sid = typeof ctx.agentSessionId === "string" ? ctx.agentSessionId.trim() : "";
      if (!sid) {
        return {
          content: JSON.stringify({ ok: false, code: "NO_ACTIVE_SESSION", error: "This run has no agent session. Pass agentOptions.sessionId when starting the agent." }),
          ok: false,
        };
      }
      const uid = sanitizeUserId(ctx.workspaceUserId || "anonymous");
      const row = await getAgentSession(sid);
      if (!row || row.ownerStorageUserId !== uid || row.workspace !== workspace) {
        return { content: JSON.stringify({ ok: false, code: "SESSION_ACCESS_DENIED", error: "Session not found or does not match this workspace/user" }), ok: false };
      }
      const body = {};
      if (Object.prototype.hasOwnProperty.call(args || {}, "planSummary")) body.planSummary = args.planSummary;
      if (Object.prototype.hasOwnProperty.call(args || {}, "planDag")) body.planDag = args.planDag;
      const up = await updateAgentSessionPlan(sid, body);
      if (!up.ok) return { content: JSON.stringify({ ok: false, code: up.code, error: up.message }), ok: false };
      appendAuditLog({ action: "update_agent_session_plan", payload: { sessionId: sid }, ok: true, requestId: getRequestId() });
      return { content: JSON.stringify({ ok: true, planUpdatedAt: up.session.planUpdatedAt, planSummary: up.session.planSummary, planDag: up.session.planDag }), ok: true };
    }

    case "recommend_tools": {
      const task = args?.task;
      if (typeof task !== "string" || !task.trim()) {
        return { content: JSON.stringify({ ok: false, error: "task is required" }), ok: false };
      }
      const recs = globalToolDiscovery.recommendToolsForTask(task.trim());
      return {
        content: JSON.stringify({
          ok: true,
          task: task.trim(),
          recommendations: recs,
          count: recs.length,
        }),
        ok: true,
      };
    }

    case "search_knowledge_graph": {
      const graph = await getWorkspaceKnowledgeGraph(workspace);
      const entityId = args?.entityId;

      // If entityId provided, do neighbor lookup
      if (typeof entityId === "string" && entityId.trim()) {
        const ent = graph.getEntity(entityId.trim());
        if (!ent) {
          return { content: JSON.stringify({ error: "Entity not found", entityId }) };
        }
        const depth = Math.max(1, Math.min(Number(args?.depth) || 1, 3));
        const neighbors = graph.getNeighbors(entityId.trim(), depth);
        return {
          content: JSON.stringify({
            entity: ent,
            neighbors: neighbors.entities.slice(0, 20),
            relations: neighbors.relations.slice(0, 30),
            depth,
          }),
        };
      }

      // Otherwise search by name/type
      const query = {};
      if (typeof args?.query === "string" && args.query.trim()) query.name = args.query.trim();
      if (typeof args?.type === "string" && args.type.trim()) query.type = args.type.trim();

      if (!query.name && !query.type) {
        const stats = graph.getStats();
        const topEntities = graph.getTopEntities(10);
        return {
          content: JSON.stringify({
            stats,
            topEntities: topEntities.map((e) => ({ name: e.entity.name, type: e.entity.type, id: e.entity.id, connections: e.connectionCount })),
          }),
        };
      }

      const entities = graph.findEntities(query).slice(0, 15);
      const entitySummaries = entities.map((e) => {
        const rels = graph.getRelations(e.id);
        return {
          id: e.id,
          name: e.name,
          type: e.type,
          properties: e.properties,
          relationCount: rels.length,
        };
      });

      return {
        content: JSON.stringify({
          entities: entitySummaries,
          count: entitySummaries.length,
          query,
        }),
      };
    }

    case "workspace_read_file": {
      if (process.env.WORKSPACE_FILE_TOOLS !== "1") {
        return { content: JSON.stringify({ ok: false, error: "WORKSPACE_FILE_TOOLS is not enabled" }), ok: false };
      }
      const filePath = args?.path;
      if (typeof filePath !== "string" || !filePath.trim()) {
        return { content: JSON.stringify({ ok: false, error: "path is required" }), ok: false };
      }
      const result = await workspaceReadFile(ctx, filePath.trim());
      if (!result.ok) {
        return { content: JSON.stringify({ ok: false, error: result.error, code: result.code }), ok: false };
      }
      return { content: JSON.stringify(result), ok: true };
    }

    case "recall_reasoning": {
      const wsId = workspace;
      const convId = typeof args?.conversationId === "string" ? args.conversationId.trim() : "";
      const limit = Math.min(Math.max(1, Number(args?.limit) || 10), 50);

      if (convId) {
        const chain = await getReasoningChain(convId, wsId);
        const steps = (chain.steps || []).slice(0, limit).map((s) => ({
          id: s.id,
          turnIndex: s.turnIndex,
          premise: s.premise,
          inference: s.inference,
          conclusion: s.conclusion,
          confidence: s.confidence,
          toolsUsed: s.toolsUsed,
          createdAt: s.createdAt,
        }));
        return {
          content: JSON.stringify({
            ok: true,
            conversationId: chain.conversationId,
            steps,
            count: steps.length,
          }),
        };
      }

      const query = typeof args?.query === "string" ? args.query.trim() : "";
      if (!query) {
        return {
          content: JSON.stringify({
            ok: false,
            error: "Either query or conversationId is required",
          }),
        };
      }
      const related = await findRelatedReasoning(query, wsId, { limit });
      return {
        content: JSON.stringify({
          ok: true,
          query,
          results: related.map((r) => ({
            conversationId: r.conversationId,
            relevance: r.relevance,
            turnIndex: r.step.turnIndex,
            premise: r.step.premise,
            inference: r.step.inference,
            conclusion: r.step.conclusion,
            confidence: r.step.confidence,
            toolsUsed: r.step.toolsUsed,
          })),
          count: related.length,
        }),
      };
    }

    case "consensus_query": {
      const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) {
        return { content: JSON.stringify({ ok: false, error: "prompt is required" }) };
      }
      const minAgents = Number.isFinite(args?.minAgents) ? Math.max(1, Number(args.minAgents)) : 2;
      const strategy = typeof args?.strategy === "string" ? args.strategy : "majority_vote";
      const requestedModels = Array.isArray(args?.models)
        ? args.models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
        : [];
      const defaultModels = ["default", "default", "default"];
      const models = requestedModels.length >= 2 ? requestedModels : defaultModels;
      const agents = models.map((m, i) => ({ agentId: `${m}#${i}`, model: m }));
      try {
        const run = await executeConsensus(prompt, {
          agents,
          strategy,
          quorum: minAgents,
          backendFetch: ctx.backendFetch,
          buildProxyConfig: ctx.buildProxyConfig,
        });
        return {
          content: JSON.stringify({
            ok: !run.error,
            id: run.id,
            consensus: run.consensus,
            confidence: run.confidence,
            agreement: run.agreement,
            strategy: run.strategy,
            quorumMet: run.quorumMet,
            error: run.error,
            agentCount: Array.isArray(run.responses) ? run.responses.length : 0,
          }),
        };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: String(err?.message || err) }) };
      }
    }

    case "tree_of_thought_plan": {
      if (process.env.AGENT_REASONING_TOOLS !== "1") {
        return { content: JSON.stringify({ ok: false, error: "AGENT_REASONING_TOOLS is not enabled" }) };
      }
      const task = typeof args?.task === "string" ? args.task.trim() : "";
      if (!task) {
        return { content: JSON.stringify({ ok: false, error: "task is required" }) };
      }
      const depth = clampInt(args?.depth, 3, 0, 6);
      const beamWidth = clampInt(args?.beamWidth, 3, 1, 8);
      const k = clampInt(args?.k, 3, 1, 8);
      const strategyRaw = typeof args?.strategy === "string" ? args.strategy.toLowerCase() : "beam";
      const searchFn = strategyRaw === "dfs" ? dfsSearch : strategyRaw === "bfs" ? bfsSearch : beamSearch;
      try {
        const res = await searchFn(task, { depth, beamWidth, k });
        const bestPath = (res.bestPath || []).map((n) => ({
          thought: n.thought,
          depth: n.depth,
          score: Number(n.score?.toFixed ? n.score.toFixed(3) : n.score) || 0,
          terminal: !!n.terminal,
        }));
        const answer = totExtractAnswer(res.bestPath || []);
        return {
          content: JSON.stringify({
            ok: true,
            strategy: strategyRaw === "dfs" || strategyRaw === "bfs" ? strategyRaw : "beam",
            answer,
            bestPath,
            pathLength: bestPath.length,
            stats: res.stats,
          }),
          ok: true,
        };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: String(err?.message || err) }) };
      }
    }

    case "verify_output": {
      if (process.env.AGENT_REASONING_TOOLS !== "1") {
        return { content: JSON.stringify({ ok: false, error: "AGENT_REASONING_TOOLS is not enabled" }) };
      }
      const task = typeof args?.task === "string" ? args.task : "";
      const answer = typeof args?.answer === "string" ? args.answer : "";
      if (!task.trim()) {
        return { content: JSON.stringify({ ok: false, error: "task is required" }) };
      }
      if (!answer.trim()) {
        return { content: JSON.stringify({ ok: false, error: "answer is required" }) };
      }
      const strategy = typeof args?.strategy === "string" ? args.strategy.toLowerCase() : "default";
      let verifierFn;
      switch (strategy) {
        case "math":
          verifierFn = mathVerifier;
          break;
        case "code":
          verifierFn = codeVerifier;
          break;
        case "format": {
          const schema = args?.schema;
          if (!schema || typeof schema !== "object") {
            return { content: JSON.stringify({ ok: false, error: "schema object is required for strategy='format'" }) };
          }
          verifierFn = (a, t) => formatVerifier(a, t, schema);
          break;
        }
        case "fact": {
          const kb = args?.knowledgeBase;
          if (!Array.isArray(kb) || kb.length === 0) {
            return { content: JSON.stringify({ ok: false, error: "knowledgeBase array is required for strategy='fact'" }) };
          }
          verifierFn = (a) => factVerifier(a, kb);
          break;
        }
        case "default":
        case "":
        case undefined:
          verifierFn = defaultVerifier;
          break;
        default:
          return {
            content: JSON.stringify({
              ok: false,
              error: `Unknown verifier strategy '${strategy}'. Use default|math|code|format|fact.`,
            }),
          };
      }
      try {
        const verdict = await verificationVerify(answer, task, verifierFn);
        return {
          content: JSON.stringify({
            ok: true,
            strategy,
            approved: verdict.approved,
            score: verdict.score,
            critique: verdict.critique,
            suggestions: verdict.suggestions,
          }),
          ok: true,
        };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: String(err?.message || err) }) };
      }
    }

    case "self_consistency": {
      if (process.env.AGENT_REASONING_TOOLS !== "1") {
        return { content: JSON.stringify({ ok: false, error: "AGENT_REASONING_TOOLS is not enabled" }) };
      }
      const task = typeof args?.task === "string" ? args.task.trim() : "";
      if (!task) {
        return { content: JSON.stringify({ ok: false, error: "task is required" }) };
      }
      const n = clampInt(args?.n, 5, 1, 15);
      const format = typeof args?.format === "string" ? args.format : "auto";

      // If caller supplied samples directly, use them; otherwise build a deterministic sampler.
      let samplerFn;
      if (Array.isArray(args?.samples) && args.samples.length > 0) {
        const provided = args.samples.map((s) => {
          if (typeof s === "string") return { answer: s, reasoning: s };
          if (s && typeof s === "object") {
            return {
              answer: s.answer != null ? s.answer : s.text != null ? s.text : null,
              reasoning: typeof s.reasoning === "string" ? s.reasoning : "",
            };
          }
          return { answer: null, reasoning: "" };
        });
        samplerFn = async (_task, opts) => provided[opts.sampleIndex % provided.length];
      } else {
        samplerFn = async (t, opts) => {
          const seed = `${t}#${opts.sampleIndex}`;
          return {
            answer: null,
            reasoning: `For task "${t}" sample ${opts.sampleIndex} answer is ${seed.length % 5}`,
          };
        };
      }

      try {
        const run = await runSelfConsistency(task, samplerFn, { n, format, persist: false });
        return {
          content: JSON.stringify({
            ok: true,
            answer: run.answer,
            normalizedAnswer: run.normalizedAnswer,
            confidence: run.confidence,
            consensus: run.consensus,
            consensusRate: run.consensusRate,
            uncertainty: run.uncertainty,
            voteBreakdown: run.voteBreakdown,
            sampleCount: Array.isArray(run.samples) ? run.samples.length : 0,
          }),
          ok: true,
        };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: String(err?.message || err) }) };
      }
    }

    default:
      return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }
}

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
