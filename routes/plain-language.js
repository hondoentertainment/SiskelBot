/**
 * Phase 70.5: Plain-language routes.
 */
import {
  computeReadability,
  simplifyText,
  listSynonymRules,
  addSynonymRule,
  grade,
} from "../lib/plain-language.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "plain-language error");
}

export function mountPlainLanguageRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/plain-language/readability", log, auth, scope("read"), async (req, res) => {
    try {
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      if (!text) return apiError(res, 400, "INVALID_INPUT", "text is required");
      const r = computeReadability(text);
      return res.json({ _version: 1, readability: r, grade: grade(r.score) });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/plain-language/simplify", log, auth, scope("read"), async (req, res) => {
    try {
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      if (!text) return apiError(res, 400, "INVALID_INPUT", "text is required");
      const r = await simplifyText(text, req.body || {});
      return res.json({ _version: 1, ...r });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/plain-language/rules", log, auth, scope("read"), async (_req, res) => {
    try {
      const rules = await listSynonymRules();
      return res.json({ _version: 1, rules, count: rules.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/plain-language/rules", log, auth, scope("write"), async (req, res) => {
    try {
      const rules = await addSynonymRule(req.body || {});
      return res.status(201).json({ _version: 1, rules, count: rules.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/plain-language/grade", log, auth, scope("read"), async (req, res) => {
    try {
      const score = Number(req.body?.score);
      const label = grade(score);
      return res.json({ _version: 1, grade: label });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountPlainLanguageRoutes;
