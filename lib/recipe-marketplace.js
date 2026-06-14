/**
 * Phase 34.3: Recipe Marketplace
 * Community-contributed recipe templates with categories, ratings, forks, stars,
 * and version history. Stored under data/recipe-marketplace/*.json via json-path-store.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import * as storage from "./storage.js";

export const RECIPE_CATEGORIES = [
  "automation",
  "deployment",
  "data-processing",
  "integration",
  "monitoring",
  "notification",
  "content-generation",
  "analysis",
  "other",
];

const MAX_RECIPES = 50_000;

// ─── storage helpers ────────────────────────────────────────────────────────

function recipesPath() {
  return join(getDataDir(), "recipe-marketplace", "recipes.json");
}

function starsPath() {
  return join(getDataDir(), "recipe-marketplace", "stars.json");
}

function eventsPath() {
  return join(getDataDir(), "recipe-marketplace", "events.json");
}

async function loadRecipes() {
  const data = await readJsonPath(recipesPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveRecipes(items) {
  const trimmed = items.length > MAX_RECIPES ? items.slice(-MAX_RECIPES) : items;
  await writeJsonPath(recipesPath(), { _version: 1, items: trimmed });
}

async function loadStars() {
  const data = await readJsonPath(starsPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveStars(items) {
  await writeJsonPath(starsPath(), { _version: 1, items });
}

async function loadEvents() {
  const data = await readJsonPath(eventsPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function appendEvent(event) {
  await withPathLock(eventsPath(), async () => {
    const events = await loadEvents();
    events.push(event);
    const trimmed = events.length > MAX_RECIPES ? events.slice(-MAX_RECIPES) : events;
    await writeJsonPath(eventsPath(), { _version: 1, items: trimmed });
  });
}

// ─── utilities ──────────────────────────────────────────────────────────────

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function uniqueSlug(base, existing) {
  const taken = new Set(existing.map((r) => r.slug));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function bumpVersion(prev) {
  if (!prev || typeof prev !== "string") return "1.0.0";
  const parts = prev.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return "1.0.0";
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim().toLowerCase().slice(0, 32))
    .slice(0, 12);
}

function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 100);
}

function recipePublic(recipe) {
  if (!recipe) return null;
  const versions = Array.isArray(recipe.versions) ? recipe.versions : [];
  const latest = versions[versions.length - 1] || null;
  return {
    marketplaceId: recipe.marketplaceId,
    slug: recipe.slug,
    name: recipe.name,
    description: recipe.description,
    category: recipe.category,
    tags: recipe.tags,
    icon: recipe.icon,
    screenshots: recipe.screenshots || [],
    publisher: recipe.publisher,
    publishedAt: recipe.publishedAt,
    updatedAt: recipe.updatedAt,
    version: latest ? latest.version : "1.0.0",
    steps: latest ? latest.steps : [],
    stars: recipe.stars || 0,
    forks: recipe.forks || 0,
    installs: recipe.installs || 0,
    forkedFrom: recipe.forkedFrom || null,
  };
}

// ─── publish ────────────────────────────────────────────────────────────────

/**
 * Publish a new recipe to the marketplace.
 * @param {string} workspaceId - Source workspace
 * @param {object} recipeData - { name, description, category, tags, steps, icon?, screenshots? }
 * @param {object} publisher - { userId, name }
 * @returns {Promise<{ marketplaceId, slug, publishedAt, version }>}
 */
export async function publishRecipe(workspaceId, recipeData, publisher) {
  if (!recipeData || typeof recipeData !== "object") {
    throw new Error("recipeData is required");
  }
  if (!recipeData.name || typeof recipeData.name !== "string" || !recipeData.name.trim()) {
    throw new Error("recipe name is required");
  }
  const category = recipeData.category && RECIPE_CATEGORIES.includes(recipeData.category)
    ? recipeData.category
    : "other";
  const pub = publisher && typeof publisher === "object"
    ? { userId: publisher.userId || "anonymous", name: publisher.name || publisher.userId || "anonymous" }
    : { userId: "anonymous", name: "anonymous" };

  const marketplaceId = randomUUID();
  const publishedAt = new Date().toISOString();
  const version = "1.0.0";
  const path = recipesPath();

  const entry = {
    marketplaceId,
    slug: "",
    sourceWorkspaceId: typeof workspaceId === "string" ? workspaceId : "default",
    name: recipeData.name.trim().slice(0, 128),
    description: typeof recipeData.description === "string"
      ? recipeData.description.trim().slice(0, 1024)
      : "",
    category,
    tags: sanitizeTags(recipeData.tags),
    icon: typeof recipeData.icon === "string" ? recipeData.icon.slice(0, 256) : null,
    screenshots: Array.isArray(recipeData.screenshots)
      ? recipeData.screenshots.filter((s) => typeof s === "string").slice(0, 10)
      : [],
    publisher: pub,
    publishedAt,
    updatedAt: publishedAt,
    versions: [
      {
        version,
        steps: sanitizeSteps(recipeData.steps),
        notes: "Initial release",
        publishedAt,
        publishedBy: pub.userId,
      },
    ],
    stars: 0,
    forks: 0,
    installs: 0,
    forkedFrom: null,
  };

  await withPathLock(path, async () => {
    const items = await loadRecipes();
    entry.slug = uniqueSlug(slugify(entry.name) || marketplaceId, items);
    items.push(entry);
    await saveRecipes(items);
  });

  await appendEvent({
    type: "publish",
    marketplaceId,
    userId: pub.userId,
    timestamp: publishedAt,
  });

  return { marketplaceId, slug: entry.slug, publishedAt, version };
}

// ─── update (new version) ───────────────────────────────────────────────────

/**
 * Update a recipe by appending a new version. Keeps version history.
 * @param {string} marketplaceId
 * @param {object} updates - { name?, description?, category?, tags?, steps?, icon?, screenshots?, notes? }
 * @param {string} publisherUserId
 * @returns {Promise<object>}
 */
export async function updateRecipe(marketplaceId, updates, publisherUserId) {
  if (!marketplaceId) throw new Error("marketplaceId is required");
  if (!updates || typeof updates !== "object") throw new Error("updates required");

  const path = recipesPath();
  let result = null;

  await withPathLock(path, async () => {
    const items = await loadRecipes();
    const idx = items.findIndex((r) => r.marketplaceId === marketplaceId);
    if (idx === -1) throw new Error("recipe not found");
    const recipe = items[idx];
    if (publisherUserId && recipe.publisher && recipe.publisher.userId !== publisherUserId) {
      throw new Error("only the publisher can update this recipe");
    }

    if (typeof updates.name === "string" && updates.name.trim()) {
      recipe.name = updates.name.trim().slice(0, 128);
    }
    if (typeof updates.description === "string") {
      recipe.description = updates.description.trim().slice(0, 1024);
    }
    if (updates.category && RECIPE_CATEGORIES.includes(updates.category)) {
      recipe.category = updates.category;
    }
    if (updates.tags !== undefined) {
      recipe.tags = sanitizeTags(updates.tags);
    }
    if (typeof updates.icon === "string") {
      recipe.icon = updates.icon.slice(0, 256);
    }
    if (Array.isArray(updates.screenshots)) {
      recipe.screenshots = updates.screenshots
        .filter((s) => typeof s === "string")
        .slice(0, 10);
    }

    if (Array.isArray(updates.steps)) {
      const versions = Array.isArray(recipe.versions) ? recipe.versions : [];
      const prev = versions[versions.length - 1];
      const newVersion = bumpVersion(prev ? prev.version : "1.0.0");
      versions.push({
        version: newVersion,
        steps: sanitizeSteps(updates.steps),
        notes: typeof updates.notes === "string" ? updates.notes.slice(0, 512) : "",
        publishedAt: new Date().toISOString(),
        publishedBy: publisherUserId || (recipe.publisher && recipe.publisher.userId) || "anonymous",
      });
      recipe.versions = versions;
    }

    recipe.updatedAt = new Date().toISOString();
    items[idx] = recipe;
    await saveRecipes(items);
    result = recipe;
  });

  await appendEvent({
    type: "update",
    marketplaceId,
    userId: publisherUserId || "anonymous",
    timestamp: new Date().toISOString(),
  });

  return recipePublic(result);
}

// ─── fork ───────────────────────────────────────────────────────────────────

/**
 * Fork a marketplace recipe into a target workspace.
 * @param {string} marketplaceId
 * @param {string} targetWorkspaceId
 * @param {string} userId
 * @returns {Promise<{ recipeId: string, forkedFrom: string }>}
 */
export async function forkRecipe(marketplaceId, targetWorkspaceId, userId) {
  if (!marketplaceId) throw new Error("marketplaceId is required");
  if (!targetWorkspaceId) throw new Error("targetWorkspaceId is required");

  const path = recipesPath();
  let recipe = null;

  await withPathLock(path, async () => {
    const items = await loadRecipes();
    const idx = items.findIndex((r) => r.marketplaceId === marketplaceId);
    if (idx === -1) throw new Error("recipe not found");
    items[idx].forks = (items[idx].forks || 0) + 1;
    items[idx].installs = (items[idx].installs || 0) + 1;
    recipe = items[idx];
    await saveRecipes(items);
  });

  // Copy to target workspace via storage.mergeItems
  const versions = Array.isArray(recipe.versions) ? recipe.versions : [];
  const latest = versions[versions.length - 1] || { steps: [] };
  const newRecipeId = randomUUID();
  const localItem = {
    id: newRecipeId,
    name: recipe.name,
    description: recipe.description,
    steps: latest.steps || [],
    category: recipe.category,
    tags: recipe.tags,
    forkedFromMarketplaceId: marketplaceId,
    forkedFromName: recipe.name,
    forkedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  try {
    if (typeof storage.mergeItems === "function") {
      await storage.mergeItems("recipes", targetWorkspaceId, [localItem], userId || "anonymous");
    }
  } catch (err) {
    // Non-fatal; lineage is still recorded in marketplace
    console.warn("[recipe-marketplace] Fork copy to workspace failed:", err.message);
  }

  await appendEvent({
    type: "fork",
    marketplaceId,
    userId: userId || "anonymous",
    targetWorkspaceId,
    forkedRecipeId: newRecipeId,
    timestamp: new Date().toISOString(),
  });

  return { recipeId: newRecipeId, forkedFrom: marketplaceId };
}

// ─── list / search / get ────────────────────────────────────────────────────

/**
 * List marketplace recipes with filters and sorting.
 * @param {object} [options] - { category, tag, sortBy, author, limit, offset }
 * @returns {Promise<{ items: object[], total: number }>}
 */
export async function listMarketplaceRecipes(options = {}) {
  const {
    category = null,
    tag = null,
    sortBy = "newest",
    author = null,
    limit = 50,
    offset = 0,
  } = options;

  let items = await loadRecipes();

  if (category) items = items.filter((r) => r.category === category);
  if (tag) items = items.filter((r) => Array.isArray(r.tags) && r.tags.includes(String(tag).toLowerCase()));
  if (author) {
    items = items.filter((r) => r.publisher && (r.publisher.userId === author || r.publisher.name === author));
  }

  switch (sortBy) {
    case "stars":
      items.sort((a, b) => (b.stars || 0) - (a.stars || 0));
      break;
    case "forks":
      items.sort((a, b) => (b.forks || 0) - (a.forks || 0));
      break;
    case "installs":
      items.sort((a, b) => (b.installs || 0) - (a.installs || 0));
      break;
    case "name":
      items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      break;
    case "oldest":
      items.sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
      break;
    case "newest":
    default:
      items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      break;
  }

  const total = items.length;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const slice = items.slice(safeOffset, safeOffset + safeLimit);
  return { items: slice.map(recipePublic), total };
}

/**
 * Search marketplace recipes by query string.
 * @param {string} query
 * @returns {Promise<object[]>}
 */
export async function searchMarketplaceRecipes(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const items = await loadRecipes();
  const matches = items.filter((r) => {
    const haystack = [
      r.name,
      r.description,
      r.category,
      ...(Array.isArray(r.tags) ? r.tags : []),
      r.publisher && r.publisher.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
  return matches.map(recipePublic);
}

/**
 * Get a single marketplace recipe by id (or slug).
 * @param {string} marketplaceId
 * @returns {Promise<object|null>}
 */
export async function getMarketplaceRecipe(marketplaceId) {
  if (!marketplaceId) return null;
  const items = await loadRecipes();
  const found = items.find(
    (r) => r.marketplaceId === marketplaceId || r.slug === marketplaceId
  );
  return found ? recipePublic(found) : null;
}

/**
 * Get version history for a marketplace recipe.
 * @param {string} marketplaceId
 * @returns {Promise<object[]>}
 */
export async function getRecipeVersions(marketplaceId) {
  if (!marketplaceId) return [];
  const items = await loadRecipes();
  const found = items.find(
    (r) => r.marketplaceId === marketplaceId || r.slug === marketplaceId
  );
  if (!found) return [];
  return (Array.isArray(found.versions) ? found.versions : []).map((v) => ({
    version: v.version,
    notes: v.notes || "",
    publishedAt: v.publishedAt,
    publishedBy: v.publishedBy,
    stepCount: Array.isArray(v.steps) ? v.steps.length : 0,
  }));
}

/**
 * Get all forks of a marketplace recipe.
 * @param {string} marketplaceId
 * @returns {Promise<object[]>}
 */
export async function getRecipeForks(marketplaceId) {
  if (!marketplaceId) return [];
  const events = await loadEvents();
  return events
    .filter((e) => e.type === "fork" && e.marketplaceId === marketplaceId)
    .map((e) => ({
      forkedRecipeId: e.forkedRecipeId,
      targetWorkspaceId: e.targetWorkspaceId,
      userId: e.userId,
      timestamp: e.timestamp,
    }));
}

// ─── stars ──────────────────────────────────────────────────────────────────

/**
 * Toggle a star on a recipe by user.
 * @param {string} marketplaceId
 * @param {string} userId
 * @returns {Promise<{ starred: boolean, count: number }>}
 */
export async function starRecipe(marketplaceId, userId) {
  if (!marketplaceId) throw new Error("marketplaceId is required");
  if (!userId) throw new Error("userId is required");

  const sPath = starsPath();
  const rPath = recipesPath();
  let starred = false;
  let count = 0;

  await withPathLock(sPath, async () => {
    const stars = await loadStars();
    const existingIdx = stars.findIndex(
      (s) => s.marketplaceId === marketplaceId && s.userId === userId
    );
    if (existingIdx >= 0) {
      stars.splice(existingIdx, 1);
      starred = false;
    } else {
      stars.push({
        marketplaceId,
        userId,
        timestamp: new Date().toISOString(),
      });
      starred = true;
    }
    await saveStars(stars);
    count = stars.filter((s) => s.marketplaceId === marketplaceId).length;
  });

  await withPathLock(rPath, async () => {
    const items = await loadRecipes();
    const idx = items.findIndex((r) => r.marketplaceId === marketplaceId);
    if (idx >= 0) {
      items[idx].stars = count;
      await saveRecipes(items);
    }
  });

  await appendEvent({
    type: starred ? "star" : "unstar",
    marketplaceId,
    userId,
    timestamp: new Date().toISOString(),
  });

  return { starred, count };
}

/**
 * Get the star count for a recipe.
 * @param {string} marketplaceId
 * @returns {Promise<number>}
 */
export async function getStarCount(marketplaceId) {
  if (!marketplaceId) return 0;
  const stars = await loadStars();
  return stars.filter((s) => s.marketplaceId === marketplaceId).length;
}

// ─── trending ───────────────────────────────────────────────────────────────

/**
 * Compute trending recipes based on stars + forks + installs in a period.
 * @param {"24h"|"7d"|"30d"} [period="7d"]
 * @returns {Promise<object[]>}
 */
export async function getTrendingRecipes(period = "7d") {
  const cutoff = parsePeriodCutoff(period) || (Date.now() - 7 * 24 * 3_600_000);
  const events = await loadEvents();
  const recent = events.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });

  const scores = new Map();
  for (const e of recent) {
    if (!e.marketplaceId) continue;
    const cur = scores.get(e.marketplaceId) || 0;
    let weight = 0;
    if (e.type === "star") weight = 3;
    else if (e.type === "fork") weight = 5;
    else if (e.type === "publish") weight = 1;
    else if (e.type === "update") weight = 1;
    scores.set(e.marketplaceId, cur + weight);
  }

  const items = await loadRecipes();
  const ranked = items
    .map((r) => ({ recipe: r, score: scores.get(r.marketplaceId) || 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map((x) => ({ ...recipePublic(x.recipe), trendingScore: x.score }));

  return ranked;
}

// ─── stats ──────────────────────────────────────────────────────────────────

/**
 * Get aggregate stats for a recipe.
 * @param {string} marketplaceId
 * @returns {Promise<{ stars: number, forks: number, installs: number, avgRating: number, versions: number }>}
 */
export async function getRecipeStats(marketplaceId) {
  if (!marketplaceId) {
    return { stars: 0, forks: 0, installs: 0, avgRating: 0, versions: 0 };
  }
  const items = await loadRecipes();
  const recipe = items.find((r) => r.marketplaceId === marketplaceId);
  if (!recipe) {
    return { stars: 0, forks: 0, installs: 0, avgRating: 0, versions: 0 };
  }
  const stars = await getStarCount(marketplaceId);
  // No explicit ratings system yet — derive a simple proxy from stars vs installs.
  const installs = recipe.installs || 0;
  const avgRating = installs > 0
    ? Math.round(Math.min(5, 3 + (stars / Math.max(installs, 1)) * 2) * 100) / 100
    : (stars > 0 ? 5 : 0);
  return {
    stars,
    forks: recipe.forks || 0,
    installs,
    avgRating,
    versions: Array.isArray(recipe.versions) ? recipe.versions.length : 0,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function parsePeriodCutoff(period) {
  if (!period) return null;
  const match = String(period).match(/^(\d+)([dhm])$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  let ms;
  if (unit === "d") ms = n * 24 * 3_600_000;
  else if (unit === "h") ms = n * 3_600_000;
  else if (unit === "m") ms = n * 60_000;
  else return null;
  return Date.now() - ms;
}

// Test helper: clear all marketplace state for a clean slate.
export async function _resetMarketplaceForTests() {
  await writeJsonPath(recipesPath(), { _version: 1, items: [] });
  await writeJsonPath(starsPath(), { _version: 1, items: [] });
  await writeJsonPath(eventsPath(), { _version: 1, items: [] });
}
