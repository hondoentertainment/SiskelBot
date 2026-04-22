import "dotenv/config";
import { createServer } from "http";
import { existsSync, readFileSync } from "node:fs";
import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import passport from "passport";
import { initPassport, isOAuthConfigured } from "./lib/oauth.js";
import { configureSSO, isSSOConfigured } from "./lib/sso.js";
import { getLeaderElection } from "./lib/leader-election.js";
import { getRegionHealth } from "./lib/region-health.js";
import { getReplicationManager, internalAuth } from "./lib/storage-replication.js";
import { getSyntheticMonitor, registerBuiltInChecks } from "./lib/synthetic-monitor.js";
import { startDailySecurityScan } from "./lib/security-scorecard.js";
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
import { globalEmbeddingCache } from "./lib/embedding-cache.js";
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
import { executePlugin as execJsPlugin, listPlugins as listJsPlugins } from "./lib/plugin-sandbox.js";
import { getToolsSchema, intersectClientToolsWithAllowlist, getAgentToolsAllowlistNames } from "./lib/agent-tools.js";
import { resolveAgentMaxIterations } from "./lib/agent-iterations.js";
import * as storage from "./lib/storage.js";
import * as scheduleStore from "./lib/schedules.js";
import { start as schedulerStart, stop as schedulerStop, refresh as schedulerRefresh, runRecipeNow, runDueJobsVercel } from "./lib/scheduler.js";
import { startPromptEvolutionScheduler } from "./lib/prompt-evolution.js";
import { userAuth, isAuthConfigured } from "./lib/auth.js";
import { recordUsage, getSummary, getTotalTokensInWindow, getRecordsForPeriod, estimate } from "./lib/usage-tracker.js";
import { getDashboard, exportToCsv, exportToJson } from "./lib/analytics.js";
import { recordUserActivity as recordCohortActivity } from "./lib/cohort-analysis.js";
import { emitEvent, listWebhooks, addWebhook, removeWebhook, validateWebhookUrl } from "./lib/webhooks.js";
import { list as listNotifications, markRead as markNotificationRead, markAllRead as markAllNotificationsRead } from "./lib/notifications.js";
import { isQuotaConfigured, checkQuota, getWorkspaceQuota, getWorkspaceTokensUsed, isQuotaAdmin, setWorkspaceQuotaOverride, getQuotaOverrides } from "./lib/quotas.js";
import { createBackup, listBackups, restoreBackup } from "./lib/backup.js";
import { createAuthMiddleware } from "./lib/server-auth-middleware.js";
import { validateAutomationRecipe } from "./lib/automation-recipe-validator.js";
import { adminAuth } from "./lib/admin-auth.js";
// import { adminIpAllowlist } from "./lib/admin-ip-allowlist.js";
import { listAllUsers, listAllWorkspaces, getRecentAuditLog } from "./lib/admin-data.js";
import { requireScope } from "./lib/scope-middleware.js";
import { logKeyUsage } from "./lib/api-key-audit.js";
import { findDeveloperByRawKey, recordDeveloperRequest } from "./lib/developer-keys.js";
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
import { listStagingTraceSummaries } from "./lib/eval-staging-traces.js";
import { createToken, attachToServer, getOnlineUsers, closeServer } from "./lib/realtime.js";
import { mountRealtimeWs } from "./routes/realtime-ws.js";
import { defaultChannelRegistry } from "./lib/realtime-channels.js";
import { sanitizeForLog } from "./lib/log-sanitizer.js";
import { requestContextMiddleware } from "./lib/request-context.js";
import { execute as circuitExecute } from "./lib/circuit-breaker.js";
import { parseRoutingConfig, selectBackend, logRouting, getRoutingStats } from "./lib/ab-router.js";
import { recordModelResponse, getModelQuality, getModelRanking, getQualityHistory, loadFromDisk as loadModelQuality, resetModelStats, checkAutoPromotion } from "./lib/model-quality.js";
import { selectSmartBackend, parseCostConfig, checkAndLogPromotion, getRoutingSummary } from "./lib/smart-router.js";
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
import { initLogShipping } from "./lib/log-shipper.js";
import {
  recordRequest,
  renderPrometheus,
  recordChatRequest,
  recordTokensUsed,
  isEnabled as metricsEnabled,
  incrementRealtimeBackpressure,
  incrementRealtimeSubscriberError,
} from "./lib/metrics.js";
import { globalSLOTracker } from "./lib/slo-tracker.js";
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
import { replayTrace } from "./lib/trace-replay.js";
import { getEventsSince } from "./lib/realtime-replay.js";
import {
  registerPeer,
  removePeer,
  listPeers,
  discoverFederatedWorkspaces,
  syncWorkspaceMetadata,
  handleDiscoverRequest,
  getInstanceInfo,
  federationAuth,
} from "./lib/federation.js";

import {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
} from "./lib/workspace-templates.js";

import { mountAllRoutes } from "./routes/index.js";
import { agentSessionApiEnabled, buildRunIndexFromSessions } from "./lib/agent-session.js";
import { mountAgentSessionRoutes } from "./routes/agent-sessions.js";
import { errorMiddleware, errorHandler } from "./lib/error-middleware.js";
import { runStartupChecks } from "./lib/startup-checks.js";

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
    compression({ filter: (req, _res) => !req.path?.startsWith("/v1/chat/completions") && !req.path?.startsWith("/v1/agent/swarm") })
  );
}
app.use(express.json({
  verify: (req, _res, buf) => {
    // Store raw body for webhook signature verification (Slack, Discord)
    if (req.url?.includes("/integrations/slack/") || req.url?.includes("/integrations/discord/")) {
      req.rawBody = buf.toString("utf8");
    }
  },
}));
app.use(otelHttpEnrichmentMiddleware());

// Phase 106: Desktop model manager routes (Ollama management)
if (process.env.ELECTRON_DESKTOP === "1") {
  try {
    const mod = await import("./electron/model-manager.cjs");
    const registerModelRoutes = mod.registerModelRoutes || mod.default?.registerModelRoutes;
    if (registerModelRoutes) registerModelRoutes(app);
  } catch (_) {
    /* model-manager only needed in desktop builds */
  }
}

// Phase 34: Request ID for all responses (k8s/tracing)
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});

// Request context propagation (AsyncLocalStorage) -- after requestId is set
app.use(requestContextMiddleware());

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

// const readRateLimiter = rateLimit({
//   windowMs: 60_000,
//   max: Number(process.env.READ_RATE_LIMIT_MAX) || 60,
//   standardHeaders: true,
//   legacyHeaders: false,
//   handler: (req, res) => {
//     apiError(res, 429, "RATE_LIMITED", "Too many read requests", "Reduce request rate or increase READ_RATE_LIMIT_MAX.");
//   },
// });

const storageRateLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.STORAGE_RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Structured error response: { error, code, hint }
function apiError(res, status, code, message, hint) {
  const requestId = res.req?.requestId || res.getHeader?.("X-Request-Id") || undefined;
  return res.status(status).json({
    error: message || "Request failed",
    code,
    hint: hint || "See docs/RUNBOOK.md for troubleshooting.",
    ...(requestId && { requestId }),
  });
}

// Phase 23: API versioning - deprecation header for legacy /api/*
function deprecationApi(req, res, next) {
  res.setHeader("X-API-Deprecated", "use /api/v1/");
  res.setHeader("Sunset", "2027-01-01T00:00:00Z");
  res.setHeader("Deprecation", "true");
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

// Auth middleware — extracted to lib/server-auth-middleware.js
const { apiKeyAuth, chatAuth, evalAuth, backupAdminAuth, resolveDeveloperKey: _resolveDeveloperKey } =
  createAuthMiddleware({
    API_KEY,
    API_KEY_PREVIOUS,
    API_KEY_SCOPES,
    apiError,
    userAuth,
    isAuthConfigured,
    isQuotaAdmin,
  });

// Request logging middleware
function logRequest(req, res, next) {
  const requestId = req.requestId || randomUUID();
  const start = Date.now();
  // Kick off developer-key resolution in the background; result is consumed in finish.
  const devKeyResolved = _resolveDeveloperKey(req);
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
    if (!process.env.NODE_TEST_CONTEXT) console.log(msg);
    if (req.apiKeyId) void logKeyUsage({ keyId: req.apiKeyId, path: req.path, method: req.method }).catch(() => {});
    // Phase 34.4: Record developer-key usage once resolution settles.
    void devKeyResolved
      .then(() => {
        if (req.developerKeyId && res.statusCode < 500) {
          return recordDeveloperRequest(req.developerKeyId).catch(() => {});
        }
      })
      .catch(() => {});
    if (metricsEnabled()) recordRequest(req.method, req.path, res.statusCode, durationMs);
    // Phase 31.2: SLO/SLI event recording.
    try {
      globalSLOTracker.recordEvent("success_rate", res.statusCode < 500 ? 1 : 0);
      globalSLOTracker.recordEvent("error_rate", res.statusCode >= 500 ? 1 : 0);
      globalSLOTracker.recordEvent("latency_ms", durationMs);
    } catch (_) {
      // never fail a request because of SLO bookkeeping
    }
    // Phase 39.1: Cohort activity tracking for authenticated users.
    if (req.userId && req.userId !== "anonymous" && res.statusCode < 500) {
      const ws = req.workspace || req.headers["x-workspace-id"] || "default";
      void recordCohortActivity(req.userId, ws, "request").catch(() => {});
    }
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

// Rate limiters for route modules
const pluginsActionsRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const marketplaceRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const webhooksRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const webhooksHandlers = [webhooksRateLimiter, storageRateLimiter, userAuth, logRequest];

const executeStepRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many execute requests", "Wait before retrying.");
  },
});

const evalRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many eval runs", "Limit: 5 runs per minute. Wait before retrying.");
  },
});

// Automation recipe validation — extracted to lib/automation-recipe-validator.js

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

  // Lib: model quality / smart router
  recordModelResponse,
  getModelQuality,
  getModelRanking,
  getQualityHistory,
  resetModelStats,
  checkAutoPromotion,
  selectSmartBackend,
  checkAndLogPromotion,
  getRoutingSummary,

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

  // Lib: backup
  createBackup,
  listBackups,
  restoreBackup,

  // Lib: conversations
  branchConversation,
  getConversationTree,
  listConversationBranches,
  getConversationBranch,
  deleteConversationBranch,

  // Lib: plugins
  getRegisteredActions,
  listJsPlugins,
  execJsPlugin,
  marketplaceListAvailable,
  marketplaceRegistry,
  marketplaceInstallPack,
  marketplaceUninstallPack,
  marketplaceListInstalled,
  join,

  // Lib: execute / automations
  executeStep,
  appendAuditLog,

  // Lib: eval / trajectory / traces
  loadTrajectory,
  listTrajectories,
  listRecordedTraces,
  getRecordedTrace,
  replayTrace,
  deleteRecordedTrace,
  listEvalSets,
  loadEvalSet,
  runEvalSet,
  listStagingTraceSummaries,

  // Lib: realtime replay
  getEventsSince,

  // Lib: federation
  registerPeer,
  removePeer,
  listPeers,
  discoverFederatedWorkspaces,
  syncWorkspaceMetadata,
  handleDiscoverRequest,
  getInstanceInfo,
  federationAuth,

  // Lib: rateLimit factory (for route modules that create their own limiters)
  rateLimit,

  // Route-specific rate limiters and helpers
  pluginsActionsRateLimiter,
  marketplaceRateLimiter,
  webhooksHandlers,
  executeStepRateLimiter,
  evalRateLimiter,
  validateAutomationRecipe,
  agentSessionApiEnabled,
};

mountAllRoutes(app, deps);
mountAgentSessionRoutes(app, deps);

// Run PostgreSQL migrations on startup when using postgres backend
if (process.env.STORAGE_BACKEND === "postgres" && process.env.DATABASE_URL) {
  try {
    const { runMigrations } = await import("./lib/migrations.js");
    const pg = await import("pg");
    const migrationPool = new pg.default.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 10_000,
    });
    const result = await runMigrations(migrationPool);
    await migrationPool.end();
    if (result.applied.length > 0) {
      console.log(`[startup] Applied ${result.applied.length} database migration(s)`);
    }
    if (result.errors.length > 0) {
      console.error("[startup] Migration errors:", result.errors);
    }
  } catch (e) {
    console.warn("[startup] Database migration failed:", e.message);
  }
}

if (!process.env.NODE_TEST_CONTEXT) {
  console.log("[startup] Running integration checks...");
  await runStartupChecks().catch(e => console.warn("[startup] Check failed:", e.message));
}

// Load persisted model quality data and parse cost config
await loadModelQuality().catch(e => console.warn("[startup] Model quality load failed:", e.message));
parseCostConfig(process.env.MODEL_COSTS);

// Phase 35.2: Load persisted embedding cache from disk if EMBEDDING_CACHE_PATH is set.
if (process.env.EMBEDDING_CACHE_PATH && !process.env.NODE_TEST_CONTEXT) {
  try {
    const loaded = await globalEmbeddingCache.load(process.env.EMBEDDING_CACHE_PATH);
    if (loaded > 0) {
      console.log(`[startup] Loaded ${loaded} embedding(s) from cache file: ${process.env.EMBEDDING_CACHE_PATH}`);
    }
  } catch (e) {
    console.warn("[startup] Embedding cache load failed:", e.message);
  }
}

// All routes are now in route modules under routes/

// Static file serving
const STATIC_CACHE_MAX_AGE_MS =
  process.env.STATIC_CACHE_MAX_AGE === "0"
    ? 0
    : Number(process.env.STATIC_CACHE_MAX_AGE_MS) || (IS_PRODUCTION ? 86_400_000 : 0);

// Optional default redirect from `/` to `/app/chat`. Off by default; opt-in
// via `UI_DEFAULT_APP=1`. When enabled, the handler is installed BEFORE the
// static middleware so it intercepts cleanly; the query string is preserved.
// Exported for tests (see tests/app-default-redirect.test.js).
installDefaultAppRedirect(app);
if (process.env.UI_DEFAULT_APP === "1") {
  console.log("[ui] / → /app/chat redirect ENABLED via UI_DEFAULT_APP=1");
}

// Wave 1 web interface — serve the SPA shell at /app (existing / route is unchanged)
// In production (or whenever client/dist/manifest.json exists), substitute the
// dev-only "/src/app.js" script tag with the hashed bundle path from the
// manifest so /app serves cache-busted, pre-bundled JS. Otherwise fall back to
// the raw source for fast dev ergonomics.
const APP_HTML_PATH = join(__dirname, "client", "app.html");
const APP_MANIFEST_PATH = join(__dirname, "client", "dist", "manifest.json");
const APP_DIST_DIR = join(__dirname, "client", "dist");
const APP_HTML_CACHE = loadAppHtmlCache();

app.get("/app", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const html = renderAppHtml();
  if (html == null) {
    // Cache miss or read failure: fall through to sending the source file
    // verbatim so the dev layout keeps working.
    return res.sendFile(APP_HTML_PATH);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// Cache-bust dist assets aggressively; they are hashed at build time.
if (existsSync(APP_DIST_DIR)) {
  app.use(
    "/dist",
    express.static(APP_DIST_DIR, {
      maxAge: "1y",
      immutable: true,
      etag: true,
    }),
  );
}

app.use(
  express.static(join(__dirname, "client"), {
    maxAge: STATIC_CACHE_MAX_AGE_MS,
    etag: true,
    setHeaders(res, filePath) {
      const norm = filePath.replace(/\\/g, "/");
      if (/(^|\/)index\.html$/i.test(norm) || /(^|\/)admin\.html$/i.test(norm) || /(^|\/)eval\.html$/i.test(norm) || /(^|\/)shared\.html$/i.test(norm) || /(^|\/)analytics\.html$/i.test(norm) || /(^|\/)health\.html$/i.test(norm) || /(^|\/)playground\.html$/i.test(norm) || /(^|\/)webhook-builder\.html$/i.test(norm)) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }),
);

function loadAppHtmlCache() {
  const cache = { html: null, manifest: null };
  try {
    if (existsSync(APP_HTML_PATH)) {
      cache.html = readFileSync(APP_HTML_PATH, "utf8");
    }
  } catch (_) {
    cache.html = null;
  }
  try {
    if (existsSync(APP_MANIFEST_PATH)) {
      cache.manifest = JSON.parse(readFileSync(APP_MANIFEST_PATH, "utf8"));
    }
  } catch (_) {
    cache.manifest = null;
  }
  return cache;
}

/**
 * Produce the HTML body to serve at /app. In production (or whenever a
 * manifest with an "app" entry is available) the dev "/src/app.js" script tag
 * is rewritten to the hashed production bundle path. In development the HTML
 * is re-read from disk on every request so edits to client/app.html show up
 * without a restart.
 *
 * Exported for tests (see tests/app-prod-bundle.test.js).
 */
export function renderAppHtml({
  htmlPath = APP_HTML_PATH,
  manifestPath = APP_MANIFEST_PATH,
  nodeEnv = process.env.NODE_ENV,
} = {}) {
  const isProd = nodeEnv === "production";
  let html;
  if (isProd && APP_HTML_CACHE.html != null && htmlPath === APP_HTML_PATH) {
    html = APP_HTML_CACHE.html;
  } else {
    try {
      if (!existsSync(htmlPath)) return null;
      html = readFileSync(htmlPath, "utf8");
    } catch (_) {
      return null;
    }
  }

  let manifest = null;
  if (isProd && APP_HTML_CACHE.manifest && manifestPath === APP_MANIFEST_PATH) {
    manifest = APP_HTML_CACHE.manifest;
  } else if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (_) {
      manifest = null;
    }
  }

  const entry = manifest && manifest.entries && manifest.entries.app;
  if (entry && typeof entry === "string") {
    return substituteAppEntry(html, entry);
  }
  return html;
}

export function substituteAppEntry(html, entryPath) {
  return html.replace(
    /<script\s+type="module"\s+src="\/src\/app\.js"\s*>\s*<\/script>/,
    `<script type="module" src="${entryPath}"></script>`,
  );
}

/**
 * Extract the channel prefix (everything before the first `:`) from a channel
 * identifier. Used to tag realtime backpressure / subscriber-error metrics
 * with a low-cardinality label (e.g. `chat:abc-123` -> `chat`).
 *
 * @param {string} channel
 * @returns {string}
 */
export function channelPrefix(channel) {
  const s = typeof channel === "string" ? channel : "";
  const idx = s.indexOf(":");
  return idx >= 0 ? s.slice(0, idx) : s;
}

/**
 * Install the realtime-channel observability hooks: slow-subscriber drops
 * and subscriber errors are forwarded to the metrics module, tagged with the
 * channel prefix. Every call into metrics is wrapped in try/catch so a
 * metric-layer failure never breaks dispatch.
 *
 * Exported for tests (see tests/server-boot-wiring.test.js).
 *
 * @param {object} registry - a channel registry from lib/realtime-channels.js
 * @param {object} [m] - metrics module overrides (tests inject fakes here)
 */
export function installRealtimeMetricsHooks(registry, m = {}) {
  if (!registry || typeof registry.setSlowSubscriberHook !== "function") return false;
  const incBackpressure = m.incrementRealtimeBackpressure || incrementRealtimeBackpressure;
  const incSubError = m.incrementRealtimeSubscriberError || incrementRealtimeSubscriberError;
  registry.setSlowSubscriberHook(({ channel }) => {
    try { incBackpressure(channelPrefix(channel)); } catch (_) { /* never break dispatch */ }
  });
  registry.setSubscriberErrorHook((channel, _clientId, _err) => {
    try { incSubError(channelPrefix(channel)); } catch (_) { /* never break dispatch */ }
  });
  return true;
}

/**
 * Install a flag-gated default redirect from `GET /` to `/app/chat`.
 *
 * When `process.env.UI_DEFAULT_APP === "1"`, registers an `app.get("/", …)`
 * handler that returns a 302 to `/app/chat`, preserving any query string.
 * When the flag is unset (or anything other than "1"), this is a no-op and
 * `/` continues to be served by the existing `express.static` middleware.
 *
 * Must be installed BEFORE the static middleware so the redirect intercepts
 * cleanly. Exported for tests (see tests/app-default-redirect.test.js).
 */
export function installDefaultAppRedirect(targetApp, env = process.env) {
  if (env.UI_DEFAULT_APP !== "1") return false;
  targetApp.get("/", (req, res) => {
    const qs = req.url.indexOf("?");
    const suffix = qs >= 0 ? req.url.slice(qs) : "";
    res.redirect(302, "/app/chat" + suffix);
  });
  return true;
}

// Error middleware (after all routes and static files)
app.use(errorMiddleware);
app.use(errorHandler);

// Phase 34: Graceful shutdown (SIGTERM, SIGINT). Vercel: not applicable.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

if (process.env.VERCEL !== "1") {
  // Phase 31.4: Initialize log shipping before anything else so startup logs are forwarded.
  initLogShipping();
  // Phase 47: Start OTEL before createServer so HTTP instrumentation wraps the server.
  initTracing()
    .catch(() => {})
    .then(() => {
      const httpServer = createServer(app);
      attachToServer(httpServer);
      if (process.env.REALTIME_WS_DISABLED !== "1") {
        mountRealtimeWs(httpServer, { channels: defaultChannelRegistry });
      }
      // Wire realtime backpressure + subscriber errors into metrics counters.
      installRealtimeMetricsHooks(defaultChannelRegistry);
      // Best-effort: rebuild the agent-session runId -> sessionId index from
      // persisted sessions so cross-process restarts recover the lookup
      // mirror without needing a first write. Non-fatal if storage is
      // unavailable (e.g. read-only test boots).
      buildRunIndexFromSessions()
        .then((stats) => {
          if (stats?.runs > 0) {
            console.log(
              `[boot] agent-session run index: ${stats.runs} runs across ${stats.sessions} sessions`,
            );
          }
        })
        .catch((err) => console.warn("[boot] buildRunIndexFromSessions failed:", err.message));

      function gracefulShutdown(signal) {
        console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);
        httpServer.close(async () => {
          try {
            if (process.env.ENABLE_SCHEDULED_RECIPES === "1") schedulerStop();
            if (process.env.ENABLE_SYNTHETIC_MONITORING === "1") {
              try { getSyntheticMonitor().stop(); } catch (_) {}
            }
            // Phase 35.2: Persist embedding cache to disk if configured.
            if (process.env.EMBEDDING_CACHE_PATH) {
              try {
                await globalEmbeddingCache.persist(process.env.EMBEDDING_CACHE_PATH);
                console.log(`[shutdown] Persisted embedding cache to ${process.env.EMBEDDING_CACHE_PATH}`);
              } catch (e) {
                console.warn("[shutdown] Embedding cache persist failed:", e.message);
              }
            }
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
        if (process.env.ENABLE_PROMPT_EVOLUTION === "1") {
          try {
            startPromptEvolutionScheduler();
            console.log("Phase 32.2: Prompt evolution auto-promotion enabled (hourly)");
          } catch (e) {
            console.warn("[prompt-evolution] Start failed:", e.message);
          }
        }
        if (process.env.ENABLE_SYNTHETIC_MONITORING === "1") {
          try {
            const monitor = getSyntheticMonitor();
            const host = (process.env.LISTEN_HOST?.trim() || "127.0.0.1");
            const baseUrl = process.env.SYNTHETIC_MONITOR_BASE_URL || `http://${host}:${PORT}`;
            registerBuiltInChecks(monitor, baseUrl);
            const intervalMs = Number(process.env.SYNTHETIC_MONITOR_INTERVAL_MS) || 5 * 60 * 1000;
            monitor.start(intervalMs);
            console.log(`Phase 31.3: Synthetic monitoring enabled (interval=${intervalMs}ms, base=${baseUrl})`);
          } catch (e) {
            console.warn("[synthetic-monitor] Start failed:", e.message);
          }
        }
        if (process.env.ENABLE_SECURITY_SCORECARD !== "0") {
          try {
            startDailySecurityScan().catch((e) =>
              console.warn("[security-scorecard] Start failed:", e.message),
            );
            console.log("Phase 36.5: Security scorecard daily scan enabled");
          } catch (e) {
            console.warn("[security-scorecard] Start failed:", e.message);
          }
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
