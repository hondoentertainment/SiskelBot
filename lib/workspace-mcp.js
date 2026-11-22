/**
 * Workspace-scoped MCP servers.
 * Registration is stored per workspace. Calling tools is off unless
 * WORKSPACE_MCP_ENABLED=1 and the server itself is enabled. Every call
 * goes through the agent policy network budget.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { sanitizeWorkspace, sanitizeUserId } from "./storage.js";
import { getSecretValue } from "./secrets-store.js";
import { loadWorkspaceAgentSettings } from "./workspace-agent-settings.js";
import {
  checkPolicyBeforeTool,
  createPolicyState,
  resolveEffectivePolicy,
  recordPolicyToolCompletion,
} from "./agent-policy.js";
import { validatePublicHttpsUrl } from "./ssrf-guard.js";

export function workspaceMcpDeploymentEnabled() {
  return process.env.WORKSPACE_MCP_ENABLED === "1";
}

export function workspaceMcpStdioEnabled() {
  return process.env.WORKSPACE_MCP_STDIO === "1";
}

export function stdioCommandAllowlist() {
  return String(process.env.WORKSPACE_MCP_STDIO_ALLOWLIST || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Local stdio servers are operator-only. The command must be a bare name on
 * WORKSPACE_MCP_STDIO_ALLOWLIST. No shell and no path is accepted.
 */
export function validateStdioCommand(command, args = []) {
  if (!workspaceMcpStdioEnabled()) {
    return { ok: false, error: "stdio MCP is disabled. Set WORKSPACE_MCP_STDIO=1" };
  }
  const allow = stdioCommandAllowlist();
  if (!allow.length) return { ok: false, error: "WORKSPACE_MCP_STDIO_ALLOWLIST is required" };
  const cmd = String(command || "").trim();
  if (!cmd || /[/\\]/.test(cmd) || /[;&|`$<>\s]/.test(cmd)) {
    return { ok: false, error: "command must be a bare executable name" };
  }
  if (!allow.includes(cmd)) return { ok: false, error: "command is not on the stdio allowlist" };
  const argv = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  if (argv.length > 12) return { ok: false, error: "too many arguments" };
  if (argv.some((arg) => /[\n\r\0]/.test(arg) || arg.length > 200)) {
    return { ok: false, error: "invalid argument" };
  }
  return { ok: true, command: cmd, args: argv };
}

function storePath(workspaceId) {
  return join(getDataDir(), "mcp-workspaces", `${sanitizeWorkspace(workspaceId)}.json`);
}

export function validateMcpUrl(url, allowedHosts) {
  const check = validatePublicHttpsUrl(url);
  if (!check.ok) {
    if (check.error === "only https URLs are allowed") return { ok: false, error: "only https MCP servers are allowed" };
    return { ok: false, error: check.error };
  }
  const host = check.host;
  const hosts = (Array.isArray(allowedHosts) ? allowedHosts : [])
    .map((h) => String(h || "").trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.length) return { ok: false, error: "allowedHosts is required" };
  if (!hosts.includes(host)) return { ok: false, error: "host is not in allowedHosts" };
  return { ok: true, host };
}

export function workspaceMcpToolName(serverId, toolName) {
  const id = String(serverId || "").replace(/-/g, "");
  const tool = String(toolName || "").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
  return `wmcp_${id}_${tool}`;
}

export function parseWorkspaceMcpToolName(name) {
  const match = String(name || "").match(/^wmcp_([0-9a-f]{32})_(.+)$/i);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const serverId = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  return { serverId, toolKey: match[2] };
}

function toPublic(server) {
  return {
    id: server.id,
    name: server.name,
    type: server.type === "stdio" ? "stdio" : "http",
    url: server.url || "",
    command: server.command || "",
    args: Array.isArray(server.args) ? server.args : [],
    allowedHosts: server.allowedHosts || [],
    enabled: server.enabled === true,
    authConfigured: Boolean(server.authSecretName),
    toolCount: Array.isArray(server.tools) ? server.tools.length : 0,
    tools: (server.tools || []).map((t) => ({
      name: t.exposedName,
      originalName: t.originalName,
      description: t.description || "",
    })),
    createdAt: server.createdAt,
  };
}

async function readStore(workspaceId) {
  const store = await readJsonPath(storePath(workspaceId), { servers: [] });
  if (!store || !Array.isArray(store.servers)) return { servers: [] };
  return store;
}

export async function listWorkspaceMcpServers(workspaceId) {
  const store = await readStore(workspaceId);
  return store.servers.map(toPublic);
}

export async function registerWorkspaceMcpServer(workspaceId, input = {}) {
  const type = input.type === "stdio" ? "stdio" : "http";
  let record;
  if (type === "stdio") {
    const check = validateStdioCommand(input.command, input.args);
    if (!check.ok) {
      const err = new Error(check.error);
      err.code = "INVALID_INPUT";
      throw err;
    }
    record = {
      id: randomUUID(),
      type: "stdio",
      name: String(input.name || check.command).trim().slice(0, 120) || check.command,
      url: "",
      command: check.command,
      args: check.args,
      allowedHosts: [],
      enabled: input.enabled === true,
      authSecretName: "",
      tools: [],
      createdAt: new Date().toISOString(),
    };
  } else {
    const allowedHosts = Array.isArray(input.allowedHosts)
      ? input.allowedHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean).slice(0, 20)
      : [];
    const check = validateMcpUrl(input.url, allowedHosts);
    if (!check.ok) {
      const err = new Error(check.error);
      err.code = "INVALID_INPUT";
      throw err;
    }
    record = {
      id: randomUUID(),
      type: "http",
      name: String(input.name || check.host).trim().slice(0, 120) || check.host,
      url: String(input.url).trim(),
      command: "",
      args: [],
      allowedHosts,
      enabled: input.enabled === true,
      authSecretName: typeof input.authSecretName === "string" ? input.authSecretName.trim().slice(0, 80) : "",
      tools: [],
      createdAt: new Date().toISOString(),
    };
  }
  const path = storePath(workspaceId);
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, { servers: [] });
    if (!Array.isArray(store.servers)) store.servers = [];
    if (store.servers.length >= 20) {
      const err = new Error("Maximum number of workspace MCP servers reached");
      err.code = "LIMIT_EXCEEDED";
      throw err;
    }
    store.servers.push(record);
    await writeJsonPath(path, store);
  });
  return toPublic(record);
}

export async function deleteWorkspaceMcpServer(workspaceId, serverId) {
  const path = storePath(workspaceId);
  let removed = false;
  await withPathLock(path, async () => {
    const store = await readJsonPath(path, { servers: [] });
    const before = Array.isArray(store.servers) ? store.servers.length : 0;
    store.servers = (store.servers || []).filter((s) => s.id !== serverId);
    removed = store.servers.length < before;
    if (removed) await writeJsonPath(path, store);
  });
  return removed;
}

async function authHeaders(workspaceId, server) {
  if (!server.authSecretName) return {};
  const secret = await getSecretValue("workspace", sanitizeWorkspace(workspaceId), server.authSecretName);
  if (!secret) return {};
  return { Authorization: `Bearer ${secret}` };
}

function connectionConfig(server, headers) {
  if (server.type === "stdio") {
    const check = validateStdioCommand(server.command, server.args);
    if (!check.ok) {
      const err = new Error(check.error);
      err.code = "MCP_STDIO_DISABLED";
      throw err;
    }
    return {
      type: "stdio",
      command: check.command,
      args: check.args,
      target: check.command,
      restrictedEnv: true,
    };
  }
  const check = validateMcpUrl(server.url, server.allowedHosts);
  if (!check.ok) {
    const err = new Error(check.error);
    err.code = "SSRF_BLOCKED";
    throw err;
  }
  return { type: "http", target: server.url, headers };
}

async function defaultListTools(server, headers) {
  const { connectToMcpServer, listTools, disconnect } = await import("./mcp-client.js");
  const conn = await connectToMcpServer(connectionConfig(server, headers));
  try {
    return await listTools(conn);
  } finally {
    try { disconnect(conn); } catch { /* ignore */ }
  }
}

export async function discoverWorkspaceMcpTools(workspaceId, serverId, deps = {}) {
  if (!workspaceMcpDeploymentEnabled()) {
    const err = new Error("Workspace MCP is disabled. Set WORKSPACE_MCP_ENABLED=1");
    err.code = "MCP_DISABLED";
    throw err;
  }
  const path = storePath(workspaceId);
  const store = await readStore(workspaceId);
  const server = store.servers.find((s) => s.id === serverId);
  if (!server) {
    const err = new Error("Server not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (server.enabled !== true) {
    const err = new Error("Enable the server before discovering tools");
    err.code = "MCP_SERVER_DISABLED";
    throw err;
  }
  const headers = await authHeaders(workspaceId, server);
  const listTools = deps.listTools || defaultListTools;
  const raw = await listTools(server, headers);
  const tools = (Array.isArray(raw) ? raw : []).slice(0, 40).map((tool) => ({
    originalName: String(tool.name || "").slice(0, 80),
    exposedName: workspaceMcpToolName(server.id, tool.name),
    description: String(tool.description || tool.name || "").slice(0, 300),
    inputSchema: tool.inputSchema && typeof tool.inputSchema === "object"
      ? tool.inputSchema
      : { type: "object", properties: {} },
  })).filter((t) => t.originalName);
  await withPathLock(path, async () => {
    const fresh = await readJsonPath(path, { servers: [] });
    const row = (fresh.servers || []).find((s) => s.id === serverId);
    if (!row) return;
    row.tools = tools;
    await writeJsonPath(path, fresh);
  });
  return tools.map((t) => ({ name: t.exposedName, originalName: t.originalName, description: t.description }));
}

export async function workspaceMcpToolDefs(workspaceId) {
  if (!workspaceMcpDeploymentEnabled()) return [];
  const store = await readStore(workspaceId);
  const defs = [];
  for (const server of store.servers) {
    if (server.enabled !== true) continue;
    for (const tool of server.tools || []) {
      defs.push({
        type: "function",
        function: {
          name: tool.exposedName,
          description: `[MCP ${server.name}] ${tool.description || tool.originalName}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
      });
    }
  }
  return defs;
}

async function defaultCallTool(server, headers, originalName, args) {
  const { connectToMcpServer, callTool, disconnect } = await import("./mcp-client.js");
  const conn = await connectToMcpServer(connectionConfig(server, headers));
  try {
    return await callTool(conn, originalName, args || {});
  } finally {
    try { disconnect(conn); } catch { /* ignore */ }
  }
}

export async function invokeWorkspaceMcpTool(name, args, ctx = {}, deps = {}) {
  const parsed = parseWorkspaceMcpToolName(name);
  if (!parsed) {
    return { content: JSON.stringify({ ok: false, code: "UNKNOWN_TOOL", error: `Unknown tool: ${name}` }), ok: false };
  }
  if (!workspaceMcpDeploymentEnabled()) {
    return {
      content: JSON.stringify({ ok: false, code: "MCP_DISABLED", error: "Workspace MCP is disabled. Set WORKSPACE_MCP_ENABLED=1" }),
      ok: false,
    };
  }
  const workspace = ctx.workspace || "default";
  const store = await readStore(workspace);
  const server = store.servers.find((s) => s.id === parsed.serverId);
  const tool = server?.tools?.find((t) => t.exposedName === name);
  if (!server || !tool) {
    return { content: JSON.stringify({ ok: false, code: "NOT_FOUND", error: "MCP tool is not registered" }), ok: false };
  }
  if (server.enabled !== true) {
    return { content: JSON.stringify({ ok: false, code: "MCP_SERVER_DISABLED", error: "MCP server is disabled" }), ok: false };
  }
  if (server.type === "stdio" && !workspaceMcpStdioEnabled()) {
    return {
      content: JSON.stringify({ ok: false, code: "MCP_STDIO_DISABLED", error: "stdio MCP is disabled. Set WORKSPACE_MCP_STDIO=1" }),
      ok: false,
    };
  }
  const uid = sanitizeUserId(ctx.workspaceUserId || "anonymous");
  const settings = await loadWorkspaceAgentSettings(uid, workspace);
  const state = createPolicyState(resolveEffectivePolicy(settings.agentPolicy || {}), {
    deniedTools: settings.agentPolicy?.deniedTools || [],
  });
  const verdict = checkPolicyBeforeTool(state, name, args);
  if (!verdict.ok) {
    return { content: JSON.stringify({ ok: false, code: verdict.code, error: verdict.reason }), ok: false };
  }
  const started = Date.now();
  try {
    const headers = await authHeaders(workspace, server);
    const call = deps.callTool || defaultCallTool;
    const result = await call(server, headers, tool.originalName, args || {});
    recordPolicyToolCompletion(state, name, Date.now() - started);
    const text = typeof result === "string" ? result : JSON.stringify(result);
    return { content: text.slice(0, 8000), ok: true };
  } catch (err) {
    return { content: JSON.stringify({ ok: false, code: "MCP_CALL_FAILED", error: err.message }), ok: false };
  }
}
