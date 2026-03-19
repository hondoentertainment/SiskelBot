/**
 * Phase 16: Scheduled & Automated Recipes
 * JSON file-based store for recipe schedules. Schema: { _version: 1, items: [...] }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.STORAGE_PATH || join(process.cwd(), "data");
const SCHEDULES_PATH = join(DATA_DIR, "schedules.json");
const STORAGE_VERSION = 1;

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load() {
  try {
    if (existsSync(SCHEDULES_PATH)) {
      const raw = readFileSync(SCHEDULES_PATH, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data.items) ? data.items : [];
    }
  } catch (e) {
    console.warn("[schedules] Failed to load:", e.message);
  }
  return [];
}

function save(items) {
  ensureDir(dirname(SCHEDULES_PATH));
  writeFileSync(SCHEDULES_PATH, JSON.stringify({ _version: STORAGE_VERSION, items }, null, 0), "utf8");
}

/**
 * List all schedules (optionally filtered by workspace).
 * @param {string} [workspace='default']
 */
export function list(workspace = "default") {
  const items = load();
  if (!workspace || workspace === "default") {
    return items.filter((i) => !i.workspace || i.workspace === "default");
  }
  return items.filter((i) => i.workspace === workspace);
}

/**
 * Get schedule for a recipe.
 */
export function get(recipeId, workspace = "default") {
  const items = list(workspace);
  return items.find((i) => String(i.recipeId) === String(recipeId)) || null;
}

/**
 * Add or update a schedule.
 */
export function upsert(recipeId, { cron, timezone, enabled = true }, workspace = "default") {
  const items = load();
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
  save(items);
  return items.find((i) => String(i.recipeId) === String(recipeId));
}

/**
 * Remove schedule for a recipe.
 */
export function remove(recipeId, workspace = "default") {
  const items = load();
  const ws = String(workspace || "default").trim().slice(0, 50) || "default";
  const before = items.length;
  const filtered = items.filter((i) => !(String(i.recipeId) === String(recipeId) && (i.workspace === ws || !i.workspace)));
  if (filtered.length < before) {
    save(filtered);
    return true;
  }
  return false;
}
