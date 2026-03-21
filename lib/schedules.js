/**
 * Phase 16: Scheduled & Automated Recipes
 * Phase 68: Durable store via json-path-store (Postgres / SQLite / file).
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORAGE_VERSION = 1;

function schedulesPath() {
  return join(getDataDir(), "schedules.json");
}

function filterByWorkspace(items, workspace = "default") {
  if (!workspace || workspace === "default") {
    return items.filter((i) => !i.workspace || i.workspace === "default");
  }
  return items.filter((i) => i.workspace === workspace);
}

/**
 * @returns {Promise<any[]>}
 */
export async function list(workspace = "default") {
  const data = await readJsonPath(schedulesPath(), { _version: STORAGE_VERSION, items: [] });
  const items = Array.isArray(data.items) ? data.items : [];
  return filterByWorkspace(items, workspace);
}

/**
 * Get schedule for a recipe.
 */
export async function get(recipeId, workspace = "default") {
  const items = await list(workspace);
  return items.find((i) => String(i.recipeId) === String(recipeId)) || null;
}

/**
 * Add or update a schedule.
 */
export async function upsert(recipeId, { cron, timezone, enabled = true }, workspace = "default") {
  const path = schedulesPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: STORAGE_VERSION, items: [] });
    let items = Array.isArray(data.items) ? [...data.items] : [];
    const ws = String(workspace || "default").trim().slice(0, 50) || "default";
    const idx = items.findIndex((i) => String(i.recipeId) === String(recipeId));
    const entry = {
      recipeId: String(recipeId),
      cron: String(cron || "").trim(),
      timezone: typeof timezone === "string" ? timezone.trim().slice(0, 64) : undefined,
      enabled: !!enabled,
      workspace: ws,
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) {
      items[idx] = { ...items[idx], ...entry };
    } else {
      entry.createdAt = new Date().toISOString();
      items.push(entry);
    }
    data._version = STORAGE_VERSION;
    data.items = items;
    await writeJsonPath(path, data);
    return items.find((i) => String(i.recipeId) === String(recipeId));
  });
}

/**
 * Remove schedule for a recipe.
 */
export async function remove(recipeId, workspace = "default") {
  const path = schedulesPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: STORAGE_VERSION, items: [] });
    let items = Array.isArray(data.items) ? data.items : [];
    const ws = String(workspace || "default").trim().slice(0, 50) || "default";
    const before = items.length;
    const filtered = items.filter((i) => !(String(i.recipeId) === String(recipeId) && (i.workspace === ws || !i.workspace)));
    if (filtered.length < before) {
      data.items = filtered;
      await writeJsonPath(path, data);
      return true;
    }
    return false;
  });
}
