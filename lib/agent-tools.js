/**
 * Phase 15: Agentic Autonomy Mode - Tool definitions for the LLM.
 * OpenAI-compatible tool schema and tool execution.
 */
import { executeStep, appendAuditLog } from "./action-executor.js";
import { emitEvent } from "./webhooks.js";
import {
  search as knowledgeSearch,
  list as knowledgeList,
  semanticSearch as knowledgeSemanticSearch,
  getDocumentById,
} from "./knowledge-store.js";
import * as storage from "./storage.js";
import { citationsRequired } from "./grounding.js";

const WORKSPACE = "default";
const CONTEXT_DOC_MAX_CHARS = Math.max(4096, Number(process.env.AGENT_CONTEXT_DOC_MAX_CHARS) || 48_000);

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
];

/**
 * Returns OpenAI-compatible tools array for chat completions.
 * @returns {Array<{ type: string; function: object }>}
 */
export function getToolsSchema() {
  return TOOLS;
}

/**
 * Get tools filtered by name list (for swarm specialist subsets).
 * @param {string[]} names - Tool names (e.g. ["search_context", "list_context"])
 * @returns {Array<{ type: string; function: object }>}
 */
export function getToolsForNames(names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const set = new Set(names);
  return TOOLS.filter((t) => t.function?.name && set.has(t.function.name));
}

/**
 * Execute a single tool call by name.
 * @param {string} name - Tool name (execute_step, search_context, list_context, semantic_search_context, get_context_document, list_recipes, get_recipe)
 * @param {object} args - Parsed JSON arguments
 * @param {object} ctx - Execution context { allowExecution?, projectDir?, vercelToken?, workspace? }
 * @returns {Promise<{ content: string; ok?: boolean }>}
 */
export async function runTool(name, args, ctx = {}) {
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
      const result = knowledgeSearch({ query: query.trim(), workspace });
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
      const result = knowledgeList({ workspace });
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
      const doc = getDocumentById({ id: docId.trim(), workspace });
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

    default:
      return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  }
}
