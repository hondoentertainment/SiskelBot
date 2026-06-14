/**
 * Phase 54.2: Image generation proxy routes.
 *
 * POST   /api/v1/images/generate           — body: { prompt, options }
 * POST   /api/v1/images/batch              — body: { prompts, options }
 * GET    /api/v1/images/history            — list with filters
 * GET    /api/v1/images/:id                — fetch one
 * DELETE /api/v1/images/:id                — delete one
 * GET    /api/v1/images/templates          — list prompt templates
 * POST   /api/v1/images/templates          — register a new template
 * GET    /api/v1/images/presets            — list saved style presets
 * POST   /api/v1/images/presets            — save a style preset
 * GET    /api/v1/images/providers          — list registered providers
 * POST   /api/v1/images/variation/:id      — generate a variation of an image
 */
import {
  IMAGE_PROVIDERS,
  generateImage,
  generateBatch,
  generateVariation,
  getGenerationHistory,
  getGeneration,
  deleteGeneration,
  listTemplates,
  registerTemplate,
  listStylePresets,
  saveStylePreset,
  getImageProvider,
} from "../lib/image-generation.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/required|must|unknown|invalid|empty|placeholder|non-empty/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code = status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "image-generation error");
}

export function mountImageGenerationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/images/generate
  apiRoute("post", "/images/generate", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "prompt is required");
      }
      const options = body.options || {};
      if (!options.userId && req.userId) options.userId = req.userId;
      if (!options.workspaceId && req.workspaceId) options.workspaceId = req.workspaceId;
      const result = await generateImage(body.prompt, options);
      return res.status(201).json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/images/batch
  apiRoute("post", "/images/batch", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.prompts) || body.prompts.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "prompts array is required");
      }
      const options = body.options || {};
      if (!options.userId && req.userId) options.userId = req.userId;
      if (!options.workspaceId && req.workspaceId) options.workspaceId = req.workspaceId;
      const batch = await generateBatch(body.prompts, options);
      return res.status(201).json({ _version: 1, ...batch });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/images/history
  apiRoute("get", "/images/history", log, auth, scope("read"), async (req, res) => {
    try {
      const filter = {
        provider: req.query.provider,
        userId: req.query.userId,
        workspaceId: req.query.workspaceId,
        template: req.query.template,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      };
      const history = await getGenerationHistory(filter);
      return res.json({ _version: 1, ...history });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/images/templates
  apiRoute("get", "/images/templates", log, auth, scope("read"), async (_req, res) => {
    try {
      const templates = listTemplates();
      return res.json({ _version: 1, templates });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/images/templates
  apiRoute("post", "/images/templates", log, auth, scope("write"), async (req, res) => {
    try {
      const { name, template } = req.body || {};
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (!template) return apiError(res, 400, "INVALID_INPUT", "template is required");
      registerTemplate(name, template);
      return res.status(201).json({ _version: 1, name, template });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/images/presets
  apiRoute("get", "/images/presets", log, auth, scope("read"), async (_req, res) => {
    try {
      const presets = await listStylePresets();
      return res.json({ _version: 1, presets, count: presets.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/images/presets
  apiRoute("post", "/images/presets", log, auth, scope("write"), async (req, res) => {
    try {
      const { name, preset } = req.body || {};
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (!preset || typeof preset !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "preset is required");
      }
      const stored = await saveStylePreset(name, preset);
      return res.status(201).json({ _version: 1, preset: stored });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/images/providers
  apiRoute("get", "/images/providers", log, auth, scope("read"), async (_req, res) => {
    try {
      const names = Object.keys(IMAGE_PROVIDERS);
      const providers = names.map((name) => {
        const p = getImageProvider(name);
        return {
          name,
          endpoint: p?.config?.endpoint || null,
          builtIn: true,
        };
      });
      return res.json({ _version: 1, providers, count: providers.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/images/variation/:id
  apiRoute(
    "post",
    "/images/variation/:id",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const options = (req.body && req.body.options) || {};
        const variation = await generateVariation(req.params.id, options);
        return res.status(201).json({ _version: 1, variation });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // GET /api/v1/images/:id  — must come after specific paths so it doesn't
  // shadow /images/templates, /images/presets, etc.
  apiRoute("get", "/images/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const entry = await getGeneration(req.params.id);
      if (!entry) {
        return apiError(res, 404, "NOT_FOUND", `image ${req.params.id} not found`);
      }
      return res.json({ _version: 1, result: entry });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/images/:id
  apiRoute("delete", "/images/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const ok = await deleteGeneration(req.params.id);
      if (!ok) {
        return apiError(res, 404, "NOT_FOUND", `image ${req.params.id} not found`);
      }
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountImageGenerationRoutes;
