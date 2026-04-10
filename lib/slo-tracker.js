/**
 * Phase 31.2: Service Level Objective (SLO) / Service Level Indicator (SLI)
 * tracking with error budget accounting.
 *
 * Concepts:
 *   - SLO: a target for service quality (e.g., 99.9% availability,
 *     p95 latency < 500ms, error rate < 1%).
 *   - SLI: an observed signal used to compute progress toward an SLO
 *     (success/failure events, request latencies, etc.).
 *   - Error budget: 1 - SLO. For a 99.9% availability target this is
 *     0.1% of the window (~43.2 minutes/month).
 *   - Burn rate: the ratio of actual consumption to the expected rate;
 *     values > 1 mean budget is being burned faster than allowed.
 *
 * SLO operators:
 *   - 'gte' (default): metric value must be >= target
 *     (e.g., availability 0.999)
 *   - 'lt': metric value must be < target
 *     (e.g., latency_ms < 500, error_rate < 0.01)
 */

const WINDOW_MS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export function parseWindow(window) {
  if (typeof window === 'number' && Number.isFinite(window)) return window;
  if (typeof window !== 'string') return WINDOW_MS['30d'];
  if (WINDOW_MS[window]) return WINDOW_MS[window];
  const m = /^(\d+)([smhd])$/.exec(window);
  if (!m) return WINDOW_MS['30d'];
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

const DEFAULT_SLOS = {
  availability: {
    target: 0.999,
    window: '30d',
    metric: 'success_rate',
    operator: 'gte',
    description: 'Service availability (fraction of requests with status < 500)',
  },
  latency_p95: {
    target: 500,
    window: '7d',
    metric: 'latency_ms',
    operator: 'lt',
    percentile: 95,
    description: 'p95 request latency in milliseconds',
  },
  error_rate: {
    target: 0.01,
    window: '24h',
    metric: 'error_rate',
    operator: 'lt',
    description: 'Fraction of requests that produced a 5xx response',
  },
};

// Cap on per-metric event history to keep memory bounded.
const MAX_EVENTS_PER_METRIC = Number(process.env.SLO_MAX_EVENTS) || 50_000;

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const rank = (p / 100) * (sortedValues.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedValues[lo];
  const frac = rank - lo;
  return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}

function classifyStatus(burnRate) {
  if (!Number.isFinite(burnRate)) return 'healthy';
  if (burnRate >= 10) return 'critical';
  if (burnRate >= 2) return 'warning';
  return 'healthy';
}

/**
 * Create an SLO tracker instance.
 */
export function createSLOTracker() {
  /** @type {Map<string, Array<{ timestamp: number, value: number }>>} */
  const events = new Map();
  /** @type {Map<string, object>} */
  const slos = new Map();

  // Seed defaults.
  for (const [name, cfg] of Object.entries(DEFAULT_SLOS)) {
    slos.set(name, { ...cfg });
  }

  function getEventsFor(metric) {
    let arr = events.get(metric);
    if (!arr) {
      arr = [];
      events.set(metric, arr);
    }
    return arr;
  }

  function recordEvent(metric, value, timestamp) {
    if (typeof metric !== 'string' || !metric) return;
    const numValue = Number(value);
    if (!Number.isFinite(numValue)) return;
    const ts = Number.isFinite(timestamp) ? Number(timestamp) : Date.now();
    const arr = getEventsFor(metric);
    arr.push({ timestamp: ts, value: numValue });
    if (arr.length > MAX_EVENTS_PER_METRIC) {
      arr.splice(0, arr.length - MAX_EVENTS_PER_METRIC);
    }
  }

  function windowEvents(metric, windowMs, now = Date.now()) {
    const all = events.get(metric) || [];
    const cutoff = now - windowMs;
    const out = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const ev = all[i];
      if (ev.timestamp < cutoff) break;
      out.push(ev);
    }
    return out.reverse();
  }

  /**
   * Compute the current SLI value for the given SLO config over its window.
   * Interprets the metric name:
   *   - 'success_rate': events are 0/1 (1 = success). Returns fraction of 1s.
   *   - 'error_rate': events are 0/1 (1 = error) OR derived from success_rate.
   *   - 'latency_ms': returns percentile (default p95).
   *   - others: returns arithmetic mean.
   */
  function computeCurrent(sloConfig, now = Date.now()) {
    const windowMs = parseWindow(sloConfig.window);
    const metric = sloConfig.metric;
    const evts = windowEvents(metric, windowMs, now);
    if (metric === 'success_rate') {
      if (!evts.length) return { value: 1, sampleSize: 0 };
      let successes = 0;
      for (const e of evts) if (e.value >= 1) successes++;
      return { value: successes / evts.length, sampleSize: evts.length };
    }
    if (metric === 'error_rate') {
      // If the tracker is seeing success_rate events reused for error_rate
      // (i.e., nothing was recorded to error_rate), fall back to success_rate.
      let source = evts;
      if (!source.length) {
        source = windowEvents('success_rate', windowMs, now);
        if (!source.length) return { value: 0, sampleSize: 0 };
        let errors = 0;
        for (const e of source) if (e.value < 1) errors++;
        return { value: errors / source.length, sampleSize: source.length };
      }
      let errors = 0;
      for (const e of source) if (e.value >= 1) errors++;
      return { value: errors / source.length, sampleSize: source.length };
    }
    if (metric === 'latency_ms') {
      if (!evts.length) return { value: 0, sampleSize: 0 };
      const sorted = evts.map((e) => e.value).sort((a, b) => a - b);
      const p = Number.isFinite(sloConfig.percentile) ? sloConfig.percentile : 95;
      return { value: percentile(sorted, p), sampleSize: sorted.length };
    }
    if (!evts.length) return { value: 0, sampleSize: 0 };
    let sum = 0;
    for (const e of evts) sum += e.value;
    return { value: sum / evts.length, sampleSize: evts.length };
  }

  /**
   * Compute error budget state for an SLO.
   * For 'gte' metrics (availability):
   *   - budget is (1 - target) * sampleSize failures allowed.
   *   - consumed is actual failure count.
   * For 'lt' rate metrics (error_rate):
   *   - budget is target * sampleSize errors allowed.
   *   - consumed is actual error count.
   * For 'lt' latency metrics:
   *   - budget is fraction of samples allowed to exceed the latency target.
   *     With no explicit allowed fraction we default to 5% (matches p95).
   */
  function computeBudget(sloConfig, current, now = Date.now()) {
    const windowMs = parseWindow(sloConfig.window);
    const metric = sloConfig.metric;
    const operator = sloConfig.operator || 'gte';
    const target = Number(sloConfig.target);
    const sampleSize = current.sampleSize;

    if (metric === 'success_rate' && operator === 'gte') {
      const allowedFailureFraction = Math.max(0, 1 - target);
      const totalBudget = Math.max(1, allowedFailureFraction * Math.max(sampleSize, 1));
      const actualFailureFraction = Math.max(0, 1 - current.value);
      const consumed = actualFailureFraction * Math.max(sampleSize, 1);
      const remaining = Math.max(0, totalBudget - consumed);
      const burnRate = allowedFailureFraction > 0 ? actualFailureFraction / allowedFailureFraction : 0;
      return budgetOutput(totalBudget, consumed, remaining, burnRate, windowMs);
    }

    if (metric === 'error_rate' && operator === 'lt') {
      const allowedErrorFraction = Math.max(0, target);
      const totalBudget = Math.max(1, allowedErrorFraction * Math.max(sampleSize, 1));
      const actualErrorFraction = Math.max(0, current.value);
      const consumed = actualErrorFraction * Math.max(sampleSize, 1);
      const remaining = Math.max(0, totalBudget - consumed);
      const burnRate = allowedErrorFraction > 0 ? actualErrorFraction / allowedErrorFraction : 0;
      return budgetOutput(totalBudget, consumed, remaining, burnRate, windowMs);
    }

    if (metric === 'latency_ms' && operator === 'lt') {
      // Measure the fraction of samples exceeding the latency target.
      const latencyEvents = windowEvents(metric, windowMs, now);
      const size = latencyEvents.length;
      let over = 0;
      for (const e of latencyEvents) if (e.value >= target) over++;
      const overFraction = size ? over / size : 0;
      const allowedFraction = Number.isFinite(sloConfig.allowedFraction)
        ? sloConfig.allowedFraction
        : sloConfig.percentile
          ? Math.max(0, 1 - sloConfig.percentile / 100)
          : 0.05;
      const totalBudget = Math.max(1, allowedFraction * Math.max(size, 1));
      const consumed = overFraction * Math.max(size, 1);
      const remaining = Math.max(0, totalBudget - consumed);
      const burnRate = allowedFraction > 0 ? overFraction / allowedFraction : 0;
      return budgetOutput(totalBudget, consumed, remaining, burnRate, windowMs);
    }

    // Generic fallback: convert a gte/lt comparison into a pass/fail ratio.
    const targetVal = target;
    const actualVal = current.value;
    const pass = operator === 'gte' ? actualVal >= targetVal : actualVal < targetVal;
    const burnRate = pass ? 0 : 2;
    return budgetOutput(1, pass ? 0 : 1, pass ? 1 : 0, burnRate, windowMs);
  }

  function budgetOutput(total, consumed, remaining, burnRate, windowMs) {
    const consumedFraction = total > 0 ? consumed / total : 0;
    return {
      total: Number(total.toFixed(6)),
      consumed: Number(consumed.toFixed(6)),
      remaining: Number(remaining.toFixed(6)),
      consumedFraction: Number(Math.min(1, Math.max(0, consumedFraction)).toFixed(6)),
      remainingFraction: Number(Math.min(1, Math.max(0, 1 - consumedFraction)).toFixed(6)),
      burnRate: Number((Number.isFinite(burnRate) ? burnRate : 0).toFixed(4)),
      windowMs,
    };
  }

  function getSLOStatus(sloName, now = Date.now()) {
    const cfg = slos.get(sloName);
    if (!cfg) return null;
    const current = computeCurrent(cfg, now);
    const budget = computeBudget(cfg, current, now);
    const status = classifyStatus(budget.burnRate);
    return {
      name: sloName,
      target: cfg.target,
      window: cfg.window,
      metric: cfg.metric,
      operator: cfg.operator || 'gte',
      description: cfg.description || '',
      current: Number(current.value.toFixed(6)),
      sampleSize: current.sampleSize,
      budget,
      status,
      updatedAt: now,
    };
  }

  function getAllSLOs(now = Date.now()) {
    const out = [];
    for (const name of slos.keys()) {
      const s = getSLOStatus(name, now);
      if (s) out.push(s);
    }
    return out;
  }

  function setSLO(name, config) {
    if (typeof name !== 'string' || !name) throw new Error('SLO name is required');
    if (!config || typeof config !== 'object') throw new Error('SLO config is required');
    if (!Number.isFinite(Number(config.target))) throw new Error('SLO target must be a number');
    if (typeof config.metric !== 'string' || !config.metric) throw new Error('SLO metric is required');
    const existing = slos.get(name) || {};
    const merged = {
      ...existing,
      ...config,
      target: Number(config.target),
      window: config.window || existing.window || '30d',
      operator: config.operator || existing.operator || 'gte',
      metric: config.metric,
    };
    slos.set(name, merged);
    return merged;
  }

  function deleteSLO(name) {
    return slos.delete(name);
  }

  function getSLOConfig(name) {
    const cfg = slos.get(name);
    return cfg ? { ...cfg } : null;
  }

  function listSLOConfigs() {
    const out = {};
    for (const [name, cfg] of slos.entries()) out[name] = { ...cfg };
    return out;
  }

  /**
   * Return a time series that shows how error budget was consumed over the
   * SLO window. Splits the window into N buckets and computes the remaining
   * budget fraction at the end of each bucket.
   */
  function getBurnDown(sloName, period, bucketCount = 24, now = Date.now()) {
    const cfg = slos.get(sloName);
    if (!cfg) return null;
    const windowMs = period ? parseWindow(period) : parseWindow(cfg.window);
    const buckets = Math.max(2, Math.min(200, Math.floor(bucketCount) || 24));
    const start = now - windowMs;
    const step = windowMs / buckets;
    const series = [];
    for (let i = 1; i <= buckets; i++) {
      const tsEnd = start + i * step;
      const stepCfg = { ...cfg, window: i * step };
      const current = computeCurrent(stepCfg, tsEnd);
      const budget = computeBudget(stepCfg, current, tsEnd);
      series.push({
        timestamp: Math.round(tsEnd),
        current: Number(current.value.toFixed(6)),
        sampleSize: current.sampleSize,
        remainingFraction: budget.remainingFraction,
        consumedFraction: budget.consumedFraction,
        burnRate: budget.burnRate,
      });
    }
    return {
      name: sloName,
      target: cfg.target,
      window: period || cfg.window,
      windowMs,
      bucketCount: buckets,
      series,
    };
  }

  function reset() {
    events.clear();
    slos.clear();
    for (const [name, cfg] of Object.entries(DEFAULT_SLOS)) {
      slos.set(name, { ...cfg });
    }
  }

  function _dumpState() {
    const out = { slos: {}, events: {} };
    for (const [name, cfg] of slos.entries()) out.slos[name] = { ...cfg };
    for (const [metric, arr] of events.entries()) out.events[metric] = arr.length;
    return out;
  }

  return {
    recordEvent,
    getSLOStatus,
    getAllSLOs,
    setSLO,
    deleteSLO,
    getSLOConfig,
    listSLOConfigs,
    getBurnDown,
    reset,
    _dumpState,
  };
}

export const globalSLOTracker = createSLOTracker();

export const __test__ = {
  parseWindow,
  classifyStatus,
  percentile,
  DEFAULT_SLOS,
};
