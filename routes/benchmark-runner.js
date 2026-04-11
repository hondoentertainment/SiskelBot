/**
 * Phase 56.2: Benchmark runner routes.
 *
 * GET  /api/v1/benchmarks                -- list benchmarks
 * POST /api/v1/benchmarks/:name/run      -- run a benchmark
 * GET  /api/v1/benchmarks/:name/history  -- run history for a benchmark
 * POST /api/v1/benchmarks/compare        -- compare two runs
 * POST /api/v1/benchmarks/register       -- register a custom fixture (admin)
 */
import {
  listBenchmarks,
  runBenchmark,
  getBenchmarkHistory,
  compareRuns,
  registerBenchmark,
} from "../lib/benchmark-runner.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "benchmark-runner error");
}

export function mountBenchmarkRunnerRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("get", "/benchmarks", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = listBenchmarks();
      return res.json({ _version: 1, benchmarks: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/benchmarks/:name/run", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const run = await runBenchmark(req.params.name, {
        model: body.model,
        limit: body.limit,
      });
      return res.status(201).json({ _version: 1, run });
    } catch (err) {
      const status = /unknown benchmark/i.test(err?.message || "") ? 404
        : /required/i.test(err?.message || "") ? 400 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/benchmarks/:name/history", log, auth, scope("read"), async (req, res) => {
    try {
      const history = await getBenchmarkHistory(req.params.name);
      return res.json({ _version: 1, name: req.params.name, history });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/benchmarks/compare", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.runIdA || !body.runIdB) {
        return apiError(res, 400, "INVALID_INPUT", "runIdA and runIdB required");
      }
      const diff = await compareRuns(body.runIdA, body.runIdB);
      return res.json({ _version: 1, comparison: diff });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404
        : /required/i.test(err?.message || "") ? 400 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/benchmarks/register", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || !body.fixture) {
        return apiError(res, 400, "INVALID_INPUT", "name and fixture required");
      }
      registerBenchmark(body.name, body.fixture);
      return res.status(201).json({ _version: 1, registered: body.name });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountBenchmarkRunnerRoutes;
