/**
 * Phase 15: Agentic Autonomy Mode - Tool definitions for the LLM.
 * OpenAI-compatible tool schema and tool execution.
 * Phases 82, 85, 88, 89: workspace memory tools, allowlisted fetch, tool hooks, deployment tool allowlist.
 */
import { executeStep, appendAuditLog } from "./action-executor.js";
import { emitEvent } from "./webhooks.js";
import { invokeBeforeToolCall, invokeAfterToolCall } from "./agent-hooks.js";
import { appendWorkspaceMemoryFact } from "./workspace-memory-tool.js";
import { loadWorkspaceAgentSettings } from "./workspace-agent-settings.js";
import { sanitizeUserId } from "./storage.js";
import { agentFetchAllowedUrl } from "./agent-fetch-url.js";
import { isMarketplaceActionAllowed } from "./marketplace-registry.js";
import {
  search as knowledgeSearch,
  list as knowledgeList,
  semanticSearch as knowledgeSemanticSearch,
  getDocumentById,
} from "./knowledge-store.js";
import * as storage from "./storage.js";
import { citationsRequired } from "./grounding.js";
import { recordPolicyDenial } from "./metrics.js";
import { workspaceListDir, workspaceReadFile, workspaceSearchText } from "./workspace-fs-tools.js";
import {
  workspaceWriteFile,
  workspaceGitStatus,
  workspaceGitLog,
  workspaceGitDiff,
  workspaceGitCommit,
  workspaceRunCommand,
  workspaceFileWriteToolsEnabled,
  workspaceGitReadToolsEnabled,
  workspaceGitWriteEnabled,
  parseWorkspaceCommandAllowlist,
} from "./workspace-act-tools.js";
import { browserOpenExtractText, agentBrowserToolsEnabled } from "./browser-agent-tools.js";

const WORKSPACE = "default";
const CONTEXT_DOC_MAX_CHARS = Math.max(4096, Number(process.env.AGENT_CONTEXT_DOC_MAX_CHARS) || 48_000);
const AGENT_TOOL_TIMEOUT_MS = Math.max(0, Number(process.env.AGENT_TOOL_TIMEOUT_MS) || 30_000);
export { AGENT_TOOL_TIMEOUT_MS };

class ToolTimeoutError extends Error {
  constructor(toolName, ms) {
    super(`Tool call timed out after ${ms}ms`);
    this.toolName = toolName;
    this.ms = ms;
  }
}

let warnedEmptyToolsAllowlist = false;

/** OpenAI-compatible tools array for function calling (core). */
const CORE_TOOLS = [
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
];

const WORKSPACE_FILE_TOOL_DEFS =
  process.env.WORKSPACE_FILE_TOOLS === "1"
    ? [
        {
          type: "function",
          function: {
            name: "workspace_list_dir",
            description:
              "List files and subdirectories under a path relative to WORKSPACE_ROOT (requires WORKSPACE_FILE_TOOLS=1 and server WORKSPACE_ROOT).",
            parameters: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Relative directory path; use empty or . for workspace root",
                },
              },
            },
          },
        },
        {
          type: "function",
          function: {
            name: "workspace_read_file",
            description:
              "Read a UTF-8 text file relative to WORKSPACE_ROOT. Subject to size limits (WORKSPACE_FILE_READ_MAX_BYTES).",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Relative file path" },
                maxBytes: { type: "integer", description: "Optional max bytes to read (capped by server)" },
              },
              required: ["path"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "workspace_search_text",
            description:
              "Search for a literal substring in text files under a relative directory (skips node_modules/.git).",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Literal text to find" },
                rootRelative: {
                  type: "string",
                  description: "Directory relative to WORKSPACE_ROOT (default .)",
                },
                maxMatches: { type: "integer", description: "Max match lines to return" },
              },
              required: ["query"],
            },
          },
        },
      ]
    : [];

function buildWorkspaceActToolDefs() {
  const out = [];
  if (workspaceFileWriteToolsEnabled()) {
    out.push({
      type: "function",
      function: {
        name: "workspace_write_file",
        description:
          "Create or overwrite a UTF-8 file under WORKSPACE_ROOT. Backs up previous file unless createOnly. Requires WORKSPACE_FILE_WRITE_TOOLS=1.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative file path" },
            content: { type: "string", description: "Full new file contents" },
            createOnly: { type: "boolean", description: "If true, fail when file already exists" },
          },
          required: ["path", "content"],
        },
      },
    });
  }
  if (workspaceGitReadToolsEnabled()) {
    out.push(
      {
        type: "function",
        function: {
          name: "workspace_git_status",
          description:
            "Run `git status` in WORKSPACE_ROOT (porcelain). Requires WORKSPACE_ROOT, WORKSPACE_GIT_TOOLS=1, and a git repo.",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "workspace_git_log",
          description: "Show recent commits (oneline, iso dates). Requires WORKSPACE_GIT_TOOLS=1.",
          parameters: {
            type: "object",
            properties: {
              maxCount: { type: "integer", description: "Max commits (default 30, cap 200)" },
            },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "workspace_git_diff",
          description:
            "Run `git diff` in WORKSPACE_ROOT. Optional staged=true for index; optional paths to limit scope.",
          parameters: {
            type: "object",
            properties: {
              staged: { type: "boolean", description: "If true, diff --cached" },
              paths: {
                type: "array",
                items: { type: "string" },
                description: "Optional relative paths (git diff -- paths)",
              },
            },
          },
        },
      }
    );
  }
  if (workspaceGitWriteEnabled()) {
    out.push({
      type: "function",
      function: {
        name: "workspace_git_commit",
        description:
          "Stage listed relative paths and `git commit -m`. Requires WORKSPACE_GIT_WRITE=1. Does not force-push.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Commit message (single line; newlines stripped server-side)" },
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Relative paths to `git add` before commit",
            },
          },
          required: ["message", "paths"],
        },
      },
    });
  }
  if (parseWorkspaceCommandAllowlist()) {
    out.push({
      type: "function",
      function: {
        name: "workspace_run_command",
        description:
          "Run a subprocess with cwd=WORKSPACE_ROOT, no shell. argv[0] must appear in WORKSPACE_COMMAND_ALLOWLIST (e.g. npm,git,pnpm).",
        parameters: {
          type: "object",
          properties: {
            argv: {
              type: "array",
              items: { type: "string" },
              description: 'Executable first, then args e.g. ["npm","run","test"]',
            },
          },
          required: ["argv"],
        },
      },
    });
  }
  return out;
}

const WORKSPACE_ACT_TOOL_DEFS = buildWorkspaceActToolDefs();

const BROWSER_TOOL_DEFS = agentBrowserToolsEnabled()
  ? [
      {
        type: "function",
        function: {
          name: "browser_open_extract_text",
          description:
            "Open an allowlisted https URL in a headless browser (Playwright), follow redirects, then return page title and visible text (body innerText). Requires AGENT_BROWSER_TOOLS=1 and BROWSER_URL_ALLOWLIST or AGENT_FETCH_ALLOWLIST. Re-checks URL after redirects.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "https URL must match deploy allowlist" },
              waitUntil: {
                type: "string",
                enum: ["load", "domcontentloaded", "networkidle"],
                description: "Playwright goto waitUntil (default domcontentloaded)",
              },
            },
            required: ["url"],
          },
        },
      },
    ]
  : [];

export const TOOLS = [...CORE_TOOLS, ...WORKSPACE_FILE_TOOL_DEFS, ...WORKSPACE_ACT_TOOL_DEFS, ...BROWSER_TOOL_DEFS];

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
      const actionPolicy = await isMarketplaceActionAllowed(workspace, step.action);
      if (!actionPolicy.allowed) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Action "${step.action}" blocked: ${actionPolicy.reason}`,
            code: "MARKETPLACE_POLICY_BLOCKED",
          }),
          ok: false,
        };
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

    case "workspace_list_dir": {
      const rel = args?.path;
      const out = await workspaceListDir(ctx, typeof rel === "string" ? rel : "");
      return { content: JSON.stringify(out) };
    }

    case "workspace_read_file": {
      const p = args?.path;
      if (typeof p !== "string" || !p.trim()) {
        return { content: JSON.stringify({ ok: false, error: "path is required" }) };
      }
      const out = await workspaceReadFile(ctx, p.trim(), args?.maxBytes);
      return { content: JSON.stringify(out) };
    }

    case "workspace_search_text": {
      const q = args?.query;
      const rootRelative = typeof args?.rootRelative === "string" ? args.rootRelative : ".";
      const maxMatches = args?.maxMatches;
      const out = await workspaceSearchText(ctx, {
        query: typeof q === "string" ? q : "",
        rootRelative,
        maxMatches,
      });
      return { content: JSON.stringify(out) };
    }

    case "workspace_write_file": {
      const out = await workspaceWriteFile(ctx, {
        path: args?.path,
        content: args?.content,
        createOnly: args?.createOnly === true,
      });
      appendAuditLog({
        action: "workspace_write_file",
        payload: { path: args?.path, ok: out.ok },
        ok: out.ok,
        error: out.error || out.code,
      });
      return { content: JSON.stringify(out) };
    }

    case "workspace_git_status": {
      const out = await workspaceGitStatus(ctx);
      return { content: JSON.stringify(out) };
    }

    case "workspace_git_log": {
      const out = await workspaceGitLog(ctx, { maxCount: args?.maxCount });
      return { content: JSON.stringify(out) };
    }

    case "workspace_git_diff": {
      const out = await workspaceGitDiff(ctx, {
        staged: args?.staged === true,
        paths: Array.isArray(args?.paths) ? args.paths : undefined,
      });
      return { content: JSON.stringify(out) };
    }

    case "workspace_git_commit": {
      const out = await workspaceGitCommit(ctx, {
        message: args?.message,
        paths: Array.isArray(args?.paths) ? args.paths : [],
      });
      appendAuditLog({
        action: "workspace_git_commit",
        payload: { paths: args?.paths, ok: out.ok },
        ok: out.ok,
        error: out.error || out.stderr,
      });
      return { content: JSON.stringify(out) };
    }

    case "workspace_run_command": {
      const argv = Array.isArray(args?.argv) ? args.argv.map((x) => String(x)) : [];
      const out = await workspaceRunCommand(ctx, argv);
      appendAuditLog({
        action: "workspace_run_command",
        payload: { argv0: out.argv0, ok: out.ok },
        ok: out.ok,
        error: out.error || out.stderr?.slice(0, 500),
      });
      return { content: JSON.stringify(out) };
    }

    case "browser_open_extract_text": {
      const u = args?.url;
      const waitUntil =
        typeof args?.waitUntil === "string" ? args.waitUntil : undefined;
      const out = await browserOpenExtractText(typeof u === "string" ? u : "", { waitUntil });
      appendAuditLog({
        action: "browser_open_extract_text",
        payload: { url: typeof u === "string" ? u.slice(0, 200) : "", ok: out.ok },
        ok: out.ok,
        error: out.error || out.code,
      });
      return { content: JSON.stringify(out) };
    }

    default:
      return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }
}
