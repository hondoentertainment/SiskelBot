import "dotenv/config";
import { initErrorReporting } from "./lib/error-reporting.js";
import { loadPlugins } from "./lib/plugins-loader.js";
import { discoverPacks } from "./lib/plugin-marketplace.js";

initErrorReporting();
loadPlugins();
discoverPacks();

const bootUrl = new URL(import.meta.url);
const configuredModuleUrl = new URL("./lib/server-configured-app.js", bootUrl);
configuredModuleUrl.search = bootUrl.search;

const configured = await import(configuredModuleUrl.href);

export const renderAppHtml = configured.renderAppHtml;
export const substituteAppEntry = configured.substituteAppEntry;
export const channelPrefix = configured.channelPrefix;
export const installRealtimeMetricsHooks = configured.installRealtimeMetricsHooks;
export const installDefaultAppRedirect = configured.installDefaultAppRedirect;

const app = configured.default;
export default app;

// Skip binding an HTTP listener on serverless hosts (Vercel exposes the Express app as a function).
const ON_SERVERLESS =
  process.env.VERCEL === "1" ||
  process.env.VERCEL === "true" ||
  Boolean(process.env.VERCEL_ENV || process.env.VERCEL_URL);

if (!ON_SERVERLESS) {
  const listenerModuleUrl = new URL("./lib/server-production-listener.js", bootUrl);
  listenerModuleUrl.search = bootUrl.search;
  const { attachProductionListener } = await import(listenerModuleUrl.href);
  attachProductionListener(app, {
    PORT: configured.PORT,
    BACKEND: configured.BACKEND,
    VLLM_URL: configured.VLLM_URL,
    OLLAMA_URL: configured.OLLAMA_URL,
    installRealtimeMetricsHooks: configured.installRealtimeMetricsHooks,
  });
}
