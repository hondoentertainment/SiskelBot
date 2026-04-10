/**
 * Phase 40 / Phase 36: Prometheus metrics export.
 * Request counts, latency histograms, circuit breaker state, swarm metrics.
 * Phase 36: http_requests_total, http_request_duration_seconds, siskelbot_chat_requests_total,
 * siskelbot_tokens_used_total, siskelbot_active_connections, process metrics.
 * Phase 69: Optional OpenMetrics exemplars on histograms (trace link) when OTEL_PROMETHEUS_EXEMPLARS=1.
 */
import { trace } from "@opentelemetry/api";
import { isOpen } from "./circuit-breaker.js";
import { getActiveConnectionCount } from "./realtime.js";

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
// Tool timeout counter: toolName -> count
const toolTimeoutCounts = new Map();
// Agent policy denials: code -> count (e.g. POLICY_TOOL_DENIED)
const agentPolicyDenialCounts = new Map();
// Phase 32.1: reflection loop counters (total runs, runs that produced a revision, duration sum)
let agentReflectionTotal = 0;
let agentReflectionRevisedTotal = 0;
let agentReflectionDurationMsSum = 0;
// Phase 35.3: SSE streaming metrics (zero-copy SSE, buffer pooling)
let sseBytesWrittenTotal = 0;
let sseWritesTotal = 0;
let sseBatchesTotal = 0;
let sseWriteDurationMsSum = 0;

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
 * @param {string} code - e.g. POLICY_TOOL_DENIED, POLICY_CATEGORY_CAP
 */
export function recordPolicyDenial(code) {
  if (!isMetricsEnabled()) return;
  const label = safeLabel(code);
  agentPolicyDenialCounts.set(label, (agentPolicyDenialCounts.get(label) || 0) + 1);
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

  lines.push("# HELP siskelbot_agent_policy_denials_total Agent tool calls blocked by policy");
  lines.push("# TYPE siskelbot_agent_policy_denials_total counter");
  for (const [policyCode, count] of agentPolicyDenialCounts) {
    lines.push(`siskelbot_agent_policy_denials_total{code="${policyCode}"} ${count}`);
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
