/**
 * Phase 17: Plugins & Extensions
 * Phase 77: Optional SHA-256 verification of config file (PLUGINS_CONFIG_SHA256).
 * Loads plugin config from plugins/config.json or PLUGINS_PATH.
 * Schema: { actions: [{ name, type: "webhook"|"builtin", config }] }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { registerAction, executorRegistry } from "./action-executor.js";
import {
  registry as marketplaceRegistry,
  installPack as mpInstallPack,
  uninstallPack as mpUninstallPack,
  listInstalled as mpListInstalled,
} from "./plugin-marketplace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const PLUGIN_STATE_PATH = join(PROJECT_ROOT, "data", "plugins-state.json");

/**
 * Load plugins config from plugins/config.json or PLUGINS_PATH.
 * Registers each action. No eval, no require(userPath). Config only.
 */
export function loadPlugins() {
  const pluginsPath = process.env.PLUGINS_PATH
    ? join(process.env.PLUGINS_PATH, "config.json")
    : join(PROJECT_ROOT, "plugins", "config.json");

  if (!existsSync(pluginsPath)) {
    return;
  }

  let raw;
  try {
    raw = readFileSync(pluginsPath, "utf8");
  } catch (e) {
    console.warn("[plugins] Failed to read config:", e.message);
    return;
  }

  const expectedSha = process.env.PLUGINS_CONFIG_SHA256?.trim().toLowerCase();
  if (expectedSha) {
    const actual = createHash("sha256").update(raw, "utf8").digest("hex");
    if (actual !== expectedSha) {
      console.warn("[plugins] Config SHA-256 mismatch; refusing to load (Phase 77). Set PLUGINS_CONFIG_SHA256 to match or unset.");
      return;
    }
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.warn("[plugins] Invalid JSON in config:", e.message);
    return;
  }

  const actions = Array.isArray(data?.actions) ? data.actions : [];
  for (const item of actions) {
    if (!item || typeof item !== "object" || !item.name || typeof item.name !== "string") {
      continue;
    }
    const name = String(item.name).trim().toLowerCase();
    const type = String(item.type || "").toLowerCase();
    const config = item.config && typeof item.config === "object" ? item.config : {};

    if (type === "webhook") {
      const url = config?.url;
      if (!url || typeof url !== "string" || !url.trim()) {
        console.warn(`[plugins] Skipping action "${name}": webhook requires config.url`);
        continue;
      }
      const headers = config?.headers && typeof config.headers === "object" ? config.headers : {};
      const body = config?.body;
      const webhookHandler = executorRegistry.webhook;
      if (!webhookHandler) {
        console.warn(`[plugins] Skipping webhook "${name}": webhook action not available`);
        continue;
      }
      registerAction(name, async (payload, ctx) => {
        const mergedPayload = {
          url: url.trim(),
          headers: { ...headers, ...(payload?.headers || {}) },
          body: body !== undefined ? body : payload?.body,
        };
        return webhookHandler(mergedPayload, ctx);
      });
      console.log(`[plugins] Registered webhook action: ${name}`);
    } else if (type === "builtin") {
      const target = config?.target;
      const targetStr = typeof target === "string" ? target.trim().toLowerCase() : "";
      const builtinHandler = executorRegistry[targetStr];
      if (!builtinHandler) {
        console.warn(`[plugins] Skipping builtin alias "${name}": unknown target "${targetStr}"`);
        continue;
      }
      registerAction(name, builtinHandler);
      console.log(`[plugins] Registered builtin alias: ${name} -> ${targetStr}`);
    }
  }
}

/**
 * Load the per-(workspace,plugin) enabled/error state.
 * Shape: { "<workspaceId>::<pluginId>": { enabled: bool, lastError?: string } }
 */
function readState() {
  if (!existsSync(PLUGIN_STATE_PATH)) return {};
  try {
    const raw = readFileSync(PLUGIN_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(data) {
  const dir = dirname(PLUGIN_STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PLUGIN_STATE_PATH, JSON.stringify(data, null, 2), "utf8");
}

function stateKey(workspaceId, pluginId) {
  return `${workspaceId}::${pluginId}`;
}

/**
 * Return install/enabled state for a plugin in a workspace.
 * @param {string} pluginId
 * @param {string} [workspaceId="default"]
 * @returns {{ installed: boolean, enabled: boolean, version: string|null, lastError?: string }}
 */
export function getInstallState(pluginId, workspaceId = "default") {
  const id = String(pluginId || "").trim();
  const ws = String(workspaceId || "default").trim() || "default";
  const installed = mpListInstalled(ws).some((p) => p.id === id);
  const manifest = marketplaceRegistry.get(id);
  const state = readState()[stateKey(ws, id)] || {};
  const enabled = installed && state.enabled !== false;
  const out = {
    installed,
    enabled,
    version: manifest?.version || null,
  };
  if (state.lastError) out.lastError = state.lastError;
  return out;
}

/**
 * Enable a previously-installed plugin for a workspace.
 * @returns {{ ok: boolean, error?: string }}
 */
export function enable(pluginId, workspaceId = "default") {
  const id = String(pluginId || "").trim();
  const ws = String(workspaceId || "default").trim() || "default";
  if (!id) return { ok: false, error: "pluginId is required" };
  const installed = mpListInstalled(ws).some((p) => p.id === id);
  if (!installed) return { ok: false, error: `Plugin not installed: ${id}` };
  const data = readState();
  const key = stateKey(ws, id);
  data[key] = { ...(data[key] || {}), enabled: true };
  delete data[key].lastError;
  writeState(data);
  return { ok: true };
}

/**
 * Disable a plugin for a workspace (keeps it installed).
 * @returns {{ ok: boolean, error?: string }}
 */
export function disable(pluginId, workspaceId = "default") {
  const id = String(pluginId || "").trim();
  const ws = String(workspaceId || "default").trim() || "default";
  if (!id) return { ok: false, error: "pluginId is required" };
  const installed = mpListInstalled(ws).some((p) => p.id === id);
  if (!installed) return { ok: false, error: `Plugin not installed: ${id}` };
  const data = readState();
  const key = stateKey(ws, id);
  data[key] = { ...(data[key] || {}), enabled: false };
  writeState(data);
  return { ok: true };
}

/**
 * Uninstall a plugin from a workspace and clear its state.
 * @returns {{ ok: boolean, error?: string }}
 */
export function uninstall(pluginId, workspaceId = "default") {
  const id = String(pluginId || "").trim();
  const ws = String(workspaceId || "default").trim() || "default";
  if (!id) return { ok: false, error: "pluginId is required" };
  const result = mpUninstallPack(id, ws);
  if (!result.ok) return result;
  const data = readState();
  delete data[stateKey(ws, id)];
  writeState(data);
  return { ok: true };
}

/**
 * Install a plugin for a workspace (synchronous wrapper).
 * @returns {{ ok: boolean, alreadyInstalled?: boolean, error?: string }}
 */
export function install(pluginId, workspaceId = "default") {
  const id = String(pluginId || "").trim();
  const ws = String(workspaceId || "default").trim() || "default";
  const result = mpInstallPack(id, ws);
  if (!result.ok) return result;
  const data = readState();
  const key = stateKey(ws, id);
  data[key] = { ...(data[key] || {}), enabled: true };
  delete data[key].lastError;
  writeState(data);
  return result;
}

/**
 * Record a last-known error for a plugin (e.g. install failure).
 * Exported for route-level job tracking.
 */
export function setLastError(pluginId, workspaceId, errorMessage) {
  const id = String(pluginId || "").trim();
  const ws = String(workspaceId || "default").trim() || "default";
  if (!id) return;
  const data = readState();
  const key = stateKey(ws, id);
  data[key] = { ...(data[key] || {}), lastError: String(errorMessage || "") };
  writeState(data);
}
