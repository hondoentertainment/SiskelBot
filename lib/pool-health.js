/**
 * Phase 23: Connection pool health monitoring.
 * Reports pool stats for Postgres connections and registers Prometheus metrics.
 */

import { postgresKvEnabled } from "./storage-postgres-kv.js";

/** @type {import('pg').Pool | null} */
let registeredPool = null;

/**
 * Register a pg Pool instance for health monitoring.
 * @param {import('pg').Pool} pool
 */
export function registerPool(pool) {
  registeredPool = pool;
}

/**
 * Get current pool statistics.
 * @returns {{ total: number, idle: number, waiting: number, active: number } | null}
 */
export function getPoolStats() {
  if (!registeredPool) {
    return null;
  }
  const total = registeredPool.totalCount ?? 0;
  const idle = registeredPool.idleCount ?? 0;
  const waiting = registeredPool.waitingCount ?? 0;
  const active = total - idle;
  return { total, idle, waiting, active };
}

/**
 * Register pool stats as Prometheus-compatible gauge lines.
 * Call from the metrics render function to include pool gauges.
 * @returns {string} Prometheus exposition text (empty string if no pool)
 */
export function renderPoolMetrics() {
  const stats = getPoolStats();
  if (!stats) return "";
  const lines = [
    "# HELP siskelbot_db_pool_total Total connections in the pool",
    "# TYPE siskelbot_db_pool_total gauge",
    `siskelbot_db_pool_total ${stats.total}`,
    "# HELP siskelbot_db_pool_idle Idle connections in the pool",
    "# TYPE siskelbot_db_pool_idle gauge",
    `siskelbot_db_pool_idle ${stats.idle}`,
    "# HELP siskelbot_db_pool_active Active connections in the pool",
    "# TYPE siskelbot_db_pool_active gauge",
    `siskelbot_db_pool_active ${stats.active}`,
    "# HELP siskelbot_db_pool_waiting Clients waiting for a connection",
    "# TYPE siskelbot_db_pool_waiting gauge",
    `siskelbot_db_pool_waiting ${stats.waiting}`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Register pool metrics into the metrics module's render pipeline.
 * @param {{ appendRenderer: (fn: () => string) => void }} metricsModule
 */
export function registerPoolMetrics(metricsModule) {
  if (metricsModule && typeof metricsModule.appendRenderer === "function") {
    metricsModule.appendRenderer(renderPoolMetrics);
  }
}
