import "dotenv/config";
import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import cors from "cors";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import multer from "multer";
import passport from "passport";
import { initPassport, isOAuthConfigured } from "./lib/oauth.js";
import { indexDocument, search as knowledgeSearch, semanticSearch as knowledgeSemanticSearch, list as knowledgeList } from "./lib/knowledge-store.js";
import { embed, embedBatch, isAvailable as embeddingsAvailable } from "./lib/embeddings.js";
import { executeStep, appendAuditLog, getRegisteredActions } from "./lib/action-executor.js";
import { loadPlugins } from "./lib/plugins-loader.js";
import { getToolsSchema, runTool } from "./lib/agent-tools.js";
import * as storage from "./lib/storage.js";
import * as scheduleStore from "./lib/schedules.js";
import { start as schedulerStart, refresh as schedulerRefresh, runRecipeNow, runDueJobsVercel } from "./lib/scheduler.js";
import { userAuth, isAuthConfigured } from "./lib/auth.js";
import { recordUsage, getSummary, getTotalTokensInWindow, getRecordsForPeriod, estimate } from "./lib/usage-tracker.js";
import { getDashboard, exportToCsv, exportToJson } from "./lib/analytics.js";
import { emitEvent, listWebhooks, addWebhook, removeWebhook, validateWebhookUrl } from "./lib/webhooks.js";
import { list as listNotifications, markRead as markNotificationRead, markAllRead as markAllNotificationsRead } from "./lib/notifications.js";
import { isQuotaConfigured, checkQuota, getWorkspaceQuota, getWorkspaceTokensUsed, isQuotaAdmin, setWorkspaceQuotaOverride, getQuotaOverrides } from "./lib/quotas.js";
import { createBackup, listBackups, restoreBackup } from "./lib/backup.js";
import { adminAuth } from "./lib/admin-auth.js";
import { listAllUsers, listAllWorkspaces, getRecentAuditLog } from "./lib/admin-data.js";
import openApiSpec from "./lib/openapi-spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Phase 17: Load plugins at startup (plugins/config.json or PLUGINS_PATH)
loadPlugins();

// Environment config
const VLLM_URL = process.env.VLLM_URL || "http://localhost:8000";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // optional; protects /v1/chat/completions when set
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 60;
const RATE_LIMIT_MAX_PER_USER = Number(process.env.RATE_LIMIT_MAX_PER_USER) || RATE_LIMIT_MAX;

// Determine backend: explicit BACKEND env, or infer (default: ollama for local dev)
function getBackend() {
  const explicit = process.env.BACKEND?.toLowerCase();
  if (explicit === "ollama" || explicit === "vllm" || explicit === "openai") {
    return explicit;
  }
  if (process.env.VLLM_URL !== undefined && process.env.VLLM_URL !== OLLAMA_URL) {
    return "vllm";
  }
  return "ollama"; // default: Ollama (runs on Windows, easy local setup)
}

const BACKEND = getBackend();
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Production security: warn if API_KEY not set (backend may be exposed)
if (IS_PRODUCTION && !API_KEY) {
  console.warn(
    "[SECURITY] NODE_ENV=production but API_KEY is not set. " +
      "The /v1/chat/completions endpoint is publicly accessible. " +
      "Set API_KEY in Vercel env vars to protect it."
  );
}

// Model presets per backend (for /config)
const MODEL_PRESETS = {
  ollama: ["llama3.2", "mistral", "llama2", "codellama"],
  vllm: ["meta-llama/Llama-3-8B-Instruct", "mistralai/Mistral-7B-Instruct-v0.2"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
};

function buildProxyConfig(backend) {
  switch (backend) {
    case "ollama": {
      return {
        baseUrl: OLLAMA_URL,
        path: "/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
      };
    }
    case "vllm": {
      return {
        baseUrl: VLLM_URL.replace(/\/$/, ""),
        path: "/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
      };
    }
    case "openai": {
      if (!OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for OpenAI backend");
      }
      return {
        baseUrl: "https://api.openai.com/v1",
        path: "/chat/completions",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      };
    }
    default:
      throw new Error(`Unknown backend: ${backend}`);
  }
}

const app = express();
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());

// Phase 19: Session middleware (must run before auth; required when OAuth configured)
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (IS_PRODUCTION ? null : "dev-secret-change-in-production");
if (isOAuthConfigured() && !SESSION_SECRET) {
  console.warn("[auth] OAuth configured but SESSION_SECRET not set. OAuth login will not persist. Set SESSION_SECRET in production.");
}
if (SESSION_SECRET) {
  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: IS_PRODUCTION,
        httpOnly: true,
        sameSite: IS_PRODUCTION ? "lax" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );
}

// Phase 19: Passport (when OAuth configured)
let oauthProviders = { github: false, google: false };
if (isOAuthConfigured()) {
  app.use(passport.initialize());
  app.use(passport.session());
  oauthProviders = initPassport();
}

// Rate limit for /v1/chat/completions
// Phase 21: When auth configured, rate limit by userId; else by IP
const chatRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: isAuthConfigured() ? RATE_LIMIT_MAX_PER_USER : RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (isAuthConfigured() && req.userId && req.userId !== "anonymous") {
      return `user:${req.userId}`;
    }
    return req.ip || req.socket?.remoteAddress || "unknown";
  },
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many requests", "Reduce request rate or increase RATE_LIMIT_MAX_PER_USER / RATE_LIMIT_MAX.");
  },
});

// Rate limit for GitHub/Vercel proxy routes (30/min per IP)
const integrationRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit for knowledge indexing (10/min per IP)
const knowledgeIndexRateLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.KNOWLEDGE_INDEX_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many index requests", "Reduce indexing rate or increase KNOWLEDGE_INDEX_RATE_LIMIT_MAX.");
  },
});

// Phase 28: Rate limit for embeddings (30/min per IP, same or stricter than knowledge indexing)
const embeddingsRateLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.EMBEDDINGS_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many embeddings requests", "Reduce request rate or increase EMBEDDINGS_RATE_LIMIT_MAX.");
  },
});

// Structured error response: { error, code, hint }
function apiError(res, status, code, message, hint) {
  return res.status(status).json({
    error: message || "Request failed",
    code,
    hint: hint || "See docs/RUNBOOK.md for troubleshooting.",
  });
}

// Phase 23: API versioning - deprecation header for legacy /api/* (non-v1, non-docs)
function deprecationApi(req, res, next) {
  res.setHeader("X-API-Deprecated", "use /api/v1/");
  next();
}

// Phase 23: Register route at both /api/v1/path (stable) and /api/path (legacy with deprecation)
function apiRoute(method, path, ...handlers) {
  app[method](`/api/v1${path}`, ...handlers);
  app[method](`/api${path}`, deprecationApi, ...handlers);
}

// Phase 21: Set quota headers on response when quota is configured
function setQuotaHeaders(res, workspace, userId) {
  const quota = getWorkspaceQuota(workspace, userId);
  if (quota) {
    res.setHeader("X-Quota-Limit", String(quota.limit));
    res.setHeader("X-Quota-Remaining", String(quota.remaining));
    res.setHeader("X-Quota-Reset", String(quota.resetAt));
  }
}

// Optional API key auth for /v1/chat/completions
function apiKeyAuth(req, res, next) {
  if (!API_KEY) return next();
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const xKey = req.headers["x-api-key"];
  const key = bearer || xKey;
  if (!key || key !== API_KEY) {
    return apiError(res, 401, "AUTH_REQUIRED", "Unauthorized", "Use Authorization: Bearer <key> or x-api-key header.");
  }
  next();
}

// Phase 24: Backup admin auth - ADMIN_API_KEY, BACKUP_ADMIN_KEY, or userId in QUOTA_ADMIN_USER_IDS
// Runs userAuth internally when needed for quota-admin path
function backupAdminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY || process.env.BACKUP_ADMIN_KEY;
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
  const xKey = req.headers["x-api-key"] || req.headers["x-backup-admin-key"];
  const key = bearer || xKey;
  if (adminKey && key && key === adminKey) return next();
  if (adminKey && !key) return apiError(res, 403, "FORBIDDEN", "Backup requires admin", "Use ADMIN_API_KEY, BACKUP_ADMIN_KEY, or be in QUOTA_ADMIN_USER_IDS.");
  if (!isAuthConfigured() && !adminKey) return next(); // No auth, no admin key: allow (local dev)
  userAuth(req, res, () => {
    if (req.userId && isQuotaAdmin(req.userId)) return next();
    return apiError(res, 403, "FORBIDDEN", "Backup requires admin", "Use ADMIN_API_KEY, BACKUP_ADMIN_KEY, or be in QUOTA_ADMIN_USER_IDS.");
  });
}

// Structured request logging
function logRequest(req, res, next) {
  const requestId = randomUUID();
  req.requestId = requestId;
  const start = Date.now();
  res.on("finish", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
    };
    console.log(JSON.stringify(entry));
  });
  next();
}

// Config endpoint for client (backend, model presets)
// Phase 7: Monitoring config (computed before /config handler)
const ENABLE_MONITORING = process.env.ENABLE_MONITORING === "1";
const MONITORING_INTERVAL_MS = Math.max(60_000, Number(process.env.MONITORING_INTERVAL_MS) || 300_000);
const MONITORING_REPO = process.env.MONITORING_REPO?.trim() || null;
const GITHUB_API_BASE = process.env.GITHUB_API_BASE || "https://api.github.com";
const VERCEL_API_BASE = process.env.VERCEL_API_BASE || "https://api.vercel.com";

function isMonitoringEnabled() {
  return ENABLE_MONITORING && (process.env.GITHUB_TOKEN || process.env.VERCEL_TOKEN);
}

app.get("/config", (req, res) => {
  const payload = {
    backend: BACKEND,
    modelPresets: MODEL_PRESETS[BACKEND] || [],
    modelPlaceholder: MODEL_PRESETS[BACKEND]?.[0] || "model",
    requiresApiKey: Boolean(API_KEY),
    isProduction: IS_PRODUCTION,
    defaultGenerationConfig: {
      temperature: 0.7,
      top_p: 0.95,
      max_tokens: 512,
    },
    monitoringEnabled: isMonitoringEnabled(),
    allowRecipeStepExecution: process.env.ALLOW_RECIPE_STEP_EXECUTION === "1",
    scheduleEnabled: process.env.ENABLE_SCHEDULED_RECIPES === "1",
    authRequired: isAuthConfigured(),
    oauthProviders,
  };
  if (IS_PRODUCTION && !API_KEY) {
    payload.productionHint = "Set API_KEY in Vercel env vars to protect /v1/chat/completions";
  }
  res.json(payload);
});

// Phase 19: OAuth routes (when configured)
function oauthCallback(req, res) {
  if (!req.session) return res.redirect("/?auth_error=session");
  req.session.userId = req.user?.userId;
  res.redirect("/");
}
if (oauthProviders.github) {
  app.get("/auth/github", passport.authenticate("github", { scope: ["user:email"] }));
  app.get("/auth/github/callback", passport.authenticate("github", { failureRedirect: "/?auth_error=1" }), oauthCallback);
}
if (oauthProviders.google) {
  app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
  app.get("/auth/google/callback", passport.authenticate("google", { failureRedirect: "/?auth_error=1" }), oauthCallback);
}
app.get("/auth/logout", (req, res) => {
  req.session?.destroy?.();
  res.redirect("/");
});
app.get("/auth/me", (req, res) => {
  if (req.session?.userId) {
    const provider = req.user?.provider || (req.session.userId?.startsWith("github-") ? "github" : req.session.userId?.startsWith("google-") ? "google" : null);
    return res.json({ userId: req.session.userId, provider });
  }
  return res.status(401).json({ error: "Not authenticated", code: "NOT_AUTHENTICATED" });
});

// Phase 13: Usage tracking env
const USAGE_ALERT_TOKENS = process.env.USAGE_ALERT_TOKENS ? Number(process.env.USAGE_ALERT_TOKENS) : null;

// Phase 15: Agent mode
const MAX_AGENT_ITERATIONS = Number(process.env.MAX_AGENT_ITERATIONS) || 5;
const ALLOW_RECIPE_STEP_EXECUTION = process.env.ALLOW_RECIPE_STEP_EXECUTION === "1";

async function runAgentLoop(req, res, config, model) {
  const url = `${config.baseUrl}${config.path}`;
  let messages = Array.isArray(req.body?.messages) ? [...req.body.messages] : [];
  const allowExecution = req.body?.agentOptions?.allowExecution === true;
  const workspace = req.body?.agentOptions?.workspace || "default";
  const toolCtx = {
    allowExecution: ALLOW_RECIPE_STEP_EXECUTION && allowExecution,
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    vercelToken: process.env.VERCEL_TOKEN,
    workspace,
  };

  const tools = req.body?.tools?.length ? req.body.tools : getToolsSchema();
  const toolChoice = req.body?.tool_choice ?? "auto";
  const bodyBase = {
    model: req.body?.model || model,
    messages,
    tools,
    tool_choice: toolChoice,
    stream: false,
    ...(req.body?.temperature != null && { temperature: req.body.temperature }),
    ...(req.body?.max_tokens != null && { max_tokens: req.body.max_tokens }),
  };

  let lastContent = "";
  let iteration = 0;

  while (iteration < MAX_AGENT_ITERATIONS) {
    iteration++;
    res.setHeader("X-Agent-Iteration", String(iteration));

    const response = await fetch(url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({ ...bodyBase, messages }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Backend error: ${response.status} ${err?.slice(0, 200) || ""}`);
    }

    const data = await response.json().catch(() => ({}));
    const choice = data.choices?.[0];
    const msg = choice?.message;

    if (!msg) {
      lastContent = "(No response from model)";
      break;
    }

    const content = typeof msg.content === "string" ? msg.content : "";
    const toolCalls = msg.tool_calls;

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      lastContent = content || "(Empty response)";
      break;
    }

    messages.push(msg);
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      const argsStr = tc.function?.arguments || "{}";
      let args = {};
      try {
        args = JSON.parse(argsStr);
      } catch (_) {
        args = {};
      }
      const result = await runTool(name, args, toolCtx);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content,
      });
    }
  }

  if (iteration >= MAX_AGENT_ITERATIONS && lastContent === "") {
    lastContent = "(Agent reached max iterations without final response)";
  }

  return { content: lastContent, iteration };
}

app.post("/v1/chat/completions", apiKeyAuth, userAuth, chatRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = req.body?.agentOptions?.workspace || "default";
    const userId = req.userId || null;

    // Phase 21: Per-workspace token quota check
    if (isQuotaConfigured()) {
      const inputTokens = estimate.inputFromMessages(req.body?.messages || []);
      const { allowed, quota } = checkQuota(workspace, userId, inputTokens + 512);
      if (!allowed && quota) {
        res.setHeader("X-Quota-Limit", String(quota.limit));
        res.setHeader("X-Quota-Remaining", "0");
        res.setHeader("X-Quota-Reset", String(quota.resetAt));
        return res.status(429).json({
          error: "Workspace token quota exceeded",
          code: "QUOTA_EXCEEDED",
          hint: "Quota resets at period end. Contact admin or use a different workspace.",
        });
      }
    }

    const config = buildProxyConfig(BACKEND);
    const url = `${config.baseUrl}${config.path}`;
    const model = req.body?.model || MODEL_PRESETS[BACKEND]?.[0] || "unknown";
    const agentMode = req.body?.agentMode === true;
    const hasTools = Array.isArray(req.body?.tools) && req.body.tools.length > 0;

    if (agentMode || hasTools) {
      const tools = hasTools ? req.body.tools : getToolsSchema();
      const bodyWithTools = { ...req.body, tools, tool_choice: req.body?.tool_choice ?? "auto" };
      if (!hasTools) req.body = bodyWithTools;

      const { content, iteration } = await runAgentLoop(req, res, config, model);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Agent-Iteration", String(iteration));
      setQuotaHeaders(res, workspace, userId);
      res.flushHeaders();

      const inputTokens = estimate.inputFromMessages(req.body?.messages || []);
      const outputTokens = estimate.outputFromChars(content?.length || 0);
      await recordUsage({ timestamp: new Date().toISOString(), model, inputTokens, outputTokens, backend: BACKEND, workspace, userId }).catch(() => {});

      const chunk = JSON.stringify({
        choices: [{ delta: { content }, index: 0, finish_reason: "stop" }],
      });
      res.write(`data: ${chunk}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      const ws = req.body?.agentOptions?.workspace || "default";
      emitEvent("message_sent", { content: content?.slice(0, 500), model, iteration }, { workspaceId: ws, userId: req.userId });
      return;
    }

    const inputTokens = estimate.inputFromMessages(req.body?.messages || []);

    const response = await fetch(url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({ ...req.body, stream: true }),
    });

    if (!response.ok) {
      const err = await response.text();
      const code = response.status === 429 ? "RATE_LIMITED" : "BACKEND_ERROR";
      return res.status(response.status).json({
        error: `${BACKEND} error`,
        code,
        hint: response.status === 429 ? "Backend rate limit exceeded; retry later." : err || "Backend returned an error.",
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    setQuotaHeaders(res, workspace, userId);
    res.flushHeaders();

    let buffer = "";
    let outputChars = 0;
    let outputContent = "";
    let usageFromApi = null;

    for await (const chunk of response.body) {
      const text = chunk.toString("utf8");
      buffer += text;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const dataMatch = part.match(/^data: (.+)$/m);
        if (!dataMatch) continue;
        const data = dataMatch[1];
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string") {
            outputChars += delta.length;
            outputContent += delta;
          }
          const usage = parsed.usage || parsed.choices?.[0]?.usage;
          if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
            usageFromApi = { ...usage };
          }
        } catch (_) {}
      }
      res.write(chunk);
      if (res.flush) res.flush();
    }

    emitEvent(
      "message_sent",
      { content: outputContent?.slice(0, 500), model },
      { workspaceId: workspace, userId }
    );

    const outputTokens = usageFromApi?.completion_tokens ?? estimate.outputFromChars(outputChars);
    const finalInputTokens = usageFromApi?.prompt_tokens ?? inputTokens;
    await recordUsage({
      timestamp: new Date().toISOString(),
      model,
      inputTokens: finalInputTokens,
      outputTokens,
      backend: BACKEND,
      workspace,
      userId,
    }).catch((e) => console.warn("[usage-tracker] Record failed:", e.message));

    if (USAGE_ALERT_TOKENS) {
      const totalInWindow = getTotalTokensInWindow();
      if (totalInWindow >= USAGE_ALERT_TOKENS) {
        res.setHeader("X-Usage-Alert", "1");
        console.warn(`[usage] Budget alert: ${totalInWindow} tokens >= ${USAGE_ALERT_TOKENS}`);
      }
    }

    res.end();
  } catch (err) {
    console.error("Proxy error:", err.message);
    const hint =
      BACKEND === "vllm"
        ? "Is vLLM running? Try: vllm serve <model> --max-model-len 4096"
        : BACKEND === "ollama"
          ? "Is Ollama running? Try: ollama serve"
          : BACKEND === "openai"
            ? "Check OPENAI_API_KEY is set and valid"
            : "Check backend configuration";

    return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, hint);
  }
});

// --- Task planning (Phase 3: Action-Oriented Agent) ---

const TASK_PLAN_SYSTEM_PROMPT = `You are a task planning assistant. Given the user's messages, produce a structured task plan as valid JSON inside a fenced code block.

Output format: a single JSON object in a \`\`\`json ... \`\`\` code block, conforming to this schema:

{
  "type": "task",
  "id": "optional-unique-id",
  "name": "Human-readable task name (required)",
  "steps": [
    { "action": "action-type-or-description (required)", "payload": { "key": "value" } }
  ],
  "requiresApproval": true
}

Rules:
- type must be exactly "task"
- name: required, non-empty string
- steps: required array, at least one step; each step needs non-empty "action" string; "payload" is optional object
- requiresApproval: optional boolean; set true for destructive or high-risk tasks (deploy, delete, shell commands)
- Return only the code block, no other text before or after the JSON
`;

function extractTaskJsonFromResponse(text) {
  if (!text || typeof text !== "string") return null;
  const jsonBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = jsonBlock ? jsonBlock[1].trim() : text.trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function validateTaskPlan(plan) {
  if (!plan || typeof plan !== "object") return "Plan must be an object";
  if (plan.type !== "task") return "Plan must have type 'task'";
  if (!plan.name || typeof plan.name !== "string" || !plan.name.trim())
    return "Plan must have a non-empty name";
  if (!Array.isArray(plan.steps) || plan.steps.length < 1) return "Plan must have at least one step";
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    if (!s || typeof s !== "object") return `Step ${i + 1}: must be an object`;
    if (!s.action || typeof s.action !== "string" || !String(s.action).trim())
      return `Step ${i + 1}: must have non-empty action`;
    if (s.payload !== undefined) {
      if (s.payload === null || Array.isArray(s.payload) || typeof s.payload !== "object")
        return `Step ${i + 1}: payload must be an object`;
    }
  }
  if (plan.requiresApproval !== undefined && typeof plan.requiresApproval !== "boolean")
    return "requiresApproval must be a boolean";
  return null;
}

const taskPlanRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});

app.post("/v1/tasks/plan", taskPlanRateLimiter, apiKeyAuth, logRequest, async (req, res) => {
  try {
    const { messages, model } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return apiError(res, 400, "INVALID_BODY", "messages must be a non-empty array", "Send a non-empty messages array in the request body.");
    }
    const modelName = typeof model === "string" && model.trim() ? model.trim() : MODEL_PRESETS[BACKEND]?.[0] || "llama3.2";

    const config = buildProxyConfig(BACKEND);
    const url = `${config.baseUrl}${config.path}`;

    const llmMessages = [
      { role: "system", content: TASK_PLAN_SYSTEM_PROMPT },
      ...messages.map((m) => ({
        role: m.role || "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ];

    const response = await fetch(url, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({
        model: modelName,
        messages: llmMessages,
        stream: false,
        temperature: 0.3,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      const code = response.status === 429 ? "RATE_LIMITED" : "BACKEND_ERROR";
      return res.status(response.status).json({
        error: `${BACKEND} error`,
        code,
        hint: response.status === 429 ? "Backend rate limit exceeded; retry later." : (err || "Backend returned an error.").slice(0, 500),
      });
    }

    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content || data.message?.content || "";
    const parsed = extractTaskJsonFromResponse(rawContent);

    if (!parsed) {
      return res.status(400).json({
        error: "Could not parse JSON task plan from LLM response",
        code: "PARSE_ERROR",
        hint: "Check that the LLM returns valid JSON in a fenced code block.",
        raw: rawContent?.slice(0, 500),
      });
    }

    const validationError = validateTaskPlan(parsed);
    if (validationError) {
      return res.status(400).json({
        error: validationError,
        code: "VALIDATION_ERROR",
        hint: "Ensure plan has type 'task', name, and steps with non-empty action.",
        raw: rawContent?.slice(0, 500),
      });
    }

    const planWorkspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
    emitEvent("plan_created", { plan: parsed, raw: rawContent?.slice(0, 500) }, { workspaceId: planWorkspace, userId: req.userId });
    res.json({ plan: parsed, raw: rawContent });
  } catch (err) {
    console.error("Task plan error:", err.message);
    const hint =
      BACKEND === "vllm"
        ? "Is vLLM running? Try: vllm serve <model> --max-model-len 4096"
        : BACKEND === "ollama"
          ? "Is Ollama running? Try: ollama serve"
          : BACKEND === "openai"
            ? "Check OPENAI_API_KEY is set and valid"
            : "Check backend configuration";

    return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, hint);
  }
});

const HEALTH_CACHE_TTL_MS = 5000;
let healthCache = null;

function getHealthUrl(backend) {
  switch (backend) {
    case "ollama":
      return `${OLLAMA_URL}/api/tags`;
    case "vllm":
      return `${VLLM_URL}/v1/models`;
    case "openai":
      return "https://api.openai.com/v1/models";
    default:
      return null;
  }
}

async function probeBackend(name, url, headers = {}) {
  const start = Date.now();
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers,
    });
    return {
      reachable: r.ok,
      latencyMs: Date.now() - start,
      error: r.ok ? undefined : `HTTP ${r.status}`,
    };
  } catch (e) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      error: e.message,
    };
  }
}

async function runHealthChecks() {
  const backends = {};
  const checks = [];

  const ollamaUrl = getHealthUrl("ollama");
  if (ollamaUrl) {
    checks.push(
      probeBackend("ollama", ollamaUrl).then((r) => {
        backends.ollama = r;
      })
    );
  }

  const vllmUrl = getHealthUrl("vllm");
  if (vllmUrl) {
    checks.push(
      probeBackend("vllm", vllmUrl).then((r) => {
        backends.vllm = r;
      })
    );
  }

  if (OPENAI_API_KEY) {
    checks.push(
      probeBackend("openai", "https://api.openai.com/v1/models", {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      }).then((r) => {
        backends.openai = r;
      })
    );
  }

  await Promise.all(checks);

  const active = backends[BACKEND];
  const reachable = active?.reachable ?? false;
  const latencyMs = active?.latencyMs ?? null;
  const lastChecked = new Date().toISOString();

  return {
    backend: BACKEND,
    reachable,
    latencyMs,
    lastChecked,
    backends,
  };
}

app.get("/health", async (req, res) => {
  const now = Date.now();
  const bypass = req.query?.refresh === "1";

  if (!bypass && healthCache && now - healthCache.timestamp < HEALTH_CACHE_TTL_MS) {
    return res.json({
      ...healthCache.data,
      cached: true,
    });
  }

  try {
    const data = await runHealthChecks();
    healthCache = { data, timestamp: now };
    return res.json(data);
  } catch (e) {
    const hint =
      BACKEND === "vllm"
        ? "Start vLLM: vllm serve <model> --max-model-len 4096"
        : BACKEND === "ollama"
          ? "Start Ollama: ollama serve"
          : BACKEND === "openai"
            ? "Check OPENAI_API_KEY"
            : "Check backend configuration";

    return res.status(503).json({
      error: "Health check failed",
      code: "BACKEND_UNREACHABLE",
      hint,
      backend: BACKEND,
      reachable: false,
      lastChecked: new Date().toISOString(),
    });
  }
});

// --- Phase 4: Toolchain Integration Hub ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

// Validate owner/repo to prevent injection (alphanumeric, hyphen, underscore, dot; 1-100 chars)
const OWNER_REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
function validateOwnerRepo(owner, repo) {
  return (
    typeof owner === "string" &&
    typeof repo === "string" &&
    OWNER_REPO_PATTERN.test(owner) &&
    OWNER_REPO_PATTERN.test(repo) &&
    owner.length <= 100 &&
    repo.length <= 100
  );
}

// GET /api/integrations/status - returns { github: boolean, vercel: boolean }
apiRoute("get", "/integrations/status", (req, res) => {
  res.json({
    github: Boolean(GITHUB_TOKEN),
    vercel: Boolean(VERCEL_TOKEN),
  });
});

// --- Phase 13: Usage summary ---
const usageSummaryRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
// Phase 21: Usage summary with quota headers when workspace in query
apiRoute("get", "/usage/summary", usageSummaryRateLimiter, logRequest, (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query?.days) || 7));
    const workspace = req.query?.workspace ? String(req.query.workspace).trim() : "default";
    const summary = getSummary(days);
    const userId = req.userId || null;

    if (isQuotaConfigured()) {
      const quota = getWorkspaceQuota(workspace, userId);
      if (quota) {
        res.setHeader("X-Quota-Limit", String(quota.limit));
        res.setHeader("X-Quota-Remaining", String(quota.remaining));
        res.setHeader("X-Quota-Reset", String(quota.resetAt));
        summary.quota = { limit: quota.limit, used: quota.used, remaining: quota.remaining, resetAt: quota.resetAt };
      }
    }
    res.json(summary);
  } catch (err) {
    console.error("Usage summary error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// --- Phase 18: Analytics dashboard ---
const analyticsRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
const analyticsHandlers = [analyticsRateLimiter, logRequest];
if (isAuthConfigured()) analyticsHandlers.push(userAuth);

apiRoute("get", "/analytics/dashboard", ...analyticsHandlers, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query?.days) || 7));
    const workspace = req.query?.workspace ? String(req.query.workspace).trim() : undefined;
    const opts = { workspace };
    if (req.userId) opts.userId = req.userId;
    const dashboard = await getDashboard(days, opts);
    if (isQuotaConfigured() && (workspace || "default")) {
      const quota = getWorkspaceQuota(workspace || "default", req.userId || null);
      if (quota) {
        res.setHeader("X-Quota-Limit", String(quota.limit));
        res.setHeader("X-Quota-Remaining", String(quota.remaining));
        res.setHeader("X-Quota-Reset", String(quota.resetAt));
        dashboard.quota = { limit: quota.limit, used: quota.used, remaining: quota.remaining, resetAt: quota.resetAt };
      }
    }
    res.json(dashboard);
  } catch (err) {
    console.error("Analytics dashboard error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/analytics/export", ...analyticsHandlers, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query?.days) || 30));
    const format = (req.query?.format || "json").toLowerCase();
    const workspace = req.query?.workspace ? String(req.query.workspace).trim() : undefined;
    const opts = { workspace };
    if (req.userId) opts.userId = req.userId;
    const records = getRecordsForPeriod(days, opts);
    const dashboard = await getDashboard(days, opts);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="analytics-${days}d.csv"`);
      return res.send(exportToCsv(records));
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="analytics-${days}d.json"`);
    res.send(exportToJson({ days, records, summary: dashboard }));
  } catch (err) {
    console.error("Analytics export error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// --- Phase 7: Autonomous Research and Monitoring ---
const STALE_PR_DAYS = 7;
let monitoringState = {
  lastCheck: null,
  checks: { github: null, vercel: null },
  summary: "idle",
  alerts: [],
};
let monitoringIntervalId = null;

async function runMonitoringChecks() {
  const alerts = [];
  const checks = { github: null, vercel: null };

  if (GITHUB_TOKEN && MONITORING_REPO) {
    const [owner, repo] = MONITORING_REPO.split("/").map((s) => s.trim());
    if (owner && repo && validateOwnerRepo(owner, repo)) {
      try {
        const base = GITHUB_API_BASE.replace(/\/$/, "");
        const [commitsRes, prsRes] = await Promise.all([
          fetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=1`, {
            headers: { Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${GITHUB_TOKEN}` },
            signal: AbortSignal.timeout(10000),
          }),
          fetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=30`, {
            headers: { Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${GITHUB_TOKEN}` },
            signal: AbortSignal.timeout(10000),
          }),
        ]);
        const lastCommit = commitsRes.ok ? (await commitsRes.json())[0] : null;
        const openPRs = prsRes.ok ? await prsRes.json() : [];
        const now = Date.now();
        const stalePRs = openPRs.filter((pr) => {
          const created = pr.created_at ? new Date(pr.created_at).getTime() : 0;
          return (now - created) / (24 * 60 * 60 * 1000) > STALE_PR_DAYS;
        });
        checks.github = {
          ok: commitsRes.ok && prsRes.ok,
          lastCommit: lastCommit ? { sha: lastCommit.sha?.slice(0, 7), date: lastCommit.commit?.author?.date, message: lastCommit.commit?.message?.split("\n")[0] } : null,
          openPRs: openPRs.length,
          stalePRs: stalePRs.length,
        };
        if (stalePRs.length > 0) alerts.push({ type: "stale_prs", count: stalePRs.length, message: `${stalePRs.length} PR(s) open > ${STALE_PR_DAYS} days` });
        if (!commitsRes.ok || !prsRes.ok) {
          checks.github.ok = false;
          checks.github.error = commitsRes.ok ? (await prsRes.text()).slice(0, 200) : (await commitsRes.text()).slice(0, 200);
          alerts.push({ type: "github_error", message: "GitHub API error" });
        }
      } catch (err) {
        checks.github = { ok: false, error: err.message };
        alerts.push({ type: "github_error", message: err.message });
      }
    } else {
      checks.github = { ok: false, error: "Invalid MONITORING_REPO format (use owner/repo)" };
    }
  } else if (GITHUB_TOKEN) {
    checks.github = { ok: true, configured: false, reason: "MONITORING_REPO not set" };
  }

  if (VERCEL_TOKEN) {
    try {
      const base = VERCEL_API_BASE.replace(/\/$/, "");
      const r = await fetch(`${base}/v6/deployments?limit=1`, {
        headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
        signal: AbortSignal.timeout(10000),
      });
      const data = r.ok ? await r.json() : null;
      const deployments = data?.deployments || (Array.isArray(data) ? data : []);
      const last = deployments[0];
      const state = last?.state || null;
      const failed = state === "ERROR" || state === "CANCELED";
      checks.vercel = {
        ok: r.ok,
        lastDeploy: last ? { state, url: last.url, created: last.created } : null,
        failed,
      };
      if (failed) alerts.push({ type: "deploy_failed", message: `Last deployment: ${state}` });
      if (!r.ok) {
        checks.vercel.error = (await r.text()).slice(0, 200);
        alerts.push({ type: "vercel_error", message: "Vercel API error" });
      }
    } catch (err) {
      checks.vercel = { ok: false, error: err.message };
      alerts.push({ type: "vercel_error", message: err.message });
    }
  }

  const summary = alerts.length > 0 ? "alerts" : "ok";
  monitoringState = {
    lastCheck: new Date().toISOString(),
    checks,
    summary,
    alerts,
  };
  return monitoringState;
}

const monitoringRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many monitoring requests", "Wait before refreshing again.");
  },
});

apiRoute("get", "/monitoring/status", monitoringRateLimiter, async (req, res) => {
  if (!isMonitoringEnabled()) {
    return apiError(res, 503, "MONITORING_DISABLED", "Monitoring is disabled", "Set ENABLE_MONITORING=1 and GITHUB_TOKEN or VERCEL_TOKEN.");
  }
  const forceRefresh = req.query?.refresh === "1";
  if (forceRefresh) {
    try {
      const data = await runMonitoringChecks();
      return res.json(data);
    } catch (err) {
      return apiError(res, 503, "CHECK_FAILED", err.message, "Monitoring check failed. See docs/RUNBOOK.md.");
    }
  }
  if (monitoringState.lastCheck) {
    return res.json(monitoringState);
  }
  try {
    const data = await runMonitoringChecks();
    return res.json(data);
  } catch (err) {
    return apiError(res, 503, "CHECK_FAILED", err.message, "Monitoring check failed. See docs/RUNBOOK.md.");
  }
});

if (isMonitoringEnabled()) {
  runMonitoringChecks().catch((e) => console.warn("[monitoring] Initial check failed:", e.message));
  monitoringIntervalId = setInterval(() => {
    runMonitoringChecks().catch((e) => console.warn("[monitoring] Scheduled check failed:", e.message));
  }, MONITORING_INTERVAL_MS);
}

// --- Phase 7: Status Report (aggregated health + integrations) ---
apiRoute("get", "/status/report", async (req, res) => {
  try {
    const [health, integrations] = await Promise.all([
      runHealthChecks(),
      Promise.resolve({
        github: Boolean(GITHUB_TOKEN),
        vercel: Boolean(VERCEL_TOKEN),
      }),
    ]);
    res.json({
      timestamp: new Date().toISOString(),
      health,
      integrations,
    });
  } catch (err) {
    return apiError(
      res,
      503,
      "REPORT_FAILED",
      err.message,
      "Health or integration checks failed. See docs/RUNBOOK.md."
    );
  }
});

// GitHub proxy - requires GITHUB_TOKEN; 503 with hint if missing
function requireGitHubToken(req, res, next) {
  if (!GITHUB_TOKEN) {
    return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "GitHub integration unavailable", "Set GITHUB_TOKEN in server environment variables.");
  }
  next();
}

apiRoute("get", "/github/repos",
  integrationRateLimiter,
  requireGitHubToken,
  async (req, res) => {
    try {
      const r = await fetch("https://api.github.com/user/repos?per_page=50", {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${GITHUB_TOKEN}`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({
          error: "GitHub API error",
          code: "BACKEND_ERROR",
          hint: (text || `HTTP ${r.status}`).slice(0, 500),
        });
      }
      const data = await r.json();
      res.json(data);
    } catch (err) {
      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check GITHUB_TOKEN and network connectivity to api.github.com.");
    }
  }
);

apiRoute("get", "/github/repo/:owner/:repo",
  integrationRateLimiter,
  requireGitHubToken,
  (req, res, next) => {
    const { owner, repo } = req.params;
    if (!validateOwnerRepo(owner, repo)) {
      return apiError(res, 400, "INVALID_INPUT", "Invalid owner or repo", "Use alphanumeric owner/repo names (e.g. octocat/hello-world).");
    }
    next();
  },
  async (req, res) => {
    const { owner, repo } = req.params;
    try {
      const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${GITHUB_TOKEN}`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({
          error: "GitHub API error",
          code: "BACKEND_ERROR",
          hint: (text || `HTTP ${r.status}`).slice(0, 500),
        });
      }
      const data = await r.json();
      res.json(data);
    } catch (err) {
      return apiError(res, 502, "BACKEND_UNREACHABLE", "GitHub proxy error: " + err.message, "Check GITHUB_TOKEN and network connectivity.");
    }
  }
);

apiRoute("get", "/github/issues/:owner/:repo",
  integrationRateLimiter,
  requireGitHubToken,
  (req, res, next) => {
    const { owner, repo } = req.params;
    if (!validateOwnerRepo(owner, repo)) {
      return apiError(res, 400, "INVALID_INPUT", "Invalid owner or repo", "Use alphanumeric owner/repo names (e.g. octocat/hello-world).");
    }
    next();
  },
  async (req, res) => {
    const { owner, repo } = req.params;
    const qs = new URLSearchParams(req.query).toString();
    const suffix = qs ? `?${qs}` : "";
    try {
      const r = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues${suffix}`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${GITHUB_TOKEN}`,
          },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({
          error: "GitHub API error",
          code: "BACKEND_ERROR",
          hint: (text || `HTTP ${r.status}`).slice(0, 500),
        });
      }
      const data = await r.json();
      res.json(data);
    } catch (err) {
      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check GITHUB_TOKEN and network connectivity to api.github.com.");
    }
  }
);

// Vercel proxy - requires VERCEL_TOKEN; 503 with hint if missing
function requireVercelToken(req, res, next) {
  if (!VERCEL_TOKEN) {
    return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "Vercel integration unavailable", "Set VERCEL_TOKEN in server environment variables.");
  }
  next();
}

apiRoute("get", "/vercel/deployments",
  integrationRateLimiter,
  requireVercelToken,
  async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const url = `https://api.vercel.com/v6/deployments${qs ? `?${qs}` : ""}`;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({
          error: "Vercel API error",
          code: "BACKEND_ERROR",
          hint: (text || `HTTP ${r.status}`).slice(0, 500),
        });
      }
      const data = await r.json();
      res.json(data);
    } catch (err) {
      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check VERCEL_TOKEN and network connectivity to api.vercel.com.");
    }
  }
);

// --- Phase 5: Personal Knowledge System ---
const KNOWLEDGE_MAX_DOC_BYTES = Number(process.env.KNOWLEDGE_MAX_DOC_BYTES) || 1024 * 1024; // 1MB
const sanitizeWorkspace = storage.sanitizeWorkspace;

// Phase 28: POST /api/embeddings - embed text(s) via OpenAI text-embedding-3-small
apiRoute("post", "/embeddings", embeddingsRateLimiter, logRequest, async (req, res) => {
  try {
    if (!embeddingsAvailable()) {
      return apiError(res, 503, "EMBEDDINGS_UNAVAILABLE", "Embeddings API unavailable", "Set OPENAI_API_KEY to enable embeddings.");
    }
    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : undefined;
    const texts = Array.isArray(body.texts) ? body.texts.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : undefined;

    if (text !== undefined && text !== "") {
      const vec = await embed(text);
      if (!vec) return apiError(res, 502, "EMBEDDING_FAILED", "Embedding request failed", "Check OPENAI_API_KEY and network.");
      return res.json({ embedding: vec });
    }
    if (texts !== undefined && texts.length > 0) {
      const vecs = await embedBatch(texts);
      if (!vecs) return apiError(res, 502, "EMBEDDING_FAILED", "Embedding request failed", "Check OPENAI_API_KEY and network.");
      return res.json({ embeddings: vecs });
    }
    return apiError(res, 400, "INVALID_BODY", "text or texts required", "Send { text: string } or { texts: string[] }.");
  } catch (err) {
    console.error("Embeddings API error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/knowledge/index",
  knowledgeIndexRateLimiter,
  logRequest,
  async (req, res) => {
    try {
      const body = req.body || {};
      const text = body.text;
      const workspace = sanitizeWorkspace(body.workspace);
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : undefined;
      const computeEmbedding = body.computeEmbedding === true;

      if (typeof text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required", "Send { text: string, workspace?: string, title?: string, computeEmbedding?: boolean } in the request body.");
      }

      const textBytes = Buffer.byteLength(text, "utf8");
      if (textBytes > KNOWLEDGE_MAX_DOC_BYTES) {
        return apiError(res, 413, "DOC_TOO_LARGE", `Document exceeds max size (${KNOWLEDGE_MAX_DOC_BYTES} bytes)`, `Reduce document size. Max ${Math.round(KNOWLEDGE_MAX_DOC_BYTES / 1024)}KB per document.`);
      }

      let embedding;
      if (computeEmbedding && embeddingsAvailable()) {
        embedding = await embed(text.trim());
      }
      const result = indexDocument({ text, workspace, title, embedding });
      if (result.error) {
        return res.status(400).json({ error: result.error, code: result.code, hint: result.hint });
      }
      res.status(201).json(result);
    } catch (err) {
      console.error("Knowledge index error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md for troubleshooting.");
    }
  }
);

apiRoute("get", "/knowledge/search", logRequest, async (req, res) => {
  try {
    const q = (req.query?.q ?? "").toString();
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const semantic = req.query?.semantic === "1" || req.query?.semantic === "true";
    const result = semantic
      ? await knowledgeSemanticSearch({ query: q, workspace })
      : knowledgeSearch({ query: q, workspace });
    if (result.error) {
      const status = result.code === "EMBEDDINGS_UNAVAILABLE" ? 503 : 400;
      return res.status(status).json({ error: result.error, code: result.code, hint: result.hint });
    }
    res.json(result);
  } catch (err) {
    console.error("Knowledge search error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md for troubleshooting.");
  }
});

apiRoute("get", "/knowledge/list", logRequest, (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const result = knowledgeList({ workspace });
    if (result.error) {
      return res.status(400).json({ error: result.error, code: result.code, hint: result.hint });
    }
    res.json(result);
  } catch (err) {
    console.error("Knowledge list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md for troubleshooting.");
  }
});

// --- Phase 10: Rate limiter for storage/workspace routes ---
const storageRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Phase 14: Workspaces API ---
apiRoute("get", "/workspaces", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const workspaces = storage.listWorkspaces(req.userId);
    res.json({ _version: 1, items: workspaces });
  } catch (err) {
    console.error("Workspaces list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/workspaces", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "Workspace";
    const ws = await storage.createWorkspace(req.userId, name);
    res.status(201).json(ws);
  } catch (err) {
    console.error("Workspace create error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// --- Phase 10: Persistent Backend Storage (SiskelBot) ---
// GET/POST /api/context (userAuth attaches req.userId; anonymous when no auth configured)
apiRoute("get", "/context", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const data = await storage.listItems("context", workspace, req.userId);
    res.json({ _version: 1, items: data });
  } catch (err) {
    console.error("Storage context list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/context", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const { title, content } = req.body || {};
    if (typeof title !== "string" || !title.trim()) {
      return apiError(res, 400, "INVALID_INPUT", "title required", "Send { title: string, content?: string }.");
    }
    const id = (req.body?.id && String(req.body.id).trim()) || randomUUID();
    const doc = {
      id,
      title: title.trim().slice(0, 500),
      content: typeof content === "string" ? content : "",
      createdAt: new Date().toISOString(),
    };
    const merged = await storage.mergeItems("context", workspace, [doc]);
    const item = merged.find((x) => x.id === id) || doc;
    res.status(201).json(item);
  } catch (err) {
    console.error("Storage context add error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// GET/PUT/DELETE /api/context/:id
apiRoute("get", "/context/:id", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const item = await storage.getItem("context", req.params.id, workspace);
    if (!item) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.json(item);
  } catch (err) {
    console.error("Storage context get error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("put", "/context/:id", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const { title, content } = req.body || {};
    const updated = await storage.updateItem("context", req.params.id, workspace, (existing) => {
      if (typeof title === "string" && title.trim()) existing.title = title.trim().slice(0, 500);
      if (content !== undefined) existing.content = typeof content === "string" ? content : "";
      return existing;
    });
    if (!updated) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.json(updated);
  } catch (err) {
    console.error("Storage context update error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("delete", "/context/:id", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const deleted = await storage.deleteItem("context", req.params.id, workspace);
    if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.status(204).send();
  } catch (err) {
    console.error("Storage context delete error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// POST /api/context/sync - merge client payload, return merged list
apiRoute("post", "/context/sync", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const valid = items.filter((x) => x && x.id && typeof x.title === "string");
    const merged = await storage.mergeItems("context", workspace, valid);
    res.json({ _version: 1, items: merged });
  } catch (err) {
    console.error("Storage context sync error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// GET/POST /api/recipes
apiRoute("get", "/recipes", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const data = await storage.listItems("recipes", workspace);
    res.json({ _version: 1, items: data });
  } catch (err) {
    console.error("Storage recipes list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/recipes", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const recipe = req.body;
    if (!recipe || typeof recipe !== "object" || typeof recipe.name !== "string" || !recipe.name.trim()) {
      return apiError(res, 400, "INVALID_INPUT", "Recipe with name required", "Send { name, steps, description?: }.");
    }
    const id = (recipe.id && String(recipe.id).trim()) || randomUUID();
    const item = {
      id,
      name: recipe.name.trim().slice(0, 128),
      description: typeof recipe.description === "string" ? recipe.description.trim().slice(0, 512) : "",
      steps: Array.isArray(recipe.steps) ? recipe.steps : [],
      createdAt: new Date().toISOString(),
    };
    const merged = await storage.mergeItems("recipes", workspace, [item]);
    const out = merged.find((x) => x.id === id) || item;
    res.status(201).json(out);
  } catch (err) {
    console.error("Storage recipes add error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// GET/PUT/DELETE /api/recipes/:id
apiRoute("get", "/recipes/:id", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const item = await storage.getItem("recipes", req.params.id, workspace);
    if (!item) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.json(item);
  } catch (err) {
    console.error("Storage recipes get error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("put", "/recipes/:id", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const { name, description, steps } = req.body || {};
    const updated = await storage.updateItem("recipes", req.params.id, workspace, (existing) => {
      if (typeof name === "string" && name.trim()) existing.name = name.trim().slice(0, 128);
      if (description !== undefined) existing.description = typeof description === "string" ? description.slice(0, 512) : "";
      if (Array.isArray(steps)) existing.steps = steps;
      return existing;
    });
    if (!updated) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.json(updated);
  } catch (err) {
    console.error("Storage recipes update error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("delete", "/recipes/:id", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const deleted = await storage.deleteItem("recipes", req.params.id, workspace);
    if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.status(204).send();
  } catch (err) {
    console.error("Storage recipes delete error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// POST /api/recipes/sync
apiRoute("post", "/recipes/sync", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const valid = items.filter((x) => x && x.id && typeof x.name === "string");
    const merged = await storage.mergeItems("recipes", workspace, valid);
    res.json({ _version: 1, items: merged });
  } catch (err) {
    console.error("Storage recipes sync error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// --- Phase 16: Scheduled & Automated Recipes ---
// GET /api/schedules - list scheduled recipes
apiRoute("get", "/schedules", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const items = scheduleStore.list(workspace);
    const withRecipe = items.map((s) => {
      const recipe = storage.get("recipes", s.recipeId, s.workspace || workspace);
      return { ...s, recipeName: recipe?.name || null };
    });
    res.json({ items: withRecipe });
  } catch (err) {
    console.error("Schedules list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// POST /api/schedules - add/update schedule for recipe
apiRoute("post", "/schedules", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const { recipeId, cron, timezone, enabled } = req.body || {};
    if (!recipeId || typeof recipeId !== "string" || !recipeId.trim()) {
      return apiError(res, 400, "INVALID_INPUT", "recipeId required", "Send { recipeId, cron, timezone?, enabled? }.");
    }
    if (!cron || typeof cron !== "string" || !cron.trim()) {
      return apiError(res, 400, "INVALID_INPUT", "cron required", "Cron format: minute hour day month weekday (e.g. 0 9 * * 1-5).");
    }
    const recipe = storage.get("recipes", recipeId.trim(), workspace);
    if (!recipe) {
      return apiError(res, 404, "NOT_FOUND", "Recipe not found", "Create the recipe first.");
    }
    const sched = scheduleStore.upsert(recipeId.trim(), { cron: cron.trim(), timezone, enabled: enabled !== false }, workspace);
    if (process.env.ENABLE_SCHEDULED_RECIPES === "1") schedulerRefresh();
    res.status(201).json(sched);
  } catch (err) {
    console.error("Schedule upsert error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// DELETE /api/schedules/:recipeId - remove schedule
apiRoute("delete", "/schedules/:recipeId", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const removed = scheduleStore.remove(req.params.recipeId, workspace);
    if (!removed) return res.status(404).json({ error: "Schedule not found", code: "NOT_FOUND" });
    if (process.env.ENABLE_SCHEDULED_RECIPES === "1") schedulerRefresh();
    res.status(204).send();
  } catch (err) {
    console.error("Schedule delete error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// POST /api/schedules/run-now/:recipeId - manual trigger
apiRoute("post", "/schedules/run-now/:recipeId", storageRateLimiter, apiKeyAuth, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
    const result = await runRecipeNow(req.params.recipeId, workspace);
    if (!result.ok) {
      return apiError(res, 400, "RUN_FAILED", result.error || "Run failed", "Check ALLOW_RECIPE_STEP_EXECUTION=1 and recipe exists.");
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Run now error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// GET /api/cron - Vercel cron: triggers scheduler for due jobs. Requires CRON_SECRET.
apiRoute("get", "/cron", logRequest, async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers["authorization"] !== `Bearer ${secret}` && req.query?.secret !== secret) {
    return apiError(res, 401, "UNAUTHORIZED", "Cron secret required", "Set CRON_SECRET and pass via Authorization: Bearer or ?secret=.");
  }
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace) || "default";
    const result = await runDueJobsVercel(workspace);
    res.json({ ok: true, ran: result.ran, skipped: result.skipped || false });
  } catch (err) {
    console.error("Cron tick error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// Phase 24: Backup & Restore
apiRoute("post", "/backup", storageRateLimiter, backupAdminAuth, logRequest, async (req, res) => {
  try {
    const result = await createBackup();
    res.status(201).json(result);
  } catch (err) {
    console.error("Backup create error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/backup", storageRateLimiter, backupAdminAuth, logRequest, async (req, res) => {
  try {
    const items = listBackups();
    res.json({ items });
  } catch (err) {
    console.error("Backup list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/backup/restore/:id", storageRateLimiter, backupAdminAuth, logRequest, async (req, res) => {
  try {
    await restoreBackup(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (err.message?.includes("not found") || err.message?.includes("Backup id required")) {
      return res.status(404).json({ error: err.message, code: "NOT_FOUND" });
    }
    console.error("Backup restore error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// GET /api/backup/cron - Vercel cron for scheduled daily backups. Requires ?secret= or BACKUP_ADMIN_KEY.
app.get("/api/backup/cron", logRequest, async (req, res) => {
  const secret = process.env.BACKUP_ADMIN_KEY || process.env.CRON_SECRET;
  if (secret && req.query?.secret !== secret && req.headers["authorization"] !== `Bearer ${secret}`) {
    return apiError(res, 401, "UNAUTHORIZED", "Backup cron secret required", "Set BACKUP_ADMIN_KEY and pass via ?secret= or Authorization: Bearer.");
  }
  try {
    const result = await createBackup();
    res.json({ ok: true, id: result.id, createdAt: result.createdAt });
  } catch (err) {
    console.error("Backup cron error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// GET/POST /api/conversations
apiRoute("get", "/conversations", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const data = await storage.listItems("conversations", workspace);
    res.json({ _version: 1, items: data });
  } catch (err) {
    console.error("Storage conversations list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/conversations", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const { id, title, messages, meta } = req.body || {};
    const convId = (id && String(id).trim()) || randomUUID();
    const item = {
      id: convId,
      title: typeof title === "string" ? title.trim().slice(0, 200) : "Untitled",
      messages: Array.isArray(messages) ? messages : [],
      meta: meta && typeof meta === "object" ? meta : {},
      createdAt: new Date().toISOString(),
    };
    const merged = await storage.mergeItems("conversations", workspace, [item]);
    const out = merged.find((x) => x.id === convId) || item;
    res.status(201).json(out);
  } catch (err) {
    console.error("Storage conversations add error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// GET/PUT/DELETE /api/conversations/:id
apiRoute("get", "/conversations/:id", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const item = await storage.getItem("conversations", req.params.id, workspace);
    if (!item) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.json(item);
  } catch (err) {
    console.error("Storage conversations get error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("put", "/conversations/:id", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const { title, messages, meta } = req.body || {};
    const updated = await storage.updateItem("conversations", req.params.id, workspace, (existing) => {
      if (typeof title === "string") existing.title = title.trim().slice(0, 200);
      if (Array.isArray(messages)) existing.messages = messages;
      if (meta && typeof meta === "object") existing.meta = meta;
      return existing;
    });
    if (!updated) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.json(updated);
  } catch (err) {
    console.error("Storage conversations update error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("delete", "/conversations/:id", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const deleted = await storage.deleteItem("conversations", req.params.id, workspace);
    if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.status(204).send();
  } catch (err) {
    console.error("Storage conversations delete error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/vercel/projects",
  integrationRateLimiter,
  requireVercelToken,
  async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const url = `https://api.vercel.com/v10/projects${qs ? `?${qs}` : ""}`;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({
          error: "Vercel API error",
          code: "BACKEND_ERROR",
          hint: (text || `HTTP ${r.status}`).slice(0, 500),
        });
      }
      const data = await r.json();
      res.json(data);
    } catch (err) {
      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check VERCEL_TOKEN and network connectivity to api.vercel.com.");
    }
  }
);

// --- Phase 6: Automation Recipes ---

const AUTOMATION_MAX_RECIPE_BYTES = 64 * 1024; // 64KB
const AUTOMATION_MAX_NAME_LENGTH = 128;
const AUTOMATION_MAX_STEP_ACTION_LENGTH = 512;

function validateAutomationRecipe(recipe) {
  const errors = [];
  if (!recipe || typeof recipe !== "object") {
    return { valid: false, errors: ["Recipe must be an object"] };
  }
  if (typeof recipe.name !== "string" || !recipe.name.trim()) {
    errors.push("name: required non-empty string");
  } else if (recipe.name.length > AUTOMATION_MAX_NAME_LENGTH) {
    errors.push(`name: max ${AUTOMATION_MAX_NAME_LENGTH} chars`);
  }
  if (recipe.trigger !== undefined && typeof recipe.trigger !== "string") {
    errors.push("trigger: must be string");
  }
  if (!Array.isArray(recipe.steps)) {
    errors.push("steps: required array");
  } else {
    recipe.steps.forEach((s, i) => {
      if (!s || typeof s !== "object") {
        errors.push(`steps[${i}]: must be object`);
      } else if (!s.action || typeof s.action !== "string" || !String(s.action).trim()) {
        errors.push(`steps[${i}]: action required non-empty string`);
      } else if (String(s.action).length > AUTOMATION_MAX_STEP_ACTION_LENGTH) {
        errors.push(`steps[${i}]: action max ${AUTOMATION_MAX_STEP_ACTION_LENGTH} chars`);
      }
      if (s.payload !== undefined && (s.payload === null || Array.isArray(s.payload) || typeof s.payload !== "object")) {
        errors.push(`steps[${i}]: payload must be object`);
      }
    });
  }
  if (recipe.inputs !== undefined && (recipe.inputs === null || Array.isArray(recipe.inputs) || typeof recipe.inputs !== "object")) {
    errors.push("inputs: must be object");
  }
  if (recipe.outputs !== undefined && (recipe.outputs === null || Array.isArray(recipe.outputs) || typeof recipe.outputs !== "object")) {
    errors.push("outputs: must be object");
  }
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(recipe)).length;
    if (bytes > AUTOMATION_MAX_RECIPE_BYTES) {
      errors.push(`Recipe exceeds max size (${AUTOMATION_MAX_RECIPE_BYTES} bytes)`);
    }
  } catch (_) {
    errors.push("Recipe serialization failed");
  }
  return { valid: errors.length === 0, errors };
}

apiRoute("post", "/automations/validate",
  integrationRateLimiter,
  logRequest,
  (req, res) => {
    try {
      const recipe = req.body;
      const result = validateAutomationRecipe(recipe);
      return res.json({ valid: result.valid, errors: result.errors });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  }
);

// --- Phase 17: Plugins & Extensions ---
const pluginsActionsRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
apiRoute("get", "/plugins/actions", pluginsActionsRateLimiter, userAuth, logRequest, (req, res) => {
  try {
    const actions = getRegisteredActions();
    res.json({ actions: [...actions].sort() });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// --- Phase 22: Event Webhooks & Notifications ---
const webhooksRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const webhooksHandlers = [webhooksRateLimiter, storageRateLimiter, userAuth, logRequest];

apiRoute("get", "/webhooks", ...webhooksHandlers, (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const items = listWebhooks(workspace);
    res.json({ _version: 1, items });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBHOOKS.md.");
  }
});

apiRoute("post", "/webhooks", ...webhooksHandlers, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const { url, events, secret } = req.body || {};
    if (!url || typeof url !== "string" || !url.trim()) {
      return apiError(res, 400, "INVALID_INPUT", "url required", "Send { url: string, events: string[], secret?: string }.");
    }
    const v = validateWebhookUrl(url.trim());
    if (!v.valid) {
      return apiError(res, 400, "INVALID_URL", v.reason, "Use HTTPS URL. Set ALLOW_WEBHOOK_LOCALHOST=1 for localhost.");
    }
    const ev = Array.isArray(events) ? events : [];
    if (ev.length === 0) {
      return apiError(res, 400, "INVALID_INPUT", "At least one event required", "Events: message_sent, plan_created, recipe_executed, schedule_completed.");
    }
    const webhook = await addWebhook({ url: url.trim(), events: ev, secret }, workspace);
    res.status(201).json(webhook);
  } catch (err) {
    if (err.message?.includes("At least one event") || err.message?.includes("URL")) {
      return apiError(res, 400, "INVALID_INPUT", err.message, "See docs/WEBHOOKS.md.");
    }
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBHOOKS.md.");
  }
});

apiRoute("delete", "/webhooks/:id", ...webhooksHandlers, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const removed = await removeWebhook(req.params.id, workspace);
    if (!removed) return res.status(404).json({ error: "Webhook not found", code: "NOT_FOUND" });
    res.status(204).send();
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBHOOKS.md.");
  }
});

// --- Phase 27: In-App Notification Center ---
apiRoute("get", "/notifications", ...webhooksHandlers, (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const userId = req.userId ?? "anonymous";
    const items = listNotifications(workspace, userId);
    res.json({ _version: 1, items });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("patch", "/notifications/mark-all-read", ...webhooksHandlers, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace || req.body?.workspace);
    const userId = req.userId ?? "anonymous";
    await markAllNotificationsRead(workspace, userId);
    res.json({ ok: true });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("patch", "/notifications/:id", ...webhooksHandlers, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const userId = req.userId ?? "anonymous";
    const ok = await markNotificationRead(req.params.id, workspace, userId);
    if (!ok) return res.status(404).json({ error: "Notification not found", code: "NOT_FOUND" });
    res.json({ ok: true });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// --- Phase 9: Recipe Execution & Automation Hooks ---
const executeStepRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many execute requests", "Wait before retrying.");
  },
});

apiRoute("post", "/execute-step",
  executeStepRateLimiter,
  apiKeyAuth,
  logRequest,
  async (req, res) => {
    if (!ALLOW_RECIPE_STEP_EXECUTION) {
      return apiError(
        res,
        503,
        "EXECUTION_DISABLED",
        "Recipe step execution is disabled",
        "Set ALLOW_RECIPE_STEP_EXECUTION=1 to enable. See docs/RUNBOOK.md."
      );
    }

    const { step, allowExecution } = req.body || {};
    if (!allowExecution) {
      return apiError(
        res,
        403,
        "EXECUTION_NOT_ALLOWED",
        "Client must have Allow recipe step execution enabled",
        "Enable the toggle in Settings to run steps."
      );
    }

    if (!step || typeof step !== "object" || !step.action) {
      return apiError(res, 400, "INVALID_BODY", "step with action required", "Send { step: { action, payload? }, allowExecution: true }.");
    }

    const execWorkspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);

    try {
      const ctx = {
        projectDir: process.env.PROJECT_DIR || process.cwd(),
        vercelToken: process.env.VERCEL_TOKEN,
      };
      const result = await executeStep(step, ctx);

      appendAuditLog({
        action: step.action,
        payload: step.payload,
        ok: result.ok,
        error: result.error,
      });

      emitEvent(
        "recipe_executed",
        { step: { action: step.action, payload: step.payload }, ok: result.ok, error: result.error },
        { workspaceId: execWorkspace, userId: req.userId }
      );

      if (result.ok) {
        return res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
      }
      return res.status(400).json({
        ok: false,
        error: result.error,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (err) {
      console.error("Execute step error:", err.message);
      appendAuditLog({
        action: step?.action,
        payload: step?.payload,
        ok: false,
        error: err.message,
      });
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  }
);

// --- Phase 8: Multimodal Utility Layer ---
const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DOC_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const ALLOWED_DOC_TYPES = ["application/pdf", "text/plain", "text/markdown", "text/csv"];

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid image type. Allowed: ${ALLOWED_IMAGE_TYPES.join(", ")}`), false);
  },
});

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOC_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_DOC_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid document type. Allowed: PDF, plain text`), false);
  },
});

const multimodalRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function sanitizeText(str, maxLen = 50_000) {
  if (typeof str !== "string") return "";
  return str.slice(0, maxLen).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

apiRoute("post", "/vision/describe",
  multimodalRateLimiter,
  (req, res, next) => {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("application/json")) {
      const { image } = req.body || {};
      if (!image) return apiError(res, 400, "INVALID_BODY", "image required (base64 or multipart)", "Send image as base64 in JSON body or multipart/form-data.");
      const match = /^data:([^;]+);base64,(.+)$/.exec(image);
      const base64 = match ? match[2] : image;
      try {
        req.visionBuffer = Buffer.from(base64, "base64");
        if (req.visionBuffer.length > IMAGE_MAX_BYTES)
          return apiError(res, 400, "FILE_TOO_LARGE", `Image exceeds ${IMAGE_MAX_BYTES / 1024 / 1024}MB limit`, "Reduce image size.");
        next();
      } catch (e) {
        return apiError(res, 400, "INVALID_BASE64", "Invalid base64 image", "Provide valid base64-encoded image data.");
      }
      return;
    }
    imageUpload.single("image")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE")
            return apiError(res, 400, "FILE_TOO_LARGE", `Image exceeds ${IMAGE_MAX_BYTES / 1024 / 1024}MB limit`, "Reduce image size.");
          if (err.code === "LIMIT_UNEXPECTED_FILE")
            return apiError(res, 400, "INVALID_BODY", "Use field name 'image' for multipart upload", null);
        }
        return apiError(res, 400, "INVALID_FILE", err.message || "Invalid image upload", null);
      }
      if (!req.file?.buffer)
        return apiError(res, 400, "INVALID_BODY", "image required (base64 or multipart)", null);
      req.visionBuffer = req.file.buffer;
      next();
    });
  },
  logRequest,
  async (req, res) => {
    try {
      if (!OPENAI_API_KEY) {
        return res.status(200).json({ description: "Vision requires OpenAI backend.", hint: "Set OPENAI_API_KEY to use image description." });
      }
      const buffer = req.visionBuffer;
      const base64 = buffer.toString("base64");
      const mime = buffer[0] === 0x89 ? "image/png" : buffer[1] === 0xff && buffer[2] === 0xd8 ? "image/jpeg" : "image/webp";
      const dataUrl = `data:${mime};base64,${base64}`;

      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image in detail. Be concise." },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 500,
        }),
      });

      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({
          error: "Vision API error",
          code: "BACKEND_ERROR",
          hint: (err || `HTTP ${r.status}`).slice(0, 500),
        });
      }
      const data = await r.json();
      const description = data.choices?.[0]?.message?.content || "No description.";
      return res.json({ description: sanitizeText(description) });
    } catch (err) {
      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check OPENAI_API_KEY and network.");
    }
  }
);

apiRoute("post", "/documents/extract",
  multimodalRateLimiter,
  (req, res, next) => {
    docUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE")
            return apiError(res, 400, "FILE_TOO_LARGE", `Document exceeds ${DOC_MAX_BYTES / 1024 / 1024}MB limit`, "Reduce file size.");
          if (err.code === "LIMIT_UNEXPECTED_FILE")
            return apiError(res, 400, "INVALID_BODY", "Use field name 'file' for multipart upload", null);
        }
        return apiError(res, 400, "INVALID_FILE", err.message || "Invalid file upload", null);
      }
      next();
    });
  },
  logRequest,
  async (req, res) => {
    try {
      if (!req.file?.buffer)
        return apiError(res, 400, "INVALID_BODY", "file required (multipart/form-data)", "Upload a PDF or plain text file with field name 'file'.");
      const mime = req.file.mimetype || "";
      const buffer = req.file.buffer;

      if (mime === "application/pdf") {
        try {
          const { PDFParse } = await import("pdf-parse");
          const parser = new PDFParse({ data: buffer });
          const result = await parser.getText();
          await parser.destroy?.();
          const text = (result?.text ?? result?.pages?.map((p) => p?.text).filter(Boolean).join("\n\n") ?? "").trim();
          return res.json({ text: sanitizeText(text), type: "pdf" });
        } catch (e) {
          return apiError(res, 500, "EXTRACT_FAILED", "PDF extraction failed", (e?.message || "See docs/RUNBOOK.md.").slice(0, 300));
        }
      }

      const text = buffer.toString("utf8");
      return res.json({ text: sanitizeText(text), type: "text" });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  }
);

apiRoute("post", "/ocr", multimodalRateLimiter, (req, res) => {
  return res.status(501).json({
    error: "OCR not implemented",
    code: "NOT_IMPLEMENTED",
    hint: "OCR will use an external service (e.g. Tesseract.js or cloud OCR). See README for planned integration.",
  });
});

// Phase 23: API docs - OpenAPI spec and Swagger UI (not versioned, no deprecation)
app.get("/api/docs/openapi.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.json(openApiSpec);
});

app.get("/docs", (req, res) => res.redirect(302, "/api/docs"));
app.get("/api/docs", (req, res) => {
  const base = req.protocol + "//" + (req.get("host") || "localhost");
  const specUrl = base + "/api/docs/openapi.json";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SiskelBot API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "${specUrl}",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    });
  </script>
</body>
</html>`);
});

// --- Phase 25: Admin Dashboard ---
app.get("/admin", (req, res) => {
  res.sendFile(join(__dirname, "client", "admin.html"));
});

const adminRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Support admin key via query for browser (GET only)
function adminAuthOrQuery(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (adminKey && req.method === "GET" && req.query?.key === adminKey) {
    return next();
  }
  return adminAuth(req, res, next);
}

app.get("/api/admin/summary", adminRateLimiter, adminAuthOrQuery, logRequest, async (req, res) => {
  try {
    const users = listAllUsers();
    const workspaces = listAllWorkspaces();
    const usageSummary = getSummary(7);
    const auditLog = getRecentAuditLog(50);
    const quotaOverrides = getQuotaOverrides();

    // Enrich workspaces with quota and usage
    const workspacesWithQuota = workspaces.map(({ userId, workspace: ws }) => {
      const wsId = ws?.id || "default";
      const quota = getWorkspaceQuota(wsId, null);
      const used = isQuotaConfigured() ? getWorkspaceTokensUsed(wsId) : 0;
      return {
        userId,
        workspaceId: wsId,
        workspaceName: ws?.name || wsId,
        quota,
        tokensUsed: used,
        override: quotaOverrides[wsId],
      };
    });

    const [health] = await Promise.all([runHealthChecks()]);
    const integrations = {
      github: Boolean(process.env.GITHUB_TOKEN),
      vercel: Boolean(process.env.VERCEL_TOKEN),
    };

    res.json({
      users,
      workspaces: workspacesWithQuota,
      usage: usageSummary,
      auditLog,
      quotaOverrides,
      system: {
        health,
        integrations,
        quotaConfigured: isQuotaConfigured(),
        scheduleEnabled: process.env.ENABLE_SCHEDULED_RECIPES === "1",
      },
    });
  } catch (err) {
    console.error("Admin summary error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

app.post("/api/admin/quotas/override", adminRateLimiter, adminAuth, logRequest, async (req, res) => {
  try {
    const { workspace, limit } = req.body || {};
    const ws = sanitizeWorkspace(workspace);
    const result = await setWorkspaceQuotaOverride(ws, limit == null ? null : Number(limit));
    if (!result.ok) {
      return res.status(400).json({ error: result.error, code: "INVALID_INPUT" });
    }
    res.json(result);
  } catch (err) {
    console.error("Quota override error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

app.use(express.static(join(__dirname, "client")));

if (process.env.VERCEL !== "1") {
  app.listen(PORT, () => {
    console.log(`Proxy: http://localhost:${PORT}`);
    console.log(`Backend: ${BACKEND}`);
    if (BACKEND === "vllm") console.log(`vLLM:  ${VLLM_URL}`);
    if (BACKEND === "ollama") console.log(`Ollama: ${OLLAMA_URL}`);
    if (BACKEND === "openai") console.log(`OpenAI: api.openai.com (key set)`);
    if (process.env.ENABLE_SCHEDULED_RECIPES === "1") schedulerStart();
  });
}
export default app;
