/**
 * Route module: API playground (Phase 61.1).
 *
 * POST   /api/v1/playground/codegen                          — generate code in a language
 * GET    /api/v1/playground/languages                        — list supported languages
 * POST   /api/v1/playground/requests                         — save a history entry
 * GET    /api/v1/playground/requests                         — list history
 * DELETE /api/v1/playground/requests                         — clear history
 * GET    /api/v1/playground/requests/:id                     — fetch a saved request
 * POST   /api/v1/playground/collections                      — create collection
 * GET    /api/v1/playground/collections                      — list collections
 * GET    /api/v1/playground/collections/:id                  — fetch a collection
 * POST   /api/v1/playground/collections/:id/requests         — add request to collection
 * DELETE /api/v1/playground/collections/:id/requests/:reqId  — remove request
 * DELETE /api/v1/playground/collections/:id                  — delete collection
 * GET    /api/v1/playground/collections/:id/export           — export collection
 * POST   /api/v1/playground/environments                     — save environment
 * GET    /api/v1/playground/environments                     — list environments
 * GET    /api/v1/playground/environments/:name               — fetch environment
 * POST   /api/v1/playground/import                           — import collection
 * GET    /api/v1/playground/openapi-endpoints                — list endpoints from spec
 */
import {
  generateCode,
  listSupportedLanguages,
  saveRequestAndIndex,
  getHistory,
  clearHistory,
  getSavedRequest,
  createCollection,
  getCollection,
  listCollections,
  addRequestToCollection,
  removeRequestFromCollection,
  deleteCollection,
  saveEnvironment,
  getEnvironment,
  listEnvironments,
  exportCollection,
  importCollection,
  getEndpointsFromSpec,
} from "../lib/api-playground.js";

function resolveUserId(req) {
  return (
    req.user?.id ||
    req.user?.userId ||
    req.apiKeyUserId ||
    req.apiKeyId ||
    req.headers?.["x-user-id"] ||
    "anonymous"
  );
}

export function mountApiPlaygroundRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // POST /playground/codegen
  apiRoute(
    "post",
    "/playground/codegen",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const { lang, endpoint, method, body: reqBody, headers } = body;
        if (!lang) return apiError(res, 400, "INVALID_INPUT", "lang is required.");
        if (!endpoint) return apiError(res, 400, "INVALID_INPUT", "endpoint is required.");
        const code = generateCode(lang, {
          endpoint,
          method: method || "GET",
          body: reqBody ?? null,
          headers: headers || {},
        });
        res.json({ lang, code });
      } catch (err) {
        if (/Unsupported language/.test(err.message)) {
          return apiError(res, 400, "INVALID_INPUT", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /playground/languages
  apiRoute(
    "get",
    "/playground/languages",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (_req, res) => {
      res.json({ languages: listSupportedLanguages() });
    },
  );

  // POST /playground/requests — save a request into user history
  apiRoute(
    "post",
    "/playground/requests",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const userId = resolveUserId(req);
        const entry = await saveRequestAndIndex(userId, req.body || {});
        res.status(201).json(entry);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /playground/requests — list history
  apiRoute(
    "get",
    "/playground/requests",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const userId = resolveUserId(req);
        const limit = Number(req.query?.limit) || 50;
        const items = await getHistory(userId, limit);
        res.json({ items });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // DELETE /playground/requests — clear history
  apiRoute(
    "delete",
    "/playground/requests",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const userId = resolveUserId(req);
        await clearHistory(userId);
        res.json({ ok: true });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /playground/requests/:id — fetch a saved request by id
  apiRoute(
    "get",
    "/playground/requests/:id",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const entry = await getSavedRequest(req.params.id);
        if (!entry) return apiError(res, 404, "NOT_FOUND", "request not found");
        res.json(entry);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /playground/collections — create a collection
  apiRoute(
    "post",
    "/playground/collections",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const userId = resolveUserId(req);
        const { name, requests } = req.body || {};
        if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required.");
        const col = await createCollection(userId, name, Array.isArray(requests) ? requests : []);
        res.status(201).json(col);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /playground/collections — list collections
  apiRoute(
    "get",
    "/playground/collections",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const userId = resolveUserId(req);
        const items = await listCollections(userId);
        res.json({ items });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /playground/collections/:id
  apiRoute(
    "get",
    "/playground/collections/:id",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const col = await getCollection(req.params.id);
        if (!col) return apiError(res, 404, "NOT_FOUND", "collection not found");
        res.json(col);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /playground/collections/:id/requests
  apiRoute(
    "post",
    "/playground/collections/:id/requests",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const entry = await addRequestToCollection(req.params.id, req.body || {});
        res.status(201).json(entry);
      } catch (err) {
        if (err?.code === "NOT_FOUND") {
          return apiError(res, 404, "NOT_FOUND", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // DELETE /playground/collections/:id/requests/:reqId
  apiRoute(
    "delete",
    "/playground/collections/:id/requests/:reqId",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const result = await removeRequestFromCollection(req.params.id, req.params.reqId);
        res.json(result);
      } catch (err) {
        if (err?.code === "NOT_FOUND") {
          return apiError(res, 404, "NOT_FOUND", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // DELETE /playground/collections/:id
  apiRoute(
    "delete",
    "/playground/collections/:id",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const result = await deleteCollection(req.params.id);
        if (!result.ok) return apiError(res, 404, "NOT_FOUND", "collection not found");
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /playground/collections/:id/export
  apiRoute(
    "get",
    "/playground/collections/:id/export",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const col = await getCollection(req.params.id);
        if (!col) return apiError(res, 404, "NOT_FOUND", "collection not found");
        const format = String(req.query?.format || "json").toLowerCase();
        const out = exportCollection(col, format);
        res.setHeader("Content-Type", "application/json");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${col.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.${format}.json"`,
        );
        res.send(out);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /playground/environments
  apiRoute(
    "post",
    "/playground/environments",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const userId = resolveUserId(req);
        const { name, vars } = req.body || {};
        if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required.");
        const env = await saveEnvironment(userId, name, vars || {});
        res.status(201).json(env);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /playground/environments
  apiRoute(
    "get",
    "/playground/environments",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const userId = resolveUserId(req);
        const envs = await listEnvironments(userId);
        res.json({ environments: envs });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /playground/environments/:name
  apiRoute(
    "get",
    "/playground/environments/:name",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const userId = resolveUserId(req);
        const env = await getEnvironment(userId, req.params.name);
        if (!env) return apiError(res, 404, "NOT_FOUND", "environment not found");
        res.json(env);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /playground/import
  apiRoute(
    "post",
    "/playground/import",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const userId = resolveUserId(req);
        const { data, format } = req.body || {};
        if (data == null) return apiError(res, 400, "INVALID_INPUT", "data is required.");
        const imported = importCollection(data, format || "json");
        const col = await createCollection(userId, imported.name || "Imported", imported.requests || []);
        res.status(201).json(col);
      } catch (err) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
    },
  );

  // GET /playground/openapi-endpoints
  apiRoute(
    "get",
    "/playground/openapi-endpoints",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (_req, res) => {
      try {
        // Serve endpoints extracted from our own OpenAPI spec, if available.
        let spec = null;
        try {
          const mod = await import("../lib/openapi-spec.js");
          if (typeof mod.buildOpenApiSpec === "function") {
            spec = mod.buildOpenApiSpec();
          } else if (mod.openapiSpec) {
            spec = mod.openapiSpec;
          } else if (mod.default) {
            spec = typeof mod.default === "function" ? mod.default() : mod.default;
          }
        } catch {
          spec = null;
        }
        if (!spec) {
          // Also try the generated spec
          try {
            const gen = await import("../lib/openapi-generated.js");
            spec = gen.default || gen.openapiSpec || gen.spec || null;
          } catch {
            spec = null;
          }
        }
        const endpoints = spec ? await getEndpointsFromSpec(spec) : [];
        res.json({ endpoints });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );
}

export default mountApiPlaygroundRoutes;
