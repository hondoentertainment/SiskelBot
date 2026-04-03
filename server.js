import "dotenv/config";
import { createServer } from "http";
import express from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
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
  indexDocumentFromBuffer,
  search as knowledgeSearch,
  semanticSearch as knowledgeSemanticSearch,
  list as knowledgeList,
  reindexKnowledgeEmbeddingsInWorkspace,
} from "./lib/knowledge-store.js";
import { getWorkspaceChunkingConfig, setWorkspaceChunkingConfig } from "./lib/knowledge-chunking-config.js";
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
import { listStagingTraceSummaries } from "./lib/eval-staging-traces.js";
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
  getAgentRunSummarySnapshot,
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
  getWorkspaceMemoryStats,
} from "./lib/workspace-agent-settings.js";
import {
  installMarketplacePack,
  listInstalledMarketplacePacks,
  setMarketplacePackEnabled,
  getWorkspaceMarketplacePolicy,
  saveWorkspaceMarketplacePolicy,
  listInstalledMarketplaceSummary,
  getTrustedMarketplaceKeyIds,
} from "./lib/marketplace-registry.js";
import compression from "compression";
import { otelHttpEnrichmentMiddleware } from "./lib/otel-context.js";
import { exportWorkspaceBundle, deleteWorkspaceForUser } from "./lib/workspace-lifecycle.js";
import {
  storeMemory,
  getMemories,
  searchMemories,
  updateMemory as updateAgentMemory,
  deleteMemory as deleteAgentMemory,
  getMemoryStats,
  extractPotentialMemories,
} from "./lib/agent-memory.js";
import {
  exportWorkspace as exportWorkspaceMigration,
  importWorkspace as importWorkspaceMigration,
  validateBundle,
  diffWorkspaces,
} from "./lib/workspace-migration.js";
import { idempotencyLookup, idempotencyStore } from "./lib/idempotency.js";
import { archiveExecutionAuditToS3, getAuditArchiveStatus } from "./lib/audit-s3-archive.js";
import { fetchTextFromAllowedUrl } from "./lib/knowledge-url-fetch.js";
import { pipeLlmChatStreamToSse } from "./lib/llm-stream-sse.js";
import { runAgentLoop, resumeAgentLoopFromHitlToken } from "./lib/agent-loop.js";
import { takeHitlState } from "./lib/agent-hitl-store.js";
import {
  recordTrace,
  listTraces as listRecordedTraces,
  getTrace as getRecordedTrace,
  deleteTrace as deleteRecordedTrace,
  autoRecordEnabled,
} from "./lib/trace-recorder.js";
import { replayTrace, replayAll } from "./lib/trace-replay.js";
import { workspaceRateLimiter } from "./lib/workspace-rate-limit.js";
import { getEventsSince } from "./lib/realtime-replay.js";
import { versionDetection } from "./lib/api-versioning.js";
import {
  recordLatency as obsRecordLatency,
  getMetricsSummary,
  getLatencyPercentiles as obsGetLatencyPercentiles,
  getErrorRates as obsGetErrorRates,
  getAgentStats as obsGetAgentStats,
  getTokenUsageByWorkspace as obsGetTokenUsageByWorkspace,
} from "./lib/observability.js";
import {
  PERMISSIONS as RBAC_PERMISSIONS,
  BUILT_IN_ROLES,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
  listRoles as listRbacRoles,
  assignRole,
  getUserPermissions,
  requirePermission,
} from "./lib/rbac.js";
import {
  getAvailableRegions,
  setDataResidency,
  getDataResidency,
  detectPII,
  redactPII,
  setRetentionPolicy,
  getRetentionPolicy,
  generateComplianceReport,
  scanTextForPII,
} from "./lib/compliance.js";
import {
  registerPeer,
  removePeer,
  listPeers,
  healthCheckPeers,
  discoverFederatedWorkspaces,
  syncWorkspaceMetadata,
  handleDiscoverRequest,
  getInstanceInfo,
  federationAuth,
  signPayload,
} from "./lib/federation.js";

import {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
  createWorkspaceFromTemplate,
} from "./lib/workspace-templates.js";

// --- Route modules (P0.1) ---
import { mountAuthRoutes } from "./routes/auth.js";
import { mountChatRoutes } from "./routes/chat.js";
import { mountHealthRoutes } from "./routes/health.js";
import { mountKnowledgeRoutes } from "./routes/knowledge.js";
import { mountWorkspaceRoutes } from "./routes/workspaces.js";
import { mountConversationRoutes } from "./routes/conversations.js";
import { mountContextRoutes } from "./routes/context.js";
import { mountRecipeRoutes } from "./routes/recipes.js";
import { mountBackupRoutes } from "./routes/backup.js";
import { mountPluginRoutes } from "./routes/plugins.js";
import { mountWebhookRoutes } from "./routes/webhooks.js";
import { mountExecuteRoutes } from "./routes/execute.js";
import { mountEvalRoutes } from "./routes/eval.js";
import { mountIntegrationRoutes } from "./routes/integrations.js";
import { mountAdminRoutes } from "./routes/admin.js";
import { mountFederationRoutes } from "./routes/federation.js";

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
/** Embedded HTTP server (Electron); session cookies must not be Secure on http://127.0.0.1 */
const IS_ELECTRON_DESKTOP = process.env.ELECTRON_DESKTOP === "1";
// Phase 51: Chunk final agent SSE for smoother client rendering (optional)
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
  // Optional vars - log warnings
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
// Phase 44: Response compression (JSON APIs; exclude streaming)
const ENABLE_COMPRESSION = process.env.ENABLE_COMPRESSION !== "0" && (IS_PRODUCTION || process.env.ENABLE_COMPRESSION === "1");
if (ENABLE_COMPRESSION) {
  app.use(
    compression({
      filter: (req, _res) => !req.path?.startsWith("/v1/chat/completions") && !req.path?.startsWith("/v1/agent/swarm"),
    })
  );
}
app.use(express.json());
app.use(otelHttpEnrichmentMiddleware());
app.use(versionDetection());

// Observability: record request latency for all requests (lightweight, after response)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    obsRecordLatency(req.route?.path || req.path, req.method, Date.now() - start, res.statusCode);
  });
  next();
});

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

// Phase 34: Security headers (configurable; disabled for dev if DISABLE_SECURITY_HEADERS=1)
// Phase 35: CSP in production when ENABLE_CSP=1; report-only by default to avoid breaking SPA
const DISABLE_SECURITY_HEADERS = process.env.DISABLE_SECURITY_HEADERS === "1";
const ENABLE_CSP = process.env.ENABLE_CSP === "1" && IS_PRODUCTION;
if (!DISABLE_SECURITY_HEADERS) {
  const helmetOpts = {
    contentSecurityPolicy: false,
    strictTransportSecurity: IS_PRODUCTION && !IS_ELECTRON_DESKTOP ? { maxAge: 31536000, includeSubDomains: true } : false,
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
        secure: IS_PRODUCTION && !IS_ELECTRON_DESKTOP,
        httpOnly: true,
        sameSite: "lax",
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

// Rate limit for /v1/chat/completions
// Phase 21: When auth configured, rate limit by userId; else by IP
// Phase 30: When RATE_LIMIT_PER_KEY set, additional per-key limit for API key requests
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

// Rate limit for read/search operations (configurable via READ_RATE_LIMIT_MAX)
const readRateLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.READ_RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    apiError(res, 429, "RATE_LIMITED", "Too many read requests", "Reduce request rate or increase READ_RATE_LIMIT_MAX.");
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

// Phase 23: Register route at /api/v1/path (stable), /api/v2/path (v2), and /api/path (legacy with deprecation)
function apiRoute(method, path, ...handlers) {
  app[method](`/api/v1${path}`, ...handlers);
  app[method](`/api/v2${path}`, ...handlers);
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

// Optional API key auth for routes that accept deployment key only (schedules, tasks/plan).
// Phase 30: When API_KEY matches, sets req.apiKeyScopes (from API_KEY_SCOPES), req.apiKeyId="deployment"
function apiKeyAuth(req, res, next) {
  if (!API_KEY) return next();
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const xKey = req.headers["x-api-key"];
  const key = bearer || xKey;
  if (!key || key !== API_KEY) {
    return apiError(res, 401, "AUTH_REQUIRED", "Unauthorized", "Use Authorization: Bearer <key> or x-api-key header.");
  }
  req.authenticatedViaDeploymentKey = true;
  req.apiKeyScopes = API_KEY_SCOPES.length ? API_KEY_SCOPES : ["read", "write"];
  req.apiKeyId = "deployment";
  next();
}

// Phase 30: Combined auth for chat - accepts API_KEY (deployment) or user key. Pass to userAuth for user key validation.
function chatAuth(req, res, next) {
  if (!API_KEY) return userAuth(req, res, next);
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
  const xApiKey = req.headers["x-api-key"];
  const xUserKey = req.headers["x-user-api-key"];
  const key = xApiKey || xUserKey || bearer;
  if (!key) return apiError(res, 401, "AUTH_REQUIRED", "Unauthorized", "Use Authorization: Bearer <key>, x-api-key, or x-user-api-key header.");
  if (key === API_KEY) {
    req.authenticatedViaDeploymentKey = true;
    req.apiKeyScopes = API_KEY_SCOPES.length ? API_KEY_SCOPES : ["read", "write"];
    req.apiKeyId = "deployment";
    req.userId = "anonymous";
    return next();
  }
  return userAuth(req, res, next);
}

// Phase 32: Eval auth - ADMIN_API_KEY or API_KEY
function evalAuth(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  const apiKey = API_KEY;
  if (!adminKey && !apiKey) return next(); // local dev: no keys = allow
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
  const xKey = req.headers["x-api-key"] || req.headers["x-admin-api-key"];
  const key = bearer || xKey;
  if (!key) return apiError(res, 401, "AUTH_REQUIRED", "Eval endpoints require ADMIN_API_KEY or API_KEY", "Use Authorization: Bearer <key> or x-api-key header.");
  if ((adminKey && key === adminKey) || (apiKey && key === apiKey)) return next();
  return apiError(res, 401, "AUTH_REQUIRED", "Invalid key", "Use ADMIN_API_KEY or API_KEY.");
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

// Phase 34: Structured request logging (X-Request-Id from middleware; JSON in production)
// Phase 36: Log sanitization - never log secrets; path/headers sanitized
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

// GET /config — mounted via routes/health.js

// Phase 19: OAuth routes — mounted via routes/auth.js
function oauthCallback(req, res) {
  if (!req.session) return res.redirect("/?auth_error=session");
  req.session.userId = req.user?.userId;
  res.redirect("/");
}

// Phase 13: Usage tracking env
const USAGE_ALERT_TOKENS = process.env.USAGE_ALERT_TOKENS ? Number(process.env.USAGE_ALERT_TOKENS) : null;

// Phase 15: Agent mode (iteration ceiling: MAX_AGENT_ITERATIONS env; Phase 92: optional agentOptions.maxIterations)
const ALLOW_RECIPE_STEP_EXECUTION = process.env.ALLOW_RECIPE_STEP_EXECUTION === "1";
const ENABLE_AGENT_SWARM = process.env.ENABLE_AGENT_SWARM === "1";

// --- Task plan helpers (used by routes/chat.js) ---

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
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function validateTaskPlan(plan) {
  if (!plan || typeof plan !== "object") return "Plan must be an object";
  if (plan.type !== "task") return "Plan must have type 'task'";
  if (!plan.name || typeof plan.name !== "string" || !plan.name.trim()) return "Plan must have a non-empty name";
  if (!Array.isArray(plan.steps) || plan.steps.length < 1) return "Plan must have at least one step";
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    if (!s || typeof s !== "object") return `Step ${i + 1}: must be an object`;
    if (!s.action || typeof s.action !== "string" || !String(s.action).trim()) return `Step ${i + 1}: must have non-empty action`;
    if (s.payload !== undefined && (s.payload === null || Array.isArray(s.payload) || typeof s.payload !== "object")) return `Step ${i + 1}: payload must be an object`;
  }
  if (plan.requiresApproval !== undefined && typeof plan.requiresApproval !== "boolean") return "requiresApproval must be a boolean";
  return null;
}

const taskPlanRateLimiter = rateLimit({ windowMs: RATE_LIMIT_WINDOW_MS, max: RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false });

// --- Health check helpers ---
const HEALTH_CACHE_TTL_MS = 5000;
let _healthCache = null;

function getHealthUrl(backend) {
  switch (backend) {
    case "ollama": return `${OLLAMA_URL}/api/tags`;
    case "vllm": return `${VLLM_URL}/v1/models`;
    case "openai": return "https://api.openai.com/v1/models";
    default: return null;
  }
}

async function probeBackend(name, url, headers = {}) {
  const start = Date.now();
  try { const r = await fetch(url, { signal: AbortSignal.timeout(3000), headers }); return { reachable: r.ok, latencyMs: Date.now() - start, error: r.ok ? undefined : `HTTP ${r.status}` }; }
  catch (e) { return { reachable: false, latencyMs: Date.now() - start, error: e.message }; }
}

async function runHealthChecks() {
  const backends = {};
  const checks = [];
  const ollamaUrl = getHealthUrl("ollama");
  if (ollamaUrl) checks.push(probeBackend("ollama", ollamaUrl).then((r) => { backends.ollama = r; }));
  const vllmUrl = getHealthUrl("vllm");
  if (vllmUrl) checks.push(probeBackend("vllm", vllmUrl).then((r) => { backends.vllm = r; }));
  if (OPENAI_API_KEY) checks.push(probeBackend("openai", "https://api.openai.com/v1/models", { Authorization: `Bearer ${OPENAI_API_KEY}` }).then((r) => { backends.openai = r; }));
  await Promise.all(checks);
  const active = backends[BACKEND];
  return { backend: BACKEND, reachable: active?.reachable ?? false, latencyMs: active?.latencyMs ?? null, lastChecked: new Date().toISOString(), backends };
}

// --- Metrics auth ---
const METRICS_PATH = (process.env.METRICS_PATH || "/metrics").replace(/^\/+/, "/").replace(/\/+$/, "") || "/metrics";
const METRICS_PROTECTED = process.env.METRICS_PROTECTED === "1";
const METRICS_SECRET = process.env.METRICS_SECRET?.trim() || null;
function metricsAuthFn(req, res, next) {
  if (!METRICS_PROTECTED) return next();
  const adminKey = process.env.ADMIN_API_KEY;
  const secret = METRICS_SECRET;
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;
  const querySecret = req.query?.secret;
  const xKey = req.headers["x-admin-api-key"];
  const key = bearer || xKey;
  if (secret && (querySecret === secret || bearer === secret)) return next();
  if (adminKey && key && key === adminKey) return next();
  if (secret || adminKey) return res.status(401).json({ error: "Metrics require authentication", code: "AUTH_REQUIRED", hint: "Use ?secret=<METRICS_SECRET> or Authorization: Bearer <ADMIN_API_KEY>" });
  next();
}

// --- Integration helpers ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const OWNER_REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
function validateOwnerRepo(owner, repo) { return typeof owner === "string" && typeof repo === "string" && OWNER_REPO_PATTERN.test(owner) && OWNER_REPO_PATTERN.test(repo) && owner.length <= 100 && repo.length <= 100; }
function requireGitHubToken(req, res, next) { if (!GITHUB_TOKEN) return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "GitHub integration unavailable", "Set GITHUB_TOKEN in server environment variables."); next(); }
function requireVercelToken(req, res, next) { if (!VERCEL_TOKEN) return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "Vercel integration unavailable", "Set VERCEL_TOKEN in server environment variables."); next(); }

// --- Monitoring ---
const STALE_PR_DAYS = 7;
let monitoringState = {
  lastCheck: null,
  checks: { github: null, vercel: null },
  summary: "idle",
  alerts: [],
};
async function runMonitoringChecks() {
  const alerts = []; const checks = { github: null, vercel: null };
  if (GITHUB_TOKEN && MONITORING_REPO) {
    const [owner, repo] = MONITORING_REPO.split("/").map((s) => s.trim());
    if (owner && repo && validateOwnerRepo(owner, repo)) {
      try {
        const base = GITHUB_API_BASE.replace(/\/$/, "");
        const [commitsRes, prsRes] = await Promise.all([
          fetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=1`, { headers: { Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${GITHUB_TOKEN}` }, signal: AbortSignal.timeout(10000) }),
          fetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=30`, { headers: { Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${GITHUB_TOKEN}` }, signal: AbortSignal.timeout(10000) }),
        ]);
        const lastCommit = commitsRes.ok ? (await commitsRes.json())[0] : null;
        const openPRs = prsRes.ok ? await prsRes.json() : [];
        const now = Date.now();
        const stalePRs = openPRs.filter((pr) => (now - new Date(pr.created_at || 0).getTime()) / 86400000 > STALE_PR_DAYS);
        checks.github = { ok: commitsRes.ok && prsRes.ok, lastCommit: lastCommit ? { sha: lastCommit.sha?.slice(0, 7), date: lastCommit.commit?.author?.date, message: lastCommit.commit?.message?.split("\n")[0] } : null, openPRs: openPRs.length, stalePRs: stalePRs.length };
        if (stalePRs.length > 0) alerts.push({ type: "stale_prs", count: stalePRs.length, message: `${stalePRs.length} PR(s) open > ${STALE_PR_DAYS} days` });
      } catch (err) { checks.github = { ok: false, error: err.message }; alerts.push({ type: "github_error", message: err.message }); }
    }
  }
  if (VERCEL_TOKEN) {
    try {
      const base = VERCEL_API_BASE.replace(/\/$/, "");
      const r = await fetch(`${base}/v6/deployments?limit=1`, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }, signal: AbortSignal.timeout(10000) });
      const data = r.ok ? await r.json() : null;
      const last = (data?.deployments || [])[0];
      const failed = last?.state === "ERROR" || last?.state === "CANCELED";
      checks.vercel = { ok: r.ok, lastDeploy: last ? { state: last.state, url: last.url, created: last.created } : null, failed };
      if (failed) alerts.push({ type: "deploy_failed", message: `Last deployment: ${last.state}` });
    } catch (err) { checks.vercel = { ok: false, error: err.message }; alerts.push({ type: "vercel_error", message: err.message }); }
  }
  monitoringState = { lastCheck: new Date().toISOString(), checks, summary: alerts.length > 0 ? "alerts" : "ok", alerts };
  return monitoringState;
}
if (isMonitoringEnabled()) {
  runMonitoringChecks().catch((e) => console.warn("[monitoring] Initial check failed:", e.message));
  setInterval(() => {
    runMonitoringChecks().catch((e) => console.warn("[monitoring] Scheduled check failed:", e.message));
  }, MONITORING_INTERVAL_MS);
}

// --- Rate limiters shared by route modules ---
const storageRateLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const KNOWLEDGE_MAX_DOC_BYTES = Number(process.env.KNOWLEDGE_MAX_DOC_BYTES) || 1024 * 1024;
const sanitizeWorkspace = storage.sanitizeWorkspace;
const multimodalRateLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
const pluginsActionsRateLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const marketplaceRateLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const webhooksRateLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const webhooksHandlers = [webhooksRateLimiter, storageRateLimiter, userAuth, logRequest];
const executeStepRateLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, handler: (req, res) => { apiError(res, 429, "RATE_LIMITED", "Too many execute requests", "Wait before retrying."); } });
const evalRateLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false, handler: (req, res) => { apiError(res, 429, "RATE_LIMITED", "Too many eval runs", "Limit: 5 runs per minute."); } });

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

// Phase 28: POST /api/embeddings - embed text(s) via OpenAI text-embedding-3-small
apiRoute("post", "/embeddings", embeddingsRateLimiter, chatAuth, requireScope("embed"), logRequest, async (req, res) => {
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
  requireScope("write"),
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
      const result = await indexDocument({ text, workspace, title, embedding });
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

apiRoute("get", "/knowledge/search", readRateLimiter, requireScope("read"), logRequest, async (req, res) => {
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

apiRoute("get", "/knowledge/status", readRateLimiter, requireScope("read"), logRequest, (req, res) => {
  const workspace = String(req.query.workspace || "default").trim();
  const result = knowledgeList({ workspace });
  if (result.error) {
    return apiError(res, 400, result.code || "INVALID_INPUT", result.error, result.hint || "");
  }
  res.json({
    workspace,
    documentCount: Array.isArray(result.items) ? result.items.length : 0,
  });
});

apiRoute("get", "/knowledge/list", readRateLimiter, requireScope("read"), logRequest, (req, res) => {
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

apiRoute("post", "/knowledge/reindex", embeddingsRateLimiter, requireScope("embed"), logRequest, async (req, res) => {
  try {
    if (!embeddingsAvailable()) {
      return apiError(res, 503, "EMBEDDINGS_UNAVAILABLE", "OPENAI_API_KEY required for reindex", "Set OPENAI_API_KEY or skip semantic refresh.");
    }
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const result = await reindexKnowledgeEmbeddingsInWorkspace(workspace);
    if (result.error) {
      return res.status(400).json({ error: result.error, code: result.code });
    }
    res.json(result);
  } catch (err) {
    console.error("Knowledge reindex error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RAG_PIPELINE_V2.md.");
  }
});

apiRoute("post", "/knowledge/fetch", knowledgeIndexRateLimiter, requireScope("write"), logRequest, async (req, res) => {
  try {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 200) : undefined;
    const computeEmbedding = req.body?.computeEmbedding === true;

    if (!url) {
      return apiError(res, 400, "INVALID_INPUT", "url is required", "Send { url, workspace?, title?, computeEmbedding? }.");
    }

    const fetched = await fetchTextFromAllowedUrl(url);
    if (fetched.error) {
      const st =
        fetched.code === "ALLOWLIST_REQUIRED" || fetched.code === "URL_NOT_ALLOWED"
          ? 403
          : fetched.code === "DOC_TOO_LARGE"
            ? 413
            : fetched.code === "UNSUPPORTED_MEDIA"
              ? 415
              : 502;
      return res.status(st).json({ error: fetched.error, code: fetched.code });
    }

    let embedding;
    if (computeEmbedding && embeddingsAvailable()) {
      embedding = await embed(fetched.text.slice(0, 8000));
    }

    const docTitle = title || fetched.finalUrl;
    const result = await indexDocument({ text: fetched.text, workspace, title: docTitle, embedding });
    if (result.error) {
      return res.status(400).json({ error: result.error, code: result.code, hint: result.hint });
    }
    res.status(201).json({ ...result, sourceUrl: fetched.finalUrl });
  } catch (err) {
    console.error("Knowledge fetch error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RAG_PIPELINE_V2.md.");
  }
});

// --- Phase 14: Workspaces API ---
apiRoute("get", "/workspaces", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
  try {
    const workspaces = await storage.listWorkspaces(req.userId);
    res.json({ _version: 1, items: workspaces });
  } catch (err) {
    console.error("Workspaces list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/workspaces", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
  try {
    const idemKey = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
    if (idemKey) {
      const prev = await idempotencyLookup(String(idemKey), "POST:/api/workspaces", req.userId || "anonymous");
      if (prev.hit) return res.status(prev.status).json(prev.body);
    }
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "Workspace";
    const type = req.body?.type === "team" ? "team" : "personal";
    const ws = await storage.createWorkspace(req.userId, name, type);
    if (idemKey) {
      await idempotencyStore(String(idemKey), "POST:/api/workspaces", req.userId || "anonymous", 201, ws);
    }
    res.status(201).json(ws);
  } catch (err) {
    console.error("Workspace create error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// --- Workspace Templates ---
apiRoute("get", "/workspace-templates", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const templates = await listTemplates();
    res.json({ _version: 1, items: templates });
  } catch (err) {
    console.error("Workspace templates list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/workspace-templates", storageRateLimiter, adminAuth, logRequest, async (req, res) => {
  try {
    const template = await createTemplate(req.body);
    res.status(201).json(template);
  } catch (err) {
    console.error("Workspace template create error:", err.message);
    if (err.message === "Template name is required") {
      return apiError(res, 400, "VALIDATION_ERROR", err.message, "Provide a name field.");
    }
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/workspace-templates/:id", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const template = await getTemplate(req.params.id);
    if (!template) {
      return apiError(res, 404, "NOT_FOUND", "Template not found", null);
    }
    res.json(template);
  } catch (err) {
    console.error("Workspace template get error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("put", "/workspace-templates/:id", storageRateLimiter, adminAuth, logRequest, async (req, res) => {
  try {
    const updated = await updateTemplate(req.params.id, req.body);
    if (!updated) {
      return apiError(res, 404, "NOT_FOUND", "Template not found", null);
    }
    res.json(updated);
  } catch (err) {
    console.error("Workspace template update error:", err.message);
    if (err.message === "Cannot update a default template") {
      return apiError(res, 403, "FORBIDDEN", err.message, "Default templates cannot be modified.");
    }
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("delete", "/workspace-templates/:id", storageRateLimiter, adminAuth, logRequest, async (req, res) => {
  try {
    const deleted = await deleteTemplate(req.params.id);
    if (!deleted) {
      return apiError(res, 404, "NOT_FOUND", "Template not found", null);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Workspace template delete error:", err.message);
    if (err.message === "Cannot delete a default template") {
      return apiError(res, 403, "FORBIDDEN", err.message, "Default templates cannot be deleted.");
    }
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/workspace-templates/:id/apply", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId.trim() : null;
    if (!workspaceId) {
      return apiError(res, 400, "VALIDATION_ERROR", "workspaceId is required", null);
    }
    const result = await applyTemplate(req.params.id, workspaceId, req.userId);
    res.json(result);
  } catch (err) {
    console.error("Workspace template apply error:", err.message);
    if (err.message === "Template not found") {
      return apiError(res, 404, "NOT_FOUND", err.message, null);
    }
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// Phase 74: Workspace export (JSON) and owner delete
apiRoute("get", "/workspaces/:id/export", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
  try {
    const workspaceId = sanitizeWorkspace(req.params.id);
    const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
    if (!access.allowed) {
      return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
    }
    const bundle = await exportWorkspaceBundle(req.userId, workspaceId);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="workspace-${workspaceId}-export.json"`);
    res.send(JSON.stringify(bundle, null, 2));
  } catch (err) {
    console.error("Workspace export error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("delete", "/workspaces/:id", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
  try {
    const workspaceId = sanitizeWorkspace(req.params.id);
    if (req.body?.confirm !== "DELETE" && req.query?.confirm !== "DELETE") {
      return apiError(
        res,
        400,
        "CONFIRM_REQUIRED",
        'Send JSON { "confirm": "DELETE" } or ?confirm=DELETE to delete a workspace.',
        "Phase 74: destructive operation requires explicit confirmation."
      );
    }
    const result = await deleteWorkspaceForUser(req.userId, workspaceId);
    if (!result.ok) {
      const st = result.error?.includes("owner") || result.error?.includes("Only") ? 403 : 400;
      return res.status(st).json({ error: result.error, code: "DELETE_WORKSPACE_FAILED" });
    }
    res.status(204).send();
  } catch (err) {
    console.error("Workspace delete error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// Phase 61–62: Per-workspace agent system prompt + approved memory (agent / swarm)
apiRoute("get", "/workspaces/:id/agent-settings", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
  try {
    const workspaceId = sanitizeWorkspace(req.params.id);
    const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
    if (!access.allowed) {
      return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
    }
    const storageUserId = await resolveStorageUserId(req.userId, workspaceId);
    const settings = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
    res.json({
      workspaceId,
      defaultSystemPrompt: settings.defaultSystemPrompt,
      memorySnippets: settings.memorySnippets,
      allowedTools: settings.allowedTools || [],
      agentPolicy: settings.agentPolicy || {},
      memoryStats: getWorkspaceMemoryStats(settings),
    });
  } catch (err) {
    console.error("Agent settings GET error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute(
  "put",
  "/workspaces/:id/agent-settings",
  storageRateLimiter,
  userAuth,
  requireScope("write"),
  logRequest,
  async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      }
      if (!canEditWorkspaceAgentSettings(access.role)) {
        return apiError(
          res,
          403,
          "FORBIDDEN",
          "Viewers cannot edit workspace agent settings",
          "Requires admin or member role on team workspaces."
        );
      }
      const storageUserId = await resolveStorageUserId(req.userId, workspaceId);
      const saved = await saveWorkspaceAgentSettings(storageUserId, workspaceId, req.body || {});
      res.json({
        workspaceId,
        defaultSystemPrompt: saved.defaultSystemPrompt,
        memorySnippets: saved.memorySnippets,
        allowedTools: saved.allowedTools || [],
        agentPolicy: saved.agentPolicy || {},
        memoryStats: getWorkspaceMemoryStats(saved),
      });
    } catch (err) {
      console.error("Agent settings PUT error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  }
);

apiRoute("get", "/workspaces/:id/agent-memory/stats", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const workspaceId = sanitizeWorkspace(req.params.id);
    const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
    if (!access.allowed) {
      return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
    }
    const storageUserId = await resolveStorageUserId(req.userId, workspaceId);
    const settings = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
    res.json({ workspaceId, memory: getWorkspaceMemoryStats(settings) });
  } catch (err) {
    console.error("Agent memory stats GET error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// Marketplace packs and workspace policy
apiRoute("get", "/workspaces/:id/marketplace/packs", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const workspaceId = sanitizeWorkspace(req.params.id);
    const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
    if (!access.allowed) {
      return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
    }
    const packs = await listInstalledMarketplacePacks(workspaceId);
    res.json({ workspaceId, packs });
  } catch (err) {
    console.error("Marketplace packs list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute(
  "post",
  "/workspaces/:id/marketplace/install",
  storageRateLimiter,
  userAuth,
  requireScope("write"),
  logRequest,
  async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      }
      if (!canEditWorkspaceAgentSettings(access.role)) {
        return apiError(res, 403, "FORBIDDEN", "Viewers cannot install marketplace packs", null);
      }
      const out = await installMarketplacePack(workspaceId, req.body?.manifest);
      if (!out.ok) {
        const status = out.code === "INVALID_MANIFEST" ? 400 : 403;
        return res.status(status).json({ error: out.error || "Install failed", code: out.code, details: out.errors || [] });
      }
      appendAuditLog({
        action: "marketplace_install",
        payload: { workspaceId, packId: out.pack.id, version: out.pack.version },
        ok: true,
      });
      res.status(201).json({ workspaceId, pack: out.pack });
    } catch (err) {
      console.error("Marketplace install error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  }
);

apiRoute(
  "post",
  "/workspaces/:id/marketplace/packs/:packId/:op(enable|disable)",
  storageRateLimiter,
  userAuth,
  requireScope("write"),
  logRequest,
  async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      }
      if (!canEditWorkspaceAgentSettings(access.role)) {
        return apiError(res, 403, "FORBIDDEN", "Viewers cannot modify marketplace packs", null);
      }
      const enable = String(req.params.op) === "enable";
      const out = await setMarketplacePackEnabled(workspaceId, req.params.packId, enable);
      if (!out.ok) {
        return res.status(out.code === "NOT_FOUND" ? 404 : 400).json({ error: out.error || "Operation failed", code: out.code });
      }
      appendAuditLog({
        action: enable ? "marketplace_enable" : "marketplace_disable",
        payload: { workspaceId, packId: out.pack.id, version: out.pack.version },
        ok: true,
      });
      res.json({ workspaceId, pack: out.pack });
    } catch (err) {
      console.error("Marketplace enable/disable error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  }
);

apiRoute("get", "/workspaces/:id/marketplace/policy", storageRateLimiter, userAuth, logRequest, async (req, res) => {
  try {
    const workspaceId = sanitizeWorkspace(req.params.id);
    const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
    if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
    const policy = await getWorkspaceMarketplacePolicy(workspaceId);
    res.json({ workspaceId, policy });
  } catch (err) {
    console.error("Marketplace policy GET error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute(
  "put",
  "/workspaces/:id/marketplace/policy",
  storageRateLimiter,
  userAuth,
  requireScope("write"),
  logRequest,
  async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      if (!canEditWorkspaceAgentSettings(access.role)) {
        return apiError(res, 403, "FORBIDDEN", "Viewers cannot edit marketplace policy", null);
      }
      const policy = await saveWorkspaceMarketplacePolicy(workspaceId, req.body || {});
      appendAuditLog({
        action: "marketplace_policy_update",
        payload: { workspaceId, keys: Object.keys(policy) },
        ok: true,
      });
      res.json({ workspaceId, policy });
    } catch (err) {
      console.error("Marketplace policy PUT error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  }
);

// --- Phase 29: Team workspaces - invite, join, members, activity ---
apiRoute("post", "/workspaces/join", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
  try {
    const code = req.body?.code?.trim?.();
    if (!code) return apiError(res, 400, "INVALID_INPUT", "code required", "Send { code: string }.");
    const result = await joinByInviteCode(code, req.userId);
    if (!result.ok) {
      const status = result.error?.includes("Invalid") || result.error?.includes("expired") ? 400 : 409;
      return res.status(status).json({ error: result.error, code: "JOIN_FAILED" });
    }
    const members = await getWorkspaceMembers(result.workspaceId);
    const ownerId = members?.ownerId || req.userId;
    const ws = (await storage.getWorkspaceById(ownerId, result.workspaceId)) || {
      id: result.workspaceId,
      name: result.workspaceName || "Team Workspace",
    };
    res.status(200).json({ ok: true, workspace: { id: result.workspaceId, name: ws.name || result.workspaceName } });
  } catch (err) {
    console.error("Workspace join error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/workspaces/:id/invite", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const access = await canAccessWorkspace(workspaceId, req.userId);
    if (!access.allowed || (access.role !== "admin" && access.role !== "member")) {
      return apiError(res, 403, "FORBIDDEN", "Admin or member role required to create invites", null);
    }
    const opts = {};
    if (req.body?.expiresInHours != null) opts.expiresInHours = Number(req.body.expiresInHours);
    if (req.body?.maxUses != null) opts.maxUses = Number(req.body.maxUses);
    const inv = await createInviteCode(workspaceId, req.userId, opts);
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host") || "localhost"}`;
    res.status(201).json({ code: inv.code, inviteLink: `${baseUrl}?join=${inv.code}`, expiresAt: inv.expiresAt, maxUses: inv.maxUses });
  } catch (err) {
    console.error("Invite create error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/workspaces/:id/members", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const access = await canAccessWorkspace(workspaceId, req.userId);
    if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Access denied", null);
    const entry = await getWorkspaceMembers(workspaceId);
    if (!entry) return res.json({ ownerId: null, members: [] });
    res.json({ ownerId: entry.ownerId, members: entry.members || [] });
  } catch (err) {
    console.error("Members list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("get", "/workspaces/:id/activity", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const access = await canAccessWorkspace(workspaceId, req.userId);
    if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Access denied", null);
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));
    const items = await getWorkspaceActivity(workspaceId, limit);
    res.json({ items });
  } catch (err) {
    console.error("Activity list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// --- Phase 10: Persistent Backend Storage (SiskelBot) ---
// GET/POST /api/context (userAuth attaches req.userId; anonymous when no auth configured)
apiRoute("get", "/context", storageRateLimiter, readRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const data = await storage.listItems("context", workspace, req.userId);
    res.json({ _version: 1, items: data });
  } catch (err) {
    console.error("Storage context list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/context", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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
    await logActivity(workspace, "context_added", req.userId || "anonymous", { title: doc.title, id: doc.id });
    res.status(201).json(item);
  } catch (err) {
    console.error("Storage context add error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// GET/PUT/DELETE /api/context/:id
apiRoute("get", "/context/:id", storageRateLimiter, readRateLimiter, requireScope("read"), logRequest, async (req, res) => {
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

apiRoute("put", "/context/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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

apiRoute("delete", "/context/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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
apiRoute("post", "/context/sync", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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
apiRoute("get", "/recipes", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const data = await storage.listItems("recipes", workspace);
    res.json({ _version: 1, items: data });
  } catch (err) {
    console.error("Storage recipes list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

apiRoute("post", "/recipes", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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
    await logActivity(workspace, "recipe_added", req.userId || "anonymous", { recipeName: item.name, id: out.id });
    res.status(201).json(out);
  } catch (err) {
    console.error("Storage recipes add error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// GET/PUT/DELETE /api/recipes/:id
apiRoute("get", "/recipes/:id", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
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

apiRoute("put", "/recipes/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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

apiRoute("delete", "/recipes/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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
apiRoute("post", "/recipes/sync", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
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
apiRoute("get", "/schedules", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const items = await scheduleStore.list(workspace);
    const withRecipe = await Promise.all(
      items.map(async (s) => {
        const recipe = await storage.get("recipes", s.recipeId, s.workspace || workspace);
        return { ...s, recipeName: recipe?.name || null };
      })
    );
    res.json({ items: withRecipe });
  } catch (err) {
    console.error("Schedules list error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// POST /api/schedules - add/update schedule for recipe
apiRoute("post", "/schedules", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.body?.workspace);
    const { recipeId, cron, timezone, enabled } = req.body || {};
    if (!recipeId || typeof recipeId !== "string" || !recipeId.trim()) {
      return apiError(res, 400, "INVALID_INPUT", "recipeId required", "Send { recipeId, cron, timezone?, enabled? }.");
    }
    if (!cron || typeof cron !== "string" || !cron.trim()) {
      return apiError(res, 400, "INVALID_INPUT", "cron required", "Cron format: minute hour day month weekday (e.g. 0 9 * * 1-5).");
    }
    const recipe = await storage.get("recipes", recipeId.trim(), workspace);
    if (!recipe) {
      return apiError(res, 404, "NOT_FOUND", "Recipe not found", "Create the recipe first.");
    }
    const sched = await scheduleStore.upsert(recipeId.trim(), { cron: cron.trim(), timezone, enabled: enabled !== false }, workspace);
    if (process.env.ENABLE_SCHEDULED_RECIPES === "1") await schedulerRefresh();
    res.status(201).json(sched);
  } catch (err) {
    console.error("Schedule upsert error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// DELETE /api/schedules/:recipeId - remove schedule
apiRoute("delete", "/schedules/:recipeId", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
  try {
    const workspace = sanitizeWorkspace(req.query?.workspace);
    const removed = await scheduleStore.remove(req.params.recipeId, workspace);
    if (!removed) return res.status(404).json({ error: "Schedule not found", code: "NOT_FOUND" });
    if (process.env.ENABLE_SCHEDULED_RECIPES === "1") await schedulerRefresh();
    res.status(204).send();
  } catch (err) {
    console.error("Schedule delete error:", err.message);
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// POST /api/schedules/run-now/:recipeId - manual trigger
apiRoute("post", "/schedules/run-now/:recipeId", storageRateLimiter, apiKeyAuth, requireScope("write"), logRequest, async (req, res) => {
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

// GET/PUT/DELETE /api/conversations/:id
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

// --- Conversation branching & forking ---
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
apiRoute("get", "/plugins/actions", pluginsActionsRateLimiter, userAuth, logRequest, (req, res) => {
  try {
    const actions = getRegisteredActions();
    res.json({ actions: [...actions].sort() });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
  }
});

// --- Phase 17.1: JS Plugin Management API ---
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

// --- Phase 49: Plugin Marketplace API ---
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

// --- Phase 22: Event Webhooks & Notifications ---
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

// --- Phase 33: Real-Time Sync - WebSocket token & presence ---
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

// --- Phase 27: In-App Notification Center ---
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

// --- Phase 9: Recipe Execution & Automation Hooks ---
apiRoute("post", "/execute-step",
  executeStepRateLimiter,
  apiKeyAuth,
  requireScope("write"),
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

      await emitEvent(
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

const OCR_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
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

// Phase 23: API docs - OpenAPI spec and Swagger UI (not versioned, no deprecation)
app.get("/api/docs/openapi.json", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.json(openApiSpec);
});

// --- OpenAPI docs ---
app.get("/api/docs/openapi.json", (req, res) => { res.setHeader("Content-Type", "application/json"); res.json(openApiSpec); });
app.get("/docs", (req, res) => res.redirect(302, "/api/docs"));
app.get("/api/docs", (req, res) => {
  const base = req.protocol + "//" + (req.get("host") || "localhost");
  const specUrl = base + "/api/docs/openapi.json";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Siskel Bot API Docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:"${specUrl}",dom_id:"#swagger-ui",presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset]});</script>
</body></html>`);
});

// =====================================================================
// P0.1: Mount extracted route modules
// =====================================================================
const routeDeps = {
  apiRoute, apiError, deprecationApi,
  userAuth, adminAuth, adminIpAllowlist, chatAuth, apiKeyAuth, evalAuth, backupAdminAuth,
  requireScope, logRequest,
  chatRateLimiter, perKeyChatRateLimiter, integrationRateLimiter,
  knowledgeIndexRateLimiter, embeddingsRateLimiter,
  storageRateLimiter, multimodalRateLimiter,
  pluginsActionsRateLimiter, marketplaceRateLimiter,
  webhooksRateLimiter, webhooksHandlers,
  executeStepRateLimiter, evalRateLimiter,
  taskPlanRateLimiter, workspaceRateLimiter,
  BACKEND, OPENAI_API_KEY, MODEL_PRESETS, API_KEY, IS_PRODUCTION,
  STREAM_AGENT_FINAL, STREAM_SWARM_SYNTH,
  MAX_AGENT_TOOL_CALLS_ENV, AGENT_MAX_WALL_MS_ENV, AGENT_STREAM_CHUNK_SIZE,
  ALLOW_RECIPE_STEP_EXECUTION, ENABLE_AGENT_SWARM,
  AB_ROUTING_ENABLED, MODEL_ROUTING_CONFIG,
  USAGE_ALERT_TOKENS, KNOWLEDGE_MAX_DOC_BYTES,
  GITHUB_TOKEN, VERCEL_TOKEN, GITHUB_API_BASE, VERCEL_API_BASE,
  buildProxyConfig, backendFetch, setQuotaHeaders,
  sanitizeWorkspace, oauthCallback, passport, oauthProviders,
  runHealthChecks,
  healthCache: () => _healthCache,
  setHealthCache: (v) => { _healthCache = v; },
  HEALTH_CACHE_TTL_MS,
  metricsEnabled, metricsAuth: metricsAuthFn, METRICS_PATH, renderPrometheus,
  isMonitoringEnabled, isAuthConfigured,
  validateOwnerRepo, requireGitHubToken, requireVercelToken,
  monitoringState: () => monitoringState, runMonitoringChecks,
  isQuotaConfigured, checkQuota, getWorkspaceQuota, getWorkspaceTokensUsed,
  getQuotaOverrides, setWorkspaceQuotaOverride, isQuotaAdmin,
  estimate, recordUsage, getSummary, getTotalTokensInWindow, getRecordsForPeriod,
  getDashboard, exportToCsv, exportToJson,
  recordChatRequest, recordTokensUsed,
  resolveAgentMaxIterations, runSwarm, runSwarmLegacy,
  intersectClientToolsWithAllowlist, getToolsSchema,
  getSwarmSelectableSpecialistNames, getSwarmSpecialistsAllowlistNames,
  intersectSwarmSpecialistsWithAllowlist,
  runAgentLoop, resumeAgentLoopFromHitlToken, takeHitlState, pipeLlmChatStreamToSse,
  selectBackend, logRouting,
  TASK_PLAN_SYSTEM_PROMPT, extractTaskJsonFromResponse, validateTaskPlan,
  emitEvent, listWebhooks, addWebhook, removeWebhook, validateWebhookUrl,
  createToken, getOnlineUsers, getEventsSince,
  listNotifications, markNotificationRead, markAllNotificationsRead,
  storage, scheduleStore, schedulerRefresh, runRecipeNow, runDueJobsVercel,
  logActivity, idempotencyLookup, idempotencyStore,
  embeddingsAvailable, embed, embedBatch,
  indexDocument, indexDocumentFromBuffer,
  knowledgeSearch, knowledgeSemanticSearch, knowledgeList,
  reindexKnowledgeEmbeddingsInWorkspace, fetchTextFromAllowedUrl,
  exportWorkspaceBundle, deleteWorkspaceForUser,
  loadWorkspaceAgentSettings, saveWorkspaceAgentSettings,
  getWorkspaceAgentAccess, canEditWorkspaceAgentSettings, resolveStorageUserId,
  getWorkspaceChunkingConfig, setWorkspaceChunkingConfig,
  canAccessWorkspace, createInviteCode, joinByInviteCode,
  getWorkspaceMembers, getWorkspaceActivity,
  storeMemory, getMemories, searchMemories,
  updateAgentMemory, deleteAgentMemory, extractPotentialMemories,
  exportWorkspaceMigration, importWorkspaceMigration, validateBundle, diffWorkspaces,
  createTemplate, listTemplates, getTemplate, updateTemplate, deleteTemplate, applyTemplate,
  getRegisteredActions, listJsPlugins, execJsPlugin,
  marketplaceListAvailable, marketplaceRegistry,
  marketplaceInstallPack, marketplaceUninstallPack, marketplaceListInstalled,
  createBackup, listBackups, restoreBackup,
  branchConversation, getConversationTree,
  listConversationBranches, getConversationBranch, deleteConversationBranch,
  executeStep, appendAuditLog, validateAutomationRecipe,
  trajectoryApiEnabled, loadTrajectory, listTrajectories,
  listRecordedTraces, getRecordedTrace, recordTrace, replayTrace, deleteRecordedTrace,
  autoRecordEnabled, listEvalSets, loadEvalSet, runEvalSet, listStagingTraceSummaries,
  reportError,
  listAllUsers, listAllWorkspaces, getRecentAuditLog,
  listKeysForAdmin, addKey, revokeKey,
  archiveExecutionAuditToS3, getAuditArchiveStatus,
  AuditLifecycle, queryAudit, exportAudit,
  getRoutingStats, getRegionHealth, getLeaderElection, getReplicationManager, internalAuth,
  getMetricsSummary, getAgentRunSummarySnapshot,
  obsGetLatencyPercentiles, obsGetErrorRates, obsGetAgentStats, obsGetTokenUsageByWorkspace,
  toolValidationEnabled, stagnationDetectionEnabled,
  defaultAgentSystemConfigured, getAgentToolsAllowlistNames,
  getTrustedMarketplaceKeyIds, listInstalledMarketplaceSummary,
  listRbacRoles, createCustomRole, updateCustomRole, deleteCustomRole, assignRole,
  getAvailableRegions, setDataResidency, getDataResidency,
  generateComplianceReport, getRetentionPolicy, setRetentionPolicy, scanTextForPII,
  registerPeer, removePeer, listPeers,
  discoverFederatedWorkspaces, syncWorkspaceMetadata,
  handleDiscoverRequest, getInstanceInfo, federationAuth,
};

mountAuthRoutes(app, routeDeps);
mountHealthRoutes(app, routeDeps);
mountChatRoutes(app, routeDeps);
mountKnowledgeRoutes(app, routeDeps);
mountWorkspaceRoutes(app, routeDeps);
mountConversationRoutes(app, routeDeps);
mountContextRoutes(app, routeDeps);
mountRecipeRoutes(app, routeDeps);
mountBackupRoutes(app, routeDeps);
mountPluginRoutes(app, routeDeps);
mountWebhookRoutes(app, routeDeps);
mountExecuteRoutes(app, routeDeps);
mountEvalRoutes(app, routeDeps);
mountIntegrationRoutes(app, routeDeps);
mountAdminRoutes(app, routeDeps);
mountFederationRoutes(app, routeDeps);

const STATIC_CACHE_MAX_AGE_MS =
  process.env.STATIC_CACHE_MAX_AGE === "0"
    ? 0
    : Number(process.env.STATIC_CACHE_MAX_AGE_MS) || (IS_PRODUCTION ? 86_400_000 : 0);

// Serve hashed client/dist/ assets with immutable cache headers (P0.3 code-splitting)
app.use(
  "/dist",
  express.static(join(__dirname, "client", "dist"), {
    maxAge: 31_536_000_000, // 1 year
    immutable: true,
    etag: true,
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }),
);

// Load the client build manifest (maps entry names to hashed filenames).
// Falls back gracefully when client/dist/ has not been built.
let _clientManifest = null;
try {
  _clientManifest = JSON.parse(readFileSync(join(__dirname, "client", "dist", "manifest.json"), "utf8"));
  console.log("[static] Client build manifest loaded:", Object.keys(_clientManifest).join(", "));
} catch {
  _clientManifest = null;
  console.log("[static] No client build manifest found — serving inline JS fallback.");
}

// P0.3: When build manifest exists, serve HTML pages with external JS modules
// instead of the large inline <script> blocks. Falls back to inline JS when no build.
const HTML_ENTRY_MAP = { "/": "chat", "/index.html": "chat", "/admin.html": "admin", "/eval.html": "eval", "/marketplace.html": "marketplace" };
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const entry = HTML_ENTRY_MAP[req.path];
  if (!entry || !_clientManifest || !_clientManifest[entry]) return next();

  const htmlFile = entry === "chat" ? "index.html" : `${entry}.html`;
  const filePath = join(__dirname, "client", htmlFile);
  let html;
  try {
    html = readFileSync(filePath, "utf8");
  } catch {
    return next();
  }

  const moduleUrl = `/dist/${_clientManifest[entry]}`;
  const lastInlineIdx = html.lastIndexOf("\n  <script>\n");
  const bodyCloseIdx = html.lastIndexOf("</body>");
  if (lastInlineIdx !== -1 && bodyCloseIdx !== -1 && lastInlineIdx < bodyCloseIdx) {
    html = html.slice(0, lastInlineIdx) +
      `\n  <script type="module" src="${moduleUrl}"></script>\n` +
      html.slice(bodyCloseIdx);
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html);
});

app.use(
  express.static(join(__dirname, "client"), {
    maxAge: STATIC_CACHE_MAX_AGE_MS,
    etag: true,
    setHeaders(res, filePath) {
      const norm = filePath.replace(/\\/g, "/");
      if (/(^|\/)index\.html$/i.test(norm) || /(^|\/)admin\.html$/i.test(norm) || /(^|\/)eval\.html$/i.test(norm) || /(^|\/)observability\.html$/i.test(norm)) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  }),
);

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
