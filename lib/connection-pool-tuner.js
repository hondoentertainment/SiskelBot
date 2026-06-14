/**
 * Phase 30: Auto-tune PostgreSQL connection pool size based on utilization.
 *
 * Monitors pool stats and adjusts max connections to match actual demand,
 * staying within the PG_POOL_MAX env cap.
 *
 * Configuration:
 *   PG_POOL_MAX           — absolute maximum pool size (default 50)
 *   PG_POOL_MIN           — absolute minimum pool size (default 2)
 *   POOL_TUNE_INTERVAL_MS — auto-tune interval in ms (default 60000)
 */

const PG_POOL_MAX = Number(process.env.PG_POOL_MAX) || 50;
const PG_POOL_MIN = Number(process.env.PG_POOL_MIN) || 2;
const DEFAULT_TUNE_INTERVAL = Number(process.env.POOL_TUNE_INTERVAL_MS) || 60_000;

const HIGH_UTILIZATION_THRESHOLD = 0.80;
const LOW_UTILIZATION_THRESHOLD = 0.20;
const SCALE_UP_FACTOR = 1.5;
const SCALE_DOWN_FACTOR = 0.75;

/**
 * Create a pool tuner for a pg Pool instance.
 *
 * @param {import('pg').Pool} pool - The pg Pool instance to monitor and tune
 * @param {object} [options]
 * @param {number} [options.maxCap]   Override PG_POOL_MAX env
 * @param {number} [options.minCap]   Override PG_POOL_MIN env
 * @returns {PoolTuner}
 */
export function createPoolTuner(pool, options = {}) {
  const maxCap = options.maxCap ?? PG_POOL_MAX;
  const minCap = options.minCap ?? PG_POOL_MIN;
  let autoTuneTimer = null;
  const history = [];
  const MAX_HISTORY = 60;

  function getPoolStats() {
    if (!pool) return null;
    const total = pool.totalCount ?? 0;
    const idle = pool.idleCount ?? 0;
    const waiting = pool.waitingCount ?? 0;
    const active = total - idle;
    const max = pool.options?.max ?? total;
    return { total, idle, waiting, active, max };
  }

  function computeUtilization(stats) {
    if (!stats || stats.max === 0) return 0;
    return stats.active / stats.max;
  }

  function recordSnapshot() {
    const stats = getPoolStats();
    if (!stats) return null;
    const snapshot = {
      ...stats,
      utilization: computeUtilization(stats),
      timestamp: Date.now(),
    };
    history.push(snapshot);
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    return snapshot;
  }

  return {
    /**
     * Analyze current pool stats and adjust pool max if needed.
     * @returns {{ action: string, previousMax: number, newMax: number, utilization: number, waiting: number }}
     */
    tune() {
      const stats = getPoolStats();
      if (!stats) {
        return { action: "no-pool", previousMax: 0, newMax: 0, utilization: 0, waiting: 0 };
      }

      const utilization = computeUtilization(stats);
      const previousMax = stats.max;
      let newMax = previousMax;

      if (utilization > HIGH_UTILIZATION_THRESHOLD || stats.waiting > 0) {
        // Scale up
        newMax = Math.ceil(previousMax * SCALE_UP_FACTOR);
        if (stats.waiting > 0) {
          // If clients are waiting, be more aggressive
          newMax = Math.max(newMax, previousMax + stats.waiting + 2);
        }
      } else if (utilization < LOW_UTILIZATION_THRESHOLD && stats.waiting === 0) {
        // Scale down
        newMax = Math.max(minCap, Math.floor(previousMax * SCALE_DOWN_FACTOR));
      } else {
        recordSnapshot();
        return { action: "no-change", previousMax, newMax: previousMax, utilization, waiting: stats.waiting };
      }

      // Clamp to bounds
      newMax = Math.max(minCap, Math.min(maxCap, newMax));

      if (newMax !== previousMax && pool.options) {
        pool.options.max = newMax;
        console.log(`[pool-tuner] Adjusted pool max: ${previousMax} -> ${newMax} (utilization=${(utilization * 100).toFixed(1)}%, waiting=${stats.waiting})`);
      }

      const action = newMax > previousMax ? "scale-up" : newMax < previousMax ? "scale-down" : "no-change";
      recordSnapshot();
      return { action, previousMax, newMax, utilization, waiting: stats.waiting };
    },

    /**
     * Get a recommendation without applying changes.
     * @returns {{ currentMax: number, recommended: number, utilization: number, waitTime: number }}
     */
    getRecommendation() {
      const stats = getPoolStats();
      if (!stats) {
        return { currentMax: 0, recommended: 0, utilization: 0, waitTime: 0 };
      }

      const utilization = computeUtilization(stats);
      let recommended = stats.max;

      if (utilization > HIGH_UTILIZATION_THRESHOLD || stats.waiting > 0) {
        recommended = Math.ceil(stats.max * SCALE_UP_FACTOR);
        if (stats.waiting > 0) {
          recommended = Math.max(recommended, stats.max + stats.waiting + 2);
        }
      } else if (utilization < LOW_UTILIZATION_THRESHOLD && stats.waiting === 0) {
        recommended = Math.max(minCap, Math.floor(stats.max * SCALE_DOWN_FACTOR));
      }

      recommended = Math.max(minCap, Math.min(maxCap, recommended));

      return {
        currentMax: stats.max,
        recommended,
        utilization,
        waitTime: stats.waiting,
      };
    },

    /**
     * Start automatic tuning on an interval.
     * @param {number} [intervalMs] Default POOL_TUNE_INTERVAL_MS or 60s
     */
    startAutoTune(intervalMs) {
      this.stopAutoTune();
      const ms = intervalMs ?? DEFAULT_TUNE_INTERVAL;
      autoTuneTimer = setInterval(() => {
        try {
          this.tune();
        } catch (err) {
          console.warn("[pool-tuner] Auto-tune error:", err.message);
        }
      }, ms);
      if (autoTuneTimer.unref) autoTuneTimer.unref();
    },

    /**
     * Stop automatic tuning.
     */
    stopAutoTune() {
      if (autoTuneTimer) {
        clearInterval(autoTuneTimer);
        autoTuneTimer = null;
      }
    },

    /**
     * Get recent pool snapshots for analysis.
     * @returns {Array<object>}
     */
    getHistory() {
      return [...history];
    },
  };
}
