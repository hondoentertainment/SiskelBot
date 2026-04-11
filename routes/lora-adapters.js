/**
 * Phase 38.5: LoRA adapter management routes.
 *
 * GET    /api/v1/adapters                         — list adapters (optionally scoped by workspace)
 * POST   /api/v1/adapters                         — register new adapter
 * GET    /api/v1/adapters/:id                     — fetch adapter
 * DELETE /api/v1/adapters/:id                     — unregister adapter
 * POST   /api/v1/adapters/:id/load                — mark adapter loaded into backend
 * POST   /api/v1/adapters/:id/unload              — mark adapter unloaded
 * GET    /api/v1/adapters/:id/metrics             — usage / latency / error metrics
 * POST   /api/v1/adapters/import/openai           — import an OpenAI fine-tune
 * POST   /api/v1/adapters/import/huggingface      — import a HuggingFace PEFT adapter (metadata)
 * GET    /api/v1/workspaces/:id/active-adapter    — get active adapter for a workspace
 * PUT    /api/v1/workspaces/:id/active-adapter    — set (or clear) active adapter for a workspace
 */

import {
  registerAdapter,
  unregisterAdapter,
  loadAdapter,
  unloadAdapter,
  listAdapters,
  getAdapter,
  switchActiveAdapter,
  getActiveAdapter,
  getAdapterMetrics,
  listOpenAIFineTunes,
  importOpenAIFineTune,
  fetchHuggingFaceAdapterInfo,
} from "../lib/lora-adapters.js";

export function mountLoraAdapterRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    requireScope,
    storageRateLimiter,
    sanitizeWorkspace,
    OPENAI_API_KEY,
  } = deps;

  const auth = userAuth || ((req, res, next) => next());
  const scopeRead = requireScope ? requireScope("read") : (req, res, next) => next();
  const scopeWrite = requireScope ? requireScope("write") : (req, res, next) => next();
  const limiter = storageRateLimiter || ((req, res, next) => next());

  // GET /api/v1/adapters
  apiRoute("get", "/adapters", limiter, auth, scopeRead, logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace
        ? (sanitizeWorkspace ? sanitizeWorkspace(req.query.workspace) : String(req.query.workspace))
        : null;
      const adapters = await listAdapters(workspace);
      res.json({ _version: 1, adapters });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/adapters
  apiRoute("post", "/adapters", limiter, auth, scopeWrite, logRequest, async (req, res) => {
    try {
      const config = req.body || {};
      if (config.workspaceId && sanitizeWorkspace) {
        config.workspaceId = sanitizeWorkspace(config.workspaceId);
      }
      const result = await registerAdapter(config);
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      if (/required|must be one of|not accessible/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      if (/already exists/i.test(err.message)) {
        return apiError(res, 409, "ALREADY_EXISTS", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/adapters/:id
  apiRoute("get", "/adapters/:id", limiter, auth, scopeRead, logRequest, async (req, res) => {
    try {
      const adapter = await getAdapter(req.params.id);
      if (!adapter) return apiError(res, 404, "NOT_FOUND", "adapter not found");
      res.json({ _version: 1, adapter });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/adapters/:id
  apiRoute("delete", "/adapters/:id", limiter, auth, scopeWrite, logRequest, async (req, res) => {
    try {
      const result = await unregisterAdapter(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", result.error);
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/adapters/:id/load
  apiRoute("post", "/adapters/:id/load", limiter, auth, scopeWrite, logRequest, async (req, res) => {
    try {
      const result = await loadAdapter(req.params.id);
      res.json({ _version: 1, id: req.params.id, ...result });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/adapters/:id/unload
  apiRoute("post", "/adapters/:id/unload", limiter, auth, scopeWrite, logRequest, async (req, res) => {
    try {
      const result = await unloadAdapter(req.params.id);
      res.json({ _version: 1, id: req.params.id, ...result });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/adapters/:id/metrics
  apiRoute("get", "/adapters/:id/metrics", limiter, auth, scopeRead, logRequest, async (req, res) => {
    try {
      const adapter = await getAdapter(req.params.id);
      if (!adapter) return apiError(res, 404, "NOT_FOUND", "adapter not found");
      const metrics = await getAdapterMetrics(req.params.id);
      res.json({ _version: 1, id: req.params.id, metrics });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/adapters/import/openai
  apiRoute("post", "/adapters/import/openai", limiter, auth, scopeWrite, logRequest, async (req, res) => {
    try {
      const jobId = req.body?.jobId;
      const apiKey = req.body?.apiKey || OPENAI_API_KEY;
      if (!jobId) return apiError(res, 400, "INVALID_INPUT", "jobId is required");
      if (!apiKey) return apiError(res, 400, "INVALID_INPUT", "OpenAI apiKey is required (body.apiKey or OPENAI_API_KEY env)");
      let workspaceId = req.body?.workspaceId || null;
      if (workspaceId && sanitizeWorkspace) workspaceId = sanitizeWorkspace(workspaceId);
      const list = req.query?.list === "1" || req.body?.list === true;
      if (list) {
        const jobs = await listOpenAIFineTunes(apiKey);
        return res.json({ _version: 1, jobs });
      }
      const result = await importOpenAIFineTune(jobId, apiKey, {
        workspaceId,
        scope: req.body?.scope,
        name: req.body?.name,
      });
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      if (/required|must be one of/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      if (/OpenAI API error/i.test(err.message)) {
        return apiError(res, 502, "UPSTREAM_ERROR", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/adapters/import/huggingface
  apiRoute("post", "/adapters/import/huggingface", limiter, auth, scopeWrite, logRequest, async (req, res) => {
    try {
      const modelId = req.body?.modelId;
      if (!modelId) return apiError(res, 400, "INVALID_INPUT", "modelId is required");
      const info = await fetchHuggingFaceAdapterInfo(modelId);
      // If caller wants to persist as an adapter, register it.
      if (req.body?.register) {
        let workspaceId = req.body?.workspaceId || null;
        if (workspaceId && sanitizeWorkspace) workspaceId = sanitizeWorkspace(workspaceId);
        const result = await registerAdapter({
          name: req.body?.name || modelId,
          baseModel: info.baseModel || req.body?.baseModel || "unknown",
          adapterType: "lora",
          source: "huggingface",
          sourceConfig: { modelId, sha: info.sha, adapterName: req.body?.adapterName || modelId },
          scope: req.body?.scope || (workspaceId ? "workspace" : "global"),
          workspaceId,
          description: `Imported HF adapter ${modelId}`,
          tags: ["huggingface", ...(info.tags || []).slice(0, 5)],
        });
        return res.status(201).json({ _version: 1, info, ...result });
      }
      res.json({ _version: 1, info });
    } catch (err) {
      if (/required|must be one of/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      if (/HuggingFace API error/i.test(err.message)) {
        return apiError(res, 502, "UPSTREAM_ERROR", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/workspaces/:id/active-adapter
  apiRoute("get", "/workspaces/:id/active-adapter", limiter, auth, scopeRead, logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace ? sanitizeWorkspace(req.params.id) : req.params.id;
      const adapter = await getActiveAdapter(workspaceId);
      res.json({ _version: 1, workspaceId, adapter });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/workspaces/:id/active-adapter
  apiRoute("put", "/workspaces/:id/active-adapter", limiter, auth, scopeWrite, logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace ? sanitizeWorkspace(req.params.id) : req.params.id;
      const adapterId = req.body?.adapterId == null ? null : String(req.body.adapterId);
      const result = await switchActiveAdapter(workspaceId, adapterId);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/not found|not accessible/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/required/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountLoraAdapterRoutes;
