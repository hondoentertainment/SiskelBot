import "dotenv/config";
import { initErrorReporting } from "./lib/error-reporting.js";
import { loadPlugins } from "./lib/plugins-loader.js";
import { discoverPacks } from "./lib/plugin-marketplace.js";

initErrorReporting();
loadPlugins();
discoverPacks();

// Use relative specifiers (not file:// URLs from `new URL`) so Vercel's Node
// bundler traces and ships these modules — absolute paths break at /var/task.
const configured = await import("./lib/server-configured-app.js");

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
  const { attachProductionListener } = await import("./lib/server-production-listener.js");
  attachProductionListener(app, {
    PORT: configured.PORT,
    BACKEND: configured.BACKEND,
    VLLM_URL: configured.VLLM_URL,
    OLLAMA_URL: configured.OLLAMA_URL,
    installRealtimeMetricsHooks: configured.installRealtimeMetricsHooks,
  });
}
