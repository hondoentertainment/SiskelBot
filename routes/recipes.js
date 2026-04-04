import express from "express";
import { randomUUID } from "crypto";

export default function mountRecipeRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    apiKeyAuth,
    requireScope,
    storageRateLimiter,
    sanitizeWorkspace,
    storage,
import { randomUUID } from "crypto";

export function mountRecipeRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    apiKeyAuth,
    requireScope,
    logRequest,
    storageRateLimiter,
    sanitizeWorkspace,
    storage,
    logActivity,
    scheduleStore,
    schedulerRefresh,
    runRecipeNow,
    runDueJobsVercel,
    logActivity,
  } = deps;

  // Recipes CRUD
  } = deps;

  apiRoute("get", "/recipes", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const data = await storage.listItems("recipes", workspace);
      res.json({ _version: 1, items: data });
    } catch (err) {
      console.error("Storage recipes list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/recipes", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const recipe = req.body;
      if (!recipe || typeof recipe !== "object" || typeof recipe.name !== "string" || !recipe.name.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "Recipe with name required", "Send { name, steps, description?: }.");
      }
      const id = (recipe.id && String(recipe.id).trim()) || randomUUID();
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
      console.error("Storage recipes add error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/recipes/:id", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const item = await storage.getItem("recipes", req.params.id, workspace);
      if (!item) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(item);
    } catch (err) {
      console.error("Storage recipes get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("put", "/recipes/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { name, description, steps } = req.body || {};
      const updated = await storage.updateItem("recipes", req.params.id, workspace, (existing) => {
        if (typeof name === "string" && name.trim()) existing.name = name.trim().slice(0, 128);
        if (description !== undefined) existing.description = typeof description === "string" ? description.slice(0, 512) : "";
        if (Array.isArray(steps)) existing.steps = steps;
        return existing;
      });
      if (!updated) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(updated);
    } catch (err) {
      console.error("Storage recipes update error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/recipes/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const deleted = await storage.deleteItem("recipes", req.params.id, workspace);
      if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.status(204).send();
    } catch (err) {
      console.error("Storage recipes delete error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/recipes/sync", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const valid = items.filter((x) => x && x.id && typeof x.name === "string");
      const merged = await storage.mergeItems("recipes", workspace, valid);
      res.json({ _version: 1, items: merged });
    } catch (err) {
      console.error("Storage recipes sync error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Schedules
  apiRoute("get", "/schedules", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const items = await scheduleStore.list(workspace);
      const withRecipe = await Promise.all(
        items.map(async (s) => {
          const recipe = await storage.get("recipes", s.recipeId, s.workspace || workspace);
          return { ...s, recipeName: recipe?.name || null };
        })
      );
      res.json({ items: withRecipe });
    } catch (err) {
      console.error("Schedules list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/schedules", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { recipeId, cron, timezone, enabled } = req.body || {};
      if (!recipeId || typeof recipeId !== "string" || !recipeId.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "recipeId required", "Send { recipeId, cron, timezone?, enabled? }.");
      }
      if (!cron || typeof cron !== "string" || !cron.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "cron required", "Cron format: minute hour day month weekday (e.g. 0 9 * * 1-5).");
      }
      const recipe = await storage.get("recipes", recipeId.trim(), workspace);
      if (!recipe) {
        return apiError(res, 404, "NOT_FOUND", "Recipe not found", "Create the recipe first.");
      }
      const sched = await scheduleStore.upsert(recipeId.trim(), { cron: cron.trim(), timezone, enabled: enabled !== false }, workspace);
      if (process.env.ENABLE_SCHEDULED_RECIPES === "1") await schedulerRefresh();
      res.status(201).json(sched);
    } catch (err) {
      console.error("Schedule upsert error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/schedules/:recipeId", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const removed = await scheduleStore.remove(req.params.recipeId, workspace);
      if (!removed) return res.status(404).json({ error: "Schedule not found", code: "NOT_FOUND" });
      if (process.env.ENABLE_SCHEDULED_RECIPES === "1") await schedulerRefresh();
      res.status(204).send();
    } catch (err) {
      console.error("Schedule delete error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/schedules/run-now/:recipeId", storageRateLimiter, apiKeyAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
      const result = await runRecipeNow(req.params.recipeId, workspace);
      if (!result.ok) {
        return apiError(res, 400, "RUN_FAILED", result.error || "Run failed", "Check ALLOW_RECIPE_STEP_EXECUTION=1 and recipe exists.");
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("Run now error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Cron endpoint
  apiRoute("get", "/cron", logRequest, async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers["authorization"] !== `Bearer ${secret}` && req.query?.secret !== secret) {
      return apiError(res, 401, "UNAUTHORIZED", "Cron secret required", "Set CRON_SECRET and pass via Authorization: Bearer or ?secret=.");
    }
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace) || "default";
      const result = await runDueJobsVercel(workspace);
      res.json({ ok: true, ran: result.ran, skipped: result.skipped || false });
    } catch (err) {
      console.error("Cron tick error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
