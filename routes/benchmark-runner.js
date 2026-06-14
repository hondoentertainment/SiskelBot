/**
 * Phase 56.2: Benchmark runner routes.
 *
 * POST   /api/v1/benchmark/save                -- body: { name, type, cases }
 * GET    /api/v1/benchmark/runs                -- history (optional ?name=)
 * GET    /api/v1/benchmark/runs/:runId         -- specific run
 * POST   /api/v1/benchmark/compare             -- body: { run1, run2 } (ids or objects)
 * GET    /api/v1/benchmarks                    -- list saved benchmarks
 * GET    /api/v1/benchmark/:name               -- fetch definition
 * DELETE /api/v1/benchmark/:name               -- delete definition
 * POST   /api/v1/benchmark/:name/run           -- body: { target, scorer?, maxCases?, concurrency? }
 *
 * The `target` body parameter is a small schema for test-mode targets so callers
 * can exercise the harness without hitting a real backend:
 *   { mode: "echo" }                           -- returns the case's input.question/prompt/text
 *   { mode: "static", text: "..." }            -- returns a fixed string for every case
 */
import {
  BENCHMARK_TYPES,
  SCORERS,
  loadBenchmark,
  saveBenchmark,
  deleteBenchmark,
  listBenchmarks,
  runBenchmark,
  recordRun,
  getRunHistory,
  compareRuns,
  formatReport,
} from "../lib/benchmark-runner.js";

function extractInputText(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    return String(
      input.question
        ?? input.prompt
        ?? input.text
        ?? input.issue
        ?? JSON.stringify(input)
    );
  }
  return String(input);
}

function buildTargetFn(target) {
  const mode = target?.mode || "echo";
  if (mode === "static") {
    const text = String(target?.text ?? "");
    return async () => text;
  }
  if (mode === "echo") {
    return async (testCase) => extractInputText(testCase?.input);
  }
  throw new Error(`unsupported target mode: ${mode}`);
}

export function mountBenchmarkRunnerRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;

  apiRoute("get", "/benchmark/types", logRequest, (_req, res) => {
    res.json({
      types: BENCHMARK_TYPES,
      scorers: Object.keys(SCORERS),
    });
  });

  apiRoute("post", "/benchmark/save", logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (!Array.isArray(body.cases)) {
        return apiError(res, 400, "INVALID_INPUT", "cases must be an array");
      }
      const saved = await saveBenchmark(name, { type: body.type, cases: body.cases });
      res.status(201).json(saved);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/benchmarks", logRequest, async (_req, res) => {
    try {
      const items = await listBenchmarks();
      res.json({ benchmarks: items, count: items.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // Run history — defined before /:name so it doesn't get shadowed.
  apiRoute("get", "/benchmark/runs", logRequest, async (req, res) => {
    try {
      const name = typeof req.query?.name === "string" && req.query.name.trim()
        ? req.query.name.trim()
        : null;
      const runs = await getRunHistory(name);
      res.json({ runs, count: runs.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/benchmark/runs/:runId", logRequest, async (req, res) => {
    try {
      const runId = String(req.params.runId || "").trim();
      if (!runId) return apiError(res, 400, "INVALID_INPUT", "runId is required");
      const runs = await getRunHistory(null);
      const found = runs.find((r) => r.runId === runId);
      if (!found) return apiError(res, 404, "NOT_FOUND", `run ${runId} not found`);
      res.json(found);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/benchmark/compare", logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      let { run1, run2 } = body;
      if (!run1 || !run2) {
        return apiError(res, 400, "INVALID_INPUT", "run1 and run2 are required");
      }
      if (typeof run1 === "string" || typeof run2 === "string") {
        const all = await getRunHistory(null);
        if (typeof run1 === "string") run1 = all.find((r) => r.runId === run1);
        if (typeof run2 === "string") run2 = all.find((r) => r.runId === run2);
      }
      if (!run1 || !run2) {
        return apiError(res, 404, "NOT_FOUND", "one or both runs not found");
      }
      const diff = compareRuns(run1, run2);
      res.json(diff);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/benchmark/:name", logRequest, async (req, res) => {
    try {
      const name = String(req.params.name || "").trim();
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      const bench = await loadBenchmark(name);
      if (!bench) return apiError(res, 404, "NOT_FOUND", `benchmark ${name} not found`);
      res.json(bench);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("delete", "/benchmark/:name", logRequest, async (req, res) => {
    try {
      const name = String(req.params.name || "").trim();
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      const result = await deleteBenchmark(name);
      if (!result.deleted) return apiError(res, 404, "NOT_FOUND", `benchmark ${name} not found`);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/benchmark/:name/run", logRequest, async (req, res) => {
    try {
      const name = String(req.params.name || "").trim();
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      const body = req.body || {};
      const bench = await loadBenchmark(name);
      if (!bench) return apiError(res, 404, "NOT_FOUND", `benchmark ${name} not found`);

      let targetFn;
      try {
        targetFn = buildTargetFn(body.target || { mode: "echo" });
      } catch (e) {
        return apiError(res, 400, "INVALID_INPUT", e.message);
      }

      const options = {
        benchmark: bench,
        type: bench.type,
        scorer: typeof body.scorer === "string" && body.scorer.trim() ? body.scorer.trim() : undefined,
        maxCases: Number.isFinite(body.maxCases) ? body.maxCases : undefined,
        concurrency: Number.isFinite(body.concurrency) ? body.concurrency : undefined,
      };

      let result;
      try {
        result = await runBenchmark(name, targetFn, options);
      } catch (e) {
        return apiError(res, 400, "INVALID_INPUT", e.message);
      }
      await recordRun(result).catch(() => {});
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountBenchmarkRunnerRoutes;
