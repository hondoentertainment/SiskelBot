/**
 * Phase 54.5: Document layout parsing routes.
 *
 * POST /api/v1/doc-layout/parse        -- body { text, hints? }
 * POST /api/v1/doc-layout/tables       -- body { text, allowCsv? }
 * POST /api/v1/doc-layout/figures      -- body { text }
 * POST /api/v1/doc-layout/form-fields  -- body { text }
 * POST /api/v1/doc-layout/reading-order-- body { text, hints? }
 */
import {
  parseLayout,
  extractTables,
  extractFigures,
  extractFormFields,
  extractReadingOrder,
} from "../lib/doc-layout.js";

function sendError(apiError, res, err, status = 500) {
  const code =
    status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "doc-layout error");
}

function requireText(apiError, res, body) {
  if (!body || typeof body.text !== "string") {
    apiError(res, 400, "INVALID_INPUT", "text is required");
    return false;
  }
  return true;
}

export function mountDocLayoutRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/doc-layout/parse", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!requireText(apiError, res, body)) return;
      const result = parseLayout(body.text, { hints: body.hints });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/doc-layout/tables", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!requireText(apiError, res, body)) return;
      const tables = extractTables(body.text, {
        allowCsv: Boolean(body.allowCsv),
        hints: body.hints,
      });
      return res.json({ _version: 1, tables, count: tables.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/doc-layout/figures", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!requireText(apiError, res, body)) return;
      const figures = extractFigures(body.text, { hints: body.hints });
      return res.json({ _version: 1, figures, count: figures.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/doc-layout/form-fields", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!requireText(apiError, res, body)) return;
      const fields = extractFormFields(body.text, { hints: body.hints });
      return res.json({ _version: 1, formFields: fields, count: fields.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/doc-layout/reading-order", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!requireText(apiError, res, body)) return;
      const blocks = extractReadingOrder(body.text, { hints: body.hints });
      return res.json({ _version: 1, blocks, count: blocks.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountDocLayoutRoutes;
