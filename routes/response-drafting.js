/**
 * Phase 62.3: Response drafting routes.
 */
import {
  createTemplate,
  listTemplates,
  setTone,
  preview,
  draftResponse,
  listTones,
} from "../lib/response-drafting.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "response-drafting error");
}

export function mountResponseDraftingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/support/drafting/templates", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (typeof body.body !== "string") return apiError(res, 400, "INVALID_INPUT", "body is required");
      const t = await createTemplate(body.name, body.body, body);
      return res.status(201).json({ _version: 1, template: t });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/support/drafting/templates", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listTemplates();
      return res.json({ _version: 1, templates: list, tones: listTones(), count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/support/drafting/templates/:name/tone", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.tone) return apiError(res, 400, "INVALID_INPUT", "tone is required");
      const t = await setTone(req.params.name, body.tone);
      return res.json({ _version: 1, template: t });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/support/drafting/preview", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.templateName) return apiError(res, 400, "INVALID_INPUT", "templateName is required");
      const out = await preview(body.templateName, body.vars || {});
      return res.json({ _version: 1, ...out });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/support/drafting/draft", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const out = await draftResponse({
        templateName: body.templateName,
        body: body.body,
        tone: body.tone,
        vars: body.vars,
      });
      return res.json({ _version: 1, ...out });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });
}

export default mountResponseDraftingRoutes;
