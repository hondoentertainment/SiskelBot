/**
 * MCP client — connects to external MCP servers (stdio or HTTP).
 * Allows SiskelBot to consume tools and resources from remote MCP servers.
 */
import { spawn } from "child_process";
import { randomUUID } from "crypto";

/**
 * @typedef {object} McpConnection
 * @property {string} id - Connection identifier
 * @property {string} type - "stdio" or "http"
 * @property {object} [process] - Child process (stdio)
 * @property {string} [baseUrl] - HTTP base URL
 * @property {object} [serverInfo] - Server info from initialize response
 * @property {boolean} ready - Whether the connection is initialized
 */

/** @type {Map<string, McpConnection>} */
const connections = new Map();

/**
 * Parse MCP_SERVERS env variable into server configs.
 * Format: "stdio:/path/to/server,http:https://example.com/mcp"
 * @param {string} [envValue]
 * @returns {Array<{ type: string, target: string }>}
 */
export function parseMcpServersEnv(envValue) {
  const raw = envValue || process.env.MCP_SERVERS || "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIdx = entry.indexOf(":");
      if (colonIdx < 1) return null;
      const type = entry.slice(0, colonIdx).toLowerCase();
      const target = entry.slice(colonIdx + 1).trim();
      if (!target) return null;
      if (type !== "stdio" && type !== "http") return null;
      return { type, target };
    })
    .filter(Boolean);
}

/**
 * Send a JSON-RPC request over an HTTP MCP connection.
 * @param {string} baseUrl
 * @param {string} method
 * @param {object} [params]
 * @returns {Promise<object>}
 */
async function httpJsonRpc(baseUrl, method, params = {}) {
  const id = randomUUID();
  const resp = await fetch(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });
  if (!resp.ok) {
    throw new Error(`MCP HTTP error ${resp.status}: ${resp.statusText}`);
  }
  const data = await resp.json();
  if (data.error) {
    throw new Error(`MCP error ${data.error.code}: ${data.error.message}`);
  }
  return data.result;
}

/**
 * Send a JSON-RPC request over a stdio MCP connection.
 * @param {import("child_process").ChildProcess} proc
 * @param {string} method
 * @param {object} [params]
 * @param {number} [timeoutMs]
 * @returns {Promise<object>}
 */
function stdioJsonRpc(proc, method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP stdio timeout after ${timeoutMs}ms for ${method}`));
    }, timeoutMs);

    let buffer = "";

    function onData(chunk) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) {
            cleanup();
            if (parsed.error) {
              reject(new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`));
            } else {
              resolve(parsed.result);
            }
            return;
          }
        } catch (_) {
          // skip non-JSON lines
        }
      }
      buffer = lines[lines.length - 1];
    }

    function cleanup() {
      clearTimeout(timer);
      proc.stdout.removeListener("data", onData);
    }

    proc.stdout.on("data", onData);
    proc.stdin.write(msg);
  });
}

/**
 * Connect to an MCP server.
 * @param {{ type: string, target: string, env?: object }} config
 * @returns {Promise<McpConnection>}
 */
export async function connectToMcpServer(config) {
  const connId = randomUUID();

  if (config.type === "http") {
    const result = await httpJsonRpc(config.target, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "siskelbot", version: "1.0.0" },
      capabilities: {},
    });
    const conn = {
      id: connId,
      type: "http",
      baseUrl: config.target,
      serverInfo: result?.serverInfo || null,
      ready: true,
    };
    connections.set(connId, conn);
    return conn;
  }

  if (config.type === "stdio") {
    const parts = config.target.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    const proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(config.env || {}) },
    });

    proc.on("error", (err) => {
      console.error(`[mcp-client] stdio process error: ${err.message}`);
    });

    const conn = {
      id: connId,
      type: "stdio",
      process: proc,
      serverInfo: null,
      ready: false,
    };

    try {
      const result = await stdioJsonRpc(proc, "initialize", {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "siskelbot", version: "1.0.0" },
        capabilities: {},
      });
      conn.serverInfo = result?.serverInfo || null;
      conn.ready = true;
    } catch (err) {
      proc.kill();
      throw new Error(`MCP stdio init failed: ${err.message}`, { cause: err });
    }

    connections.set(connId, conn);
    return conn;
  }

  throw new Error(`Unsupported MCP transport type: ${config.type}`);
}

/**
 * List tools from a connected MCP server.
 * @param {McpConnection} connection
 * @returns {Promise<Array<{ name: string, description: string, inputSchema: object }>>}
 */
export async function listTools(connection) {
  if (!connection || !connection.ready) {
    throw new Error("MCP connection not ready");
  }
  const result =
    connection.type === "http"
      ? await httpJsonRpc(connection.baseUrl, "tools/list")
      : await stdioJsonRpc(connection.process, "tools/list");
  return result?.tools || [];
}

/**
 * Call a tool on a connected MCP server.
 * @param {McpConnection} connection
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @returns {Promise<object>}
 */
export async function callTool(connection, name, args = {}) {
  if (!connection || !connection.ready) {
    throw new Error("MCP connection not ready");
  }
  const result =
    connection.type === "http"
      ? await httpJsonRpc(connection.baseUrl, "tools/call", { name, arguments: args })
      : await stdioJsonRpc(connection.process, "tools/call", { name, arguments: args });
  return result;
}

/**
 * List resources from a connected MCP server.
 * @param {McpConnection} connection
 * @returns {Promise<Array<object>>}
 */
export async function listResources(connection) {
  if (!connection || !connection.ready) {
    throw new Error("MCP connection not ready");
  }
  const result =
    connection.type === "http"
      ? await httpJsonRpc(connection.baseUrl, "resources/list")
      : await stdioJsonRpc(connection.process, "resources/list");
  return result?.resources || [];
}

/**
 * Read a resource from a connected MCP server.
 * @param {McpConnection} connection
 * @param {string} uri - Resource URI
 * @returns {Promise<object>}
 */
export async function readResource(connection, uri) {
  if (!connection || !connection.ready) {
    throw new Error("MCP connection not ready");
  }
  const result =
    connection.type === "http"
      ? await httpJsonRpc(connection.baseUrl, "resources/read", { uri })
      : await stdioJsonRpc(connection.process, "resources/read", { uri });
  return result;
}

/**
 * Disconnect from an MCP server.
 * @param {McpConnection} connection
 */
export function disconnect(connection) {
  if (!connection) return;
  if (connection.type === "stdio" && connection.process) {
    connection.process.kill();
  }
  connection.ready = false;
  connections.delete(connection.id);
}

/**
 * Get all active connections.
 * @returns {McpConnection[]}
 */
export function getActiveConnections() {
  return [...connections.values()].filter((c) => c.ready);
}
