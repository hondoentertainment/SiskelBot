/**
 * Phase 40 / Phase 36: Prometheus metrics export.
 * Request counts, latency histograms, circuit breaker state, swarm metrics.
 * Phase 36: http_requests_total, http_request_duration_seconds, siskelbot_chat_requests_total,
 * siskelbot_tokens_used_total, siskelbot_active_connections, process metrics.
 * Phase 69: Optional OpenMetrics exemplars on histograms (trace link) when OTEL_PROMETHEUS_EXEMPLARS=1.
 */
import { trace } from "@opentelemetry/api";
import { isOpen } from "./circuit-breaker.js";
import { getCacheStats as getEmbeddingCacheStats } from "./embedding-cache.js";
import { getActiveConnectionCount } from "./realtime.js";
import { getModelCost } from "./smart-router.js";

function isMetricsEnabled() {
  return process.env.ENABLE_METRICS === "1";
}

// Counters: method_path_status -> count
const requestCounts = new Map();
// Latency buckets in ms: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
// Phase 36: buckets in seconds for http_request_duration_seconds
const BUCKETS_SEC = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const latencyBuckets = new Map(); // bucket_ms -> count per path
const latencyTotals = new Map(); // path -> { sumMs, count }
// Phase 36: method+path for histogram labels
const latencyByMethodPath = new Map(); // "{method}_{path}" -> { sumSec, count, bucketCounts }
// Swarm
let swarmInvocations = 0;
let swarmSpecialistSuccess = 0;
let swarmSpecialistFailure = 0;
// Phase 105: agent run wall-time breakdown (Prometheus counters; derive rates in PromQL)
/** @type {Map<string, { sumMs: number, count: number }>} key = mode\x00phase */
const agentPhaseMs = new Map();
/** @type {Map<string, number>} key = mode\x00stopReason */
const agentRunTotal = new Map();
// Phase 36: chat requests and tokens (from usage-tracker integration)
let chatRequestsTotal = 0;
let tokensUsedTotal = 0;
// Per-workspace, per-model, per-direction token counters.
// Key: workspaceId\x00model\x00direction (input|output)
// Note: workspace IDs in metric labels can be a cardinality risk. The
// METRICS_WORKSPACE_LABEL=1 env var (default off) controls whether the
// real workspace id is emitted; when off, all rows are aggregated under
// workspace="aggregated" to keep cardinality bounded.
const tokensByWorkspace = new Map();
// Per-workspace cost in micro-USD (avoids float drift; divide by 1e6 for display).
const costMicroByWorkspace = new Map();
// Cardinality cap: drop new workspaces silently after the limit and log once.
const TOKENS_BY_WORKSPACE_MAX = 1000;
let tokensByWorkspaceLimitWarned = false;
// Tool timeout counter: toolName -> count
const toolTimeoutCounts = new Map();
// Phase 9: transient retry attempts (after first failure) per tool name
const toolRetryCounts = new Map();
// Agent policy denials: code -> count (e.g. POLICY_TOOL_DENIED)
const agentPolicyDenialCounts = new Map();
// Per-tool cooldown starts: tool\x00reason -> count
const toolCooldownStartCounts = new Map();
// Phase 32.1: reflection loop counters (total runs, runs that produced a revision, duration sum)
let agentReflectionTotal = 0;
let agentReflectionRevisedTotal = 0;
let agentReflectionDurationMsSum = 0;
// Agent quality metrics: failure categories, tool outcomes, swarm conflicts
/** @type {Map<string, number>} key = tool\x00category */
const agentToolFailureCounts = new Map();
/** @type {Map<string, number>} key = tool\x00outcome (success|failure) */
const agentToolOutcomeCounts = new Map();
/** @type {Map<string, number>} key = conflict type (polarity|numeric|divergent|partial) */
const swarmConflictCounts = new Map();
// Phase 35.3: SSE streaming metrics (zero-copy SSE, buffer pooling)
let sseBytesWrittenTotal = 0;
let sseWritesTotal = 0;
let sseBatchesTotal = 0;
let sseWriteDurationMsSum = 0;
// Phase 35.2: embedding cache counters live in lib/embedding-cache.js
// (single source of truth, exposed via getCacheStats()).
// Phase 37.2: per-endpoint bandwidth (bytes sent by the server)
const bandwidthBytesByMethodPath = new Map(); // key = "{method}\x00{path}" -> bytes
// Realtime channel observability: slow-subscriber drops and subscriber errors.
// Keyed by a category label (typically the channel prefix, e.g. "chat", "run",
// "presence"). Always recorded regardless of ENABLE_METRICS so operators can
// inspect via getRealtimeBackpressureCounters() even outside Prometheus.
const realtimeBackpressureCounts = new Map(); // label -> count
const realtimeSubscriberErrorCounts = new Map(); // label -> count
// Wave 17B: moderation blocks by category and direction (input|output)
const moderationBlockCounts = new Map(); // "{category}\x00{direction}" -> count

// RAG quality metrics
// precision@k: key = k label ("1"|"3"|"5") -> { sum, count }
const ragPrecisionAtK = new Map();
// MRR: { sum, count }
let ragMrrSum = 0;
let ragMrrCount = 0;
// Retrieval duration: { sumSec, count, bucketCounts }
const RAG_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
let ragDurationSumSec = 0;
let ragDurationCount = 0;
const ragDurationBuckets = {};
for (const b of RAG_DURATION_BUCKETS) ragDurationBuckets[b] = 0;
// Chunks retrieved counter: key = workspace_id label -> count
const ragChunksRetrievedByWorkspace = new Map();

function getBackends() {
  return ["ollama", "vllm", "openai"];
}

const MP_SEP = "\x00"; // separator for method|path in latencyByMethodPath keys

/** @type {Map<string, { traceId: string, val: number, ts: number }>} */
const histogramExemplarsByMethodPath = new Map();
const EXEMPLAR_MAP_MAX = 64;

function maybeRecordHistogramExemplar(mpKey, durationSec) {
  if (process.env.ENABLE_METRICS !== "1") return;
  if (process.env.OTEL_PROMETHEUS_EXEMPLARS !== "1") return;
  if (process.env.OTEL_ENABLED !== "1") return;
  try {
    const span = trace.getActiveSpan();
    const sc = span?.spanContext();
    const tid = sc?.traceId;
    if (!tid || tid === "00000000000000000000000000000000") return;
    histogramExemplarsByMethodPath.set(mpKey, {
      traceId: tid,
      val: durationSec,
      ts: Date.now() / 1000,
    });
    while (histogramExemplarsByMethodPath.size > EXEMPLAR_MAP_MAX) {
      const first = histogramExemplarsByMethodPath.keys().next().value;
      histogramExemplarsByMethodPath.delete(first);
    }
  } catch (_) {}
}

function exemplarSuffix(mpKey) {
  if (process.env.OTEL_PROMETHEUS_EXEMPLARS !== "1") return "";
  const ex = histogramExemplarsByMethodPath.get(mpKey);
  if (!ex) return "";
  return ` # {trace_id="${ex.traceId}"} ${Number(ex.val).toFixed(6)} ${ex.ts.toFixed(3)}`;
}

function safeLabel(s) {
  return String(s || "unknown").replace(/[^a-zA-Z0-9_:]/g, "_").slice(0, 64);
}

/**
 * Record an HTTP request for metrics.
 * @param {string} method - HTTP method
 * @param {string} path - Normalized path (e.g. /v1/chat/completions)
 * @param {number} status - Response status
 * @param {number} durationMs - Request duration in ms
 */
export function recordRequest(method, path, status, durationMs) {
  if (!isMetricsEnabled()) return;

  const pathLabel = path?.replace(/^\/+/, "") || "root";
  const key = JSON.stringify({ m: method, p: pathLabel, s: status });
  requestCounts.set(key, (requestCounts.get(key) || 0) + 1);

  const pathKey = (path?.replace(/^\/+/, "") || "root").replace(/[^a-zA-Z0-9_:]/g, "_").slice(0, 64);
  let tot = latencyTotals.get(pathKey);
  if (!tot) tot = { sumMs: 0, count: 0 };
  tot.sumMs += durationMs;
  tot.count += 1;
  latencyTotals.set(pathKey, tot);

  for (const b of BUCKETS_MS) {
    if (durationMs <= b) {
      const bk = `${pathKey}_${b}`;
      latencyBuckets.set(bk, (latencyBuckets.get(bk) || 0) + 1);
      break;
    }
  }

  // Phase 36: http_request_duration_seconds{method, path}
  const durationSec = durationMs / 1000;
  const methodLabel = safeLabel(method);
  const mpKey = `${methodLabel}${MP_SEP}${pathKey}`;
  let mpTot = latencyByMethodPath.get(mpKey);
  if (!mpTot) mpTot = { sumSec: 0, count: 0, buckets: {} };
  mpTot.sumSec += durationSec;
  mpTot.count += 1;
  for (const b of BUCKETS_SEC) {
    if (durationSec <= b) {
      mpTot.buckets[b] = (mpTot.buckets[b] || 0) + 1;
      break;
    }
  }
  latencyByMethodPath.set(mpKey, mpTot);
  maybeRecordHistogramExemplar(mpKey, durationSec);
}

/**
 * Phase 36: Record a chat completion request (increments siskelbot_chat_requests_total).
 */
export function recordChatRequest() {
  if (!isMetricsEnabled()) return;
  chatRequestsTotal++;
}

/**
 * Phase 36: Record tokens used (from usage-tracker); increments siskelbot_tokens_used_total.
 * @param {number} inputTokens
 * @param {number} outputTokens
 */
export function recordTokensUsed(inputTokens, outputTokens) {
  if (!isMetricsEnabled()) return;
  tokensUsedTotal += (Number(inputTokens) || 0) + (Number(outputTokens) || 0);
}

/**
 * Resolve the workspace label used in metric output. When
 * METRICS_WORKSPACE_LABEL is unset/0 we collapse everything to
 * "aggregated" so high-cardinality tenants don't blow up Prometheus.
 * @param {string} workspaceId
 * @returns {string}
 */
function resolveWorkspaceLabel(workspaceId) {
  if (process.env.METRICS_WORKSPACE_LABEL !== "1") return "aggregated";
  return safeLabel(workspaceId || "anonymous");
}

/**
 * Compute cost in micro-USD (1e-6 USD per unit) for a model + token counts.
 * MODEL_COSTS (parsed by smart-router) is "cost per 1K tokens"; we treat
 * input and output identically since smart-router has only one figure.
 * Returns 0 for unknown models so token counters still record.
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number}
 */
function computeCostMicros(model, inputTokens, outputTokens) {
  const costPer1k = Number(getModelCost(model)) || 0;
  if (costPer1k <= 0) return 0;
  const totalTokens =
    Math.max(0, Number(inputTokens) || 0) +
    Math.max(0, Number(outputTokens) || 0);
  if (totalTokens <= 0) return 0;
  // costPer1k is USD per 1K tokens; cost in USD = (tokens/1000) * costPer1k.
  // Convert to micro-USD by multiplying by 1e6, so:
  //   micros = (tokens / 1000) * costPer1k * 1e6 = tokens * costPer1k * 1000
  return Math.round(totalTokens * costPer1k * 1000);
}

/**
 * Record per-workspace LLM token + cost usage. Called once per chat
 * completion response (after the LLM returns a usage block). Tokens are
 * tracked separately for input/output; cost is summed across both.
 *
 * Cardinality is bounded by TOKENS_BY_WORKSPACE_MAX; new workspaces past
 * that cap are silently dropped (with one warning log) so labels can't
 * grow unbounded. METRICS_WORKSPACE_LABEL controls whether the workspace
 * label is the real id or "aggregated".
 *
 * @param {{
 *   workspaceId?: string,
 *   model?: string,
 *   inputTokens?: number,
 *   outputTokens?: number,
 * }} args
 */
export function recordLlmUsage(args) {
  if (!isMetricsEnabled()) return;
  const ws = String(args?.workspaceId || "anonymous");
  const m = String(args?.model || "unknown");
  const inputTokens = Math.max(0, Number(args?.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(args?.outputTokens) || 0);

  const label = resolveWorkspaceLabel(ws);
  const safeModel = safeLabel(m);

  const inputKey = `${label}\x00${safeModel}\x00input`;
  const outputKey = `${label}\x00${safeModel}\x00output`;

  // Cardinality cap: only refuse to add brand-new keys once at limit;
  // existing keys are still updated.
  const wouldAdd =
    (inputTokens > 0 && !tokensByWorkspace.has(inputKey)) ||
    (outputTokens > 0 && !tokensByWorkspace.has(outputKey));
  if (wouldAdd && tokensByWorkspace.size >= TOKENS_BY_WORKSPACE_MAX) {
    if (!tokensByWorkspaceLimitWarned) {
      tokensByWorkspaceLimitWarned = true;
      console.warn(
        JSON.stringify({
          event: "metrics_workspace_label_cap_reached",
          limit: TOKENS_BY_WORKSPACE_MAX,
          message:
            "tokens_by_workspace cardinality cap hit; dropping new workspaces",
        })
      );
    }
    return;
  }

  if (inputTokens > 0) {
    tokensByWorkspace.set(
      inputKey,
      (tokensByWorkspace.get(inputKey) || 0) + inputTokens
    );
  }
  if (outputTokens > 0) {
    tokensByWorkspace.set(
      outputKey,
      (tokensByWorkspace.get(outputKey) || 0) + outputTokens
    );
  }

  const costMicros = computeCostMicros(m, inputTokens, outputTokens);
  if (costMicros > 0) {
    costMicroByWorkspace.set(
      label,
      (costMicroByWorkspace.get(label) || 0) + costMicros
    );
  }
}

/**
 * Test helper: reset the per-workspace LLM usage state.
 */
export function __resetLlmUsageMetricsForTests() {
  tokensByWorkspace.clear();
  costMicroByWorkspace.clear();
  tokensByWorkspaceLimitWarned = false;
}

/**
 * Record swarm invocation.
 * @param {number} specialistCount
 * @param {number} successCount
 * @param {number} durationMs
 */
export function recordSwarm(specialistCount, successCount, _durationMs) {
  if (!isMetricsEnabled()) return;
  swarmInvocations++;
  swarmSpecialistSuccess += successCount;
  swarmSpecialistFailure += specialistCount - successCount;
}

/**
 * Phase 105: Record milliseconds spent in one agent/swarm phase (llm, tools, reflect, synthesis, specialists_wall).
 * @param {string} mode - e.g. single | swarm
 * @param {string} phase - llm | tools | reflect | synthesis | specialists_wall
 * @param {number} durationMs
 */
export function recordAgentPhaseMs(mode, phase, durationMs) {
  if (!isMetricsEnabled()) return;
  const ms = Math.max(0, Number(durationMs) || 0);
  if (ms <= 0) return;
  const key = `${safeLabel(mode)}${MP_SEP}${safeLabel(phase)}`;
  let row = agentPhaseMs.get(key);
  if (!row) row = { sumMs: 0, count: 0 };
  row.sumMs += ms;
  row.count += 1;
  agentPhaseMs.set(key, row);
}

/**
 * Phase 105: Count completed agent or swarm runs by terminal stopReason (or complete).
 * @param {string} mode
 * @param {string} stopReason
 */
export function recordAgentRunSummary(mode, stopReason) {
  if (!isMetricsEnabled()) return;
  const key = `${safeLabel(mode)}${MP_SEP}${safeLabel(stopReason || "unknown")}`;
  agentRunTotal.set(key, (agentRunTotal.get(key) || 0) + 1);
}

/**
 * Record a tool timeout event.
 * @param {string} toolName
 */
export function recordToolTimeout(toolName) {
  if (!isMetricsEnabled()) return;
  const label = safeLabel(toolName);
  toolTimeoutCounts.set(label, (toolTimeoutCounts.get(label) || 0) + 1);
}

/**
 * Record a classified tool failure (from lib/agent-tool-failure-analyzer).
 * Increments siskelbot_agent_tool_failure_total{tool, category}.
 * @param {string} toolName
 * @param {string} category
 */
export function recordToolFailure(toolName, category) {
  if (!isMetricsEnabled()) return;
  const key = `${safeLabel(toolName)}\x00${safeLabel(category)}`;
  agentToolFailureCounts.set(key, (agentToolFailureCounts.get(key) || 0) + 1);
}

/**
 * Record a tool call outcome (success or failure). Used for per-tool reliability.
 * Increments siskelbot_agent_tool_outcome_total{tool, outcome}.
 * @param {string} toolName
 * @param {boolean} ok
 */
export function recordToolOutcome(toolName, ok) {
  if (!isMetricsEnabled()) return;
  const outcome = ok ? "success" : "failure";
  const key = `${safeLabel(toolName)}\x00${outcome}`;
  agentToolOutcomeCounts.set(key, (agentToolOutcomeCounts.get(key) || 0) + 1);
}

/**
 * Record a swarm conflict detection. Increments
 * siskelbot_swarm_conflict_total{type}.
 * @param {string} conflictType
 */
export function recordSwarmConflict(conflictType) {
  if (!isMetricsEnabled()) return;
  const key = safeLabel(conflictType);
  swarmConflictCounts.set(key, (swarmConflictCounts.get(key) || 0) + 1);
}

/**
 * Test helper: reset agent-quality counters.
 */
export function __resetAgentQualityMetricsForTests() {
  agentToolFailureCounts.clear();
  agentToolOutcomeCounts.clear();
  swarmConflictCounts.clear();
}

/**
 * Test helper: snapshot agent-quality counters as plain objects.
 */
export function __getAgentQualityMetricsForTests() {
  return {
    failures: Object.fromEntries(agentToolFailureCounts),
    outcomes: Object.fromEntries(agentToolOutcomeCounts),
    conflicts: Object.fromEntries(swarmConflictCounts),
  };
}

/**
 * Phase 32.1: Record a reflection pass. Tracks total reflections, how many
 * required a revision, and accumulated wall-time so averages can be derived.
 * @param {boolean} needsRevision
 * @param {number} durationMs
 */
export function recordReflection(needsRevision, durationMs) {
  if (!isMetricsEnabled()) return;
  agentReflectionTotal++;
  if (needsRevision) agentReflectionRevisedTotal++;
  const ms = Math.max(0, Number(durationMs) || 0);
  agentReflectionDurationMsSum += ms;
}

/**
 * Phase 35.3: Record an SSE write (bytes flushed to socket and time spent).
 * Increments siskelbot_sse_bytes_written_total and siskelbot_sse_writes_total.
 * @param {number} bytes
 * @param {number} durationMs
 */
export function recordSSEWrite(bytes, durationMs) {
  if (!isMetricsEnabled()) return;
  sseBytesWrittenTotal += Math.max(0, Number(bytes) || 0);
  sseWritesTotal += 1;
  sseWriteDurationMsSum += Math.max(0, Number(durationMs) || 0);
}

/**
 * Phase 35.3: Record that a batch was flushed to the socket
 * (a batch may include multiple logical SSE events).
 * Increments siskelbot_sse_batches_total.
 */
export function recordSSEBatch() {
  if (!isMetricsEnabled()) return;
  sseBatchesTotal += 1;
}

/**
 * Phase 37.2: Record bytes sent for a response. Used by the mobile
 * bandwidth-tracking middleware to expose per-endpoint bandwidth via
 * /metrics.
 * @param {string} method
 * @param {string} path
 * @param {number} bytes
 */
export function recordBandwidth(method, path, bytes) {
  if (!isMetricsEnabled()) return;
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const methodLabel = safeLabel(method);
  const pathLabel = (path?.replace(/^\/+/, "") || "root").replace(/[^a-zA-Z0-9_:]/g, "_").slice(0, 64);
  const key = `${methodLabel}${MP_SEP}${pathLabel}`;
  bandwidthBytesByMethodPath.set(key, (bandwidthBytesByMethodPath.get(key) || 0) + bytes);
}

/**
 * Snapshot of the bandwidth counters keyed by "{method} {path}".
 * Exposed primarily for tests.
 * @returns {Record<string, number>}
 */
export function getBandwidthSnapshot() {
  const out = {};
  for (const [key, bytes] of bandwidthBytesByMethodPath) {
    const sepIdx = key.indexOf(MP_SEP);
    const method = sepIdx >= 0 ? key.slice(0, sepIdx) : "unknown";
    const path = sepIdx >= 0 ? key.slice(sepIdx + 1) : key;
    out[`${method} ${path}`] = bytes;
  }
  return out;
}

/**
 * @param {string} code - e.g. POLICY_TOOL_DENIED, POLICY_CATEGORY_CAP
 */
export function recordPolicyDenial(code) {
  if (!isMetricsEnabled()) return;
  const label = safeLabel(code);
  agentPolicyDenialCounts.set(label, (agentPolicyDenialCounts.get(label) || 0) + 1);
}

/** @param {string} toolName */
export function recordToolRetry(toolName) {
  if (!isMetricsEnabled()) return;
  const label = safeLabel(toolName);
  toolRetryCounts.set(label, (toolRetryCounts.get(label) || 0) + 1);
}

/**
 * Record that a per-tool circuit-breaker cooldown was started for (tool, reason).
 * Increments siskelbot_tool_cooldown_active.
 * @param {string} toolName
 * @param {string} reason
 */
export function recordCooldownStart(toolName, reason) {
  if (!isMetricsEnabled()) return;
  const key = `${safeLabel(toolName)}\x00${safeLabel(reason)}`;
  toolCooldownStartCounts.set(key, (toolCooldownStartCounts.get(key) || 0) + 1);
}

/**
 * Record RAG precision@k values after a retrieval. Call once per search.
 * @param {{ p1: number, p3: number, p5: number }} precisions - values 0.0-1.0
 */
export function recordRagPrecision(precisions) {
  if (!isMetricsEnabled()) return;
  for (const [k, val] of [["1", precisions.p1], ["3", precisions.p3], ["5", precisions.p5]]) {
    const v = Number(val);
    if (!Number.isFinite(v)) continue;
    let row = ragPrecisionAtK.get(k);
    if (!row) row = { sum: 0, count: 0 };
    row.sum += v;
    row.count += 1;
    ragPrecisionAtK.set(k, row);
  }
}

/**
 * Record Mean Reciprocal Rank for a retrieval.
 * @param {number} mrr - 0.0-1.0 (0 if no relevant result found)
 */
export function recordRagMrr(mrr) {
  if (!isMetricsEnabled()) return;
  const v = Number(mrr);
  if (!Number.isFinite(v)) return;
  ragMrrSum += v;
  ragMrrCount += 1;
}

/**
 * Record retrieval duration for a knowledge search.
 * @param {number} durationMs
 */
export function recordRagRetrievalDuration(durationMs) {
  if (!isMetricsEnabled()) return;
  const sec = Math.max(0, Number(durationMs) || 0) / 1000;
  ragDurationSumSec += sec;
  ragDurationCount += 1;
  for (const b of RAG_DURATION_BUCKETS) {
    if (sec <= b) {
      ragDurationBuckets[b] = (ragDurationBuckets[b] || 0) + 1;
      break;
    }
  }
}

/**
 * Record the number of chunks retrieved for a workspace.
 * @param {string} workspaceId
 * @param {number} count
 */
export function recordRagChunksRetrieved(workspaceId, count) {
  if (!isMetricsEnabled()) return;
  const label = resolveWorkspaceLabel(workspaceId || "anonymous");
  ragChunksRetrievedByWorkspace.set(label, (ragChunksRetrievedByWorkspace.get(label) || 0) + Math.max(0, Number(count) || 0));
}

/**
 * Test helper: reset RAG quality metrics.
 */
export function __resetRagMetricsForTests() {
  ragPrecisionAtK.clear();
  ragMrrSum = 0;
  ragMrrCount = 0;
  ragDurationSumSec = 0;
  ragDurationCount = 0;
  for (const b of RAG_DURATION_BUCKETS) ragDurationBuckets[b] = 0;
  ragChunksRetrievedByWorkspace.clear();
}

/**
 * Test helper: snapshot RAG metrics as plain objects.
 */
export function __getRagMetricsForTests() {
  return {
    precisionAtK: Object.fromEntries([...ragPrecisionAtK].map(([k, v]) => [k, { ...v }])),
    mrr: { sum: ragMrrSum, count: ragMrrCount },
    duration: { sumSec: ragDurationSumSec, count: ragDurationCount },
    chunksRetrieved: Object.fromEntries(ragChunksRetrievedByWorkspace),
  };
}

/**
 * Wave 17B: Record a moderation block event.
 * Increments siskelbot_moderation_blocks_total{category, direction}.
 * @param {string} category - e.g. prompt_injection | jailbreak | pii_extraction | harmful_content
 * @param {string} direction - "input" | "output"
 */
export function recordModerationBlock(category, direction) {
  const key = `${safeLabel(category || "unknown")}\x00${safeLabel(direction || "unknown")}`;
  moderationBlockCounts.set(key, (moderationBlockCounts.get(key) || 0) + 1);
}

/**
 * Test helper: reset moderation block counters.
 */
export function __resetModerationBlocksForTests() {
  moderationBlockCounts.clear();
}

/**
 * Test helper: snapshot moderation block counters.
 * @returns {Record<string, number>}
 */
export function __getModerationBlocksForTests() {
  const out = {};
  for (const [key, count] of moderationBlockCounts) {
    const sep = key.indexOf("\x00");
    const category = sep >= 0 ? key.slice(0, sep) : key;
    const direction = sep >= 0 ? key.slice(sep + 1) : "unknown";
    out[`${category}/${direction}`] = count;
  }
  return out;
}

/**
 * Record a slow-subscriber drop against the realtime channel registry.
 * Always counted (independent of ENABLE_METRICS) so operators can inspect
 * the in-process snapshot via getRealtimeBackpressureCounters().
 * @param {string} category - typically the channel prefix (e.g. "chat", "run", "presence")
 */
export function incrementRealtimeBackpressure(category) {
  const label = safeLabel(category);
  realtimeBackpressureCounts.set(label, (realtimeBackpressureCounts.get(label) || 0) + 1);
}

/**
 * Record a subscriber-side error against the realtime channel registry.
 * @param {string} category - typically the channel prefix (e.g. "chat", "run", "presence")
 */
export function incrementRealtimeSubscriberError(category) {
  const label = safeLabel(category);
  realtimeSubscriberErrorCounts.set(label, (realtimeSubscriberErrorCounts.get(label) || 0) + 1);
}

/**
 * Snapshot the realtime backpressure and subscriber-error counters.
 * Exposed for tests and operator introspection.
 * @returns {{ backpressure: Record<string, number>, subscriberErrors: Record<string, number> }}
 */
export function getRealtimeBackpressureCounters() {
  const backpressure = {};
  for (const [k, v] of realtimeBackpressureCounts) backpressure[k] = v;
  const subscriberErrors = {};
  for (const [k, v] of realtimeSubscriberErrorCounts) subscriberErrors[k] = v;
  return { backpressure, subscriberErrors };
}

/**
 * Get circuit breaker state for metrics.
 */
function getCircuitState() {
  const out = {};
  for (const b of getBackends()) {
    const check = isOpen(b);
    out[b] = check.open ? 1 : 0;
  }
  return out;
}

/**
 * Render Prometheus text format.
 * Phase 36: http_requests_total, http_request_duration_seconds, siskelbot_* metrics.
 * @returns {string}
 */
export function renderPrometheus() {
  const lines = [];

  // Phase 36: http_requests_total{method, path, status}
  lines.push("# HELP http_requests_total Total HTTP requests");
  lines.push("# TYPE http_requests_total counter");
  for (const [key, count] of requestCounts) {
    let method = "unknown", path = "unknown", status = "unknown";
    try {
      const parsed = JSON.parse(key);
      method = safeLabel(parsed.m);
      path = safeLabel(parsed.p);
      status = String(parsed.s ?? "unknown");
    } catch (_) {}
    lines.push(`http_requests_total{method="${method}",path="${path}",status="${status}"} ${count}`);
  }

  // Phase 36: http_request_duration_seconds{method, path} (Prometheus convention: seconds)
  // Phase 69: optional exemplar on +Inf bucket (OpenMetrics; Prometheus 2.26+)
  lines.push("# HELP http_request_duration_seconds HTTP request duration in seconds");
  lines.push("# TYPE http_request_duration_seconds histogram");
  for (const [mpKey, mp] of latencyByMethodPath) {
    const sepIdx = mpKey.indexOf(MP_SEP);
    const method = sepIdx >= 0 ? mpKey.slice(0, sepIdx) : "unknown";
    const path = sepIdx >= 0 ? mpKey.slice(sepIdx + 1) : mpKey;
    let cum = 0;
    for (const b of BUCKETS_SEC) {
      cum += mp.buckets[b] || 0;
      lines.push(`http_request_duration_seconds_bucket{method="${method}",path="${path}",le="${b}"} ${cum}`);
    }
    const infLine = `http_request_duration_seconds_bucket{method="${method}",path="${path}",le="+Inf"} ${mp.count}`;
    lines.push(infLine + exemplarSuffix(mpKey));
    lines.push(`http_request_duration_seconds_sum{method="${method}",path="${path}"} ${mp.sumSec.toFixed(6)}`);
    lines.push(`http_request_duration_seconds_count{method="${method}",path="${path}"} ${mp.count}`);
  }

  // Phase 36: siskelbot_chat_requests_total
  lines.push("# HELP siskelbot_chat_requests_total Total chat completion requests");
  lines.push("# TYPE siskelbot_chat_requests_total counter");
  lines.push(`siskelbot_chat_requests_total ${chatRequestsTotal}`);

  // Phase 36: siskelbot_tokens_used_total (from usage-tracker integration)
  lines.push("# HELP siskelbot_tokens_used_total Total tokens used (input + output)");
  lines.push("# TYPE siskelbot_tokens_used_total counter");
  lines.push(`siskelbot_tokens_used_total ${tokensUsedTotal}`);

  // Per-workspace, per-model, per-direction token counters
  lines.push(
    "# HELP siskelbot_llm_tokens_total Tokens consumed by workspace, model, and direction"
  );
  lines.push("# TYPE siskelbot_llm_tokens_total counter");
  for (const [key, count] of tokensByWorkspace) {
    const firstSep = key.indexOf("\x00");
    const secondSep = key.indexOf("\x00", firstSep + 1);
    if (firstSep < 0 || secondSep < 0) continue;
    const workspace = key.slice(0, firstSep);
    const model = key.slice(firstSep + 1, secondSep);
    const direction = key.slice(secondSep + 1);
    lines.push(
      `siskelbot_llm_tokens_total{workspace="${workspace}",model="${model}",direction="${direction}"} ${count}`
    );
  }

  // Per-workspace cumulative LLM cost in USD (from MODEL_COSTS).
  lines.push(
    "# HELP siskelbot_llm_cost_usd_total Cumulative LLM cost in USD by workspace"
  );
  lines.push("# TYPE siskelbot_llm_cost_usd_total counter");
  for (const [workspace, micros] of costMicroByWorkspace) {
    const usd = micros / 1e6;
    lines.push(
      `siskelbot_llm_cost_usd_total{workspace="${workspace}"} ${usd.toFixed(6)}`
    );
  }

  // Phase 36: siskelbot_active_connections (WebSocket count)
  let connCount = 0;
  try {
    connCount = getActiveConnectionCount();
  } catch (_) {}
  lines.push("# HELP siskelbot_active_connections Active WebSocket connections");
  lines.push("# TYPE siskelbot_active_connections gauge");
  lines.push(`siskelbot_active_connections ${connCount}`);

  // Phase 36: process_cpu_seconds_total, process_resident_memory_bytes (optional)
  try {
    const cpu = process.cpuUsage();
    const cpuTotalSec = ((cpu.user + cpu.system) / 1e6).toFixed(6);
    lines.push("# HELP process_cpu_seconds_total Total user and system CPU time in seconds");
    lines.push("# TYPE process_cpu_seconds_total counter");
    lines.push(`process_cpu_seconds_total ${cpuTotalSec}`);
  } catch (_) {}
  try {
    const mem = process.memoryUsage();
    lines.push("# HELP process_resident_memory_bytes Resident memory in bytes");
    lines.push("# TYPE process_resident_memory_bytes gauge");
    lines.push(`process_resident_memory_bytes ${mem.rss}`);
  } catch (_) {}

  // Legacy: experimentagent_* for backward compatibility
  lines.push("# HELP experimentagent_http_requests_total Total HTTP requests (legacy)");
  lines.push("# TYPE experimentagent_http_requests_total counter");
  for (const [key, count] of requestCounts) {
    let method = "unknown", path = "unknown", status = "unknown";
    try {
      const parsed = JSON.parse(key);
      method = safeLabel(parsed.m);
      path = safeLabel(parsed.p);
      status = String(parsed.s ?? "unknown");
    } catch (_) {}
    lines.push(`experimentagent_http_requests_total{method="${method}",path="${path}",status="${status}"} ${count}`);
  }

  lines.push("# HELP experimentagent_http_request_duration_ms HTTP request duration in milliseconds (legacy)");
  lines.push("# TYPE experimentagent_http_request_duration_ms histogram");
  for (const [pathKey, tot] of latencyTotals) {
    const leCounts = {};
    for (const b of BUCKETS_MS) {
      const bk = `${pathKey}_${b}`;
      leCounts[b] = (leCounts[b] || 0) + (latencyBuckets.get(bk) || 0);
    }
    let cum = 0;
    for (const b of BUCKETS_MS) {
      cum += leCounts[b] || 0;
      lines.push(`experimentagent_http_request_duration_ms_bucket{path="${pathKey}",le="${b}"} ${cum}`);
    }
    lines.push(`experimentagent_http_request_duration_ms_bucket{path="${pathKey}",le="+Inf"} ${tot.count}`);
    lines.push(`experimentagent_http_request_duration_ms_sum{path="${pathKey}"} ${tot.sumMs}`);
    lines.push(`experimentagent_http_request_duration_ms_count{path="${pathKey}"} ${tot.count}`);
  }

  const circuit = getCircuitState();
  lines.push("# HELP experimentagent_circuit_breaker_open Circuit breaker open (1) or closed (0)");
  lines.push("# TYPE experimentagent_circuit_breaker_open gauge");
  for (const [backend, open] of Object.entries(circuit)) {
    lines.push(`experimentagent_circuit_breaker_open{backend="${backend}"} ${open}`);
  }

  lines.push("# HELP experimentagent_swarm_invocations_total Total swarm invocations");
  lines.push("# TYPE experimentagent_swarm_invocations_total counter");
  lines.push(`experimentagent_swarm_invocations_total ${swarmInvocations}`);

  lines.push("# HELP experimentagent_swarm_specialist_success_total Swarm specialist successes");
  lines.push("# TYPE experimentagent_swarm_specialist_success_total counter");
  lines.push(`experimentagent_swarm_specialist_success_total ${swarmSpecialistSuccess}`);

  lines.push("# HELP experimentagent_swarm_specialist_failure_total Swarm specialist failures");
  lines.push("# TYPE experimentagent_swarm_specialist_failure_total counter");
  lines.push(`experimentagent_swarm_specialist_failure_total ${swarmSpecialistFailure}`);

  // Phase 105: agent phase duration (sum/count for avg in PromQL: sum/count)
  lines.push("# HELP siskelbot_agent_phase_milliseconds_sum Sum of wall milliseconds per agent phase");
  lines.push("# TYPE siskelbot_agent_phase_milliseconds_sum counter");
  for (const [key, row] of agentPhaseMs) {
    const sepIdx = key.indexOf(MP_SEP);
    const mode = sepIdx >= 0 ? key.slice(0, sepIdx) : "unknown";
    const phase = sepIdx >= 0 ? key.slice(sepIdx + 1) : key;
    lines.push(`siskelbot_agent_phase_milliseconds_sum{mode="${mode}",phase="${phase}"} ${Math.round(row.sumMs)}`);
  }
  lines.push("# HELP siskelbot_agent_phase_samples_total Samples recorded per agent phase");
  lines.push("# TYPE siskelbot_agent_phase_samples_total counter");
  for (const [key, row] of agentPhaseMs) {
    const sepIdx = key.indexOf(MP_SEP);
    const mode = sepIdx >= 0 ? key.slice(0, sepIdx) : "unknown";
    const phase = sepIdx >= 0 ? key.slice(sepIdx + 1) : key;
    lines.push(`siskelbot_agent_phase_samples_total{mode="${mode}",phase="${phase}"} ${row.count}`);
  }
  lines.push("# HELP siskelbot_agent_runs_total Completed agent or swarm runs by mode and stop_reason");
  lines.push("# TYPE siskelbot_agent_runs_total counter");
  for (const [key, n] of agentRunTotal) {
    const sepIdx = key.indexOf(MP_SEP);
    const mode = sepIdx >= 0 ? key.slice(0, sepIdx) : "unknown";
    const stopReason = sepIdx >= 0 ? key.slice(sepIdx + 1) : key;
    lines.push(`siskelbot_agent_runs_total{mode="${mode}",stop_reason="${stopReason}"} ${n}`);
  }

  // Tool timeout counter
  lines.push("# HELP siskelbot_agent_tool_timeouts_total Tool calls that timed out by tool name");
  lines.push("# TYPE siskelbot_agent_tool_timeouts_total counter");
  for (const [toolName, count] of toolTimeoutCounts) {
    lines.push(`siskelbot_agent_tool_timeouts_total{tool="${toolName}"} ${count}`);
  }

  lines.push("# HELP siskelbot_agent_tool_retries_total Extra attempts after transient tool failure");
  lines.push("# TYPE siskelbot_agent_tool_retries_total counter");
  for (const [toolName, count] of toolRetryCounts) {
    lines.push(`siskelbot_agent_tool_retries_total{tool="${toolName}"} ${count}`);
  }

  lines.push("# HELP siskelbot_agent_policy_denials_total Agent tool calls blocked by policy");
  lines.push("# TYPE siskelbot_agent_policy_denials_total counter");
  for (const [policyCode, count] of agentPolicyDenialCounts) {
    lines.push(`siskelbot_agent_policy_denials_total{code="${policyCode}"} ${count}`);
  }

  // Per-tool circuit-breaker cooldowns started
  lines.push("# HELP siskelbot_tool_cooldown_active Per-tool cooldown activations by tool and reason");
  lines.push("# TYPE siskelbot_tool_cooldown_active counter");
  for (const [key, count] of toolCooldownStartCounts) {
    const sep = key.indexOf("\x00");
    const tool = sep >= 0 ? key.slice(0, sep) : key;
    const reason = sep >= 0 ? key.slice(sep + 1) : "unknown";
    lines.push(`siskelbot_tool_cooldown_active{tool="${tool}",reason="${reason}"} ${count}`);
  }

  // Phase 32.1: reflection loop metrics
  lines.push("# HELP siskelbot_agent_reflection_total Total agent reflection passes executed");
  lines.push("# TYPE siskelbot_agent_reflection_total counter");
  lines.push(`siskelbot_agent_reflection_total ${agentReflectionTotal}`);
  lines.push("# HELP siskelbot_agent_reflection_revised_total Agent reflection passes that produced a revision");
  lines.push("# TYPE siskelbot_agent_reflection_revised_total counter");
  lines.push(`siskelbot_agent_reflection_revised_total ${agentReflectionRevisedTotal}`);
  lines.push("# HELP siskelbot_agent_reflection_duration_milliseconds_sum Cumulative reflection wall milliseconds");
  lines.push("# TYPE siskelbot_agent_reflection_duration_milliseconds_sum counter");
  lines.push(`siskelbot_agent_reflection_duration_milliseconds_sum ${Math.round(agentReflectionDurationMsSum)}`);

  // Phase 35.2: embedding cache metrics (single source of truth: lib/embedding-cache.js)
  let embedStats = { hits: 0, misses: 0, evictions: { lru: 0, ttl: 0, manual: 0 }, size: 0 };
  try {
    embedStats = getEmbeddingCacheStats();
  } catch (_) {}
  lines.push("# HELP siskelbot_embedding_cache_hits_total Embedding cache hits");
  lines.push("# TYPE siskelbot_embedding_cache_hits_total counter");
  lines.push(`siskelbot_embedding_cache_hits_total ${embedStats.hits}`);
  lines.push("# HELP siskelbot_embedding_cache_misses_total Embedding cache misses");
  lines.push("# TYPE siskelbot_embedding_cache_misses_total counter");
  lines.push(`siskelbot_embedding_cache_misses_total ${embedStats.misses}`);
  lines.push("# HELP siskelbot_embedding_cache_evictions_total Embedding cache evictions");
  lines.push("# TYPE siskelbot_embedding_cache_evictions_total counter");
  lines.push(`siskelbot_embedding_cache_evictions_total{reason="lru"} ${embedStats.evictions.lru}`);
  lines.push(`siskelbot_embedding_cache_evictions_total{reason="ttl"} ${embedStats.evictions.ttl}`);
  lines.push(`siskelbot_embedding_cache_evictions_total{reason="manual"} ${embedStats.evictions.manual}`);
  lines.push("# HELP siskelbot_embedding_cache_size Current entries in embedding cache");
  lines.push("# TYPE siskelbot_embedding_cache_size gauge");
  lines.push(`siskelbot_embedding_cache_size ${embedStats.size}`);

  // Phase 37.2: per-endpoint bandwidth
  lines.push("# HELP siskelbot_http_response_bytes_total Total bytes sent per endpoint");
  lines.push("# TYPE siskelbot_http_response_bytes_total counter");
  for (const [key, bytes] of bandwidthBytesByMethodPath) {
    const sepIdx = key.indexOf(MP_SEP);
    const method = sepIdx >= 0 ? key.slice(0, sepIdx) : "unknown";
    const path = sepIdx >= 0 ? key.slice(sepIdx + 1) : key;
    lines.push(`siskelbot_http_response_bytes_total{method="${method}",path="${path}"} ${bytes}`);
  }

  // Phase 35.3: SSE streaming metrics
  lines.push("# HELP siskelbot_sse_bytes_written_total Total bytes flushed to SSE clients");
  lines.push("# TYPE siskelbot_sse_bytes_written_total counter");
  lines.push(`siskelbot_sse_bytes_written_total ${sseBytesWrittenTotal}`);
  lines.push("# HELP siskelbot_sse_writes_total Total SSE write syscalls");
  lines.push("# TYPE siskelbot_sse_writes_total counter");
  lines.push(`siskelbot_sse_writes_total ${sseWritesTotal}`);
  lines.push("# HELP siskelbot_sse_batches_total Total SSE batches flushed");
  lines.push("# TYPE siskelbot_sse_batches_total counter");
  lines.push(`siskelbot_sse_batches_total ${sseBatchesTotal}`);
  lines.push("# HELP siskelbot_sse_write_duration_milliseconds_sum Cumulative SSE write wall milliseconds");
  lines.push("# TYPE siskelbot_sse_write_duration_milliseconds_sum counter");
  lines.push(`siskelbot_sse_write_duration_milliseconds_sum ${Math.round(sseWriteDurationMsSum)}`);

  // Agent quality: tool failure categories
  lines.push("# HELP siskelbot_agent_tool_failure_total Classified agent tool failures by tool and category");
  lines.push("# TYPE siskelbot_agent_tool_failure_total counter");
  for (const [key, count] of agentToolFailureCounts) {
    const sep = key.indexOf("\x00");
    const tool = sep >= 0 ? key.slice(0, sep) : key;
    const category = sep >= 0 ? key.slice(sep + 1) : "unknown";
    lines.push(`siskelbot_agent_tool_failure_total{tool="${tool}",category="${category}"} ${count}`);
  }

  // Agent quality: per-tool outcome totals (success vs failure)
  lines.push("# HELP siskelbot_agent_tool_outcome_total Agent tool call outcomes by tool and outcome");
  lines.push("# TYPE siskelbot_agent_tool_outcome_total counter");
  for (const [key, count] of agentToolOutcomeCounts) {
    const sep = key.indexOf("\x00");
    const tool = sep >= 0 ? key.slice(0, sep) : key;
    const outcome = sep >= 0 ? key.slice(sep + 1) : "unknown";
    lines.push(`siskelbot_agent_tool_outcome_total{tool="${tool}",outcome="${outcome}"} ${count}`);
  }

  // Agent quality: swarm conflict detections
  lines.push("# HELP siskelbot_swarm_conflict_total Detected swarm specialist disagreements by type");
  lines.push("# TYPE siskelbot_swarm_conflict_total counter");
  for (const [type, count] of swarmConflictCounts) {
    lines.push(`siskelbot_swarm_conflict_total{type="${type}"} ${count}`);
  }

  // Wave 17B: content moderation blocks
  lines.push("# HELP siskelbot_moderation_blocks_total Content policy blocks by category and direction");
  lines.push("# TYPE siskelbot_moderation_blocks_total counter");
  for (const [key, count] of moderationBlockCounts) {
    const sep = key.indexOf("\x00");
    const category = sep >= 0 ? key.slice(0, sep) : key;
    const direction = sep >= 0 ? key.slice(sep + 1) : "unknown";
    lines.push(`siskelbot_moderation_blocks_total{category="${category}",direction="${direction}"} ${count}`);
  }

  // RAG quality metrics
  lines.push("# HELP siskelbot_rag_precision_at_k RAG precision@k (0.0-1.0) histogram by k");
  lines.push("# TYPE siskelbot_rag_precision_at_k histogram");
  for (const [k, row] of ragPrecisionAtK) {
    lines.push(`siskelbot_rag_precision_at_k_sum{k="${k}"} ${row.sum.toFixed(6)}`);
    lines.push(`siskelbot_rag_precision_at_k_count{k="${k}"} ${row.count}`);
  }

  lines.push("# HELP siskelbot_rag_mrr RAG mean reciprocal rank (0.0-1.0) histogram");
  lines.push("# TYPE siskelbot_rag_mrr histogram");
  lines.push(`siskelbot_rag_mrr_sum ${ragMrrSum.toFixed(6)}`);
  lines.push(`siskelbot_rag_mrr_count ${ragMrrCount}`);

  lines.push("# HELP siskelbot_rag_retrieval_duration_seconds RAG vector retrieval latency");
  lines.push("# TYPE siskelbot_rag_retrieval_duration_seconds histogram");
  {
    let cum = 0;
    for (const b of RAG_DURATION_BUCKETS) {
      cum += ragDurationBuckets[b] || 0;
      lines.push(`siskelbot_rag_retrieval_duration_seconds_bucket{le="${b}"} ${cum}`);
    }
    lines.push(`siskelbot_rag_retrieval_duration_seconds_bucket{le="+Inf"} ${ragDurationCount}`);
    lines.push(`siskelbot_rag_retrieval_duration_seconds_sum ${ragDurationSumSec.toFixed(6)}`);
    lines.push(`siskelbot_rag_retrieval_duration_seconds_count ${ragDurationCount}`);
  }

  lines.push("# HELP siskelbot_rag_chunks_retrieved_total Total knowledge chunks retrieved by workspace");
  lines.push("# TYPE siskelbot_rag_chunks_retrieved_total counter");
  for (const [workspace, count] of ragChunksRetrievedByWorkspace) {
    lines.push(`siskelbot_rag_chunks_retrieved_total{workspace_id="${workspace}"} ${count}`);
  }

  return lines.join("\n") + "\n";
}

export function isEnabled() {
  return isMetricsEnabled();
}

export function getAgentRunSummarySnapshot() {
  const out = {};
  for (const [key, n] of agentRunTotal) {
    const sepIdx = key.indexOf(MP_SEP);
    const mode = sepIdx >= 0 ? key.slice(0, sepIdx) : "unknown";
    const stopReason = sepIdx >= 0 ? key.slice(sepIdx + 1) : key;
    if (!out[mode]) out[mode] = {};
    out[mode][stopReason] = n;
  }
  return out;
}
