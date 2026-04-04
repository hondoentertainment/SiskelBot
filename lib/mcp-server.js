/**
 * MCP (Model Context Protocol) server implementation.
 * Exposes SiskelBot capabilities as MCP resources and tools.
 */
import * as storage from "./storage.js";
import {
  search as knowledgeSearch,
  list as knowledgeList,
  getDocumentById,
} from "./knowledge-store.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "siskelbot";
const SERVER_VERSION = "1.0.0";

/**
 * Return MCP server capabilities declaration.
 * @returns {object}
 */
export function getMcpCapabilities() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    capabilities: {
      resources: { listChanged: false },
      tools: {},
    },
  };
}

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "siskelbot://knowledge/{docId}",
    name: "Knowledge Document",
    description: "A knowledge base document by ID",
    mimeType: "application/json",
  },
  {
    uriTemplate: "siskelbot://recipes/{recipeId}",
    name: "Recipe",
    description: "A recipe definition by ID",
    mimeType: "application/json",
  },
  {
    uriTemplate: "siskelbot://conversations/{convId}",
    name: "Conversation",
    description: "A conversation by ID",
    mimeType: "application/json",
  },
  {
    uriTemplate: "siskelbot://config",
    name: "Server Configuration",
    description: "Current server configuration (non-secret)",
    mimeType: "application/json",
  },
];

const MCP_TOOLS = [
  {
    name: "search_knowledge",
    description: "Search the SiskelBot knowledge base by keyword query",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        workspace: { type: "string", description: "Workspace ID (default: 'default')" },
      },
      required: ["query"],
    },
  },
  {
    name: "chat_completion",
    description: "Send a chat message and get a completion response from the configured LLM backend",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["system", "user", "assistant"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
          description: "Chat messages array",
        },
        model: { type: "string", description: "Model name (optional, uses default)" },
      },
      required: ["messages"],
    },
  },
  {
    name: "run_recipe",
    description: "Execute a saved recipe by name",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Recipe name" },
        workspace: { type: "string", description: "Workspace ID (default: 'default')" },
      },
      required: ["name"],
    },
  },
  {
    name: "plan_task",
    description: "Generate a structured task plan from a natural-language description",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Task description in natural language" },
      },
      required: ["description"],
    },
  },
  {
    name: "list_workspaces",
    description: "List available workspaces for a user",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID (default: 'anonymous')" },
      },
    },
  },
];

/**
 * Parse a siskelbot:// URI into { type, id }.
 * @param {string} uri
 * @returns {{ type: string, id: string } | null}
 */
function parseResourceUri(uri) {
  if (typeof uri !== "string") return null;
  const m = uri.match(/^siskelbot:\/\/(knowledge|recipes|conversations|config)(?:\/(.+))?$/);
  if (!m) return null;
  return { type: m[1], id: m[2] || "" };
}

/**
 * Handle an MCP JSON-RPC request.
 * @param {string} method - MCP method (e.g. "initialize", "tools/list")
 * @param {object} params - Method parameters
 * @param {object} ctx - Execution context { userId, workspace, backendFetch, buildProxyConfig, BACKEND, MODEL_PRESETS }
 * @returns {Promise<object>} - JSON-RPC result object
 */
export async function handleMcpRequest(method, params, ctx = {}) {
  const userId = ctx.userId || "anonymous";
  const workspace = ctx.workspace || "default";

  switch (method) {
    case "initialize": {
      return getMcpCapabilities();
    }

    case "resources/list": {
      return { resources: RESOURCE_TEMPLATES };
    }

    case "resources/read": {
      const uri = params?.uri;
      const parsed = parseResourceUri(uri);
      if (!parsed) {
        return { error: { code: -32602, message: `Invalid resource URI: ${uri}` } };
      }

      switch (parsed.type) {
        case "knowledge": {
          if (!parsed.id) {
            const items = await knowledgeList({ workspace });
            return {
              contents: [
                {
                  uri,
                  mimeType: "application/json",
                  text: JSON.stringify(items.items || []),
                },
              ],
            };
          }
          const doc = await getDocumentById({ id: parsed.id, workspace });
          if (doc.error) {
            return { error: { code: -32602, message: doc.error } };
          }
          return {
            contents: [
              { uri, mimeType: "application/json", text: JSON.stringify(doc) },
            ],
          };
        }

        case "recipes": {
          const recipes = await storage.listItems("recipes", workspace, userId);
          if (!parsed.id) {
            return {
              contents: [
                { uri, mimeType: "application/json", text: JSON.stringify(recipes || []) },
              ],
            };
          }
          const recipe = (recipes || []).find((r) => r && String(r.id) === parsed.id);
          if (!recipe) {
            return { error: { code: -32602, message: `Recipe not found: ${parsed.id}` } };
          }
          return {
            contents: [
              { uri, mimeType: "application/json", text: JSON.stringify(recipe) },
            ],
          };
        }

        case "conversations": {
          const convos = await storage.listItems("conversations", workspace, userId);
          if (!parsed.id) {
            return {
              contents: [
                { uri, mimeType: "application/json", text: JSON.stringify(convos || []) },
              ],
            };
          }
          const conv = (convos || []).find((c) => c && String(c.id) === parsed.id);
          if (!conv) {
            return { error: { code: -32602, message: `Conversation not found: ${parsed.id}` } };
          }
          return {
            contents: [
              { uri, mimeType: "application/json", text: JSON.stringify(conv) },
            ],
          };
        }

        case "config": {
          const config = {
            backend: process.env.BACKEND || "ollama",
            ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
            vllmUrl: process.env.VLLM_URL || "http://localhost:8000",
            storageBackend: process.env.STORAGE_BACKEND || "json",
            agentEnabled: true,
            mcpVersion: PROTOCOL_VERSION,
          };
          return {
            contents: [
              { uri, mimeType: "application/json", text: JSON.stringify(config) },
            ],
          };
        }

        default:
          return { error: { code: -32602, message: `Unknown resource type: ${parsed.type}` } };
      }
    }

    case "tools/list": {
      return { tools: MCP_TOOLS };
    }

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};

      switch (toolName) {
        case "search_knowledge": {
          const query = args.query;
          if (typeof query !== "string" || !query.trim()) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "query is required" }) }], isError: true };
          }
          const ws = args.workspace || workspace;
          const result = await knowledgeSearch({ query: query.trim(), workspace: ws });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: !!result.error,
          };
        }

        case "chat_completion": {
          const messages = args.messages;
          if (!Array.isArray(messages) || messages.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "messages array is required" }) }], isError: true };
          }
          if (!ctx.backendFetch || !ctx.buildProxyConfig) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "Chat backend not configured in MCP context" }) }], isError: true };
          }
          const backend = ctx.BACKEND || process.env.BACKEND || "ollama";
          const config = ctx.buildProxyConfig(backend);
          const url = `${config.baseUrl}${config.path}`;
          const modelPresets = ctx.MODEL_PRESETS || {};
          const modelName = args.model || modelPresets[backend]?.[0] || "llama3.2";
          try {
            const resp = await ctx.backendFetch(url, {
              method: "POST",
              headers: { ...config.headers, "Content-Type": "application/json" },
              body: JSON.stringify({ model: modelName, messages, stream: false }),
            });
            const data = await resp.json();
            const text = data.choices?.[0]?.message?.content || JSON.stringify(data);
            return { content: [{ type: "text", text }] };
          } catch (err) {
            return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
          }
        }

        case "run_recipe": {
          const recipeName = args.name;
          if (typeof recipeName !== "string" || !recipeName.trim()) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "name is required" }) }], isError: true };
          }
          const ws = args.workspace || workspace;
          const recipes = await storage.listItems("recipes", ws, userId);
          const q = recipeName.trim().toLowerCase();
          const recipe = (recipes || []).find(
            (r) => r && (String(r.name || "").toLowerCase() === q || String(r.name || "").toLowerCase().includes(q))
          );
          if (!recipe) {
            const names = (recipes || []).filter((r) => r?.name).map((r) => r.name);
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `Recipe "${recipeName}" not found`, available: names }) }],
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ id: recipe.id, name: recipe.name, steps: recipe.steps || [], stepCount: (recipe.steps || []).length }) }],
          };
        }

        case "plan_task": {
          const description = args.description;
          if (typeof description !== "string" || !description.trim()) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "description is required" }) }], isError: true };
          }
          if (!ctx.backendFetch || !ctx.buildProxyConfig) {
            return { content: [{ type: "text", text: JSON.stringify({ error: "Chat backend not configured in MCP context" }) }], isError: true };
          }
          const backend = ctx.BACKEND || process.env.BACKEND || "ollama";
          const config = ctx.buildProxyConfig(backend);
          const url = `${config.baseUrl}${config.path}`;
          const modelPresets = ctx.MODEL_PRESETS || {};
          const modelName = modelPresets[backend]?.[0] || "llama3.2";
          const systemPrompt = `You are a task planning assistant. Given a description, produce a structured task plan as valid JSON. Output format: { "type": "task", "name": "...", "steps": [{ "action": "...", "payload": {} }], "requiresApproval": true }`;
          try {
            const resp = await ctx.backendFetch(url, {
              method: "POST",
              headers: { ...config.headers, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: modelName,
                messages: [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: description.trim() },
                ],
                stream: false,
              }),
            });
            const data = await resp.json();
            const text = data.choices?.[0]?.message?.content || JSON.stringify(data);
            return { content: [{ type: "text", text }] };
          } catch (err) {
            return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
          }
        }

        case "list_workspaces": {
          const uid = args.userId || userId;
          const workspaces = await storage.listWorkspaces(uid);
          return {
            content: [{ type: "text", text: JSON.stringify(workspaces) }],
          };
        }

        default:
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
            isError: true,
          };
      }
    }

    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}
