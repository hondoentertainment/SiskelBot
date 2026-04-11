/**
 * Phase 64.5: Reproducibility routes.
 */
import {
  runReproCheck,
  getChecklist,
  recordResult,
  listChecks,
  exportReport,
} from "../lib/reproducibility.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "reproducibility error");
}

export function mountReproducibilityRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("get", "/research/repro/checklist", log, auth, scope("read"), async (_req, res) => {
    try {
      return res.json({ _version: 1, checklist: getChecklist() });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/research/repro/run", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.subject || typeof body.subject !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "subject required");
      }
      const out = runReproCheck(body.subject);
      if (body.record) {
        await recordResult({ ...out, subjectName: body.subjectName });
      }
      return res.json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/research/repro/record", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await recordResult(req.body || {});
      return res.status(201).json({ _version: 1, result: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/research/repro/list", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listChecks();
      return res.json({ _version: 1, results: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/research/repro/report", log, auth, scope("read"), async (req, res) => {
    try {
      const format = req.query.format === "markdown" ? "markdown" : "json";
      const out = await exportReport(format);
      if (format === "markdown") {
        res.setHeader("Content-Type", "text/markdown");
        return res.send(out);
      }
      return res.json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountReproducibilityRoutes;
