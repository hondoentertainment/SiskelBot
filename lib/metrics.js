/**
 * Phase 40: Prometheus metrics export.
 * Request counts, latency histograms, circuit breaker state, swarm metrics.
 */
import { isOpen } from "./circuit-breaker.js";

const ENABLE_METRICS = process.env.ENABLE_METRICS === "1";

// Counters: method_path_status -> count
const requestCounts = new Map();
// Latency buckets in ms: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const latencyBuckets = new Map(); // bucket_ms -> count per path
const latencyTotals = new Map(); // path -> { sum, count }
// Swarm
let swarmInvocations = 0;
let swarmSpecialistSuccess = 0;
let swarmSpecialistFailure = 0;

function getBackends() {
  return ["ollama", "vllm", "openai"];
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
  if (!ENABLE_METRICS) return;

  const pathLabel = path?.replace(/^\/+/, "") || "root";
  const key = JSON.stringify({ m: method, p: pathLabel, s: status });
  requestCounts.set(key, (requestCounts.get(key) || 0) + 1);

  const pathKey = (path?.replace(/^\/+/, "") || "root").replace(/[^a-zA-Z0-9_:]/g, "_").slice(0, 64);
  let tot = latencyTotals.get(pathKey);
  if (!tot) tot = { sum: 0, count: 0 };
  tot.sum += durationMs;
  tot.count += 1;
  latencyTotals.set(pathKey, tot);

  for (const b of BUCKETS) {
    if (durationMs <= b) {
      const bk = `${pathKey}_${b}`;
      latencyBuckets.set(bk, (latencyBuckets.get(bk) || 0) + 1);
      break;
    }
  }
}

/**
 * Record swarm invocation.
 * @param {number} specialistCount
 * @param {number} successCount
 * @param {number} durationMs
 */
export function recordSwarm(specialistCount, successCount, durationMs) {
  if (!ENABLE_METRICS) return;
  swarmInvocations++;
  swarmSpecialistSuccess += successCount;
  swarmSpecialistFailure += specialistCount - successCount;
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
 * @returns {string}
 */
export function renderPrometheus() {
  const lines = [];

  lines.push("# HELP experimentagent_http_requests_total Total HTTP requests");
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

  lines.push("# HELP experimentagent_http_request_duration_ms HTTP request duration in milliseconds");
  lines.push("# TYPE experimentagent_http_request_duration_ms histogram");
  for (const [pathKey, tot] of latencyTotals) {
    const leCounts = {};
    for (const b of BUCKETS) {
      const bk = `${pathKey}_${b}`;
      leCounts[b] = (leCounts[b] || 0) + (latencyBuckets.get(bk) || 0);
    }
    let cum = 0;
    for (const b of BUCKETS) {
      cum += leCounts[b] || 0;
      lines.push(`experimentagent_http_request_duration_ms_bucket{path="${pathKey}",le="${b}"} ${cum}`);
    }
    lines.push(`experimentagent_http_request_duration_ms_bucket{path="${pathKey}",le="+Inf"} ${tot.count}`);
    lines.push(`experimentagent_http_request_duration_ms_sum{path="${pathKey}"} ${tot.sum}`);
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

  return lines.join("\n") + "\n";
}

export function isEnabled() {
  return ENABLE_METRICS;
}
