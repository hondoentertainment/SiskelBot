/**
 * Phase 17.1: Sandboxed JS Plugin Runtime
 * Uses Node.js worker_threads for isolated plugin execution.
 * Exports: loadPlugin, executePlugin, listPlugins, unloadPlugin
 */
import { Worker } from "worker_threads";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(__dirname, "plugin-worker.js");

const PLUGIN_TIMEOUT_MS = Math.max(1000, Number(process.env.PLUGIN_TIMEOUT_MS) || 30_000);
const PLUGIN_MEMORY_MB = Math.max(8, Number(process.env.PLUGIN_MEMORY_MB) || 64);

/**
 * In-memory registry of loaded plugins.
 * Key: pluginId, Value: { id, name, version, description, path }
 */
const _plugins = new Map();

/**
 * Validate and load a JS plugin file.
 * The plugin module must export: { name, version, description, execute }
 * @param {string} pluginPath - Absolute or relative path to the .js plugin file
 * @returns {Promise<{ id: string; name: string; version: string; description: string }>}
 */
export async function loadPlugin(pluginPath) {
  const absPath = resolve(pluginPath);
  if (!existsSync(absPath)) {
    throw new Error(`Plugin file not found: ${absPath}`);
  }

  // Quick validation: dynamically import to check exports (in main thread for validation only)
  const moduleUrl = pathToFileURL(absPath).href;
  let mod;
  try {
    mod = await import(moduleUrl);
  } catch (err) {
    throw new Error(`Failed to import plugin ${absPath}: ${err.message}`, { cause: err });
  }

  if (typeof mod.name !== "string" || !mod.name.trim()) {
    throw new Error("Plugin must export a non-empty 'name' string");
  }
  if (typeof mod.version !== "string" || !mod.version.trim()) {
    throw new Error("Plugin must export a non-empty 'version' string");
  }
  if (typeof mod.execute !== "function") {
    throw new Error("Plugin must export an 'execute' function");
  }

  const id = mod.name.trim().toLowerCase().replace(/\s+/g, "-");
  const meta = {
    id,
    name: mod.name.trim(),
    version: mod.version.trim(),
    description: typeof mod.description === "string" ? mod.description.trim() : "",
    path: absPath,
  };

  _plugins.set(id, meta);
  return meta;
}

/**
 * Execute a loaded plugin in a sandboxed worker thread.
 * @param {string} pluginId - The plugin ID (from loadPlugin)
 * @param {{ input?: string; workspaceId?: string; userId?: string; config?: object }} context
 * @returns {Promise<{ output: string; metadata?: object }>}
 */
export async function executePlugin(pluginId, context = {}) {
  const plugin = _plugins.get(pluginId);
  if (!plugin) {
    throw new Error(`Plugin not loaded: ${pluginId}`);
  }

  const pluginFileUrl = pathToFileURL(plugin.path).href;

  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        pluginPath: pluginFileUrl,
        context: {
          input: context.input ?? "",
          workspaceId: context.workspaceId ?? null,
          userId: context.userId ?? null,
          config: context.config ?? {},
        },
      },
      resourceLimits: {
        maxOldGenerationSizeMb: PLUGIN_MEMORY_MB,
        maxYoungGenerationSizeMb: Math.ceil(PLUGIN_MEMORY_MB / 4),
      },
    });

    const timeout = setTimeout(() => {
      worker.terminate();
      rejectPromise(new Error(`Plugin "${pluginId}" timed out after ${PLUGIN_TIMEOUT_MS}ms`));
    }, PLUGIN_TIMEOUT_MS);

    worker.on("message", (msg) => {
      clearTimeout(timeout);
      if (msg.ok) {
        resolvePromise(msg.result);
      } else {
        rejectPromise(new Error(msg.error || "Plugin execution failed"));
      }
      worker.terminate();
    });

    worker.on("error", (err) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`Plugin worker error: ${err.message}`));
    });

    worker.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectPromise(new Error(`Plugin worker exited with code ${code}`));
      }
    });
  });
}

/**
 * List all loaded plugins with metadata.
 * @returns {{ id: string; name: string; version: string; description: string }[]}
 */
export function listPlugins() {
  return Array.from(_plugins.values()).map(({ id, name, version, description }) => ({
    id,
    name,
    version,
    description,
  }));
}

/**
 * Unload a plugin by ID.
 * @param {string} pluginId
 * @returns {boolean} true if removed, false if not found
 */
export function unloadPlugin(pluginId) {
  return _plugins.delete(pluginId);
}
