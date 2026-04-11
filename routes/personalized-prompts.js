/**
 * Phase 69.4: Personalized prompts routes.
 */
import {
  buildSystemPrompt,
  registerTrait,
  listTraits,
  clearTraits,
  getPromptForUser,
} from "../lib/personalized-prompts.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "personalized-prompts error");
}

export function mountPersonalizedPromptsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/prompts/traits/:userId", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await registerTrait(req.params.userId, req.body || {});
      return res.status(201).json({ _version: 1, user: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/prompts/traits/:userId", log, auth, scope("read"), async (req, res) => {
    try {
      const list = await listTraits(req.params.userId);
      return res.json({ _version: 1, traits: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("delete", "/prompts/traits/:userId", log, auth, scope("write"), async (req, res) => {
    try {
      const key = typeof req.query?.key === "string" ? req.query.key : undefined;
      const r = await clearTraits(req.params.userId, { key });
      return res.json({ _version: 1, ...r });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/prompts/for-user/:userId", log, auth, scope("read"), async (req, res) => {
    try {
      const base = typeof req.query?.base === "string" ? req.query.base : undefined;
      const prompt = await getPromptForUser(req.params.userId, { base });
      return res.json({ _version: 1, prompt });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/prompts/build", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const prompt = buildSystemPrompt(body.base || "", Array.isArray(body.traits) ? body.traits : []);
      return res.json({ _version: 1, prompt });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountPersonalizedPromptsRoutes;
