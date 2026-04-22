/**
 * Wave-2: Continuous eval-live sampling with LLM judge.
 *
 * Samples a small fraction of completed agent runs and scores them with the
 * existing eval-judge. Results are appended to data/eval-live/results.json so
 * operators can see quality drift on live traffic. Complements eval-in-prod.js
 * (which is shadow-traffic diff-based, not judge-based).
 *
 * All hooks are best-effort, fire-and-forget, and no-op by default.
 *
 * Env flags:
 *   EVAL_LIVE_SAMPLING=1            enable
 *   EVAL_LIVE_SAMPLE_RATE=0.02      fraction 0..1 (default 2%)
 *   EVAL_LIVE_JUDGE_MODEL=...       override judge model
 *   EVAL_LIVE_JUDGE_URL=...         override judge base URL
 *   EVAL_LIVE_JUDGE_KEY=...         override judge API key
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_LIVE_RESULTS = 10_000;
const DEFAULT_SAMPLE_RATE = 0.02;
const DEFAULT_RUBRIC =
  "Answer correctness, clarity, and relevance to the user's request. " +
  "Judge pass=true when the response directly addresses the request without hallucinated facts.";

export function liveSamplingEnabled() {
  return process.env.EVAL_LIVE_SAMPLING === "1";
}

export function getSampleRate() {
  const raw = Number(process.env.EVAL_LIVE_SAMPLE_RATE);
  if (!Number.isFinite(raw)) return DEFAULT_SAMPLE_RATE;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

/**
 * Returns true for a sampled fraction of runs. Accepts an injectable rng so
 * tests can make the decision deterministic.
 */
export function shouldSample(rate, rng = Math.random) {
  if (!liveSamplingEnabled()) return false;
  const r = typeof rate === "number" ? rate : getSampleRate();
  if (r <= 0) return false;
  if (r >= 1) return true;
  return rng() < r;
}

function resultsPath() {
  return join(getDataDir(), "eval-live", "results.json");
}

async function loadResults() {
  const raw = await readJsonPath(resultsPath(), { _version: 1, results: [] });
  return Array.isArray(raw.results) ? raw.results : [];
}

async function saveResults(results) {
  const trimmed = results.length > MAX_LIVE_RESULTS ? results.slice(-MAX_LIVE_RESULTS) : results;
  await writeJsonPath(resultsPath(), { _version: 1, results: trimmed });
}

/**
 * Judge a single run using the existing eval-judge. Best-effort: returns null
 * on any failure so callers can fire-and-forget safely.
 *
 * @param {{
 *   assistantOutput: string,
 *   rubric?: string,
 *   baseUrl?: string,
 *   apiKey?: string,
 *   model?: string,
 * }} params
 * @returns {Promise<{ pass: boolean, reason: string } | null>}
 */
export async function judgeLiveRun(params) {
  if (!params || typeof params.assistantOutput !== "string") return null;
  try {
    const { runEvalJudge } = await import("./eval-judge.js");
    const baseUrl =
      params.baseUrl ||
      process.env.EVAL_LIVE_JUDGE_URL ||
      process.env.OLLAMA_URL ||
      "http://localhost:11434";
    const apiKey =
      params.apiKey || process.env.EVAL_LIVE_JUDGE_KEY || process.env.OPENAI_API_KEY || "";
    const model = params.model || process.env.EVAL_LIVE_JUDGE_MODEL || "gpt-4o-mini";
    const rubric = params.rubric || DEFAULT_RUBRIC;
    const verdict = await runEvalJudge(baseUrl, apiKey, model, params.assistantOutput, rubric);
    if (!verdict || typeof verdict.pass !== "boolean") return null;
    return { pass: verdict.pass, reason: String(verdict.reason || "") };
  } catch {
    return null;
  }
}

/**
 * Record a judged run to the live results store. Best-effort.
 */
export async function recordLiveEvalResult(entry) {
  try {
    const path = resultsPath();
    await withPathLock(path, async () => {
      const results = await loadResults();
      results.push({
        t: Date.now(),
        runId: String(entry.runId || ""),
        workspace: String(entry.workspace || "default"),
        userMessage: String(entry.userMessage || "").slice(0, 500),
        pass: entry.pass === true,
        reason: String(entry.reason || "").slice(0, 500),
        model: entry.model ? String(entry.model).slice(0, 120) : null,
        durationMs: Number(entry.durationMs) || 0,
      });
      await saveResults(results);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * One-shot sample + judge + record. Safe to fire-and-forget from the agent loop.
 *
 * @returns {Promise<{ sampled: boolean, judged: boolean, pass: boolean|null }>}
 */
export async function sampleAndJudge(params) {
  if (!shouldSample()) return { sampled: false, judged: false, pass: null };
  const verdict = await judgeLiveRun(params);
  if (!verdict) return { sampled: true, judged: false, pass: null };
  await recordLiveEvalResult({
    runId: params.runId || "",
    workspace: params.workspace || "default",
    userMessage: params.userMessage || "",
    pass: verdict.pass,
    reason: verdict.reason,
    model: params.model || null,
    durationMs: params.durationMs || 0,
  });
  return { sampled: true, judged: true, pass: verdict.pass };
}

/**
 * Summarize recent live results, optionally scoped by workspace.
 */
export async function getLiveQualitySummary(opts = {}) {
  try {
    const all = await loadResults();
    const filtered = opts.workspace ? all.filter((r) => r.workspace === opts.workspace) : all;
    const limit = Math.min(1000, Math.max(1, Number(opts.limit) || 100));
    const recent = filtered.slice(-limit);
    const total = recent.length;
    const passed = recent.filter((r) => r.pass === true).length;
    return {
      total,
      passed,
      passRate: total === 0 ? 0 : passed / total,
      recent: recent.map((r) => ({
        t: r.t,
        runId: r.runId,
        workspace: r.workspace,
        pass: r.pass,
        reason: r.reason,
        model: r.model,
      })),
    };
  } catch {
    return { total: 0, passed: 0, passRate: 0, recent: [] };
  }
}
