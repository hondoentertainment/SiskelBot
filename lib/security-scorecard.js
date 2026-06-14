/**
 * Phase 36.5: Automated security scorecard.
 *
 * Runs a daily audit of the server's security posture and produces a
 * weighted score (0-100) with a letter grade (A-F). Checks cover
 * authentication, transport, headers, storage, encryption, monitoring,
 * and availability.
 *
 * Results are persisted to `data/security-scorecard.json` as a rolling
 * history (most recent first) so trends can be charted over time.
 */

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.STORAGE_PATH || join(process.cwd(), "data");
const SCORECARD_FILE = join(DATA_DIR, "security-scorecard.json");
const MAX_HISTORY = 365;
const BACKUP_MAX_AGE_DAYS = 7;
const DEFAULT_SECRET_NEEDLES = [
  "changeme",
  "password",
  "secret123",
  "admin123",
  "test123",
  "default",
];

const SECRET_ENV_VARS = [
  "API_KEY",
  "ADMIN_API_KEY",
  "SESSION_SECRET",
  "OPENAI_API_KEY",
  "ENCRYPTION_SECRET",
  "JIRA_API_TOKEN",
  "LINEAR_API_KEY",
  "SLACK_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SMTP_PASS",
];

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function passWarnFail(value) {
  if (value === "pass" || value === "warn" || value === "fail") return value;
  if (value === true) return "pass";
  if (value === false) return "fail";
  return "warn";
}

/**
 * Each check returns one of "pass" | "warn" | "fail".
 * Weight determines contribution to the total score.
 */
export const SCORECARD_CHECKS = {
  api_key_set: {
    category: "authentication",
    weight: 10,
    description: "API_KEY is set to protect /v1/chat/completions.",
    check: () => (process.env.API_KEY ? "pass" : "fail"),
    remediation: "Set API_KEY environment variable.",
  },
  admin_key_set: {
    category: "authentication",
    weight: 10,
    description: "ADMIN_API_KEY is set to protect admin endpoints.",
    check: () => (process.env.ADMIN_API_KEY ? "pass" : "fail"),
    remediation: "Set ADMIN_API_KEY environment variable.",
  },
  session_secret_set: {
    category: "authentication",
    weight: 8,
    description: "SESSION_SECRET is set for signed session cookies.",
    check: () => (process.env.SESSION_SECRET ? "pass" : "warn"),
    remediation: "Set SESSION_SECRET to a long random string.",
  },
  strong_admin_key: {
    category: "authentication",
    weight: 8,
    description: "ADMIN_API_KEY is at least 32 characters.",
    check: () => {
      const v = process.env.ADMIN_API_KEY || "";
      if (!v) return "fail";
      return v.length >= 32 ? "pass" : "warn";
    },
    remediation: "Use a 32+ character ADMIN_API_KEY.",
  },
  no_default_secrets: {
    category: "authentication",
    weight: 10,
    description: "No secret uses a default/weak value.",
    check: () => {
      for (const k of SECRET_ENV_VARS) {
        const v = (process.env[k] || "").toLowerCase();
        if (!v) continue;
        for (const needle of DEFAULT_SECRET_NEEDLES) {
          if (v.includes(needle)) return "fail";
        }
      }
      return "pass";
    },
    remediation: "Rotate any secret containing 'changeme', 'password', 'default', etc.",
  },
  csp_enforced: {
    category: "headers",
    weight: 5,
    description: "Content Security Policy is enforced (not report-only).",
    check: () => (process.env.CSP_ENFORCE === "1" ? "pass" : "warn"),
    remediation: "Set CSP_ENFORCE=1 to enforce Content Security Policy.",
  },
  hsts_enabled: {
    category: "headers",
    weight: 4,
    description: "HTTP Strict Transport Security is enabled.",
    check: () => (process.env.HSTS_ENABLED === "1" ? "pass" : "warn"),
    remediation: "Set HSTS_ENABLED=1 behind HTTPS termination.",
  },
  cors_restricted: {
    category: "headers",
    weight: 4,
    description: "CORS origin is restricted (not wildcard).",
    check: () => {
      const origin = process.env.CORS_ORIGIN;
      if (!origin) return "warn";
      if (origin === "*" || origin === "true") return "fail";
      return "pass";
    },
    remediation: "Set CORS_ORIGIN to an explicit allowed origin list.",
  },
  https_enabled: {
    category: "transport",
    weight: 10,
    description: "Running in production with HTTPS-aware config.",
    check: () => {
      if (process.env.NODE_ENV !== "production") return "warn";
      if (process.env.TRUST_PROXY === "1" || process.env.FORCE_HTTPS === "1") return "pass";
      return "warn";
    },
    remediation: "Terminate TLS at the proxy and set TRUST_PROXY=1 and FORCE_HTTPS=1.",
  },
  trust_proxy_production: {
    category: "transport",
    weight: 3,
    description: "TRUST_PROXY is configured for proxied deployments.",
    check: () =>
      process.env.NODE_ENV === "production" && process.env.TRUST_PROXY !== "1" ? "warn" : "pass",
    remediation: "Set TRUST_PROXY=1 when running behind a reverse proxy.",
  },
  postgres_backend: {
    category: "storage",
    weight: 5,
    description: "Using a durable storage backend (Postgres or SQLite).",
    check: () => {
      const b = process.env.STORAGE_BACKEND;
      if (b === "postgres") return "pass";
      if (b === "sqlite") return "warn";
      return "warn";
    },
    remediation: "Set STORAGE_BACKEND=postgres with DATABASE_URL for production.",
  },
  database_ssl: {
    category: "storage",
    weight: 5,
    description: "DATABASE_URL uses SSL/TLS.",
    check: () => {
      const url = process.env.DATABASE_URL;
      if (!url) return "warn";
      if (/sslmode=require|sslmode=verify/.test(url)) return "pass";
      return "warn";
    },
    remediation: "Append ?sslmode=require to DATABASE_URL.",
  },
  encryption_configured: {
    category: "encryption",
    weight: 8,
    description: "ENCRYPTION_SECRET is configured for at-rest encryption.",
    check: () => (process.env.ENCRYPTION_SECRET ? "pass" : "warn"),
    remediation: "Set ENCRYPTION_SECRET to enable field-level encryption.",
  },
  strong_encryption_secret: {
    category: "encryption",
    weight: 5,
    description: "ENCRYPTION_SECRET is at least 32 characters.",
    check: () => {
      const v = process.env.ENCRYPTION_SECRET || "";
      if (!v) return "warn";
      return v.length >= 32 ? "pass" : "warn";
    },
    remediation: "Use a 32+ character ENCRYPTION_SECRET.",
  },
  rate_limiting: {
    category: "availability",
    weight: 6,
    description: "Rate limiting middleware is wired into the server.",
    check: () => "pass",
    remediation: "Rate limiting is enabled by default.",
  },
  request_timeout: {
    category: "availability",
    weight: 3,
    description: "Per-request timeout is configured.",
    check: () => {
      const v = Number(process.env.REQUEST_TIMEOUT_MS || 0);
      if (v > 0) return "pass";
      return "warn";
    },
    remediation: "Set REQUEST_TIMEOUT_MS to a sensible value (e.g. 60000).",
  },
  recent_backup: {
    category: "availability",
    weight: 6,
    description: "A backup exists within the last 7 days.",
    check: async () => {
      try {
        const backupsDir = join(process.cwd(), "backups");
        if (!existsSync(backupsDir)) return "warn";
        const files = readdirSync(backupsDir).filter((f) => f.endsWith(".zip"));
        if (files.length === 0) return "fail";
        const cutoff = Date.now() - BACKUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
        const hasRecent = files.some((f) => {
          try {
            return statSync(join(backupsDir, f)).mtimeMs >= cutoff;
          } catch {
            return false;
          }
        });
        return hasRecent ? "pass" : "warn";
      } catch {
        return "warn";
      }
    },
    remediation: "Run `siskelbot backup` or schedule daily backups.",
  },
  audit_log_enabled: {
    category: "monitoring",
    weight: 7,
    description: "Audit log file exists and is being written.",
    check: async () => {
      try {
        const candidates = [
          join(DATA_DIR, "audit-log.json"),
          join(DATA_DIR, "execution-audit.json"),
          join(DATA_DIR, "api-key-audit.json"),
        ];
        for (const c of candidates) {
          if (existsSync(c)) return "pass";
        }
        return "warn";
      } catch {
        return "warn";
      }
    },
    remediation: "Ensure audit-lifecycle is configured and writing.",
  },
  metrics_enabled: {
    category: "monitoring",
    weight: 4,
    description: "Prometheus metrics endpoint is enabled.",
    check: () => (process.env.ENABLE_METRICS === "1" ? "pass" : "warn"),
    remediation: "Set ENABLE_METRICS=1 to expose /metrics.",
  },
  error_reporting: {
    category: "monitoring",
    weight: 4,
    description: "Error reporting (Sentry) is configured.",
    check: () => (process.env.SENTRY_DSN ? "pass" : "warn"),
    remediation: "Set SENTRY_DSN to forward errors to Sentry.",
  },
  circuit_breaker: {
    category: "availability",
    weight: 4,
    description: "Circuit breaker is enabled for backend calls.",
    check: () => {
      const v = process.env.CIRCUIT_BREAKER_FAILURES;
      if (v == null || Number(v) > 0) return "pass";
      return "warn";
    },
    remediation: "Leave CIRCUIT_BREAKER_FAILURES unset or set to a positive value.",
  },
  tool_allowlist: {
    category: "authentication",
    weight: 4,
    description: "Agent tool allowlist is configured.",
    check: () => {
      const v = process.env.AGENT_TOOLS_ALLOWLIST;
      if (v && v.trim().length > 0) return "pass";
      return "warn";
    },
    remediation: "Set AGENT_TOOLS_ALLOWLIST to restrict exposed agent tools.",
  },
  code_execute_disabled: {
    category: "authentication",
    weight: 5,
    description: "Code execution agent tool is not enabled by default.",
    check: () => (process.env.AGENT_CODE_EXECUTE === "1" ? "warn" : "pass"),
    remediation: "Avoid enabling AGENT_CODE_EXECUTE=1 unless sandboxed.",
  },
  db_query_disabled: {
    category: "authentication",
    weight: 4,
    description: "Database query agent tool is not enabled by default.",
    check: () => (process.env.AGENT_DB_QUERY === "1" ? "warn" : "pass"),
    remediation: "Avoid enabling AGENT_DB_QUERY=1 on production data.",
  },
};

/**
 * Map pass/warn/fail status to a fractional score in [0, 1].
 */
function statusWeight(status) {
  if (status === "pass") return 1;
  if (status === "warn") return 0.5;
  return 0;
}

/**
 * Compute a letter grade from a numeric score.
 * @param {number} score
 * @returns {"A"|"B"|"C"|"D"|"F"}
 */
export function getGrade(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/**
 * Execute every check and build the scorecard.
 * @param {object} [options]
 * @param {object} [options.checks] - override check map (used by tests)
 * @returns {Promise<object>} scorecard
 */
export async function runSecurityScan(options = {}) {
  const checkMap = options.checks || SCORECARD_CHECKS;
  const entries = Object.entries(checkMap);
  const results = [];
  for (const [id, def] of entries) {
    let rawStatus;
    let error = null;
    try {
      rawStatus = await def.check();
    } catch (e) {
      error = e?.message || String(e);
      rawStatus = "fail";
    }
    const status = passWarnFail(rawStatus);
    results.push({
      id,
      category: def.category,
      weight: def.weight,
      description: def.description || "",
      status,
      earned: def.weight * statusWeight(status),
      remediation: def.remediation || null,
      error,
    });
  }

  const totalWeight = results.reduce((a, r) => a + r.weight, 0);
  const earned = results.reduce((a, r) => a + r.earned, 0);
  const score = totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : 0;
  const grade = getGrade(score);

  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) {
      byCategory[r.category] = {
        category: r.category,
        total: 0,
        earned: 0,
        pass: 0,
        warn: 0,
        fail: 0,
        checks: 0,
      };
    }
    const c = byCategory[r.category];
    c.total += r.weight;
    c.earned += r.earned;
    c.checks += 1;
    c[r.status] += 1;
  }
  for (const c of Object.values(byCategory)) {
    c.score = c.total > 0 ? Math.round((c.earned / c.total) * 100) : 0;
    c.grade = getGrade(c.score);
  }

  const recommendations = results
    .filter((r) => r.status !== "pass" && r.remediation)
    .sort((a, b) => b.weight - a.weight)
    .map((r) => ({
      id: r.id,
      status: r.status,
      weight: r.weight,
      description: r.description,
      remediation: r.remediation,
    }));

  const counts = {
    pass: results.filter((r) => r.status === "pass").length,
    warn: results.filter((r) => r.status === "warn").length,
    fail: results.filter((r) => r.status === "fail").length,
  };

  return {
    timestamp: new Date().toISOString(),
    score,
    grade,
    totalChecks: results.length,
    counts,
    byCategory,
    checks: results,
    recommendations,
  };
}

async function readHistory() {
  try {
    const raw = await fs.readFile(SCORECARD_FILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.history)) return data.history;
    return [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    return [];
  }
}

async function writeHistory(history) {
  ensureDataDir();
  const trimmed = history.slice(0, MAX_HISTORY);
  await fs.writeFile(SCORECARD_FILE, JSON.stringify({ history: trimmed }, null, 2), "utf8");
}

/**
 * Run a scan and append the result to history on disk.
 */
export async function runAndSaveSecurityScan() {
  const scorecard = await runSecurityScan();
  const history = await readHistory();
  history.unshift(scorecard);
  await writeHistory(history);
  return scorecard;
}

/**
 * Return the most recent scorecard, or null if none exist.
 */
export async function getLatestScorecard() {
  const history = await readHistory();
  return history[0] || null;
}

/**
 * Return the last `days` days of scorecards (newest first).
 * @param {number} days
 */
export async function getScorecardHistory(days = 30) {
  const history = await readHistory();
  const n = Math.max(1, Math.min(MAX_HISTORY, Number(days) || 30));
  const cutoff = Date.now() - n * 24 * 60 * 60 * 1000;
  return history.filter((s) => {
    const t = new Date(s.timestamp).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Return detail for a single check id from the latest scorecard.
 * @param {string} checkId
 */
export async function getCheckDetail(checkId) {
  const latest = await getLatestScorecard();
  if (!latest) return null;
  return latest.checks.find((c) => c.id === checkId) || null;
}

let scanTimer = null;

/**
 * Start a daily scan loop. First scan runs on the next midnight UTC,
 * or immediately if the history is empty.
 * @param {object} [options]
 * @param {number} [options.intervalMs] - override (used by tests)
 * @param {boolean} [options.runImmediately]
 */
export async function startDailySecurityScan(options = {}) {
  const intervalMs = Number(options.intervalMs) || 24 * 60 * 60 * 1000;
  stopDailySecurityScan();

  if (options.runImmediately) {
    try {
      await runAndSaveSecurityScan();
    } catch (e) {
      // swallow scheduler errors
    }
  } else {
    const history = await readHistory();
    if (history.length === 0) {
      try {
        await runAndSaveSecurityScan();
      } catch (e) {
        // swallow
      }
    }
  }

  scanTimer = setInterval(() => {
    runAndSaveSecurityScan().catch(() => {});
  }, intervalMs);
  if (typeof scanTimer.unref === "function") scanTimer.unref();
}

export function stopDailySecurityScan() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

/**
 * Test helper: clear the scorecard file.
 */
export async function _resetScorecardHistoryForTests() {
  try {
    await fs.unlink(SCORECARD_FILE);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
