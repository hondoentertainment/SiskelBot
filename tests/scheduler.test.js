/**
 * Phase 16: Scheduler and schedules module tests.
 * Uses temp STORAGE_PATH; runDueJobs/runRecipeNow tested with ALLOW_EXECUTION=0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

// Create temp dir and set STORAGE_PATH before any imports
const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-sched-"));
process.env.STORAGE_PATH = tempDir;

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("schedules list returns empty when no schedules", async () => {
  const { list } = await import("../lib/schedules.js");
  const items = list("default");
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 0);
});

test("schedules upsert adds schedule", async () => {
  const schedules = await import("../lib/schedules.js");
  const storage = await import("../lib/storage.js");

  const recipeId = "recipe-test-1";
  const ws = "default";
  mkdirSync(join(tempDir, "users", "anonymous", "workspaces", ws), { recursive: true });
  const recipePath = join(tempDir, "users", "anonymous", "workspaces", ws, "recipes.json");
  mkdirSync(dirname(recipePath), { recursive: true });
  writeFileSync(
    recipePath,
    JSON.stringify({ _version: 1, items: [{ id: recipeId, name: "Test Recipe", steps: [{ action: "copy", payload: {} }] }] }),
    "utf8"
  );

  const sched = schedules.upsert(recipeId, { cron: "0 9 * * 1-5", enabled: true }, ws);
  assert.ok(sched);
  assert.equal(sched.recipeId, recipeId);
  assert.equal(sched.cron, "0 9 * * 1-5");

  const items = schedules.list(ws);
  assert.equal(items.length, 1);
});

test("schedules remove deletes schedule", async () => {
  const schedules = await import("../lib/schedules.js");
  const recipeId = "recipe-remove-test";
  const ws = "test-remove-ws";

  mkdirSync(join(tempDir, "users", "anonymous", "workspaces", ws), { recursive: true });
  const recipePath = join(tempDir, "users", "anonymous", "workspaces", ws, "recipes.json");
  mkdirSync(dirname(recipePath), { recursive: true });
  writeFileSync(
    recipePath,
    JSON.stringify({ _version: 1, items: [{ id: recipeId, name: "R", steps: [] }] }),
    "utf8"
  );

  schedules.upsert(recipeId, { cron: "0 0 * * *", enabled: true }, ws);
  assert.equal(schedules.list(ws).length, 1, "schedule should exist before remove");
  const removed = schedules.remove(recipeId, ws);
  assert.equal(removed, true);
  assert.equal(schedules.list(ws).length, 0);
});

test("runDueJobs returns skipped when ALLOW_RECIPE_STEP_EXECUTION not 1", async () => {
  const orig = process.env.ALLOW_RECIPE_STEP_EXECUTION;
  process.env.ALLOW_RECIPE_STEP_EXECUTION = "";
  const { runDueJobs } = await import(`../lib/scheduler.js?t=${Date.now()}`);
  const result = await runDueJobs("default");
  process.env.ALLOW_RECIPE_STEP_EXECUTION = orig;
  assert.equal(result.skipped, true);
  assert.equal(result.ran, 0);
});

test("runRecipeNow returns ok false when recipe not found", async () => {
  const orig = process.env.ALLOW_RECIPE_STEP_EXECUTION;
  process.env.ALLOW_RECIPE_STEP_EXECUTION = "1";
  const { runRecipeNow } = await import(`../lib/scheduler.js?t=${Date.now() + 1}`);
  const result = await runRecipeNow("non-existent-recipe-id", "default");
  process.env.ALLOW_RECIPE_STEP_EXECUTION = orig;
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});
