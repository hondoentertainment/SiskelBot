/**
 * Phase 16: Scheduled & Automated Recipes
 * Loads schedules, uses node-cron to run recipes at specified times.
 * On tick: executes each step via executeStep; logs to execution-audit with source: "scheduled".
 * Skips if ALLOW_RECIPE_STEP_EXECUTION !== "1".
 */
import cron from "node-cron";
import { executeStep, appendAuditLog } from "./action-executor.js";
import { emitEvent } from "./webhooks.js";
import * as storage from "./storage.js";
import * as schedules from "./schedules.js";

const ENABLE_SCHEDULED_RECIPES = process.env.ENABLE_SCHEDULED_RECIPES === "1";
const ALLOW_EXECUTION = process.env.ALLOW_RECIPE_STEP_EXECUTION === "1";

let cronTasks = new Map();

/**
 * Run a single recipe (all steps) for scheduled execution.
 * @param {object} recipe - { id, name, steps }
 * @param {string} [workspace]
 */
async function runRecipe(recipe, workspace = "default") {
  if (!recipe || !Array.isArray(recipe.steps) || recipe.steps.length === 0) return;
  const ctx = {
    projectDir: process.env.PROJECT_DIR || process.cwd(),
    vercelToken: process.env.VERCEL_TOKEN,
  };
  for (const step of recipe.steps) {
    const action = String(step?.action || "").trim().toLowerCase();
    if (action === "copy") {
      appendAuditLog({ action: "copy", payload: step.payload, ok: true, source: "scheduled" });
      continue;
    }
    try {
      const result = await executeStep(step, ctx);
      appendAuditLog({
        action: step.action,
        payload: step.payload,
        ok: result.ok,
        error: result.error,
        source: "scheduled",
        recipeId: recipe.id,
        recipeName: recipe.name,
      });
      if (!result.ok) {
        console.warn("[scheduler] Step failed:", recipe.name, step.action, result.error);
      }
    } catch (err) {
      appendAuditLog({
        action: step.action,
        payload: step.payload,
        ok: false,
        error: err.message,
        source: "scheduled",
        recipeId: recipe.id,
        recipeName: recipe.name,
      });
      console.warn("[scheduler] Step error:", recipe.name, step.action, err.message);
    }
  }
  emitEvent("schedule_completed", { recipeId: recipe.id, recipeName: recipe.name, stepCount: (recipe.steps || []).length }, { workspaceId: workspace });
}

/**
 * Process due jobs: load enabled schedules, fetch recipes, run each.
 * For local (node-cron): used as batch runner.
 * For Vercel: call runDueJobsVercel() which checks isDueNow per schedule.
 */
export async function runDueJobs(workspace = "default") {
  if (!ALLOW_EXECUTION) {
    console.log("[scheduler] Skipped: ALLOW_RECIPE_STEP_EXECUTION != 1");
    return { ran: 0, skipped: true };
  }
  const items = schedules.list(workspace).filter((s) => s.enabled && s.cron);
  let ran = 0;
  for (const sched of items) {
    const recipe = storage.get("recipes", sched.recipeId, sched.workspace || workspace);
    if (!recipe) continue;
    await runRecipe(recipe, sched.workspace || workspace);
    ran++;
  }
  return { ran };
}

/**
 * Vercel serverless: run only recipes whose cron matches current minute.
 */
export async function runDueJobsVercel(workspace = "default") {
  if (!ALLOW_EXECUTION) return { ran: 0, skipped: true };
  let ran = 0;
  const items = schedules.list(workspace).filter((s) => s.enabled && s.cron);
  for (const sched of items) {
    try {
      const mod = await import("cron-parser");
      const parseExpression = mod.parseExpression || mod.default?.parseExpression;
      if (!parseExpression) continue;
      const opts = { currentDate: new Date() };
      if (sched.timezone) opts.tz = sched.timezone;
      const interval = parseExpression(sched.cron, opts);
      const prev = interval.prev();
      const prevMs = prev.toDate().getTime();
      if (Date.now() - prevMs >= 120_000) continue;
    } catch {
      continue;
    }
    const recipe = storage.get("recipes", sched.recipeId, sched.workspace || workspace);
    if (recipe) {
      await runRecipe(recipe, sched.workspace || workspace);
      ran++;
    }
  }
  return { ran };
}

/**
 * Run a specific recipe immediately (manual trigger).
 */
export async function runRecipeNow(recipeId, workspace = "default") {
  if (!ALLOW_EXECUTION) {
    return { ok: false, error: "ALLOW_RECIPE_STEP_EXECUTION must be 1" };
  }
  const recipe = storage.get("recipes", recipeId, workspace);
  if (!recipe) return { ok: false, error: "Recipe not found" };
  await runRecipe(recipe, workspace);
  return { ok: true };
}

/**
 * Start the in-process cron scheduler. Call only when ENABLE_SCHEDULED_RECIPES=1.
 */
export function start() {
  if (!ENABLE_SCHEDULED_RECIPES) return;
  const items = schedules.list("default").filter((s) => s.enabled && s.cron);
  for (const sched of items) {
    try {
      const valid = cron.validate(sched.cron);
      if (!valid) {
        console.warn("[scheduler] Invalid cron for recipe", sched.recipeId, ":", sched.cron);
        continue;
      }
      const workspace = sched.workspace || "default";
      const recipeId = sched.recipeId;
      const task = cron.schedule(
        sched.cron,
        async () => {
          if (!ALLOW_EXECUTION) return;
          const recipe = storage.get("recipes", recipeId, workspace);
          if (recipe) await runRecipe(recipe, workspace).catch((e) => console.warn("[scheduler] Tick error:", e.message));
        },
        { scheduled: true, timezone: sched.timezone || undefined }
      );
      cronTasks.set(sched.recipeId, task);
    } catch (e) {
      console.warn("[scheduler] Failed to schedule recipe", sched.recipeId, ":", e.message);
    }
  }
  if (cronTasks.size > 0) {
    console.log("[scheduler] Started", cronTasks.size, "scheduled recipe(s)");
  }
}

/**
 * Refresh cron tasks (e.g. after schedule add/delete). Stops existing, reloads.
 */
export function refresh() {
  for (const task of cronTasks.values()) {
    task.stop();
  }
  cronTasks.clear();
  start();
}

/**
 * Stop the scheduler.
 */
export function stop() {
  for (const task of cronTasks.values()) {
    task.stop();
  }
  cronTasks.clear();
}
