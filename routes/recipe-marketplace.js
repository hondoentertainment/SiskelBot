/**
 * Route module: Phase 34.3 Recipe marketplace
 *
 * GET    /api/v1/recipe-marketplace                    — list with filters
 * GET    /api/v1/recipe-marketplace/search?q=...       — search by query
 * GET    /api/v1/recipe-marketplace/trending?period=7d — trending recipes
 * GET    /api/v1/recipe-marketplace/:id                — get recipe by id or slug
 * POST   /api/v1/recipe-marketplace                    — publish a new recipe
 * PUT    /api/v1/recipe-marketplace/:id                — update (creates new version)
 * POST   /api/v1/recipe-marketplace/:id/fork           — fork into target workspace
 * POST   /api/v1/recipe-marketplace/:id/star           — star/unstar toggle
 * GET    /api/v1/recipe-marketplace/:id/versions       — version history
 * GET    /api/v1/recipe-marketplace/:id/forks          — fork lineage
 * GET    /api/v1/recipe-marketplace/:id/stats          — aggregate stats
 */
import {
  publishRecipe,
  updateRecipe,
  forkRecipe,
  listMarketplaceRecipes,
  searchMarketplaceRecipes,
  getMarketplaceRecipe,
  getRecipeVersions,
  getRecipeForks,
  starRecipe,
  getTrendingRecipes,
  getRecipeStats,
  RECIPE_CATEGORIES,
} from "../lib/recipe-marketplace.js";

export function mountRecipeMarketplaceRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // GET /api/v1/recipe-marketplace
  apiRoute("get", "/recipe-marketplace", requireScope("read"), logRequest, async (req, res) => {
    try {
      const { category, tag, sortBy, author, limit, offset } = req.query || {};
      if (category && !RECIPE_CATEGORIES.includes(category)) {
        return apiError(res, 400, "INVALID_CATEGORY", `category must be one of: ${RECIPE_CATEGORIES.join(", ")}`);
      }
      const result = await listMarketplaceRecipes({
        category: category || null,
        tag: tag || null,
        sortBy: sortBy || "newest",
        author: author || null,
        limit: limit !== undefined ? Number(limit) : 50,
        offset: offset !== undefined ? Number(offset) : 0,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/recipe-marketplace/search
  apiRoute("get", "/recipe-marketplace/search", requireScope("read"), logRequest, async (req, res) => {
    try {
      const q = req.query?.q;
      if (!q || typeof q !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "q query parameter is required");
      }
      const items = await searchMarketplaceRecipes(q);
      res.json({ items, total: items.length, query: q });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/recipe-marketplace/trending
  apiRoute("get", "/recipe-marketplace/trending", requireScope("read"), logRequest, async (req, res) => {
    try {
      const period = req.query?.period || "7d";
      if (!/^\d+[dhm]$/.test(period)) {
        return apiError(res, 400, "INVALID_PERIOD", "period must be like '24h', '7d', or '30d'");
      }
      const items = await getTrendingRecipes(period);
      res.json({ items, period });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/recipe-marketplace/:id
  apiRoute("get", "/recipe-marketplace/:id", requireScope("read"), logRequest, async (req, res) => {
    try {
      const recipe = await getMarketplaceRecipe(req.params.id);
      if (!recipe) {
        return apiError(res, 404, "NOT_FOUND", "marketplace recipe not found");
      }
      res.json(recipe);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/recipe-marketplace — publish
  apiRoute("post", "/recipe-marketplace", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      if (body.category && !RECIPE_CATEGORIES.includes(body.category)) {
        return apiError(res, 400, "INVALID_CATEGORY", `category must be one of: ${RECIPE_CATEGORIES.join(", ")}`);
      }
      const workspaceId = body.workspace || req.query?.workspace || "default";
      const publisher = {
        userId: req.userId || "anonymous",
        name: req.userName || req.userId || "anonymous",
      };
      const result = await publishRecipe(workspaceId, body, publisher);
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/recipe-marketplace/:id — update / new version
  apiRoute("put", "/recipe-marketplace/:id", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      if (req.body?.category && !RECIPE_CATEGORIES.includes(req.body.category)) {
        return apiError(res, 400, "INVALID_CATEGORY", `category must be one of: ${RECIPE_CATEGORIES.join(", ")}`);
      }
      const result = await updateRecipe(req.params.id, req.body || {}, req.userId || "anonymous");
      res.json(result);
    } catch (err) {
      if (err.message === "recipe not found") {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (err.message.includes("only the publisher")) {
        return apiError(res, 403, "FORBIDDEN", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/recipe-marketplace/:id/fork
  apiRoute("post", "/recipe-marketplace/:id/fork", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const targetWorkspaceId = req.body?.workspace || req.query?.workspace || "default";
      const result = await forkRecipe(req.params.id, targetWorkspaceId, req.userId || "anonymous");
      res.status(201).json(result);
    } catch (err) {
      if (err.message === "recipe not found") {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/recipe-marketplace/:id/star
  apiRoute("post", "/recipe-marketplace/:id/star", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const userId = req.userId || req.body?.userId;
      if (!userId) {
        return apiError(res, 401, "UNAUTHORIZED", "user id required to star a recipe");
      }
      const result = await starRecipe(req.params.id, userId);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/recipe-marketplace/:id/versions
  apiRoute("get", "/recipe-marketplace/:id/versions", requireScope("read"), logRequest, async (req, res) => {
    try {
      const versions = await getRecipeVersions(req.params.id);
      res.json({ items: versions, total: versions.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/recipe-marketplace/:id/forks
  apiRoute("get", "/recipe-marketplace/:id/forks", requireScope("read"), logRequest, async (req, res) => {
    try {
      const forks = await getRecipeForks(req.params.id);
      res.json({ items: forks, total: forks.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/recipe-marketplace/:id/stats
  apiRoute("get", "/recipe-marketplace/:id/stats", requireScope("read"), logRequest, async (req, res) => {
    try {
      const stats = await getRecipeStats(req.params.id);
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountRecipeMarketplaceRoutes;
