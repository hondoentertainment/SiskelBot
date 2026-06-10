/**
 * Phase 16: Scheduled & Automated Recipes
 * Loads schedules, uses node-cron to run recipes at specified times.
 * On tick: executes each step via executeStep; logs to execution-audit with source: "scheduled".
 * Skips if ALLOW_RECIPE_STEP_EXECUTION !== "1".
 * Phase 68: Async schedule store (Postgres / SQLite / file).
 */
import cron from "node-cron";
import { executeStep, appendAuditLog } from "./action-executor.js";
import { emitEvent } from "./webhooks.js";
import * as storage from "./storage.js";
import * as schedules from "./schedules.js";
import { getLeaderElection } from "./leader-election.js";
import { createLogger } from "./logger.js";
import { runDueRotations } from "./secret-rotation-auto.js";
import { runDueExports } from "./data-warehouse.js";
import { runScheduledGroupSync, startScheduledGroupSync } from "./group-sync.js";
import { collectAndSave as collectComplianceEvidence } from "./compliance-evidence.js";
import { runInitiativeCycle, formatProposalMessage } from "./initiative-engine.js";
import { sendSlackMessage, isSlackConfigured } from "./slack-bot.js";

const log = createLogger('scheduler');

const ENABLE_SCHEDULED_RECIPES = process.env.ENABLE_SCHEDULED_RECIPES === "1";
const ALLOW_EXECUTION = process.env.ALLOW_RECIPE_STEP_EXECUTION === "1";

const ENABLE_INITIATIVE_ENGINE = process.env.ENABLE_INITIATIVE_ENGINE === "1";
const INITIATIVE_CRON = process.env.INITIATIVE_CRON || "*/15 * * * *";
const INITIATIVE_WORKSPACES = (process.env.INITIATIVE_WORKSPACES || "default")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const INITIATIVE_NOTIFY_SLACK = process.env.INITIATIVE_NOTIFY_SLACK === "1";
const INITIATIVE_SLACK_CHANNEL = process.env.INITIATIVE_SLACK_CHANNEL || "";

/**
 * Surface a newly-created proposal to Slack when configured. Best-effort.
 */
async function surfaceProposalToSlack(proposal) {
  if (!INITIATIVE_NOTIFY_SLACK || !isSlackConfigured()) return;
  try {
    await sendSlackMessage(INITIATIVE_SLACK_CHANNEL || undefined, formatProposalMessage(proposal));
  } catch (e) {
    log.warn("Failed to surface proposal to Slack", { error: e.message });
  }
}

/**
 * Run one initiative cycle per configured workspace. Leader-gated by caller.
 */
export async function runInitiativeCycles() {
  let totalCreated = 0;
  for (const workspaceId of INITIATIVE_WORKSPACES) {
    try {
      const result = await runInitiativeCycle({
        workspaceId,
        onProposal: surfaceProposalToSlack,
      });
      totalCreated += result.created.length;
    } catch (e) {
      log.warn("Initiative cycle error", { workspaceId, error: e.message });
    }
  }
  if (totalCreated > 0) log.info("Initiative cycles complete", { created: totalCreated });
  return { created: totalCreated };
}

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
        log.warn("Step failed", { recipe: recipe.name, action: step.action, error: result.error });
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
      log.warn("Step error", { recipe: recipe.name, action: step.action, error: err.message });
    }
  }
  await emitEvent(
    "schedule_completed",
    { recipeId: recipe.id, recipeName: recipe.name, stepCount: (recipe.steps || []).length },
    { workspaceId: workspace }
  );
}

/**
 * Process due jobs: load enabled schedules, fetch recipes, run each.
 */
export async function runDueJobs(workspace = "default") {
  // Secret rotations run independently of ALLOW_RECIPE_STEP_EXECUTION.
  let rotations = { ran: 0 };
  try {
    rotations = await runDueRotations();
  } catch (e) {
    log.warn("Secret rotation tick error", { error: e.message });
  }

  // Phase 39.5: Data warehouse exports run independently of recipe execution.
  let warehouseExports = { ran: 0 };
  try {
    warehouseExports = await runDueExports();
  } catch (e) {
    log.warn("Warehouse export tick error", { error: e.message });
  }

  // Phase 46.4: Group sync from external identity providers.
  let groupSync = { ran: 0 };
  try {
    groupSync = await runScheduledGroupSync();
  } catch (e) {
    log.warn("Group sync tick error", { error: e.message });
  }

  if (!ALLOW_EXECUTION) {
    log.info("Skipped: ALLOW_RECIPE_STEP_EXECUTION != 1");
    return { ran: 0, skipped: true, rotations, warehouseExports, groupSync };
  }
  const all = await schedules.list(workspace);
  const items = all.filter((s) => s.enabled && s.cron);
  let ran = 0;
  for (const sched of items) {
    const recipe = await storage.get("recipes", sched.recipeId, sched.workspace || workspace);
    if (!recipe) continue;
    await runRecipe(recipe, sched.workspace || workspace);
    ran++;
  }
  return { ran, rotations, warehouseExports, groupSync };
}

/**
 * Vercel serverless: run only recipes whose cron matches current minute.
 */
export async function runDueJobsVercel(workspace = "default") {
  if (!ALLOW_EXECUTION) return { ran: 0, skipped: true };
  let ran = 0;
  const all = await schedules.list(workspace);
  const items = all.filter((s) => s.enabled && s.cron);
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
    const recipe = await storage.get("recipes", sched.recipeId, sched.workspace || workspace);
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
  const recipe = await storage.get("recipes", recipeId, workspace);
  if (!recipe) return { ok: false, error: "Recipe not found" };
  await runRecipe(recipe, workspace);
  return { ok: true };
}

/**
 * Start the in-process cron scheduler. Call only when ENABLE_SCHEDULED_RECIPES=1.
 * In multi-instance deployments, only the leader instance runs scheduled recipes.
 */
export async function start() {
  if (!ENABLE_SCHEDULED_RECIPES) return;

  // Attempt to acquire leadership for scheduled execution
  const leader = getLeaderElection();
  const acquired = await leader.acquire();
  if (!acquired) {
    const isLead = await leader.isLeader();
    if (!isLead) {
      log.info("Not leader, skipping scheduled recipe start");
      return;
    }
  }
  log.info("This instance is leader, starting scheduled recipes");

  // Listen for leadership changes
  leader.onLeaderChange((isLeader) => {
    if (isLeader) {
      log.info("Acquired leadership, cron tasks will execute");
    } else {
      log.info("Lost leadership, cron tasks will be skipped");
    }
  });

  const all = await schedules.list("default");
  const items = all.filter((s) => s.enabled && s.cron);
  for (const sched of items) {
    try {
      const valid = cron.validate(sched.cron);
      if (!valid) {
        log.warn("Invalid cron for recipe", { recipeId: sched.recipeId, cron: sched.cron });
        continue;
      }
      const workspace = sched.workspace || "default";
      const recipeId = sched.recipeId;
      const task = cron.schedule(
        sched.cron,
        async () => {
          if (!ALLOW_EXECUTION) return;
          // Only execute if still leader
          const stillLeader = await leader.isLeader();
          if (!stillLeader) {
            log.info("Skipping tick, not leader");
            return;
          }
          const recipe = await storage.get("recipes", recipeId, workspace);
          if (recipe) await runRecipe(recipe, workspace).catch((e) => log.warn("Tick error", { error: e.message }));
        },
        { scheduled: true, timezone: sched.timezone || undefined }
      );
      cronTasks.set(sched.recipeId, task);
    } catch (e) {
      log.warn("Failed to schedule recipe", { recipeId: sched.recipeId, error: e.message });
    }
  }
  if (cronTasks.size > 0) {
    log.info("Started scheduled recipes", { count: cronTasks.size });
  }

  // Phase 46.4: also start the periodic group-sync timer (no-op when disabled)
  try {
    startScheduledGroupSync();
  } catch (e) {
    log.warn("Failed to start group sync timer", { error: e.message });
  }

  // Wave 19A: nightly SOC2 compliance evidence collection at 02:00 UTC
  try {
    cron.schedule(
      "0 2 * * *",
      async () => {
        const stillLeader = await leader.isLeader();
        if (!stillLeader) return;
        try {
          const { key } = await collectComplianceEvidence();
          log.info("Compliance evidence snapshot saved", { key });
        } catch (e) {
          log.warn("Compliance evidence collection failed", { error: e.message });
        }
      },
      { scheduled: true, timezone: "UTC" }
    );
    log.info("Nightly compliance evidence collection scheduled (02:00 UTC)");
  } catch (e) {
    log.warn("Failed to schedule compliance evidence collection", { error: e.message });
  }

  // Initiative engine: proactive proposal generation on a cadence (leader-only).
  if (ENABLE_INITIATIVE_ENGINE) {
    try {
      if (!cron.validate(INITIATIVE_CRON)) {
        log.warn("Invalid INITIATIVE_CRON, skipping initiative engine", { cron: INITIATIVE_CRON });
      } else {
        cron.schedule(
          INITIATIVE_CRON,
          async () => {
            const stillLeader = await leader.isLeader();
            if (!stillLeader) return;
            await runInitiativeCycles().catch((e) => log.warn("Initiative tick error", { error: e.message }));
          },
          { scheduled: true }
        );
        log.info("Initiative engine scheduled", {
          cron: INITIATIVE_CRON,
          workspaces: INITIATIVE_WORKSPACES.length,
        });
      }
    } catch (e) {
      log.warn("Failed to schedule initiative engine", { error: e.message });
    }
  }
}

/**
 * Refresh cron tasks (e.g. after schedule add/delete). Stops existing, reloads.
 */
export async function refresh() {
  for (const task of cronTasks.values()) {
    task.stop();
  }
  cronTasks.clear();
  await start();
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
