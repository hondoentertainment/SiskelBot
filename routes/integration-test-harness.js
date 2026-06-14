/**
 * Phase 61.3: Integration test harness routes.
 *
 * POST /api/v1/integration-tests/run          — run a recipe test
 * GET  /api/v1/integration-tests/runs         — list runs
 * GET  /api/v1/integration-tests/runs/:id     — fetch single run
 *
 * All routes require admin auth.
 */
import {
  runRecipeTest,
  listTestRuns,
  getTestRun,
} from "../lib/integration-test-harness.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountIntegrationTestHarnessRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // POST /integration-tests/run
  apiRoute("post", "/integration-tests/run", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.recipe) {
        return apiError(res, 400, "INVALID_INPUT", "recipe is required");
      }
      const result = await runRecipeTest(body.recipe, { name: body.name });
      res.status(201).json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /integration-tests/runs
  apiRoute("get", "/integration-tests/runs", adminAuth, logRequest, async (req, res) => {
    try {
      const runs = await listTestRuns({
        limit: Number(req.query?.limit) || 50,
        status: req.query?.status ? String(req.query.status) : undefined,
        name: req.query?.name ? String(req.query.name) : undefined,
      });
      res.json({ runs });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /integration-tests/runs/:id
  apiRoute("get", "/integration-tests/runs/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const run = await getTestRun(req.params.id);
      if (!run) return apiError(res, 404, "NOT_FOUND", "run not found");
      res.json(run);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountIntegrationTestHarnessRoutes;
