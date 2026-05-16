/**
 * Synchronous startup config validation.
 *
 * Distinct from lib/startup-checks.js, which performs async network-reachability
 * probes against configured integrations. This module validates that required
 * environment variables are present before the server begins wiring routes,
 * and refuses to start (process.exit(1)) on fatal misconfiguration.
 *
 * Extracted from server.js so the entry point reads as a composition root.
 */
import { isOAuthConfigured } from "./oauth.js";

/**
 * Validate startup configuration. Exits the process on a fatal production
 * misconfiguration; otherwise logs warnings for recommended-but-missing vars.
 *
 * @param {object} cfg
 * @param {boolean} cfg.IS_PRODUCTION
 * @param {string|undefined} cfg.API_KEY
 * @param {string} cfg.BACKEND
 * @param {string|undefined} cfg.OPENAI_API_KEY
 */
export function validateStartupConfig({ IS_PRODUCTION, API_KEY, BACKEND, OPENAI_API_KEY }) {
  // Production security: refuse to start if API_KEY not set (unless explicitly bypassed)
  if (IS_PRODUCTION && !API_KEY) {
    if (process.env.ALLOW_INSECURE_PRODUCTION === "1") {
      console.warn(
        "[SECURITY] NODE_ENV=production but API_KEY is not set. " +
          "The /v1/chat/completions endpoint is publicly accessible. " +
          "Continuing because ALLOW_INSECURE_PRODUCTION=1."
      );
    } else {
      console.error(
        "[SECURITY] NODE_ENV=production but API_KEY is not set. " +
          "The /v1/chat/completions endpoint is publicly accessible. " +
          "Set API_KEY in Vercel env vars to protect it. " +
          "Set ALLOW_INSECURE_PRODUCTION=1 to bypass this check."
      );
      process.exit(1);
    }
  }

  // Phase 34: Startup config validation
  const requiredMissing = [];
  if (BACKEND === "openai" && !OPENAI_API_KEY) {
    requiredMissing.push("OPENAI_API_KEY (required when BACKEND=openai)");
  }
  if (IS_PRODUCTION && requiredMissing.length > 0) {
    console.error("[startup] Required env vars missing:", requiredMissing.join("; "));
    process.exit(1);
  }
  if (isOAuthConfigured() && !process.env.SESSION_SECRET) {
    console.warn("[startup] OAuth configured but SESSION_SECRET not set.");
  }
  if (IS_PRODUCTION && process.env.ALLOW_RECIPE_STEP_EXECUTION === "1" && !process.env.VERCEL_TOKEN) {
    console.warn("[startup] Recipe execution enabled; VERCEL_TOKEN recommended for deploy steps.");
  }
}
