// API v2 recipes routes
import { randomUUID } from "crypto";
import { apiV2Route } from "../../lib/api-version.js";
import { apiV2Error } from "../../lib/api-v2-errors.js";

function parsePagination(query) {
  const cursor = query.cursor || null;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
  return { cursor, limit };
}

function paginate(items, cursor, limit) {
  let startIdx = 0;
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf8");
      const idx = items.findIndex((i) => i.id === decoded);
      if (idx >= 0) startIdx = idx + 1;
    } catch {
      // invalid cursor, start from beginning
    }
  }
  const page = items.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < items.length;
  const nextCursor = page.length > 0 && hasMore
    ? Buffer.from(page[page.length - 1].id).toString("base64")
    : null;
  return { items: page, cursor: nextCursor, hasMore };
}

export function mountV2RecipeRoutes(app, deps) {
  const {
    requireScope,
    logRequest,
    storageRateLimiter,
    sanitizeWorkspace,
    storage,
    logActivity,
    runRecipeNow,
    v2BearerAuth,
    v2RateHeaders,
  } = deps;

  const prefix = "/recipes";
  const mw = [storageRateLimiter, v2BearerAuth, v2RateHeaders, logRequest];

  // GET /api/v2/recipes — list with cursor pagination
  apiV2Route(app, "get", prefix, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const { cursor, limit } = parsePagination(req.query);
      const data = await storage.listItems("recipes", workspace);
      const result = paginate(data, cursor, limit);
      res.json(result);
    } catch (err) {
      console.error("v2 recipes list error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v2/recipes — create
  apiV2Route(app, "post", prefix, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const recipe = req.body;
      if (!recipe || typeof recipe !== "object" || typeof recipe.name !== "string" || !recipe.name.trim()) {
        return apiV2Error(res, 400, "INVALID_INPUT", "Recipe name is required");
      }
      const id = randomUUID();
      const item = {
        id,
        name: recipe.name.trim().slice(0, 128),
        description: typeof recipe.description === "string" ? recipe.description.trim().slice(0, 512) : "",
        steps: Array.isArray(recipe.steps) ? recipe.steps : [],
        createdAt: new Date().toISOString(),
      };
      const merged = await storage.mergeItems("recipes", workspace, [item]);
      const out = merged.find((x) => x.id === id) || item;
      await logActivity(workspace, "recipe_added", req.userId || "anonymous", { recipeName: item.name, id: out.id });
      res.status(201).json(out);
    } catch (err) {
      console.error("v2 recipes create error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v2/recipes/:id — get single
  apiV2Route(app, "get", `${prefix}/:id`, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const item = await storage.getItem("recipes", req.params.id, workspace);
      if (!item) return apiV2Error(res, 404, "NOT_FOUND", "Recipe not found");
      res.json(item);
    } catch (err) {
      console.error("v2 recipes get error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v2/recipes/:id/run — execute recipe
  apiV2Route(app, "post", `${prefix}/:id/run`, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
      const result = await runRecipeNow(req.params.id, workspace);
      if (!result.ok) {
        return apiV2Error(res, 400, "RUN_FAILED", result.error || "Recipe execution failed");
      }
      res.json({ ok: true, result: result.result || null });
    } catch (err) {
      console.error("v2 recipes run error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
