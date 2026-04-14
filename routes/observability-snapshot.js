/**
 * In-app observability snapshot endpoint.
 *
 * Consolidates the signals non-ops users care about into a single
 * JSON payload for the in-app observability view:
 *
 *   - breakers: per-backend circuit-breaker state (from lib/circuit-breaker.js)
 *   - slowRoutes: top-10 routes by p95 (from lib/observability.js)
 *   - recentTrajectories: last 20 recorded traces (from lib/trace-recorder.js)
 *   - pool: Postgres pool stats (from lib/pool-health.js)
 *   - uptimeSec, requestsPerMinute, errorsPerMinute
 *
 * Route conventions mirror routes/agent-sessions.js:
 * `logRequest → userAuth → requireScope("read") → handler`.
 *
 * No long-term logic lives here — all numbers come from existing modules;
 * unavailable data points are stubbed with zero and marked with a TODO.
 */
import { isOpen } from "../lib/circuit-breaker.js";
import { getLatencyPercentiles, getErrorRates } from "../lib/observability.js";
import { listTraces } from "../lib/trace-recorder.js";
import { getPoolStats } from "../lib/pool-health.js";

const KNOWN_BACKENDS = ["ollama", "vllm", "openai"];

/**
 * Build the breaker rows. Uses the public `isOpen()` API from
 * lib/circuit-breaker.js. The module doesn't expose failure counts or
 * last-failure timestamps, so those fields are stubbed to 0/null until
 * a richer snapshot API exists.
 * TODO: expose a `getBreakerSnapshot()` from lib/circuit-breaker.js so
 * this view can surface failure counts and lastFailureAt.
 * @returns {Array<{ name: string, state: string, failures: number, lastFailureAt: string|null }>}
 */
function collectBreakers() {
  const rows = [];
  for (const name of KNOWN_BACKENDS) {
    let state = "closed";
    try {
      const check = isOpen(name);
      state = check.open ? "open" : "closed";
    } catch (_) {
      state = "unknown";
    }
    rows.push({
      name,
      state,
      failures: 0, // TODO: sourced from lib/circuit-breaker.js once a snapshot API exists
      lastFailureAt: null, // TODO: ditto
    });
  }
  return rows;
}

/**
 * Build the top-N slow-routes table keyed by p95.
 * @param {number} limit
 * @returns {Array<{ route: string, p50Ms: number, p95Ms: number, hits: number }>}
 */
function collectSlowRoutes(limit = 10) {
  let byRoute = {};
  try {
    ({ byRoute } = getLatencyPercentiles(60));
  } catch (_) {
    byRoute = {};
  }
  const rows = [];
  for (const [route, stats] of Object.entries(byRoute || {})) {
    rows.push({
      route,
      p50Ms: Number(stats?.p50 || 0),
      p95Ms: Number(stats?.p95 || 0),
      hits: Number(stats?.count || 0),
    });
  }
  rows.sort((a, b) => b.p95Ms - a.p95Ms);
  return rows.slice(0, limit);
}

/**
 * Build the recent trajectories rows from persisted traces.
 * @returns {Promise<Array<{ runId: string, startedAt: string, steps: number, status: string }>>}
 */
async function collectRecentTrajectories(limit = 20) {
  try {
    const listing = await listTraces({ limit });
    const items = Array.isArray(listing?.items) ? listing.items : [];
    return items.map((t) => ({
      runId: t.traceId || t.runId || "unknown",
      startedAt: t.recordedAt || null,
      steps: Number(t.stepCount || 0),
      status: t.stopReason || "unknown",
    }));
  } catch (_) {
    return [];
  }
}

/**
 * Build the pool rows from lib/pool-health.js. Returns all zeros when no
 * pool is registered (i.e. the server is running against the JSON/SQLite
 * backend), so the UI has stable fields to render.
 * @returns {{ dbConnections: number, inUse: number, waiting: number }}
 */
function collectPool() {
  const stats = getPoolStats();
  if (!stats) {
    // TODO: when STORAGE_BACKEND=postgres is not configured, pool-health
    // has nothing to report — surface this explicitly in the UI.
    return { dbConnections: 0, inUse: 0, waiting: 0 };
  }
  return {
    dbConnections: Number(stats.total || 0),
    inUse: Number(stats.active || 0),
    waiting: Number(stats.waiting || 0),
  };
}

/**
 * Requests/errors per minute averaged across the last 60-minute window.
 * @returns {{ requestsPerMinute: number, errorsPerMinute: number }}
 */
function collectRates() {
  try {
    const err = getErrorRates(60);
    const total = Number(err?.total || 0);
    const errors = Number(err?.errors4xx || 0) + Number(err?.errors5xx || 0);
    return {
      requestsPerMinute: +(total / 60).toFixed(2),
      errorsPerMinute: +(errors / 60).toFixed(2),
    };
  } catch (_) {
    return { requestsPerMinute: 0, errorsPerMinute: 0 };
  }
}

/**
 * Compose the snapshot payload. Exported so tests can call it directly.
 */
export async function buildObservabilitySnapshot() {
  const breakers = collectBreakers();
  const slowRoutes = collectSlowRoutes(10);
  const recentTrajectories = await collectRecentTrajectories(20);
  const pool = collectPool();
  const rates = collectRates();
  return {
    breakers,
    slowRoutes,
    recentTrajectories,
    pool,
    uptimeSec: Math.round(process.uptime()),
    requestsPerMinute: rates.requestsPerMinute,
    errorsPerMinute: rates.errorsPerMinute,
  };
}

export function mountObservabilitySnapshotRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  apiRoute(
    "get",
    "/observability/snapshot",
    logRequest,
    userAuth,
    requireScope("read"),
    async (_req, res) => {
      try {
        const snapshot = await buildObservabilitySnapshot();
        res.json(snapshot);
      } catch (err) {
        return apiError(
          res,
          500,
          "INTERNAL_ERROR",
          err?.message || "Snapshot failed",
          "See server logs.",
        );
      }
    },
  );
}

export default mountObservabilitySnapshotRoutes;
