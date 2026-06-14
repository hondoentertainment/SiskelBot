/**
 * Phase 31.3: Synthetic monitoring.
 *
 * Automated smoke tests that run on a schedule from the server
 * (or multiple regions if deployed HA). Each registered check periodically
 * executes a probe (HTTP, TCP, DNS, or script) and records the result.
 *
 * The monitor keeps a rolling history of the last N results per check and
 * computes basic SLO stats (uptime %, avg latency, failure count) over a
 * configurable period.
 *
 * Usage:
 *   import { createSyntheticMonitor, registerBuiltInChecks } from "./synthetic-monitor.js";
 *   const monitor = createSyntheticMonitor();
 *   registerBuiltInChecks(monitor, "http://localhost:3000");
 *   monitor.start(5 * 60 * 1000);
 */

import { resolve as dnsResolve } from "node:dns/promises";
import { createConnection } from "node:net";

const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} CheckConfig
 * @property {string} id
 * @property {string} name
 * @property {"http"|"tcp"|"dns"|"script"} type
 * @property {any} target     - URL / host:port / hostname / function
 * @property {any} [expected] - Expectation for pass/fail
 * @property {number} [interval] - ms
 * @property {number} [timeout]  - ms
 * @property {string[]} [regions]
 */

/**
 * @typedef {Object} CheckResult
 * @property {string} id
 * @property {"pass"|"fail"} status
 * @property {number} durationMs
 * @property {string|null} output
 * @property {string|null} error
 * @property {string} timestamp
 */

/**
 * Create a new synthetic monitor instance.
 *
 * @param {Object} [options]
 * @param {number} [options.historyLimit] - Max history entries per check.
 * @returns {object} monitor API
 */
export function createSyntheticMonitor(options = {}) {
  const historyLimit = Number.isFinite(options.historyLimit) ? options.historyLimit : DEFAULT_HISTORY_LIMIT;

  /** @type {Map<string, CheckConfig>} */
  const checks = new Map();
  /** @type {Map<string, CheckResult[]>} */
  const history = new Map();
  let timer = null;
  let running = false;

  function registerCheck(config) {
    if (!config || typeof config !== "object") {
      throw new Error("registerCheck: config is required");
    }
    const id = String(config.id || "").trim();
    if (!id) throw new Error("registerCheck: id is required");
    const type = String(config.type || "").toLowerCase();
    if (!["http", "tcp", "dns", "script"].includes(type)) {
      throw new Error(`registerCheck: invalid type "${config.type}"`);
    }
    const entry = {
      id,
      name: String(config.name || id),
      type,
      target: config.target,
      expected: config.expected ?? null,
      interval: Number.isFinite(config.interval) ? Number(config.interval) : DEFAULT_INTERVAL_MS,
      timeout: Number.isFinite(config.timeout) ? Number(config.timeout) : DEFAULT_TIMEOUT_MS,
      regions: Array.isArray(config.regions) ? config.regions.slice() : [],
      createdAt: new Date().toISOString(),
    };
    checks.set(id, entry);
    if (!history.has(id)) history.set(id, []);
    return entry;
  }

  function unregisterCheck(id) {
    const removed = checks.delete(id);
    history.delete(id);
    return removed;
  }

  function listChecks() {
    return Array.from(checks.values()).map((c) => ({ ...c }));
  }

  function getCheck(id) {
    const c = checks.get(id);
    return c ? { ...c } : null;
  }

  async function runCheck(id) {
    const check = checks.get(id);
    if (!check) {
      throw new Error(`runCheck: unknown check id "${id}"`);
    }
    const start = Date.now();
    let status;
    let output;
    let error;
    try {
      const result = await executeCheck(check);
      status = result.status;
      output = result.output ?? null;
      error = result.error ?? null;
    } catch (e) {
      status = "fail";
      output = null;
      error = e?.message || String(e);
    }
    const rec = {
      id,
      status,
      durationMs: Date.now() - start,
      output,
      error,
      timestamp: new Date().toISOString(),
    };
    const list = history.get(id) || [];
    list.push(rec);
    if (list.length > historyLimit) list.splice(0, list.length - historyLimit);
    history.set(id, list);
    return rec;
  }

  async function runAllChecks() {
    const ids = Array.from(checks.keys());
    const results = await Promise.all(
      ids.map((id) =>
        runCheck(id).catch((e) => ({
          id,
          status: "fail",
          durationMs: 0,
          output: null,
          error: e?.message || String(e),
          timestamp: new Date().toISOString(),
        })),
      ),
    );
    return results;
  }

  function getCheckHistory(id, limit) {
    const list = history.get(id) || [];
    const n = Number.isFinite(limit) && limit > 0 ? Number(limit) : list.length;
    return list.slice(-n);
  }

  function getCheckStats(id, period) {
    const list = history.get(id) || [];
    const windowMs = parsePeriod(period) ?? 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const inWindow = list.filter((r) => {
      const t = Date.parse(r.timestamp);
      return Number.isFinite(t) && t >= cutoff;
    });
    const total = inWindow.length;
    const passes = inWindow.filter((r) => r.status === "pass").length;
    const failures = total - passes;
    const uptime = total === 0 ? null : (passes / total) * 100;
    const durations = inWindow.map((r) => r.durationMs).filter((d) => Number.isFinite(d));
    const avgDurationMs =
      durations.length === 0 ? null : durations.reduce((a, b) => a + b, 0) / durations.length;
    const sorted = durations.slice().sort((a, b) => a - b);
    const p95 =
      sorted.length === 0
        ? null
        : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const last = list[list.length - 1] || null;
    return {
      id,
      period: period || "24h",
      windowMs,
      total,
      passes,
      failures,
      uptime,
      avgDurationMs,
      p95DurationMs: p95,
      lastStatus: last?.status ?? null,
      lastCheckedAt: last?.timestamp ?? null,
    };
  }

  function start(intervalMs) {
    stop();
    const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    running = true;
    timer = setInterval(() => {
      runAllChecks().catch((e) => {
        console.warn("[synthetic-monitor] runAllChecks error:", e?.message || e);
      });
    }, period);
    if (timer && typeof timer.unref === "function") timer.unref();
    // Fire an initial run
    runAllChecks().catch(() => {});
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    running = false;
  }

  function isRunning() {
    return running;
  }

  return {
    registerCheck,
    unregisterCheck,
    listChecks,
    getCheck,
    runCheck,
    runAllChecks,
    getCheckHistory,
    getCheckStats,
    start,
    stop,
    isRunning,
  };
}

/**
 * Execute a single check configuration and return a structured result.
 *
 * @param {CheckConfig} check
 * @returns {Promise<{status: "pass"|"fail", output?: string|null, error?: string|null}>}
 */
async function executeCheck(check) {
  const timeout = Number(check.timeout) > 0 ? Number(check.timeout) : DEFAULT_TIMEOUT_MS;
  switch (check.type) {
    case "http":
      return executeHttpCheck(check, timeout);
    case "tcp":
      return executeTcpCheck(check, timeout);
    case "dns":
      return executeDnsCheck(check, timeout);
    case "script":
      return executeScriptCheck(check, timeout);
    default:
      return { status: "fail", error: `unknown check type: ${check.type}` };
  }
}

async function executeHttpCheck(check, timeout) {
  const target = check.target;
  if (!target || typeof target !== "object" || !target.url) {
    // Also support target being a URL string
    if (typeof target !== "string") {
      return { status: "fail", error: "http check requires target.url or string URL" };
    }
  }
  const url = typeof target === "string" ? target : target.url;
  const method = (typeof target === "object" && target.method) || "GET";
  const headers = (typeof target === "object" && target.headers) || {};
  const body = typeof target === "object" ? target.body : undefined;

  const expected = check.expected || {};
  const expectedStatus = Array.isArray(expected.status)
    ? expected.status.map(Number)
    : Number.isFinite(expected.status)
      ? [Number(expected.status)]
      : [200];
  const expectContains = typeof expected.contains === "string" ? expected.contains : null;
  const expectContentType = typeof expected.contentType === "string" ? expected.contentType : null;
  const expectJsonField = typeof expected.jsonField === "string" ? expected.jsonField : null;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "User-Agent": "SiskelBot-SyntheticMonitor/1.0",
        ...headers,
      },
      body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
    });
    clearTimeout(t);
    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();

    if (!expectedStatus.includes(res.status)) {
      return {
        status: "fail",
        output: `HTTP ${res.status}`,
        error: `expected status ${expectedStatus.join("|")}, got ${res.status}`,
      };
    }
    if (expectContentType && !contentType.includes(expectContentType)) {
      return {
        status: "fail",
        output: `content-type: ${contentType}`,
        error: `expected content-type to include "${expectContentType}"`,
      };
    }
    if (expectContains && !text.includes(expectContains)) {
      return {
        status: "fail",
        output: text.slice(0, 200),
        error: `expected body to contain "${expectContains}"`,
      };
    }
    if (expectJsonField) {
      try {
        const parsed = JSON.parse(text);
        const val = getPath(parsed, expectJsonField);
        if (val === undefined || val === null) {
          return {
            status: "fail",
            output: text.slice(0, 200),
            error: `expected JSON field "${expectJsonField}" to be present`,
          };
        }
      } catch (e) {
        return {
          status: "fail",
          output: text.slice(0, 200),
          error: `expected valid JSON: ${e.message}`,
        };
      }
    }
    return {
      status: "pass",
      output: `HTTP ${res.status} ${contentType}`,
      error: null,
    };
  } catch (e) {
    clearTimeout(t);
    const msg = e?.name === "AbortError" ? `timeout after ${timeout}ms` : e?.message || String(e);
    return { status: "fail", error: msg };
  }
}

async function executeTcpCheck(check, timeout) {
  const target = check.target;
  let host;
  let port;
  if (typeof target === "string") {
    const idx = target.lastIndexOf(":");
    if (idx < 0) return { status: "fail", error: "tcp check target must be host:port" };
    host = target.slice(0, idx);
    port = Number(target.slice(idx + 1));
  } else if (target && typeof target === "object") {
    host = target.host;
    port = Number(target.port);
  } else {
    return { status: "fail", error: "tcp check requires host:port target" };
  }
  if (!host || !Number.isFinite(port)) {
    return { status: "fail", error: "tcp check requires valid host and port" };
  }
  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolvePromise(result);
    };
    const socket = createConnection({ host, port });
    const t = setTimeout(() => finish({ status: "fail", error: `timeout after ${timeout}ms` }), timeout);
    socket.once("connect", () => {
      clearTimeout(t);
      finish({ status: "pass", output: `connected to ${host}:${port}`, error: null });
    });
    socket.once("error", (err) => {
      clearTimeout(t);
      finish({ status: "fail", error: err.message });
    });
  });
}

async function executeDnsCheck(check, timeout) {
  const target = check.target;
  const hostname = typeof target === "string" ? target : target?.hostname;
  const recordType = (typeof target === "object" && target.recordType) || "A";
  if (!hostname) {
    return { status: "fail", error: "dns check requires hostname" };
  }
  const expectedList = Array.isArray(check.expected?.contains)
    ? check.expected.contains
    : check.expected?.contains
      ? [check.expected.contains]
      : [];
  try {
    const result = await Promise.race([
      dnsResolve(hostname, recordType),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeout}ms`)), timeout),
      ),
    ]);
    const records = Array.isArray(result) ? result : [result];
    if (records.length === 0) {
      return { status: "fail", error: "no records returned" };
    }
    const flat = records.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
    for (const want of expectedList) {
      if (!flat.some((r) => r.includes(String(want)))) {
        return {
          status: "fail",
          output: flat.join(","),
          error: `expected records to include "${want}"`,
        };
      }
    }
    return { status: "pass", output: flat.join(","), error: null };
  } catch (e) {
    return { status: "fail", error: e?.message || String(e) };
  }
}

async function executeScriptCheck(check, timeout) {
  const target = check.target;
  if (typeof target !== "function") {
    return { status: "fail", error: "script check target must be a function" };
  }
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => target()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeout}ms`)), timeout),
      ),
    ]);
    if (result && typeof result === "object" && "status" in result) {
      return {
        status: result.status === "pass" ? "pass" : "fail",
        output: result.output ?? null,
        error: result.error ?? null,
      };
    }
    if (result === false) {
      return { status: "fail", error: "script returned false" };
    }
    return { status: "pass", output: result === true ? null : String(result).slice(0, 200), error: null };
  } catch (e) {
    return { status: "fail", error: e?.message || String(e) };
  }
}

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Parse period strings like "1h", "24h", "7d", "30m", "45s".
 * Returns milliseconds or null if unparseable.
 * @param {string|number|undefined|null} period
 * @returns {number|null}
 */
export function parsePeriod(period) {
  if (period == null) return null;
  if (typeof period === "number") return period > 0 ? period : null;
  const s = String(period).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/);
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2] || "ms";
  const mult = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  }[unit];
  return Number.isFinite(value) && mult ? value * mult : null;
}

/**
 * Register the built-in SiskelBot smoke checks on a monitor.
 * @param {ReturnType<typeof createSyntheticMonitor>} monitor
 * @param {string} baseUrl - e.g. "http://localhost:3000"
 * @param {object} [options]
 * @param {number} [options.interval] - Override interval (ms) for built-ins.
 * @param {number} [options.timeout]  - Override timeout (ms) for built-ins.
 */
export function registerBuiltInChecks(monitor, baseUrl, options = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const interval = Number.isFinite(options.interval) ? options.interval : undefined;
  const timeout = Number.isFinite(options.timeout) ? options.timeout : undefined;

  const common = {};
  if (interval) common.interval = interval;
  if (timeout) common.timeout = timeout;

  monitor.registerCheck({
    id: "health_live",
    name: "Liveness probe",
    type: "http",
    target: { url: `${base}/health/live` },
    expected: { status: 200 },
    ...common,
  });

  monitor.registerCheck({
    id: "health_ready",
    name: "Readiness probe",
    type: "http",
    target: { url: `${base}/health/ready` },
    expected: { status: 200 },
    ...common,
  });

  monitor.registerCheck({
    id: "config",
    name: "Config endpoint",
    type: "http",
    target: { url: `${base}/config` },
    expected: { status: 200, contentType: "application/json", jsonField: "backend" },
    ...common,
  });

  monitor.registerCheck({
    id: "metrics",
    name: "Prometheus metrics",
    type: "http",
    target: { url: `${base}/metrics` },
    expected: { status: [200, 404], contains: "" },
    ...common,
  });

  monitor.registerCheck({
    id: "chat",
    name: "Chat completions smoke test",
    type: "http",
    target: {
      url: `${base}/v1/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { model: "synthetic-monitor-probe", messages: [] },
    },
    // Expect 4xx (bad request / auth / missing backend) without a real backend.
    expected: { status: [400, 401, 403, 422, 503] },
    ...common,
  });
}

// Singleton helper for server.js auto-start scenarios.
let _singleton = null;

/**
 * Get or create the process-wide synthetic monitor instance.
 */
export function getSyntheticMonitor() {
  if (!_singleton) _singleton = createSyntheticMonitor();
  return _singleton;
}
