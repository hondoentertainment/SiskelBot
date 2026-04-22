/**
 * Wave-2: Eval suite run history. Persists each completed eval suite run
 * (suite ID, timestamp, pass/fail counts, per-case results, durationMs) to
 * data/eval-runs/history.json so the UI can render a pass-rate trend and CI
 * can detect regressions.
 *
 * Distinct from eval-history-store.js, which is for arbitrary metric samples.
 * This store is suite-run-scoped: one entry per `runEvalSet()` completion or
 * per `npm run eval:golden` invocation.
 *
 * All operations are best-effort.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_HISTORY = 1000;

function historyPath() {
  return join(getDataDir(), "eval-runs", "history.json");
}

async function loadHistory() {
  const raw = await readJsonPath(historyPath(), { _version: 1, runs: [] });
  return Array.isArray(raw.runs) ? raw.runs : [];
}

async function saveHistory(runs) {
  const trimmed = runs.length > MAX_HISTORY ? runs.slice(-MAX_HISTORY) : runs;
  await writeJsonPath(historyPath(), { _version: 1, runs: trimmed });
}

/**
 * Append a single eval suite run. Best-effort.
 *
 * @param {{
 *   suiteId: string,
 *   passed: number,
 *   total: number,
 *   skipped?: number,
 *   durationMs?: number,
 *   results?: Array<{ id: string, pass: boolean, reason?: string }>,
 *   meta?: object,
 * }} run
 * @returns {Promise<boolean>}
 */
export async function recordEvalRun(run) {
  if (!run || typeof run.suiteId !== "string" || !run.suiteId) return false;
  if (typeof run.total !== "number" || typeof run.passed !== "number") return false;
  try {
    const path = historyPath();
    await withPathLock(path, async () => {
      const runs = await loadHistory();
      const passRate = run.total === 0 ? 0 : run.passed / run.total;
      runs.push({
        t: Date.now(),
        suiteId: run.suiteId,
        passed: run.passed,
        total: run.total,
        skipped: Number(run.skipped) || 0,
        passRate: Number(passRate.toFixed(4)),
        durationMs: Number(run.durationMs) || 0,
        results: Array.isArray(run.results)
          ? run.results.slice(0, 500).map((r) => ({
              id: String(r.id || ""),
              pass: r.pass === true,
              reason: r.reason ? String(r.reason).slice(0, 300) : undefined,
            }))
          : [],
        meta: run.meta && typeof run.meta === "object" ? run.meta : {},
      });
      await saveHistory(runs);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * List recent runs, newest-first, optionally scoped to a suite.
 *
 * @param {{ suiteId?: string, limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listEvalRuns(opts = {}) {
  try {
    const runs = await loadHistory();
    const filtered = opts.suiteId ? runs.filter((r) => r.suiteId === opts.suiteId) : runs;
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 30));
    return filtered.slice(-limit).reverse();
  } catch {
    return [];
  }
}

/**
 * Detect regression vs. the previous run of the same suite. Returns null
 * unless the current run's pass rate dropped by at least `regressionThreshold`
 * (default 0.05 = 5 percentage points).
 *
 * @param {string} suiteId
 * @param {{ regressionThreshold?: number }} [opts]
 * @returns {Promise<null | { current: number, previous: number, delta: number }>}
 */
export async function detectRegression(suiteId, opts = {}) {
  try {
    const threshold = typeof opts.regressionThreshold === "number" ? opts.regressionThreshold : 0.05;
    const runs = await loadHistory();
    const suite = runs.filter((r) => r.suiteId === suiteId);
    if (suite.length < 2) return null;
    const current = suite[suite.length - 1];
    const previous = suite[suite.length - 2];
    const delta = current.passRate - previous.passRate;
    if (delta >= -threshold) return null;
    return { current: current.passRate, previous: previous.passRate, delta };
  } catch {
    return null;
  }
}

/**
 * Pass-rate sparkline points for a suite, oldest-first.
 *
 * @param {string} suiteId
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ t: number, passRate: number, passed: number, total: number }>>}
 */
export async function getPassRateTrend(suiteId, opts = {}) {
  try {
    const runs = await loadHistory();
    const filtered = runs.filter((r) => r.suiteId === suiteId);
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 30));
    return filtered.slice(-limit).map((r) => ({
      t: r.t,
      passRate: r.passRate,
      passed: r.passed,
      total: r.total,
    }));
  } catch {
    return [];
  }
}
