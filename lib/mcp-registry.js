/**
 * Durable registry of external MCP servers.
 *
 * The MCP client (lib/mcp-client.js) can connect to servers, but on its own
 * only knows about the MCP_SERVERS env var (which requires a restart to
 * change). This registry persists server registrations and lets them be
 * added/removed at runtime, connecting immediately so their tools become
 * available to agents without a restart (discoverMcpTools reads the active
 * connections this module creates).
 *
 * Storage: data/mcp-servers.json (deployment-global)
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { connectToMcpServer, disconnect, listTools, parseMcpServersEnv } from "./mcp-client.js";

const MAX_SERVERS = 100;
const VALID_TYPES = new Set(["stdio", "http"]);

/** id -> live McpConnection */
const liveConnections = new Map();

function storePath() {
  return join(getDataDir(), "mcp-servers.json");
}

function normalize(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.servers)) return raw;
  return { servers: [] };
}

function toPublic(server) {
  return { ...server, connected: liveConnections.has(server.id) };
}

/**
 * List all registered servers with live connection status.
 */
export async function listServers() {
  const store = normalize(await readJsonPath(storePath(), null));
  return store.servers.map(toPublic);
}

/**
 * Register (and by default connect to) an MCP server.
 * @param {{ name?: string, type: string, target: string, env?: object, enabled?: boolean, connect?: boolean }} config
 * @returns {Promise<{ server: object, connected: boolean, tools: object[]|null, error: string|null }>}
 */
export async function registerServer(config) {
  const type = String(config.type || "").toLowerCase().trim();
  const target = typeof config.target === "string" ? config.target.trim() : "";
  if (!VALID_TYPES.has(type)) throw new Error(`type must be one of: ${[...VALID_TYPES].join(", ")}`);
  if (!target) throw new Error("target is required");

  const path = storePath();
  let record = null;
  let existing = false;

  await withPathLock(path, async () => {
    const store = normalize(await readJsonPath(path, null));
    const dup = store.servers.find((s) => s.type === type && s.target === target);
    if (dup) {
      record = dup;
      existing = true;
      return;
    }
    if (store.servers.length >= MAX_SERVERS) throw new Error("Maximum number of MCP servers reached");
    const now = new Date().toISOString();
    record = {
      id: randomUUID(),
      name: typeof config.name === "string" ? config.name.trim().slice(0, 200) : target.slice(0, 200),
      type,
      target,
      env: config.env && typeof config.env === "object" ? config.env : null,
      enabled: config.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    store.servers.push(record);
    await writeJsonPath(path, store);
  });

  let connected = false;
  let tools = null;
  let error = null;

  if (config.connect !== false && record.enabled && !liveConnections.has(record.id)) {
    try {
      const conn = await connectToMcpServer({ type: record.type, target: record.target, env: record.env || undefined });
      liveConnections.set(record.id, conn);
      connected = true;
      tools = await listTools(conn).catch(() => null);
    } catch (e) {
      error = e.message;
    }
  } else if (liveConnections.has(record.id)) {
    connected = true;
  }

  return { server: toPublic(record), connected, tools, error, existing };
}

/**
 * Connect to an already-registered server.
 */
export async function connectServer(id) {
  const store = normalize(await readJsonPath(storePath(), null));
  const server = store.servers.find((s) => s.id === id);
  if (!server) return { ok: false, error: "Server not found" };
  if (liveConnections.has(id)) return { ok: true, connected: true, alreadyConnected: true };
  try {
    const conn = await connectToMcpServer({ type: server.type, target: server.target, env: server.env || undefined });
    liveConnections.set(id, conn);
    const tools = await listTools(conn).catch(() => null);
    return { ok: true, connected: true, tools };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Disconnect a live server connection (keeps the registration).
 */
export function disconnectServer(id) {
  const conn = liveConnections.get(id);
  if (!conn) return false;
  try {
    disconnect(conn);
  } catch { /* best-effort */ }
  liveConnections.delete(id);
  return true;
}

/**
 * Unregister a server: disconnect (if live) and remove from the store.
 */
export async function unregisterServer(id) {
  disconnectServer(id);
  const path = storePath();
  let removed = false;
  await withPathLock(path, async () => {
    const store = normalize(await readJsonPath(path, null));
    const before = store.servers.length;
    store.servers = store.servers.filter((s) => s.id !== id);
    if (store.servers.length < before) {
      removed = true;
      await writeJsonPath(path, store);
    }
  });
  return removed;
}

/**
 * List tools from a registered server, connecting on demand if needed.
 */
export async function discoverServerTools(id) {
  if (!liveConnections.has(id)) {
    const res = await connectServer(id);
    if (!res.ok) throw new Error(res.error || "Could not connect to server");
  }
  const conn = liveConnections.get(id);
  return listTools(conn);
}

/**
 * Server configs (type/target/env) for all enabled, registered servers.
 * Used by the tool-discovery path so persisted registrations are honored
 * across restarts.
 */
export async function getRegistryServerConfigs() {
  const store = normalize(await readJsonPath(storePath(), null));
  return store.servers
    .filter((s) => s.enabled)
    .map((s) => ({ type: s.type, target: s.target, env: s.env || undefined }));
}

/**
 * Connect all enabled persisted servers plus any from MCP_SERVERS env.
 * Best-effort; intended to run once at startup. Returns a summary.
 */
export async function initRegistry() {
  const store = normalize(await readJsonPath(storePath(), null));
  let connected = 0;
  for (const server of store.servers.filter((s) => s.enabled)) {
    const res = await connectServer(server.id).catch(() => ({ ok: false }));
    if (res.ok) connected++;
  }
  // Ensure env-declared servers are registered too (idempotent).
  for (const cfg of parseMcpServersEnv()) {
    try {
      await registerServer({ ...cfg, connect: true });
    } catch { /* best-effort */ }
  }
  return { registered: store.servers.length, connected };
}

/** Test helper. */
export function __getLiveConnectionsForTests() {
  return liveConnections;
}
