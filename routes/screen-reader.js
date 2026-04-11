/**
 * Phase 70.1: Screen reader routes.
 */
import {
  auditHtml,
  suggestAriaLabels,
  getAuditReport,
  listIssues,
  fixIssue,
} from "../lib/screen-reader.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "screen-reader error");
}

export function mountScreenReaderRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/screen-reader/audit", log, auth, scope("read"), async (req, res) => {
    try {
      const html = typeof req.body?.html === "string" ? req.body.html : "";
      if (!html) return apiError(res, 400, "INVALID_INPUT", "html is required");
      const report = await auditHtml(html, req.body || {});
      return res.status(201).json({ _version: 1, report });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/screen-reader/suggest", log, auth, scope("read"), async (req, res) => {
    try {
      const label = suggestAriaLabels(req.body || {});
      return res.json({ _version: 1, label });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/screen-reader/reports/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const r = await getAuditReport(req.params.id);
      if (!r) return apiError(res, 404, "NOT_FOUND", "report not found");
      return res.json({ _version: 1, report: r });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/screen-reader/issues", log, auth, scope("read"), async (req, res) => {
    try {
      const status = typeof req.query?.status === "string" ? req.query.status : undefined;
      const severity = typeof req.query?.severity === "string" ? req.query.severity : undefined;
      const items = await listIssues({ status, severity });
      return res.json({ _version: 1, issues: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/screen-reader/issues/:id/fix", log, auth, scope("write"), async (req, res) => {
    try {
      const r = await fixIssue(req.params.id, req.body || {});
      return res.json({ _version: 1, issue: r });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountScreenReaderRoutes;
