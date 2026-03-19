/**
 * Phase 17: Plugins & Extensions
 * Loads plugin config from plugins/config.json or PLUGINS_PATH.
 * Schema: { actions: [{ name, type: "webhook"|"builtin", config }] }
 */
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { registerAction, executorRegistry } from "./action-executor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

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
