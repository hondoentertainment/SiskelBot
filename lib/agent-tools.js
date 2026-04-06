/**
 * Phase 15: Agentic Autonomy Mode - Tool definitions for the LLM.
 * OpenAI-compatible tool schema and tool execution.
 * Phases 82, 85, 88, 89: workspace memory tools, allowlisted fetch, tool hooks, deployment tool allowlist.
 */
import { executeStep, appendAuditLog } from "./action-executor.js";
import { emitEvent } from "./webhooks.js";
import { invokeBeforeToolCall, invokeAfterToolCall } from "./agent-hooks.js";
import { appendWorkspaceMemoryFact } from "./workspace-memory-tool.js";
import { remember, recall, forget } from "./agent-memory.js";
import { loadWorkspaceAgentSettings } from "./workspace-agent-settings.js";
import { sanitizeUserId } from "./storage.js";
import { agentFetchAllowedUrl } from "./agent-fetch-url.js";
import {
  search as knowledgeSearch,
  list as knowledgeList,
  semanticSearch as knowledgeSemanticSearch,
  getDocumentById,
  indexDocument,
} from "./knowledge-store.js";
import * as storage from "./storage.js";
import { citationsRequired } from "./grounding.js";
import * as schedules from "./schedules.js";
import vm from "node:vm";

const WORKSPACE = "default";
const CONTEXT_DOC_MAX_CHARS = Math.max(4096, Number(process.env.AGENT_CONTEXT_DOC_MAX_CHARS) || 48_000);
const AGENT_TOOL_TIMEOUT_MS = Math.max(0, Number(process.env.AGENT_TOOL_TIMEOUT_MS) || 30_000);
export { AGENT_TOOL_TIMEOUT_MS };

/** @type {Map<string, { connection: object, originalName: string }>} */
const externalToolRegistry = new Map();

/**
 * Register tools sourced from an external MCP server into the TOOLS array.
 * Each tool is prefixed with "mcp_" to avoid collisions with built-in tools.
 * @param {Array<{ name: string, description: string, inputSchema: object }>} tools - MCP tool definitions
 * @param {object} connection - MCP connection object (from mcp-client)
 * @returns {number} Number of tools registered
 */
export function registerExternalTools(tools, connection) {
  if (!Array.isArray(tools)) return 0;
  let count = 0;
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string") continue;
    const prefixedName = `mcp_${tool.name}`;
    if (externalToolRegistry.has(prefixedName)) continue;
    const toolDef = {
      type: "function",
      function: {
        name: prefixedName,
        description: `[MCP] ${tool.description || tool.name}`,
        parameters: tool.inputSchema || { type: "object", properties: {} },
      },
    };
    TOOLS.push(toolDef);
    externalToolRegistry.set(prefixedName, { connection, originalName: tool.name });
    count++;
  }
  return count;
}

/**
 * Remove all externally registered MCP tools (for cleanup or reconnect).
 */
export function clearExternalTools() {
  for (const name of externalToolRegistry.keys()) {
    const idx = TOOLS.findIndex((t) => t.function?.name === name);
    if (idx >= 0) TOOLS.splice(idx, 1);
  }
  externalToolRegistry.clear();
}

/**
 * Load tools from configured MCP servers and register them.
 * Call on agent loop start when MCP_SERVERS is set.
 * @returns {Promise<number>} Total tools registered
 */
export async function loadExternalMcpTools() {
  const { parseMcpServersEnv, connectToMcpServer, listTools } = await import("./mcp-client.js");
  const servers = parseMcpServersEnv();
  if (servers.length === 0) return 0;
  let total = 0;
  for (const serverConfig of servers) {
    try {
      const conn = await connectToMcpServer(serverConfig);
      const tools = await listTools(conn);
      total += registerExternalTools(tools, conn);
    } catch (err) {
      console.warn(`[agent-tools] Failed to load MCP tools from ${serverConfig.type}:${serverConfig.target}: ${err.message}`);
    }
  }
  return total;
}

class ToolTimeoutError extends Error {
  constructor(toolName, ms) {
    super(`Tool call timed out after ${ms}ms`);
    this.toolName = toolName;
    this.ms = ms;
  }
}

let warnedEmptyToolsAllowlist = false;

/** OpenAI-compatible tools array for function calling. */
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
      name: "recall_memory",
      description:
        "Search long-term memory for relevant facts, preferences, and context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query to find relevant memories" },
          category: { type: "string", description: "Optional category filter: fact, preference, context, instruction, observation" },
          limit: { type: "number", description: "Max results to return (default 10)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_memory",
      description:
        "Remove a memory by ID when it's no longer relevant.",
      parameters: {
        type: "object",
        properties: {
          memoryId: { type: "string", description: "The ID of the memory to remove" },
        },
        required: ["memoryId"],
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
      name: "web_search",
      description:
        "Search the web using a search API. Returns top results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results to return (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_execute",
      description:
        "Execute JavaScript code in a sandboxed environment. Useful for calculations, data processing, and transformations.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript code to execute" },
          timeout: { type: "number", description: "Execution timeout in ms (default 5000)" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_document",
      description:
        "Create a new knowledge document in the workspace. Use to save important findings, summaries, or notes.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Document title" },
          content: { type: "string", description: "Document text content" },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_task",
      description:
        "Schedule a recipe to run at a future time or on a cron schedule.",
      parameters: {
        type: "object",
        properties: {
          recipeName: { type: "string", description: "Name of the recipe to schedule" },
          cron: { type: "string", description: "Cron expression (e.g. '0 9 * * 1' for Mondays at 9am)" },
          runAt: { type: "string", description: "ISO date string for one-time execution" },
          description: { type: "string", description: "Optional description of the scheduled task" },
        },
        required: ["recipeName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_notification",
      description:
        "Send a notification to configured channels (webhooks, email). Use to alert users about important findings.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Notification message" },
          channel: { type: "string", description: "Target channel (optional)" },
          urgency: { type: "string", enum: ["low", "normal", "high"], description: "Notification urgency (default normal)" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_database",
      description:
        "Execute a read-only SQL query against the connected PostgreSQL database. Only SELECT queries allowed.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "SQL SELECT query to execute" },
        },
        required: ["query"],
      },
    },
  },
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
 * Execute a single tool call by name.
 * @param {string} name - Tool name (execute_step, search_context, list_context, semantic_search_context, get_context_document, list_recipes, get_recipe)
 * @param {object} args - Parsed JSON arguments
 * @param {object} ctx - Execution context { allowExecution?, projectDir?, vercelToken?, workspace? }
 * @returns {Promise<{ content: string; ok?: boolean }>}
 */
export async function runTool(name, args, ctx = {}) {
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
    if (AGENT_TOOL_TIMEOUT_MS > 0) {
      result = await Promise.race([
        runToolCore(name, execArgs, ctx),
        new Promise((_, reject) =>
          setTimeout(() => reject(new ToolTimeoutError(name, AGENT_TOOL_TIMEOUT_MS)), AGENT_TOOL_TIMEOUT_MS)
        ),
      ]);
    } else {
      result = await runToolCore(name, execArgs, ctx);
    }
  } catch (e) {
    if (e instanceof ToolTimeoutError) {
      result = {
        content: JSON.stringify({ error: e.message, toolName: e.toolName }),
        _timeout: true,
        _timeoutMs: e.ms,
      };
    } else {
      result = { content: JSON.stringify({ ok: false, error: String(e?.message || e) }) };
    }
  }
  await invokeAfterToolCall(name, execArgs, result, ctx);
  return result;
}

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
      // Also store in the long-term memory system
      try {
        await remember(uid, workspace, {
          content: fact.trim(),
          category: "fact",
          importance: 3,
          source: "remember_workspace_fact",
        });
      } catch {
        // best-effort; workspace memory is the primary store
      }
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

    case "web_search": {
      const query = args?.query;
      if (typeof query !== "string" || !query.trim()) {
        return { content: JSON.stringify({ ok: false, error: "query is required" }) };
      }
      const searchApi = (process.env.SEARCH_API || "").trim().toLowerCase();
      if (!searchApi) {
        return {
          content: JSON.stringify({
            ok: false,
            error: "Web search not configured. Set SEARCH_API and relevant keys.",
          }),
        };
      }
      const limit = Math.min(Math.max(1, Number(args?.limit) || 5), 20);
      try {
        let rawResults = [];
        if (searchApi === "searxng") {
          const baseUrl = (process.env.SEARCH_API_URL || "").trim();
          if (!baseUrl) {
            return { content: JSON.stringify({ ok: false, error: "SEARCH_API_URL is required for SearXNG." }) };
          }
          const url = `${baseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query.trim())}&format=json`;
          const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!resp.ok) throw new Error(`SearXNG returned ${resp.status}`);
          const data = await resp.json();
          rawResults = (data.results || []).slice(0, limit).map((r) => ({
            title: r.title || "",
            url: r.url || "",
            snippet: r.content || "",
          }));
        } else if (searchApi === "brave") {
          const apiKey = (process.env.BRAVE_SEARCH_API_KEY || "").trim();
          if (!apiKey) {
            return { content: JSON.stringify({ ok: false, error: "BRAVE_SEARCH_API_KEY is required for Brave Search." }) };
          }
          const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query.trim())}&count=${limit}`;
          const resp = await fetch(url, {
            headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(10_000),
          });
          if (!resp.ok) throw new Error(`Brave Search returned ${resp.status}`);
          const data = await resp.json();
          rawResults = (data.web?.results || []).slice(0, limit).map((r) => ({
            title: r.title || "",
            url: r.url || "",
            snippet: r.description || "",
          }));
        } else if (searchApi === "google") {
          const apiKey = (process.env.GOOGLE_SEARCH_API_KEY || "").trim();
          const cx = (process.env.GOOGLE_SEARCH_CX || "").trim();
          if (!apiKey || !cx) {
            return { content: JSON.stringify({ ok: false, error: "GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX are required for Google Search." }) };
          }
          const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query.trim())}&num=${limit}`;
          const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!resp.ok) throw new Error(`Google Search returned ${resp.status}`);
          const data = await resp.json();
          rawResults = (data.items || []).slice(0, limit).map((r) => ({
            title: r.title || "",
            url: r.link || "",
            snippet: r.snippet || "",
          }));
        } else {
          return { content: JSON.stringify({ ok: false, error: `Unknown SEARCH_API value: "${searchApi}". Use searxng, brave, or google.` }) };
        }
        return { content: JSON.stringify({ ok: true, results: rawResults, count: rawResults.length }) };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: `Web search failed: ${err.message}` }) };
      }
    }

    case "code_execute": {
      if (process.env.AGENT_CODE_EXECUTE !== "1") {
        return {
          content: JSON.stringify({
            ok: false,
            error: "Code execution is disabled. Set AGENT_CODE_EXECUTE=1 to enable.",
          }),
        };
      }
      const code = args?.code;
      if (typeof code !== "string" || !code.trim()) {
        return { content: JSON.stringify({ ok: false, error: "code is required" }) };
      }
      const timeoutMs = Math.min(Math.max(100, Number(args?.timeout) || 5000), 30_000);
      const logs = [];
      const sandbox = {
        console: { log: (...a) => logs.push(a.map(String).join(" ")), warn: (...a) => logs.push(a.map(String).join(" ")), error: (...a) => logs.push(a.map(String).join(" ")) },
        JSON,
        Math,
        Date,
        Array,
        Object,
        String,
        Number,
        RegExp,
        Map,
        Set,
        parseInt,
        parseFloat,
      };
      try {
        const ctx = vm.createContext(sandbox);
        const script = new vm.Script(code);
        const result = script.runInContext(ctx, { timeout: timeoutMs });
        return {
          content: JSON.stringify({
            ok: true,
            output: logs.join("\n"),
            result: result !== undefined ? result : null,
          }),
        };
      } catch (err) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Execution error: ${err.message}`,
            output: logs.join("\n"),
          }),
        };
      }
    }

    case "create_document": {
      const title = args?.title;
      const content = args?.content;
      if (typeof title !== "string" || !title.trim()) {
        return { content: JSON.stringify({ ok: false, error: "title is required" }) };
      }
      if (typeof content !== "string" || !content.trim()) {
        return { content: JSON.stringify({ ok: false, error: "content is required" }) };
      }
      const result = await indexDocument({ text: content.trim(), title: title.trim(), workspace });
      if (result.error) {
        return { content: JSON.stringify({ ok: false, error: result.error, code: result.code }) };
      }
      return {
        content: JSON.stringify({
          ok: true,
          id: result.id,
          title: result.title || title.trim(),
          created: true,
        }),
      };
    }

    case "schedule_task": {
      if (process.env.ENABLE_SCHEDULED_RECIPES !== "1") {
        return {
          content: JSON.stringify({
            ok: false,
            error: "Scheduled recipes are disabled. Set ENABLE_SCHEDULED_RECIPES=1 to enable.",
          }),
        };
      }
      const recipeName = args?.recipeName;
      if (typeof recipeName !== "string" || !recipeName.trim()) {
        return { content: JSON.stringify({ ok: false, error: "recipeName is required" }) };
      }
      const cron = args?.cron;
      const runAt = args?.runAt;
      if (!cron && !runAt) {
        return { content: JSON.stringify({ ok: false, error: "Either cron or runAt must be provided" }) };
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
            ok: false,
            error: `Recipe "${recipeName}" not found`,
            available: names,
          }),
        };
      }
      const cronExpr = cron || `at:${runAt}`;
      const entry = await schedules.upsert(recipe.id, { cron: cronExpr, enabled: true }, workspace);
      return {
        content: JSON.stringify({
          ok: true,
          scheduleId: entry.recipeId,
          recipeName: recipe.name,
          cron: cronExpr,
          nextRun: runAt || null,
        }),
      };
    }

    case "send_notification": {
      const message = args?.message;
      if (typeof message !== "string" || !message.trim()) {
        return { content: JSON.stringify({ ok: false, error: "message is required" }) };
      }
      const urgency = ["low", "normal", "high"].includes(args?.urgency) ? args.urgency : "normal";
      const channels = [];
      try {
        await emitEvent(
          "agent_notification",
          { message: message.trim(), channel: args?.channel || null, urgency },
          { workspaceId: workspace }
        );
        channels.push("webhook");
      } catch (_) { /* ignore webhook errors */ }
      const slackUrl = (process.env.SLACK_WEBHOOK_URL || "").trim();
      if (slackUrl) {
        try {
          const resp = await fetch(slackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: `[${urgency.toUpperCase()}] ${message.trim()}` }),
            signal: AbortSignal.timeout(10_000),
          });
          if (resp.ok) channels.push("slack");
        } catch (_) { /* ignore slack errors */ }
      }
      return {
        content: JSON.stringify({ ok: true, sent: true, channels }),
      };
    }

    case "query_database": {
      if (process.env.STORAGE_BACKEND !== "postgres") {
        return {
          content: JSON.stringify({
            ok: false,
            error: "query_database requires STORAGE_BACKEND=postgres.",
          }),
        };
      }
      if (process.env.AGENT_DB_QUERY !== "1") {
        return {
          content: JSON.stringify({
            ok: false,
            error: "Database queries are disabled. Set AGENT_DB_QUERY=1 to enable.",
          }),
        };
      }
      const sql = args?.query;
      if (typeof sql !== "string" || !sql.trim()) {
        return { content: JSON.stringify({ ok: false, error: "query is required" }) };
      }
      const trimmed = sql.trim();
      if (!/^select\b/i.test(trimmed)) {
        return { content: JSON.stringify({ ok: false, error: "Only SELECT queries are allowed." }) };
      }
      const forbidden = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE)\b/i;
      if (forbidden.test(trimmed)) {
        return { content: JSON.stringify({ ok: false, error: "Query contains forbidden keywords (DROP, DELETE, INSERT, UPDATE, ALTER, CREATE, TRUNCATE)." }) };
      }
      try {
        const { default: pg } = await import("pg");
        const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
        await client.connect();
        try {
          await client.query("SET statement_timeout = 5000");
          const result = await client.query(trimmed);
          return {
            content: JSON.stringify({
              ok: true,
              rows: result.rows,
              rowCount: result.rowCount,
            }),
          };
        } finally {
          await client.end();
        }
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: `Database query failed: ${err.message}` }) };
      }
    }

    case "recall_memory": {
      const query = args?.query;
      if (typeof query !== "string" || !query.trim()) {
        return { content: JSON.stringify({ ok: false, error: "query is required" }) };
      }
      const uid = sanitizeUserId(ctx.workspaceUserId || "anonymous");
      try {
        const result = await recall(uid, workspace, query.trim(), {
          category: args?.category || undefined,
          limit: args?.limit || 10,
        });
        return {
          content: JSON.stringify({
            ok: true,
            memories: result.memories,
            count: result.memories.length,
          }),
        };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: err.message }) };
      }
    }

    case "forget_memory": {
      const memoryId = args?.memoryId;
      if (typeof memoryId !== "string" || !memoryId.trim()) {
        return { content: JSON.stringify({ ok: false, error: "memoryId is required" }) };
      }
      const uid = sanitizeUserId(ctx.workspaceUserId || "anonymous");
      try {
        const result = await forget(uid, workspace, memoryId.trim());
        return { content: JSON.stringify(result) };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: err.message }) };
      }
    }

    default:
      return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }
}
