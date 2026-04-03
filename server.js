import "dotenv/config";
import { createServer } from "http";
import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import multer from "multer";
import passport from "passport";
import { initPassport, isOAuthConfigured } from "./lib/oauth.js";
import { configureSSO, isSSOConfigured } from "./lib/sso.js";
import { getLeaderElection } from "./lib/leader-election.js";
import { getRegionHealth } from "./lib/region-health.js";
import { getReplicationManager, internalAuth } from "./lib/storage-replication.js";
import {
  branchConversation,
  getConversationTree,
  listBranches as listConversationBranches,
  getBranch as getConversationBranch,
  deleteBranch as deleteConversationBranch,
} from "./lib/conversation-tree.js";
import {
  indexDocument,
  search as knowledgeSearch,
  semanticSearch as knowledgeSemanticSearch,
  list as knowledgeList,
  reindexKnowledgeEmbeddingsInWorkspace,
} from "./lib/knowledge-store.js";
import { embed, embedBatch, isAvailable as embeddingsAvailable } from "./lib/embeddings.js";
import { executeStep, appendAuditLog, getRegisteredActions } from "./lib/action-executor.js";
import { loadPlugins } from "./lib/plugins-loader.js";
import {
  discoverPacks,
  registry as marketplaceRegistry,
  listAvailable as marketplaceListAvailable,
  listInstalled as marketplaceListInstalled,
  installPack as marketplaceInstallPack,
  uninstallPack as marketplaceUninstallPack,
} from "./lib/plugin-marketplace.js";
import { loadPlugin as loadJsPlugin, executePlugin as execJsPlugin, listPlugins as listJsPlugins } from "./lib/plugin-sandbox.js";
import { getToolsSchema, intersectClientToolsWithAllowlist, getAgentToolsAllowlistNames } from "./lib/agent-tools.js";
import { resolveAgentMaxIterations } from "./lib/agent-iterations.js";
import * as storage from "./lib/storage.js";
import * as scheduleStore from "./lib/schedules.js";
import { start as schedulerStart, stop as schedulerStop, refresh as schedulerRefresh, runRecipeNow, runDueJobsVercel } from "./lib/scheduler.js";
import { userAuth, isAuthConfigured } from "./lib/auth.js";
import { recordUsage, getSummary, getTotalTokensInWindow, getRecordsForPeriod, estimate } from "./lib/usage-tracker.js";
import { getDashboard, exportToCsv, exportToJson } from "./lib/analytics.js";
import { emitEvent, listWebhooks, addWebhook, removeWebhook, validateWebhookUrl } from "./lib/webhooks.js";
import { list as listNotifications, markRead as markNotificationRead, markAllRead as markAllNotificationsRead } from "./lib/notifications.js";
import { isQuotaConfigured, checkQuota, getWorkspaceQuota, getWorkspaceTokensUsed, isQuotaAdmin, setWorkspaceQuotaOverride, getQuotaOverrides } from "./lib/quotas.js";
import { createBackup, listBackups, restoreBackup } from "./lib/backup.js";
import { adminAuth } from "./lib/admin-auth.js";
import { adminIpAllowlist } from "./lib/admin-ip-allowlist.js";
import { listAllUsers, listAllWorkspaces, getRecentAuditLog } from "./lib/admin-data.js";
import { requireScope } from "./lib/scope-middleware.js";
import { logKeyUsage } from "./lib/api-key-audit.js";
import { listKeysForAdmin, addKey, revokeKey, warmApiKeysCache } from "./lib/api-keys.js";
import {
  canAccessWorkspace,
  resolveStorageUserId,
  createInviteCode,
  joinByInviteCode,
  getWorkspaceMembers,
  getWorkspaceActivity,
  logActivity,
} from "./lib/teams.js";
import openApiSpec from "./lib/openapi-spec.js";
import { runEvalSet } from "./lib/eval-runner.js";
import { listEvalSets, loadEvalSet } from "./lib/storage-eval.js";
import { createToken, attachToServer, getOnlineUsers, closeServer } from "./lib/realtime.js";
import { sanitizeForLog } from "./lib/log-sanitizer.js";
import { execute as circuitExecute } from "./lib/circuit-breaker.js";
import { parseRoutingConfig, selectBackend, logRouting, getRoutingStats } from "./lib/ab-router.js";
import { AuditLifecycle } from "./lib/audit-lifecycle.js";
import { queryAudit, exportAudit } from "./lib/audit-query.js";
import { initErrorReporting, reportError } from "./lib/error-reporting.js";
import {
  runSwarm,
  runSwarmLegacy,
  getSwarmSelectableSpecialistNames,
  getSwarmSpecialistsAllowlistNames,
  intersectSwarmSpecialistsWithAllowlist,
} from "./lib/swarm.js";
import { initTracing } from "./lib/tracing.js";
import {
  recordRequest,
  renderPrometheus,
  recordChatRequest,
  recordTokensUsed,
  isEnabled as metricsEnabled,
} from "./lib/metrics.js";
import { fetchWithTimeoutAndRetry } from "./lib/backend-fetch.js";
import { toolValidationEnabled } from "./lib/tool-validation.js";
import { stagnationDetectionEnabled } from "./lib/agent-stagnation.js";
import { loadTrajectory, listTrajectories, trajectoryApiEnabled } from "./lib/agent-trajectory.js";
import { defaultAgentSystemConfigured } from "./lib/agent-defaults.js";
import {
  loadWorkspaceAgentSettings,
  saveWorkspaceAgentSettings,
  getWorkspaceAgentAccess,
  canEditWorkspaceAgentSettings,
} from "./lib/workspace-agent-settings.js";
import compression from "compression";
import { otelHttpEnrichmentMiddleware } from "./lib/otel-context.js";
import { exportWorkspaceBundle, deleteWorkspaceForUser } from "./lib/workspace-lifecycle.js";
import { idempotencyLookup, idempotencyStore } from "./lib/idempotency.js";
import { archiveExecutionAuditToS3, getAuditArchiveStatus } from "./lib/audit-s3-archive.js";
import { fetchTextFromAllowedUrl } from "./lib/knowledge-url-fetch.js";
import { pipeLlmChatStreamToSse } from "./lib/llm-stream-sse.js";
import { runAgentLoop } from "./lib/agent-loop.js";
import {
  recordTrace,
  listTraces as listRecordedTraces,
  getTrace as getRecordedTrace,
  deleteTrace as deleteRecordedTrace,
  autoRecordEnabled,
} from "./lib/trace-recorder.js";
import { replayTrace, replayAll } from "./lib/trace-replay.js";

import {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
  createWorkspaceFromTemplate,
} from "./lib/workspace-templates.js";

import { mountAllRoutes } from "./routes/index.js";
import { errorMiddleware, errorHandler } from "./lib/error-middleware.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Phase 38: Error reporting webhook (production)
initErrorReporting();

// Phase 17: Load plugins at startup (plugins/config.json or PLUGINS_PATH)
loadPlugins();

// Phase 49: Discover marketplace plugin packs at startup
discoverPacks();

// Environment config
const VLLM_URL = process.env.VLLM_URL || "http://localhost:8000";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; // optional; protects /v1/chat/completions when set
const API_KEY_PREVIOUS = process.env.API_KEY_PREVIOUS || null; // rotation: previous key accepted during rollover
const API_KEY_SCOPES = (process.env.API_KEY_SCOPES || "read,write").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 60;
const RATE_LIMIT_MAX_PER_USER = Number(process.env.RATE_LIMIT_MAX_PER_USER) || RATE_LIMIT_MAX;
const RATE_LIMIT_PER_KEY = process.env.RATE_LIMIT_PER_KEY ? Number(process.env.RATE_LIMIT_PER_KEY) : null;

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

// A/B routing: parse MODEL_ROUTING env var (e.g. "ollama:0.8,openai:0.2")
const MODEL_ROUTING_CONFIG = parseRoutingConfig(process.env.MODEL_ROUTING);
const AB_ROUTING_ENABLED = MODEL_ROUTING_CONFIG.length > 0;

const BACKEND = getBackend();
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const STREAM_AGENT_FINAL = process.env.STREAM_AGENT_FINAL === "1";
const AGENT_STREAM_CHUNK_SIZE = Math.max(64, Number(process.env.AGENT_STREAM_CHUNK_SIZE) || 320);
const STREAM_SWARM_SYNTH = process.env.STREAM_SWARM_SYNTH === "1";
const MAX_AGENT_TOOL_CALLS_ENV = Number(process.env.MAX_AGENT_TOOL_CALLS) || 0;
const AGENT_MAX_WALL_MS_ENV = Number(process.env.AGENT_MAX_WALL_MS) || 0;

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
function validateStartupConfig() {
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
validateStartupConfig();

// Model presets per backend (for /config)
const MODEL_PRESETS = {
  ollama: ["llama3.2", "mistral", "llama2", "codellama"],
  vllm: ["meta-llama/Llama-3-8B-Instruct", "mistralai/Mistral-7B-Instruct-v0.2"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
};

// Phase 37: Backend fetch with circuit breaker; Phase 41: timeout/retry; Phase 53: optional FALLBACK_BACKEND
async function backendFetch(url, options, backend = BACKEND) {
  const fb = process.env.FALLBACK_BACKEND?.toLowerCase();
  const tryFallback = async (firstRes) => {
    if (!fb || fb === backend) return firstRes;
    if (firstRes?.ok) return firstRes;
    if (firstRes && firstRes.status < 500 && firstRes.status !== 429) return firstRes;
    try {
      const cfg = buildProxyConfig(fb);
      const url2 = `${cfg.baseUrl}${cfg.path}`;
      const hdr = { ...cfg.headers, ...(options.headers || {}) };
      const opts2 = { ...options, headers: hdr };
      return await circuitExecute(fb, () => fetchWithTimeoutAndRetry(url2, opts2, fb));
    } catch {
      return firstRes;
    }
  };

  try {
    const res = await circuitExecute(backend, () => fetchWithTimeoutAndRetry(url, options, backend));
    return await tryFallback(res);
  } catch (e) {
    if (!fb || fb === backend) throw e;
    try {
      const cfg = buildProxyConfig(fb);
      const url2 = `${cfg.baseUrl}${cfg.path}`;
      const hdr = { ...cfg.headers, ...(options.headers || {}) };
      const opts2 = { ...options, headers: hdr };
      return await circuitExecute(fb, () => fetchWithTimeoutAndRetry(url2, opts2, fb));
    } catch {
      throw e;
    }
  }
}

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
// Phase 42: Granular CORS - use CORS_ORIGINS when set (comma-separated)
const CORS_ORIGINS = process.env.CORS_ORIGINS?.trim();
const corsOpts = CORS_ORIGINS
  ? {
      origin: CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
      credentials: process.env.CORS_ALLOW_CREDENTIALS !== "0",
    }
  : { credentials: true, origin: true };
app.use(cors(corsOpts));
const ENABLE_COMPRESSION = process.env.ENABLE_COMPRESSION !== "0" && (IS_PRODUCTION || process.env.ENABLE_COMPRESSION === "1");
if (ENABLE_COMPRESSION) {
  app.use(
    compression({ filter: (req, res) => !req.path?.startsWith("/v1/chat/completions") && !req.path?.startsWith("/v1/agent/swarm") })
  );
}
app.use(express.json());
app.use(otelHttpEnrichmentMiddleware());

// Phase 34: Request ID for all responses (k8s/tracing)
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

// Phase 34: Security headers (configurable; disabled for dev if DISABLE_SECURITY_HEADERS=1)
const DISABLE_SECURITY_HEADERS = process.env.DISABLE_SECURITY_HEADERS === "1";
const ENABLE_CSP = process.env.ENABLE_CSP === "1" && IS_PRODUCTION;
if (!DISABLE_SECURITY_HEADERS) {
  const helmetOpts = {
    contentSecurityPolicy: false,
    strictTransportSecurity: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true } : false,
  };
  if (ENABLE_CSP) {
    helmetOpts.contentSecurityPolicy = {
      reportOnly: process.env.CSP_ENFORCE !== "1",
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
        "style-src": ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "https:"],
        "connect-src": ["'self'", "https://api.openai.com", "wss:", "ws:"],
        "font-src": ["'self'", "https://cdn.jsdelivr.net", "https:"],
        "frame-ancestors": ["'self'"],
        "base-uri": ["'self'"],
      },
    };
  }
  app.use(helmet(helmetOpts));
}

// Phase 19: Session middleware
// Secret rotation: when SESSION_SECRET_PREVIOUS is set, express-session receives an
// array of secrets — it signs with the first and validates against all.
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (IS_PRODUCTION ? null : "dev-secret-change-in-production");
const SESSION_SECRET_PREVIOUS = process.env.SESSION_SECRET_PREVIOUS?.trim() || null;
const sessionSecretValue = SESSION_SECRET_PREVIOUS ? [SESSION_SECRET, SESSION_SECRET_PREVIOUS] : SESSION_SECRET;
if (isOAuthConfigured() && !SESSION_SECRET) {
  console.warn("[auth] OAuth configured but SESSION_SECRET not set. OAuth login will not persist. Set SESSION_SECRET in production.");
}
if (SESSION_SECRET) {
  app.use(
    session({
      secret: sessionSecretValue,
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

// Phase 19: Passport (when OAuth or SSO configured)
let oauthProviders = { github: false, google: false };
let ssoProviders = { oidc: false, saml: false };
const needsPassport = isOAuthConfigured() || isSSOConfigured();
if (needsPassport) {
  app.use(passport.initialize());
  app.use(passport.session());
  oauthProviders = initPassport();
  ssoProviders = configureSSO(app, passport);
}

// Phase 68: Warm Postgres-backed API key cache before isAuthConfigured / rate limiters.
await warmApiKeysCache().catch((e) => console.warn("[startup] api-keys warm:", e.message));

// Rate limiters
const perKeyChatRateLimiter =
  RATE_LIMIT_PER_KEY != null
    ? rateLimit({
        windowMs: RATE_LIMIT_WINDOW_MS,
        max: RATE_LIMIT_PER_KEY,
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => !req.apiKeyId,
        keyGenerator: (req) => `key:${req.apiKeyId || "unknown"}`,
        handler: (req, res) => {
          apiError(res, 429, "RATE_LIMITED", "Too many requests per API key", "Reduce request rate or increase RATE_LIMIT_PER_KEY.");
        },
      })
    : (req, res, next) => next();

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

const integrationRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const knowledgeIndexRateLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.KNOWLEDGE_INDEX_RATE_LIMIT_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many index requests", "Reduce indexing rate or increase KNOWLEDGE_INDEX_RATE_LIMIT_MAX.");
  },
});

const embeddingsRateLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.EMBEDDINGS_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many embeddings requests", "Reduce request rate or increase EMBEDDINGS_RATE_LIMIT_MAX.");
  },
});

const readRateLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.READ_RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many read requests", "Reduce request rate or increase READ_RATE_LIMIT_MAX.");
  },
});

const storageRateLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.STORAGE_RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Structured error response: { error, code, hint }
function apiError(res, status, code, message, hint) {
  return res.status(status).json({
    error: message || "Request failed",
    code,
    hint: hint || "See docs/RUNBOOK.md for troubleshooting.",
  });
}

// Phase 23: API versioning - deprecation header for legacy /api/*
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
async function setQuotaHeaders(res, workspace, userId) {
  const quota = await getWorkspaceQuota(workspace, userId);
  if (quota) {
    res.setHeader("X-Quota-Limit", String(quota.limit));
    res.setHeader("X-Quota-Remaining", String(quota.remaining));
    res.setHeader("X-Quota-Reset", String(quota.resetAt));
  }
}

// Auth middleware
// Secret rotation: accepts API_KEY_PREVIOUS during key rollover.
function apiKeyAuth(req, res, next) {
  if (!API_KEY) return next();
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const xKey = req.headers["x-api-key"];
  const key = bearer || xKey;
  const matchesCurrent = key && key === API_KEY;
  const matchesPrevious = !matchesCurrent && API_KEY_PREVIOUS && key === API_KEY_PREVIOUS;
  if (!key || (!matchesCurrent && !matchesPrevious)) {
    return apiError(res, 401, "AUTH_REQUIRED", "Unauthorized", "Use Authorization: Bearer <key> or x-api-key header.");
  }
  if (matchesPrevious) {
    res.setHeader("X-API-Key-Deprecated", "true");
    console.warn("[auth] Request authenticated with API_KEY_PREVIOUS. Rotate clients to new key.");
  }
  req.authenticatedViaDeploymentKey = true;
  req.apiKeyScopes = API_KEY_SCOPES.length ? API_KEY_SCOPES : ["read", "write"];
  req.apiKeyId = "deployment";
  next();
}

function chatAuth(req, res, next) {
  if (!API_KEY) return userAuth(req, res, next);
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
  const xApiKey = req.headers["x-api-key"];
  const xUserKey = req.headers["x-user-api-key"];
  const key = xApiKey || xUserKey || bearer;
  if (!key) return apiError(res, 401, "AUTH_REQUIRED", "Unauthorized", "Use Authorization: Bearer <key>, x-api-key, or x-user-api-key header.");
  if (key === API_KEY || (API_KEY_PREVIOUS && key === API_KEY_PREVIOUS)) {
    req.authenticatedViaDeploymentKey = true;
    req.apiKeyScopes = API_KEY_SCOPES.length ? API_KEY_SCOPES : ["read", "write"];
    req.apiKeyId = "deployment";
    req.userId = "anonymous";
    if (API_KEY_PREVIOUS && key === API_KEY_PREVIOUS) {
      res.setHeader("X-API-Key-Deprecated", "true");
      console.warn("[auth] Request authenticated with API_KEY_PREVIOUS. Rotate clients to new key.");
    }
    return next();
  }
  return userAuth(req, res, next);
}

function evalAuth(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  const apiKey = API_KEY;
  if (!adminKey && !apiKey) return next();
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
  const xKey = req.headers["x-api-key"] || req.headers["x-admin-api-key"];
  const key = bearer || xKey;
  if (!key) return apiError(res, 401, "AUTH_REQUIRED", "Eval endpoints require ADMIN_API_KEY or API_KEY", "Use Authorization: Bearer <key> or x-api-key header.");
  const adminKeyPrev = process.env.ADMIN_API_KEY_PREVIOUS;
  const apiKeyPrev = API_KEY_PREVIOUS;
  if ((adminKey && key === adminKey) || (apiKey && key === apiKey)) return next();
  if ((adminKeyPrev && key === adminKeyPrev) || (apiKeyPrev && key === apiKeyPrev)) {
    console.warn("[auth] Eval request authenticated with previous key. Rotate clients to new key.");
    return next();
  }
  return apiError(res, 401, "AUTH_REQUIRED", "Invalid key", "Use ADMIN_API_KEY or API_KEY.");
}

function backupAdminAuth(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY || process.env.BACKUP_ADMIN_KEY;
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
  const xKey = req.headers["x-api-key"] || req.headers["x-backup-admin-key"];
  const key = bearer || xKey;
  if (adminKey && key && key === adminKey) return next();
  if (adminKey && !key) return apiError(res, 403, "FORBIDDEN", "Backup requires admin", "Use ADMIN_API_KEY, BACKUP_ADMIN_KEY, or be in QUOTA_ADMIN_USER_IDS.");
  if (!isAuthConfigured() && !adminKey) return next();
  userAuth(req, res, () => {
    if (req.userId && isQuotaAdmin(req.userId)) return next();
    return apiError(res, 403, "FORBIDDEN", "Backup requires admin", "Use ADMIN_API_KEY, BACKUP_ADMIN_KEY, or be in QUOTA_ADMIN_USER_IDS.");
  });
}

// Request logging middleware
function logRequest(req, res, next) {
  const requestId = req.requestId || randomUUID();
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const entry = sanitizeForLog({
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
    });
    const msg = IS_PRODUCTION ? JSON.stringify(entry) : `${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms`;
    console.log(msg);
    if (req.apiKeyId) void logKeyUsage({ keyId: req.apiKeyId, path: req.path, method: req.method }).catch(() => {});
    if (metricsEnabled()) recordRequest(req.method, req.path, res.statusCode, durationMs);
  });
  next();
}

// Additional config constants needed by route modules
const ENABLE_MONITORING = process.env.ENABLE_MONITORING === "1";
const MONITORING_INTERVAL_MS = Math.max(60_000, Number(process.env.MONITORING_INTERVAL_MS) || 300_000);
const MONITORING_REPO = process.env.MONITORING_REPO?.trim() || null;
const GITHUB_API_BASE = process.env.GITHUB_API_BASE || "https://api.github.com";
const VERCEL_API_BASE = process.env.VERCEL_API_BASE || "https://api.vercel.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const USAGE_ALERT_TOKENS = process.env.USAGE_ALERT_TOKENS ? Number(process.env.USAGE_ALERT_TOKENS) : null;
const ALLOW_RECIPE_STEP_EXECUTION = process.env.ALLOW_RECIPE_STEP_EXECUTION === "1";
const ENABLE_AGENT_SWARM = process.env.ENABLE_AGENT_SWARM === "1";
const sanitizeWorkspace = storage.sanitizeWorkspace;

function isMonitoringEnabled() {
  return ENABLE_MONITORING && (GITHUB_TOKEN || VERCEL_TOKEN);
}

// ─── Mount all route modules ────────────────────────────────────────────────

const deps = {
  // Helpers
  apiError,
  apiRoute,
  buildProxyConfig,
  backendFetch,
  setQuotaHeaders,
  sanitizeWorkspace,
  __dirname,

  // Auth middleware
  chatAuth,
  apiKeyAuth,
  userAuth,
  adminAuth,
  evalAuth,
  backupAdminAuth,
  requireScope,
  internalAuth,

  // Rate limiters
  chatRateLimiter,
  perKeyChatRateLimiter,
  integrationRateLimiter,
  knowledgeIndexRateLimiter,
  embeddingsRateLimiter,
  storageRateLimiter,

  // Logging
  logRequest,

  // OAuth / SSO
  oauthProviders,
  ssoProviders,

  // Config constants
  BACKEND,
  IS_PRODUCTION,
  MODEL_PRESETS,
  VLLM_URL,
  OLLAMA_URL,
  OPENAI_API_KEY,
  API_KEY,
  API_KEY_PREVIOUS,
  AB_ROUTING_ENABLED,
  MODEL_ROUTING_CONFIG,
  STREAM_AGENT_FINAL,
  AGENT_STREAM_CHUNK_SIZE,
  STREAM_SWARM_SYNTH,
  MAX_AGENT_TOOL_CALLS_ENV,
  AGENT_MAX_WALL_MS_ENV,
  USAGE_ALERT_TOKENS,
  ENABLE_AGENT_SWARM,
  ALLOW_RECIPE_STEP_EXECUTION,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  GITHUB_TOKEN,
  VERCEL_TOKEN,
  GITHUB_API_BASE,
  VERCEL_API_BASE,
  MONITORING_REPO,
  MONITORING_INTERVAL_MS,

  // Lib: storage
  storage,
  scheduleStore,

  // Lib: usage / analytics
  recordUsage,
  getSummary,
  getTotalTokensInWindow,
  getRecordsForPeriod,
  estimate,
  getDashboard,
  exportToCsv,
  exportToJson,
  recordChatRequest,
  recordTokensUsed,

  // Lib: quota
  isQuotaConfigured,
  checkQuota,
  getWorkspaceQuota,
  getWorkspaceTokensUsed,
  setWorkspaceQuotaOverride,
  getQuotaOverrides,

  // Lib: agent / swarm
  getToolsSchema,
  intersectClientToolsWithAllowlist,
  getAgentToolsAllowlistNames,
  resolveAgentMaxIterations,
  runAgentLoop,
  runSwarm,
  runSwarmLegacy,
  getSwarmSelectableSpecialistNames,
  getSwarmSpecialistsAllowlistNames,
  intersectSwarmSpecialistsWithAllowlist,
  pipeLlmChatStreamToSse,

  // Lib: knowledge / embeddings
  indexDocument,
  knowledgeSearch,
  knowledgeSemanticSearch,
  knowledgeList,
  reindexKnowledgeEmbeddingsInWorkspace,
  embed,
  embedBatch,
  embeddingsAvailable,
  fetchTextFromAllowedUrl,

  // Lib: teams
  canAccessWorkspace,
  resolveStorageUserId,
  createInviteCode,
  joinByInviteCode,
  getWorkspaceMembers,
  getWorkspaceActivity,
  logActivity,

  // Lib: workspace templates
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,

  // Lib: workspace lifecycle
  exportWorkspaceBundle,
  deleteWorkspaceForUser,

  // Lib: workspace agent settings
  loadWorkspaceAgentSettings,
  saveWorkspaceAgentSettings,
  getWorkspaceAgentAccess,
  canEditWorkspaceAgentSettings,

  // Lib: idempotency
  idempotencyLookup,
  idempotencyStore,

  // Lib: scheduler
  schedulerRefresh,
  runRecipeNow,
  runDueJobsVercel,

  // Lib: webhooks / notifications / realtime
  emitEvent,
  listWebhooks,
  addWebhook,
  removeWebhook,
  validateWebhookUrl,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  createToken,
  getOnlineUsers,

  // Lib: admin
  listAllUsers,
  listAllWorkspaces,
  getRecentAuditLog,
  listKeysForAdmin,
  addKey,
  revokeKey,

  // Lib: audit
  archiveExecutionAuditToS3,
  getAuditArchiveStatus,
  AuditLifecycle,
  queryAudit,
  exportAudit,

  // Lib: routing
  selectBackend,
  logRouting,
  getRoutingStats,

  // Lib: regions / replication
  getRegionHealth,
  getLeaderElection,
  getReplicationManager,

  // Lib: metrics
  metricsEnabled,
  renderPrometheus,

  // Lib: docs
  openApiSpec,

  // Lib: monitoring
  isMonitoringEnabled,

  // Lib: error reporting
  reportError,

  // Lib: trace recorder
  recordTrace,
  autoRecordEnabled,

  // Lib: auth config
  isAuthConfigured,
  toolValidationEnabled,
  stagnationDetectionEnabled,
  trajectoryApiEnabled,
  defaultAgentSystemConfigured,
};

mountAllRoutes(app, deps);

// ─── Remaining inline routes (not yet extracted to route modules) ──────────

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

// Conversations CRUD
apiRoute("get", "/conversations", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const data = await storage.listItems("conversations", workspace);
    res.json({ _version: 1, items: data });
  } catch (err) {
    console.error("Storage conversations list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/conversations", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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
    await logActivity(workspace, "conversation_created", req.userId || "anonymous", { title: item.title, id: out.id });
    res.status(201).json(out);
  } catch (err) {
    console.error("Storage conversations add error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/conversations/:id", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
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

apiRoute("put", "/conversations/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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

apiRoute("delete", "/conversations/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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

// Conversation branching
apiRoute("post", "/conversations/:id/branch", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
    const userId = req.userId || "anonymous";
    const { atMessageIndex, label } = req.body || {};
    if (typeof atMessageIndex !== "number" || !Number.isInteger(atMessageIndex) || atMessageIndex < 0) {
      return apiError(res, 400, "INVALID_INPUT", "atMessageIndex must be a non-negative integer.");
    }
    const branch = await branchConversation(req.params.id, atMessageIndex, userId, { label, workspace });
    res.status(201).json(branch);
  } catch (err) {
    if (err.message.includes("not found")) return apiError(res, 404, "NOT_FOUND", err.message);
    if (err.message.includes("Invalid branch point")) return apiError(res, 400, "INVALID_INPUT", err.message);
    console.error("Branch conversation error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/conversations/:id/tree", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const userId = req.userId || "anonymous";
    const tree = await getConversationTree(req.params.id, workspace, userId);
    if (!tree) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.json(tree);
  } catch (err) {
    console.error("Conversation tree error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/conversations/:id/branches", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const userId = req.userId || "anonymous";
    const branches = await listConversationBranches(req.params.id, workspace, userId);
    res.json({ branches });
  } catch (err) {
    console.error("List branches error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/conversations/branches/:branchId", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const userId = req.userId || "anonymous";
    const branch = await getConversationBranch(req.params.branchId, workspace, userId);
    if (!branch) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.json(branch);
  } catch (err) {
    console.error("Get branch error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("delete", "/conversations/branches/:branchId", storageRateLimiter, logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const userId = req.userId || "anonymous";
    const deleted = await deleteConversationBranch(req.params.branchId, workspace, userId);
    if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
    res.status(204).send();
  } catch (err) {
    console.error("Delete branch error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// Automations validate
const AUTOMATION_MAX_RECIPE_BYTES = 64 * 1024;
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

apiRoute("post", "/automations/validate", integrationRateLimiter, logRequest, (req, res) => {
  try {
    const recipe = req.body;
    const result = validateAutomationRecipe(recipe);
    return res.json({ valid: result.valid, errors: result.errors });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// Plugins & Extensions
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

apiRoute("get", "/plugins", pluginsActionsRateLimiter, userAuth, logRequest, (req, res) => {
  try {
    const plugins = listJsPlugins();
    res.json({ plugins });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGIN_API.md.");
  }
});

apiRoute("post", "/plugins/execute", pluginsActionsRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const { pluginId, input, workspaceId, config } = req.body || {};
    if (!pluginId || typeof pluginId !== "string") {
      return apiError(res, 400, "INVALID_INPUT", "pluginId is required", "Send { pluginId, input?, workspaceId?, config? }.");
    }
    const result = await execJsPlugin(pluginId.trim(), {
      input: typeof input === "string" ? input : "",
      workspaceId: workspaceId || null,
      userId: req.userId || null,
      config: config && typeof config === "object" ? config : {},
    });
    res.json({ ok: true, output: result.output, metadata: result.metadata });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Plugin Marketplace
const marketplaceRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

apiRoute("get", "/marketplace", marketplaceRateLimiter, logRequest, (req, res) => {
  try {
    const packs = marketplaceListAvailable();
    const category = req.query?.category;
    const filtered = category ? packs.filter((p) => p.category === category) : packs;
    res.json({ _version: 1, packs: filtered });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
  }
});

apiRoute("get", "/marketplace/:packId", marketplaceRateLimiter, logRequest, (req, res) => {
  try {
    const packId = req.params.packId;
    const manifest = marketplaceRegistry.get(packId);
    if (!manifest) {
      return apiError(res, 404, "NOT_FOUND", `Pack not found: ${packId}`, "Use GET /api/marketplace to list available packs.");
    }
    res.json({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      category: manifest.category || "uncategorized",
      actions: manifest.actions,
    });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
  }
});

apiRoute("post", "/marketplace/:packId/install", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
  try {
    const packId = req.params.packId;
    const workspaceId = req.body?.workspaceId;
    if (!workspaceId || typeof workspaceId !== "string") {
      return apiError(res, 400, "INVALID_INPUT", "workspaceId required", "Send { workspaceId: string }.");
    }
    const result = marketplaceInstallPack(packId, workspaceId);
    if (!result.ok) {
      return apiError(res, 400, "INSTALL_FAILED", result.error, "Check that the pack exists.");
    }
    res.json({ ok: true, packId, workspaceId, alreadyInstalled: result.alreadyInstalled || false });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
  }
});

apiRoute("delete", "/marketplace/:packId/install", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
  try {
    const packId = req.params.packId;
    const workspaceId = req.body?.workspaceId || req.query?.workspaceId;
    if (!workspaceId || typeof workspaceId !== "string") {
      return apiError(res, 400, "INVALID_INPUT", "workspaceId required", "Send { workspaceId: string } or ?workspaceId=.");
    }
    const result = marketplaceUninstallPack(packId, workspaceId);
    if (!result.ok) {
      return apiError(res, 400, "UNINSTALL_FAILED", result.error, "Check that the pack exists.");
    }
    res.json({ ok: true, packId, workspaceId });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
  }
});

apiRoute("get", "/workspaces/:id/plugins", marketplaceRateLimiter, userAuth, logRequest, (req, res) => {
  try {
    const workspaceId = req.params.id;
    const packs = marketplaceListInstalled(workspaceId);
    res.json({ _version: 1, workspaceId, packs });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
  }
});

// Webhooks & Notifications
const webhooksRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const webhooksHandlers = [webhooksRateLimiter, storageRateLimiter, userAuth, logRequest];

apiRoute("get", "/webhooks", ...webhooksHandlers, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const items = await listWebhooks(workspace);
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

// WebSocket token & presence
apiRoute("get", "/ws-token", ...webhooksHandlers, (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const userId = req.userId ?? "anonymous";
    const { token, url } = createToken(userId, workspace);
    res.json({ token, url });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/workspaces/:id/presence", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const access = await canAccessWorkspace(workspaceId, req.userId);
    const isTeamWorkspace = !!(await getWorkspaceMembers(workspaceId));
    if (!access.allowed && isTeamWorkspace) return apiError(res, 403, "FORBIDDEN", "Access denied", null);
    const online = getOnlineUsers(workspaceId);
    res.json({ online });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// Notifications
apiRoute("get", "/notifications", ...webhooksHandlers, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const userId = req.userId ?? "anonymous";
    const items = await listNotifications(workspace, userId);
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

// Recipe Execution
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
  requireScope("write"),
  logRequest,
  async (req, res) => {
    if (!ALLOW_RECIPE_STEP_EXECUTION) {
      return apiError(res, 503, "EXECUTION_DISABLED", "Recipe step execution is disabled", "Set ALLOW_RECIPE_STEP_EXECUTION=1 to enable. See docs/RUNBOOK.md.");
    }
    const { step, allowExecution } = req.body || {};
    if (!allowExecution) {
      return apiError(res, 403, "EXECUTION_NOT_ALLOWED", "Client must have Allow recipe step execution enabled", "Enable the toggle in Settings to run steps.");
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
      appendAuditLog({ action: step.action, payload: step.payload, ok: result.ok, error: result.error });
      await emitEvent("recipe_executed", { step: { action: step.action, payload: step.payload }, ok: result.ok, error: result.error }, { workspaceId: execWorkspace, userId: req.userId });
      if (result.ok) {
        return res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
      }
      return res.status(400).json({ ok: false, error: result.error, stdout: result.stdout, stderr: result.stderr });
    } catch (err) {
      console.error("Execute step error:", err.message);
      appendAuditLog({ action: step?.action, payload: step?.payload, ok: false, error: err.message });
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  }
);

// Multimodal: Vision, Document Extract, OCR
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DOC_MAX_BYTES = 2 * 1024 * 1024;
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: [{ type: "text", text: "Describe this image in detail. Be concise." }, { type: "image_url", image_url: { url: dataUrl } }] }],
          max_tokens: 500,
        }),
      });
      if (!r.ok) {
        const err = await r.text();
        return res.status(r.status).json({ error: "Vision API error", code: "BACKEND_ERROR", hint: (err || `HTTP ${r.status}`).slice(0, 500) });
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

const OCR_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_OCR_TYPES = ["image/png", "image/jpeg", "image/tiff", "image/bmp", "application/pdf"];

const ocrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: OCR_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_OCR_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type. Accepted: PNG, JPG, TIFF, BMP, PDF."));
  },
});

apiRoute("post", "/ocr",
  multimodalRateLimiter,
  (req, res, next) => {
    ocrUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE")
            return apiError(res, 400, "FILE_TOO_LARGE", `File exceeds ${OCR_MAX_BYTES / 1024 / 1024}MB limit`, "Reduce file size.");
          if (err.code === "LIMIT_UNEXPECTED_FILE")
            return apiError(res, 400, "INVALID_BODY", "Use field name 'file' for multipart upload", null);
        }
        if (err.message && err.message.includes("Unsupported file type"))
          return apiError(res, 415, "UNSUPPORTED_FORMAT", err.message, "Accepted formats: PNG, JPG, TIFF, BMP, PDF.");
        return apiError(res, 400, "INVALID_FILE", err.message || "Invalid file upload", null);
      }
      next();
    });
  },
  logRequest,
  async (req, res) => {
    try {
      if (!req.file?.buffer)
        return apiError(res, 400, "INVALID_BODY", "file required (multipart/form-data)", "Upload an image or PDF with field name 'file'.");
      const { extractText } = await import("./lib/ocr.js");
      const mime = req.file.mimetype || "";
      const { text, confidence } = await extractText(req.file.buffer, mime);
      return res.json({ text: sanitizeText(text), pages: 1, confidence });
    } catch (err) {
      if (err.code === "UNSUPPORTED_FORMAT")
        return apiError(res, 415, "UNSUPPORTED_FORMAT", err.message, "Accepted formats: PNG, JPG, TIFF, BMP, PDF.");
      return apiError(res, 500, "OCR_FAILED", err.message || "OCR processing failed", "See docs/RUNBOOK.md.");
    }
  }
);

// Agent trajectory
apiRoute("get", "/agent/trajectory/:runId", logRequest, userAuth, async (req, res) => {
  if (!trajectoryApiEnabled()) {
    return apiError(res, 503, "FEATURE_DISABLED", "Trajectory API disabled", "Unset AGENT_TRAJECTORY_API=0 to enable GET /api/agent/trajectory/:runId.");
  }
  const runId = String(req.params.runId || "").trim();
  const t = await loadTrajectory(runId);
  if (!t) {
    return apiError(res, 404, "TRAJECTORY_NOT_FOUND", "Trajectory not found or expired", "IDs are short-lived; run agent mode again and use the X-Agent-Run-Id header.");
  }
  res.json(t);
});

apiRoute("get", "/agent/trajectories", logRequest, userAuth, async (req, res) => {
  if (!trajectoryApiEnabled()) {
    return apiError(res, 503, "FEATURE_DISABLED", "Trajectory API disabled", "Unset AGENT_TRAJECTORY_API=0 to enable trajectory listing.");
  }
  const workspace = String(req.query.workspace || "default").trim();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const data = await listTrajectories({ workspace, limit, offset });
    res.json(data);
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List failed", "See server logs.");
  }
});

// Trace replay
apiRoute("get", "/traces", logRequest, evalAuth, async (req, res) => {
  try {
    const opts = { type: req.query.type || undefined, workspace: req.query.workspace || undefined, limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0 };
    const data = await listRecordedTraces(opts);
    res.json(data);
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List traces failed", "See server logs.");
  }
});

apiRoute("get", "/traces/:id", logRequest, evalAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return apiError(res, 400, "INVALID_ID", "Trace ID required", "Provide a valid trace ID.");
  const trace = await getRecordedTrace(id);
  if (!trace) return apiError(res, 404, "NOT_FOUND", "Trace not found", `No trace with id: ${id}`);
  res.json(trace);
});

apiRoute("post", "/traces/record", logRequest, evalAuth, async (req, res) => {
  try {
    const traceData = req.body;
    if (!traceData || typeof traceData !== "object") {
      return apiError(res, 400, "INVALID_BODY", "Request body must be a trace object", "Send JSON with steps, toolCalls, or goldenTrace.");
    }
    const result = await recordTrace(traceData);
    res.status(201).json(result);
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Record failed", "See server logs.");
  }
});

apiRoute("post", "/traces/:id/replay", logRequest, evalAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return apiError(res, 400, "INVALID_ID", "Trace ID required", "Provide a valid trace ID.");
  try {
    const expectations = req.body && typeof req.body === "object" && Object.keys(req.body).length > 0 ? req.body : null;
    const result = await replayTrace(id, expectations);
    res.json(result);
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Replay failed", "See server logs.");
  }
});

apiRoute("delete", "/traces/:id", logRequest, evalAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return apiError(res, 400, "INVALID_ID", "Trace ID required", "Provide a valid trace ID.");
  const deleted = await deleteRecordedTrace(id);
  if (!deleted) return apiError(res, 404, "NOT_FOUND", "Trace not found", `No trace with id: ${id}`);
  res.json({ ok: true, traceId: id });
});

// Eval harness
const evalRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many eval runs", "Limit: 5 runs per minute. Wait before retrying.");
  },
});

apiRoute("get", "/eval/sets", evalRateLimiter, evalAuth, logRequest, async (req, res) => {
  try {
    const sets = await listEvalSets();
    res.json({ sets });
  } catch (err) {
    console.error("Eval sets list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/eval/run", evalRateLimiter, evalAuth, logRequest, async (req, res) => {
  try {
    const { evalSetId, evalSet, model } = req.body || {};
    let set = evalSet;
    if (!set && evalSetId) {
      set = await loadEvalSet(String(evalSetId).trim());
      if (!set) return apiError(res, 404, "NOT_FOUND", "Eval set not found", `No eval set with id: ${evalSetId}`);
    }
    if (!set || !Array.isArray(set.cases)) {
      return apiError(res, 400, "INVALID_BODY", "evalSetId, evalSet, or valid evalSet JSON required", "Send { evalSetId: string } or { evalSet: { id, name, cases } }.");
    }
    const baseUrl = `${req.protocol}://${req.get("host") || "localhost"}`;
    const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
    const apiKey = bearer || req.headers["x-api-key"] || req.headers["x-admin-api-key"];
    const result = await runEvalSet(set, { model: model || undefined, baseUrl, apiKey: apiKey || undefined });
    res.json(result);
  } catch (err) {
    console.error("Eval run error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// HTML pages
app.get("/eval", (req, res) => {
  res.sendFile(join(__dirname, "client", "eval.html"));
});

app.get("/marketplace", (req, res) => {
  res.sendFile(join(__dirname, "client", "marketplace.html"));
});

// Static file serving
const STATIC_CACHE_MAX_AGE_MS =
  process.env.STATIC_CACHE_MAX_AGE === "0"
    ? 0
    : Number(process.env.STATIC_CACHE_MAX_AGE_MS) || (IS_PRODUCTION ? 86_400_000 : 0);

app.use(
  express.static(join(__dirname, "client"), {
    maxAge: STATIC_CACHE_MAX_AGE_MS,
    etag: true,
    setHeaders(res, filePath) {
      const norm = filePath.replace(/\\/g, "/");
      if (/(^|\/)index\.html$/i.test(norm) || /(^|\/)admin\.html$/i.test(norm) || /(^|\/)eval\.html$/i.test(norm)) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }),
);

// Error middleware (after all routes and static files)
app.use(errorMiddleware);
app.use(errorHandler);

// Phase 34: Graceful shutdown (SIGTERM, SIGINT). Vercel: not applicable.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

if (process.env.VERCEL !== "1") {
  // Phase 47: Start OTEL before createServer so HTTP instrumentation wraps the server.
  initTracing()
    .catch(() => {})
    .then(() => {
      const httpServer = createServer(app);
      attachToServer(httpServer);

      function gracefulShutdown(signal) {
        console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);
        httpServer.close(async () => {
          try {
            if (process.env.ENABLE_SCHEDULED_RECIPES === "1") schedulerStop();
            await closeServer();
            console.log("[shutdown] Graceful shutdown complete");
            process.exit(0);
          } catch (e) {
            console.error("[shutdown] Error during shutdown:", e.message);
            process.exit(1);
          }
        });
        setTimeout(() => {
          console.error("[shutdown] Forced exit after timeout");
          process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS).unref();
      }

      process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
      process.on("SIGINT", () => gracefulShutdown("SIGINT"));

      const listenHost = process.env.LISTEN_HOST?.trim() || undefined;
      const onListen = () => {
        console.log(`Proxy: http://localhost:${PORT}`);
        console.log(`Backend: ${BACKEND}`);
        if (BACKEND === "vllm") console.log(`vLLM:  ${VLLM_URL}`);
        if (BACKEND === "ollama") console.log(`Ollama: ${OLLAMA_URL}`);
        if (BACKEND === "openai") console.log(`OpenAI: api.openai.com (key set)`);
        if (process.env.ENABLE_SCHEDULED_RECIPES === "1") {
          schedulerStart().catch((e) => console.warn("[scheduler] Start failed:", e.message));
        }
        console.log("Phase 33: WebSocket real-time sync enabled at /ws");
        console.log("Phase 34: Health probes at /health/live, /health/ready");
      };
      if (listenHost) {
        httpServer.listen(PORT, listenHost, onListen);
      } else {
        httpServer.listen(PORT, onListen);
      }
    });
}
export default app;
