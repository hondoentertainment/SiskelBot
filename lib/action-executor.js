/**
 * Phase 9 + 17: Recipe Execution & Action Executor Registry
 * Handlers run build, deploy, copy, webhook. Extensible via registerAction() and plugins config.
 */
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { trimAuditEntries } from "./audit-trim.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root (parent of lib/) */
const PROJECT_ROOT = join(__dirname, "..");
const AUDIT_LOG_PATH = join(PROJECT_ROOT, "data", "execution-audit.json");
const AUDIT_MAX_ENTRIES = Math.max(10, Number(process.env.AUDIT_MAX_ENTRIES) || 1000);
const AUDIT_RETENTION_DAYS = process.env.AUDIT_RETENTION_DAYS ? Number(process.env.AUDIT_RETENTION_DAYS) : null;

/** Allowed command patterns for build (npm run build, npm run <script>). No arbitrary shell. */
const SAFE_COMMAND_PATTERN = /^npm\s+run\s+([a-zA-Z0-9_-]+)$/;

const ALLOW_WEBHOOK_ACTIONS = process.env.ALLOW_WEBHOOK_ACTIONS === "1";
const WEBHOOK_RATE_LIMIT_PER_MIN = 5;
const WEBHOOK_RATE_WINDOW_MS = 60_000;

/** Webhook rate limit: URL -> array of timestamps (last N calls) */
const webhookCallTimestamps = new Map();

function checkWebhookRateLimit(url) {
  const key = String(url).trim().toLowerCase();
  const now = Date.now();
  let timestamps = webhookCallTimestamps.get(key) || [];
  timestamps = timestamps.filter((t) => now - t < WEBHOOK_RATE_WINDOW_MS);
  if (timestamps.length >= WEBHOOK_RATE_LIMIT_PER_MIN) {
    return false;
  }
  timestamps.push(now);
  webhookCallTimestamps.set(key, timestamps);
  return true;
}

/** Validate webhook URL: HTTPS only, no localhost/private IPs. */
function isValidWebhookUrl(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  const u = url.trim();
  if (!u.startsWith("https://")) return false;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname || "";
    if (/^localhost$/i.test(host) || /^127\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) || /^192\.168\./.test(host)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Action executor registry. Keys are action types; values are async handlers.
 * Handler signature: (payload, ctx) => Promise<{ ok, stdout?, stderr?, error? }>
 * @type {Record<string, (payload: object, ctx: object) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>>}
 */
const _handlers = {};

/**
 * Register an action handler. Overwrites existing handler for same name.
 * @param {string} name - Action name (lowercase recommended)
 * @param {(payload: object, ctx: object) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>} handler
 */
export function registerAction(name, handler) {
  if (typeof name !== "string" || !name.trim()) return;
  if (typeof handler !== "function") return;
  _handlers[name.trim().toLowerCase()] = handler;
}

/** Read-only view of registered action names (for backwards compatibility). */
export const executorRegistry = new Proxy(
  {},
  {
    get(_, prop) {
      return _handlers[String(prop)];
    },
    ownKeys() {
      return Object.keys(_handlers);
    },
    getOwnPropertyDescriptor(_, prop) {
      return _handlers[String(prop)] ? { enumerable: true, configurable: true } : undefined;
    },
  }
);

/** Return array of registered action names. */
export function getRegisteredActions() {
  return Object.keys(_handlers);
}

// --- Built-in handlers ---

registerAction("build", async function buildHandler(payload, ctx = {}) {
  const projectDir = payload?.cwd || ctx.projectDir || process.cwd();
  const command = typeof payload?.command === "string" && payload.command.trim() ? payload.command.trim() : "npm run build";
  if (!SAFE_COMMAND_PATTERN.test(command)) {
    return { ok: false, error: `Unsupported command. Use "npm run <script>" (e.g. npm run build). Got: ${command}` };
  }
  return new Promise((resolve) => {
    const [cmd, ...args] = command.split(/\s+/);
    const child = spawn(cmd, args, {
      cwd: projectDir,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, stdout: stdout.trim() || undefined, stderr: stderr.trim() || undefined });
      } else {
        resolve({
          ok: false,
          error: `Build exited with code ${code}`,
          stdout: stdout.trim() || undefined,
          stderr: stderr.trim() || undefined,
        });
      }
    });
    child.on("error", (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
});

registerAction("deploy", async function deployHandler(payload, ctx = {}) {
  const vercelToken = ctx.vercelToken || process.env.VERCEL_TOKEN;
  if (!vercelToken) {
    return { ok: false, error: "VERCEL_TOKEN not set. Deploy requires Vercel integration." };
  }
  const deployHookUrl = payload?.deployHookUrl;
  if (deployHookUrl && typeof deployHookUrl === "string") {
    try {
      const url = deployHookUrl.trim();
      if (!url.startsWith("https://") && !url.startsWith("http://")) {
        return { ok: false, error: "Invalid deployHookUrl: must be a valid URL" };
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: `Deploy hook failed: HTTP ${res.status}`, stderr: text?.slice(0, 500) };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: true, stdout: `Deployment triggered: ${JSON.stringify(data)}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  const projectName = payload?.project || payload?.projectId;
  if (projectName && typeof projectName === "string") {
    const base = (process.env.VERCEL_API_BASE || "https://api.vercel.com").replace(/\/$/, "");
    try {
      const res = await fetch(`${base}/v13/deployments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${vercelToken}`,
        },
        body: JSON.stringify({
          name: projectName.trim().slice(0, 100),
          target: payload.env === "preview" ? "preview" : "production",
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: data.error?.message || `Vercel API HTTP ${res.status}`,
          stderr: JSON.stringify(data)?.slice(0, 500),
        };
      }
      return { ok: true, stdout: `Deployment created: ${data.url || data.id || "pending"}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  return {
    ok: false,
    error:
      "Deploy requires payload.deployHookUrl or payload.project. Set deployHookUrl for Deploy Hooks, or project name for Vercel API.",
  };
});

registerAction("copy", async function copyHandler() {
  return { ok: true, stdout: "Copy performed client-side" };
});

// --- Webhook handler (Phase 17) ---
registerAction("webhook", async function webhookHandler(payload, ctx = {}) {
  if (!ALLOW_WEBHOOK_ACTIONS) {
    return { ok: false, error: "Webhook actions disabled. Set ALLOW_WEBHOOK_ACTIONS=1 to enable." };
  }
  const url = payload?.url;
  if (!url || typeof url !== "string" || !url.trim()) {
    return { ok: false, error: "Webhook requires payload.url" };
  }
  const urlStr = url.trim();
  if (!isValidWebhookUrl(urlStr)) {
    return { ok: false, error: "Webhook URL must be HTTPS and not localhost or private IP" };
  }
  if (!checkWebhookRateLimit(urlStr)) {
    return {
      ok: false,
      error: `Webhook rate limit exceeded (${WEBHOOK_RATE_LIMIT_PER_MIN}/min per URL). Retry later.`,
    };
  }
  const headers = payload?.headers && typeof payload.headers === "object" ? payload.headers : {};
  const body = payload?.body;
  const bodyStr = body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined;
  try {
    const reqHeaders = { "Content-Type": "application/json", ...headers };
    const res = await fetch(urlStr, {
      method: "POST",
      headers: reqHeaders,
      body: bodyStr !== undefined ? bodyStr : "{}",
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Webhook failed: HTTP ${res.status}`, stderr: text?.slice(0, 500) };
    }
    return { ok: true, stdout: text?.slice(0, 500) || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * Create a webhook handler for plugin config. Uses same validation and rate limit as "webhook" action.
 * @param {{ url: string; headers?: object; body?: object }} config
 * @returns {(payload: object, ctx: object) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>}
 */
export function createWebhookExecutor(config) {
  const url = config?.url && typeof config.url === "string" ? config.url.trim() : "";
  const headers = config?.headers && typeof config.headers === "object" ? config.headers : {};
  const body = config?.body;
  const bodyStr = body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined;
  return async function pluginWebhookHandler() {
    if (!ALLOW_WEBHOOK_ACTIONS) {
      return { ok: false, error: "Webhook actions disabled. Set ALLOW_WEBHOOK_ACTIONS=1 to enable." };
    }
    if (!url || !isValidWebhookUrl(url)) {
      return { ok: false, error: "Plugin webhook URL must be HTTPS and not localhost or private IP" };
    }
    if (!checkWebhookRateLimit(url)) {
      return {
        ok: false,
        error: `Webhook rate limit exceeded (${WEBHOOK_RATE_LIMIT_PER_MIN}/min per URL). Retry later.`,
      };
    }
    try {
      const reqHeaders = { "Content-Type": "application/json", ...headers };
      const res = await fetch(url, {
        method: "POST",
        headers: reqHeaders,
        body: bodyStr !== undefined ? bodyStr : "{}",
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, error: `Webhook failed: HTTP ${res.status}`, stderr: text?.slice(0, 500) };
      }
      return { ok: true, stdout: text?.slice(0, 500) || `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
}

/**
 * Execute a single step. Returns { ok, stdout, stderr } or { ok: false, error }.
 * @param {{ action: string; payload?: object }} step
 * @param {object} ctx - { projectDir, vercelToken }
 * @returns {Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>}
 */
export async function executeStep(step, ctx = {}) {
  if (!step || typeof step !== "object" || !step.action) {
    return { ok: false, error: "Step must have a non-empty action" };
  }
  const action = String(step.action).trim().toLowerCase();
  const payload = step.payload && typeof step.payload === "object" ? step.payload : {};
  const handler = _handlers[action];
  if (!handler) {
    return {
      ok: false,
      error: `Unknown action: ${action}. Supported: ${getRegisteredActions().join(", ")}`,
    };
  }
  return handler(payload, ctx);
}

/**
 * Append an audit log entry. Persists to JSON file.
 * Schema: { timestamp, action, payload, ok, error?, source? }
 */
export function appendAuditLog(entry) {
  try {
    const dir = dirname(AUDIT_LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let entries = [];
    if (existsSync(AUDIT_LOG_PATH)) {
      try {
        const raw = readFileSync(AUDIT_LOG_PATH, "utf8");
        const parsed = JSON.parse(raw);
        entries = Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        entries = [];
      }
    }
    entries.push({
      timestamp: new Date().toISOString(),
      action: entry.action,
      payload: entry.payload,
      ok: !!entry.ok,
      error: entry.error,
    });
    entries = trimAuditEntries(entries, AUDIT_MAX_ENTRIES, AUDIT_RETENTION_DAYS);
    writeFileSync(AUDIT_LOG_PATH, JSON.stringify(entries, null, 0), "utf8");
  } catch (e) {
    console.warn("[action-executor] Failed to append audit log:", e.message);
  }
}
