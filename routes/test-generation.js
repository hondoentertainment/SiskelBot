/**
 * Phase 63.3: Test generation routes.
 */
import {
  analyzeCoverage,
  generateTestScaffold,
  listGaps,
  recordGeneratedTest,
  getSuggestedFixtures,
} from "../lib/test-generation.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "test-generation error");
}

export function mountTestGenerationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/code/test-gen/analyze", log, auth, scope("write"), async (req, res) => {
    try {
      const gaps = await analyzeCoverage(req.body || {});
      return res.json({ _version: 1, gaps, count: gaps.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/code/test-gen/gaps", log, auth, scope("read"), async (_req, res) => {
    try {
      const gaps = await listGaps();
      return res.json({ _version: 1, gaps, count: gaps.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/code/test-gen/scaffold", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.signature) return apiError(res, 400, "INVALID_INPUT", "signature required");
      const out = generateTestScaffold(body);
      return res.json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/code/test-gen/record", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await recordGeneratedTest(req.body || {});
      return res.status(201).json({ _version: 1, record: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/code/test-gen/fixtures", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.signature) return apiError(res, 400, "INVALID_INPUT", "signature required");
      const fixtures = getSuggestedFixtures(body.signature);
      return res.json({ _version: 1, fixtures });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountTestGenerationRoutes;
