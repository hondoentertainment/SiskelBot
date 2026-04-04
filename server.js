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
import { agentSessionApiEnabled } from "./lib/agent-session.js";
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
import { mountAgentSessionRoutes } from "./routes/agent-sessions.js";
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

// GitHub/Vercel proxy routes live in routes/integrations.js (mountIntegrationRoutes).

// --- Phase 5–21: knowledge, workspaces, context, recipes, backup, conversations, plugins, webhooks, execute, multimodal ---
// Handlers live under routes/*.js and are mounted near the end of this file.

// --- Phase 6: recipe validation (shared by mountExecuteRoutes /automations/validate) ---
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
  readRateLimiter, storageRateLimiter, multimodalRateLimiter,
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
  loadWorkspaceAgentSettings, saveWorkspaceAgentSettings, getWorkspaceMemoryStats,
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
  agentSessionApiEnabled,
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
  installMarketplacePack, listInstalledMarketplacePacks, setMarketplacePackEnabled,
  getWorkspaceMarketplacePolicy, saveWorkspaceMarketplacePolicy,
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
mountAgentSessionRoutes(app, routeDeps);
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
