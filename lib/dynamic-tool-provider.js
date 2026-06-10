/**
 * Dynamic tool provisioning — resolves a tool set from static + MCP sources.
 *
 * Parent agents can specify tools per child at spawn time, including MCP tools
 * discovered from connected MCP servers.
 *
 * @module dynamic-tool-provider
 */

import { TOOLS, applyAgentToolsAllowlist } from "./agent-tools.js";
import {
  parseMcpServersEnv,
  connectToMcpServer,
  listTools as mcpListTools,
  getActiveConnections,
  disconnect,
} from "./mcp-client.js";

/**
 * Per-server MCP tool cache.
 * Map<serverUrl, { tools: McpTool[], fetchedAt: number }>
 */
const mcpToolCache = new Map();

/** Cache TTL in milliseconds. */
const CACHE_TTL_MS = 60_000;

/**
 * Convert an MCP tool (name, description, inputSchema) into OpenAI
 * function-calling schema format.
 * @param {{ name: string, description?: string, inputSchema?: object }} mcpTool
 * @param {string} [serverUrl]
 * @returns {{ type: "function", function: { name: string, description: string, parameters: object }, _source: "mcp", _serverUrl?: string }}
 */
function toOpenAiFunctionSchema(mcpTool, serverUrl) {
  return {
    type: "function",
    function: {
      name: mcpTool.name,
      description: mcpTool.description || "",
      parameters: mcpTool.inputSchema || { type: "object", properties: {} },
    },
    _source: "mcp",
    _serverUrl: serverUrl || undefined,
  };
}

/**
 * Discover tools from MCP servers configured via MCP_SERVERS env or already
 * connected. Results are cached for 60 seconds per server URL to avoid
 * repeated network calls.
 *
 * @param {string} [workspace] - Workspace identifier (reserved for future per-workspace MCP config).
 * @returns {Promise<Array<{ type: "function", function: { name: string, description: string, parameters: object }, _source: "mcp", _serverUrl?: string }>>}
 */
export async function discoverMcpTools(workspace) {
  const allTools = [];

  // 1. Try already-active connections
  const active = getActiveConnections();
  for (const conn of active) {
    const cacheKey = conn.baseUrl || conn.id;
    const cached = mcpToolCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      allTools.push(...cached.tools);
      continue;
    }
    try {
      const raw = await mcpListTools(conn);
      const tools = (raw || []).map((t) => toOpenAiFunctionSchema(t, conn.baseUrl));
      mcpToolCache.set(cacheKey, { tools, fetchedAt: Date.now() });
      allTools.push(...tools);
    } catch {
      // Connection may be stale; skip.
    }
  }

  // 2. Parse MCP_SERVERS env + runtime-registered servers not already connected
  const serverConfigs = [...parseMcpServersEnv()];
  try {
    const { getRegistryServerConfigs } = await import("./mcp-registry.js");
    const registryConfigs = await getRegistryServerConfigs();
    for (const cfg of registryConfigs) {
      if (!serverConfigs.some((c) => c.type === cfg.type && c.target === cfg.target)) {
        serverConfigs.push(cfg);
      }
    }
  } catch {
    // registry optional — fall back to env-only
  }
  const activeUrls = new Set(active.map((c) => c.baseUrl).filter(Boolean));

  for (const cfg of serverConfigs) {
    if (cfg.type === "http" && activeUrls.has(cfg.target)) continue;

    const cacheKey = cfg.target;
    const cached = mcpToolCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      allTools.push(...cached.tools);
      continue;
    }

    let conn;
    try {
      conn = await connectToMcpServer(cfg);
      const raw = await mcpListTools(conn);
      const tools = (raw || []).map((t) => toOpenAiFunctionSchema(t, cfg.target));
      mcpToolCache.set(cacheKey, { tools, fetchedAt: Date.now() });
      allTools.push(...tools);
    } catch {
      // Server unreachable — skip silently.
    }
  }

  return allTools;
}

/**
 * Merge static tools with MCP tools. Static tools win on name conflict.
 *
 * @param {Array<{ type: string, function: { name: string, [k: string]: any } }>} staticTools
 * @param {Array<{ type: string, function: { name: string, [k: string]: any }, _source?: string, _serverUrl?: string }>} mcpTools
 * @returns {Array<{ type: string, function: { name: string, [k: string]: any } }>}
 */
export function mergeToolSets(staticTools, mcpTools) {
  const seen = new Set();
  const merged = [];

  // Static tools first — they win on conflict
  for (const t of staticTools) {
    const name = t?.function?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    merged.push(t);
  }

  // MCP tools second — skip duplicates
  for (const t of mcpTools) {
    const name = t?.function?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    merged.push(t);
  }

  return merged;
}

/**
 * Resolve a complete tool set from static tools + optional MCP discovery,
 * then apply allowlist/denylist filters.
 *
 * @param {{
 *   allowlist?: string[],
 *   denylist?: string[],
 *   includeMcp?: boolean,
 *   workspace?: string,
 * }} [opts]
 * @returns {Promise<Array<{ type: string, function: { name: string, [k: string]: any } }>>}
 */
export async function resolveToolSet(opts = {}) {
  const { allowlist, denylist, includeMcp = false, workspace } = opts;

  // Start with static TOOLS (already filtered by AGENT_TOOLS_ALLOWLIST)
  let tools = applyAgentToolsAllowlist(TOOLS);

  // Optionally merge MCP-discovered tools
  if (includeMcp) {
    const mcpTools = await discoverMcpTools(workspace);
    tools = mergeToolSets(tools, mcpTools);
  }

  // Apply allowlist (keep only listed)
  if (Array.isArray(allowlist) && allowlist.length > 0) {
    const allowed = new Set(allowlist.map((n) => String(n).trim()).filter(Boolean));
    tools = tools.filter((t) => t?.function?.name && allowed.has(t.function.name));
  }

  // Apply denylist (remove listed)
  if (Array.isArray(denylist) && denylist.length > 0) {
    const denied = new Set(denylist.map((n) => String(n).trim()).filter(Boolean));
    tools = tools.filter((t) => !(t?.function?.name && denied.has(t.function.name)));
  }

  return tools;
}

/**
 * Clear the MCP tool cache. Useful for testing.
 */
export function clearMcpToolCache() {
  mcpToolCache.clear();
}

/**
 * Get the current cache contents (for testing / debugging).
 * @returns {Map<string, { tools: any[], fetchedAt: number }>}
 */
export function getMcpToolCache() {
  return mcpToolCache;
}
