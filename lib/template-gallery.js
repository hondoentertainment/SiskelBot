/**
 * Phase 34.2: Public template gallery — shareable workspace templates with ratings and reviews.
 *
 * Storage layout (under data/):
 *   template-gallery/index.json            — list of all gallery entries (metadata)
 *   template-gallery/{galleryId}.json      — full template content
 *   template-gallery/{galleryId}-ratings.json — ratings + reviews for an entry
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { saveWorkspaceAgentSettings } from "./workspace-agent-settings.js";

const GALLERY_VERSION = 1;
const MAX_NAME_LEN = 120;
const MAX_DESCRIPTION_LEN = 2000;
const MAX_CATEGORY_LEN = 60;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;
const MAX_REVIEW_LEN = 1000;
const VALID_SORTS = new Set(["popular", "recent", "rating"]);

function galleryDir() {
  return join(getDataDir(), "template-gallery");
}

function indexPath() {
  return join(galleryDir(), "index.json");
}

function entryPath(galleryId) {
  return join(galleryDir(), `${galleryId}.json`);
}

function ratingsPath(galleryId) {
  return join(galleryDir(), `${galleryId}-ratings.json`);
}

function sanitizeId(id) {
  if (typeof id !== "string") return "";
  return id.trim().replace(/[^a-zA-Z0-9._-]/g, "");
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === "string" ? t.trim().toLowerCase().slice(0, MAX_TAG_LEN) : ""))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}

function normalizeCategory(c) {
  if (typeof c !== "string") return "general";
  const v = c.trim().toLowerCase().slice(0, MAX_CATEGORY_LEN);
  return v || "general";
}

async function loadIndex() {
  const data = await readJsonPath(indexPath(), { _version: GALLERY_VERSION, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveIndex(items) {
  await writeJsonPath(indexPath(), { _version: GALLERY_VERSION, items });
}

/**
 * Publish a template to the public gallery.
 * @param {string} workspaceId
 * @param {object} templateData - { name, description, category, tags, content }
 * @param {object} publisher - { userId, displayName }
 * @returns {Promise<{ galleryId: string, publishedAt: string }>}
 */
export async function publishTemplate(workspaceId, templateData, publisher) {
  if (!templateData || typeof templateData !== "object") {
    throw new Error("templateData is required");
  }
  if (!publisher || typeof publisher !== "object" || !publisher.userId) {
    throw new Error("publisher.userId is required");
  }
  const name = typeof templateData.name === "string" ? templateData.name.trim().slice(0, MAX_NAME_LEN) : "";
  if (!name) {
    throw new Error("template name is required");
  }
  const description = typeof templateData.description === "string"
    ? templateData.description.trim().slice(0, MAX_DESCRIPTION_LEN)
    : "";
  const category = normalizeCategory(templateData.category);
  const tags = normalizeTags(templateData.tags);
  const content = templateData.content && typeof templateData.content === "object"
    ? templateData.content
    : {};

  const galleryId = randomUUID();
  const publishedAt = new Date().toISOString();
  const indexEntry = {
    galleryId,
    name,
    description,
    category,
    tags,
    publisherUserId: String(publisher.userId),
    publisherDisplayName: typeof publisher.displayName === "string"
      ? publisher.displayName.trim().slice(0, 120)
      : String(publisher.userId),
    sourceWorkspaceId: workspaceId ? String(workspaceId) : null,
    publishedAt,
    updatedAt: publishedAt,
    downloads: 0,
    ratingAverage: 0,
    ratingCount: 0,
  };

  // Persist full entry (with content) at its own key.
  await writeJsonPath(entryPath(galleryId), {
    _version: GALLERY_VERSION,
    ...indexEntry,
    content,
  });
  // Initialize empty ratings file.
  await writeJsonPath(ratingsPath(galleryId), {
    _version: GALLERY_VERSION,
    ratings: [],
  });

  await withPathLock(indexPath(), async () => {
    const items = await loadIndex();
    items.push(indexEntry);
    await saveIndex(items);
  });

  return { galleryId, publishedAt };
}

/**
 * Unpublish a template (only its publisher can unpublish).
 * @param {string} galleryId
 * @param {string} publisherUserId
 * @returns {Promise<{ ok: boolean }>}
 */
export async function unpublishTemplate(galleryId, publisherUserId) {
  const id = sanitizeId(galleryId);
  if (!id) {
    return { ok: false, error: "invalid galleryId" };
  }
  if (!publisherUserId) {
    return { ok: false, error: "publisherUserId required" };
  }
  return withPathLock(indexPath(), async () => {
    const items = await loadIndex();
    const idx = items.findIndex((e) => e.galleryId === id);
    if (idx < 0) {
      return { ok: false, error: "not found" };
    }
    if (String(items[idx].publisherUserId) !== String(publisherUserId)) {
      return { ok: false, error: "forbidden" };
    }
    items.splice(idx, 1);
    await saveIndex(items);
    // Clear the entry and ratings (best-effort).
    await writeJsonPath(entryPath(id), { _version: GALLERY_VERSION, deleted: true });
    await writeJsonPath(ratingsPath(id), { _version: GALLERY_VERSION, deleted: true, ratings: [] });
    return { ok: true };
  });
}

/**
 * Get a single gallery template (full content).
 * @param {string} galleryId
 * @returns {Promise<object|null>}
 */
export async function getGalleryTemplate(galleryId) {
  const id = sanitizeId(galleryId);
  if (!id) return null;
  const data = await readJsonPath(entryPath(id), null);
  if (!data || data.deleted || !data.galleryId) return null;
  return data;
}

/**
 * List gallery templates with optional filters and sort.
 * @param {object} [options] - { category, tag, sortBy, limit, offset }
 * @returns {Promise<{ items: object[], total: number }>}
 */
export async function listGalleryTemplates(options = {}) {
  const items = await loadIndex();
  let filtered = items.slice();
  if (options.category) {
    const cat = normalizeCategory(options.category);
    filtered = filtered.filter((e) => e.category === cat);
  }
  if (options.tag) {
    const tag = String(options.tag).trim().toLowerCase();
    filtered = filtered.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
  }
  const sortBy = VALID_SORTS.has(options.sortBy) ? options.sortBy : "recent";
  if (sortBy === "popular") {
    filtered.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  } else if (sortBy === "rating") {
    filtered.sort((a, b) => {
      const ar = a.ratingAverage || 0;
      const br = b.ratingAverage || 0;
      if (br !== ar) return br - ar;
      return (b.ratingCount || 0) - (a.ratingCount || 0);
    });
  } else {
    filtered.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  }
  const total = filtered.length;
  const offset = Number.isInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;
  const page = filtered.slice(offset, offset + limit);
  return { items: page, total };
}

/**
 * Search gallery templates by free-text query against name, description, tags.
 * @param {string} query
 * @param {object} [options]
 * @returns {Promise<{ items: object[], total: number }>}
 */
export async function searchGalleryTemplates(query, options = {}) {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q) {
    return listGalleryTemplates(options);
  }
  const items = await loadIndex();
  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = items.filter((e) => {
    const hay = [
      e.name || "",
      e.description || "",
      e.category || "",
      ...(Array.isArray(e.tags) ? e.tags : []),
    ].join(" ").toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  const sortBy = VALID_SORTS.has(options.sortBy) ? options.sortBy : "popular";
  if (sortBy === "popular") {
    matches.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  } else if (sortBy === "rating") {
    matches.sort((a, b) => (b.ratingAverage || 0) - (a.ratingAverage || 0));
  } else {
    matches.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  }
  const total = matches.length;
  const offset = Number.isInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;
  return { items: matches.slice(offset, offset + limit), total };
}

/**
 * Install a gallery template into a target workspace.
 * Increments the entry's download count.
 * @param {string} galleryId
 * @param {string} targetWorkspaceId
 * @param {string} userId - storage user installing
 * @returns {Promise<{ installed: boolean, workspaceId: string, galleryId: string }>}
 */
export async function installFromGallery(galleryId, targetWorkspaceId, userId) {
  const id = sanitizeId(galleryId);
  if (!id) throw new Error("invalid galleryId");
  if (!targetWorkspaceId) throw new Error("targetWorkspaceId is required");
  if (!userId) throw new Error("userId is required");

  const entry = await getGalleryTemplate(id);
  if (!entry) {
    throw new Error("template not found");
  }

  // Increment download count atomically.
  await withPathLock(indexPath(), async () => {
    const items = await loadIndex();
    const idx = items.findIndex((e) => e.galleryId === id);
    if (idx >= 0) {
      items[idx].downloads = (items[idx].downloads || 0) + 1;
      await saveIndex(items);
    }
  });
  // Mirror download count into the entry file.
  const fresh = await readJsonPath(entryPath(id), null);
  if (fresh && fresh.galleryId) {
    fresh.downloads = (fresh.downloads || 0) + 1;
    await writeJsonPath(entryPath(id), fresh);
  }

  // Apply template content to the workspace agent settings.
  const content = entry.content || {};
  const settings = {
    defaultSystemPrompt: typeof content.defaultSystemPrompt === "string" ? content.defaultSystemPrompt : "",
    memorySnippets: Array.isArray(content.memorySnippets) ? content.memorySnippets : [],
    allowedTools: Array.isArray(content.toolAllowlist)
      ? content.toolAllowlist
      : Array.isArray(content.allowedTools) ? content.allowedTools : [],
  };
  try {
    await saveWorkspaceAgentSettings(userId, targetWorkspaceId, settings);
  } catch {
    // settings save is best-effort; do not fail the install
  }
  return { installed: true, workspaceId: targetWorkspaceId, galleryId: id };
}

/**
 * Submit (or update) a rating + optional review for a gallery template.
 * Each user contributes a single rating per template; submitting again replaces.
 * @param {string} galleryId
 * @param {string} userId
 * @param {number} rating - integer 1-5
 * @param {string} [review]
 * @returns {Promise<{ ok: boolean, average: number, count: number }>}
 */
export async function rateTemplate(galleryId, userId, rating, review) {
  const id = sanitizeId(galleryId);
  if (!id) throw new Error("invalid galleryId");
  if (!userId) throw new Error("userId is required");
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) {
    throw new Error("rating must be an integer between 1 and 5");
  }
  const reviewText = typeof review === "string" ? review.trim().slice(0, MAX_REVIEW_LEN) : "";

  const entry = await getGalleryTemplate(id);
  if (!entry) {
    throw new Error("template not found");
  }

  let average = 0;
  let count = 0;
  await withPathLock(ratingsPath(id), async () => {
    const data = await readJsonPath(ratingsPath(id), { _version: GALLERY_VERSION, ratings: [] });
    const ratings = Array.isArray(data.ratings) ? data.ratings : [];
    const existingIdx = ratings.findIndex((x) => String(x.userId) === String(userId));
    const ratingEntry = {
      userId: String(userId),
      rating: r,
      review: reviewText,
      createdAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) {
      ratings[existingIdx] = ratingEntry;
    } else {
      ratings.push(ratingEntry);
    }
    count = ratings.length;
    const sum = ratings.reduce((acc, x) => acc + (Number(x.rating) || 0), 0);
    average = count > 0 ? Number((sum / count).toFixed(2)) : 0;
    await writeJsonPath(ratingsPath(id), { _version: GALLERY_VERSION, ratings });
  });

  // Update aggregate on the index entry and entry file.
  await withPathLock(indexPath(), async () => {
    const items = await loadIndex();
    const idx = items.findIndex((e) => e.galleryId === id);
    if (idx >= 0) {
      items[idx].ratingAverage = average;
      items[idx].ratingCount = count;
      await saveIndex(items);
    }
  });
  const fresh = await readJsonPath(entryPath(id), null);
  if (fresh && fresh.galleryId) {
    fresh.ratingAverage = average;
    fresh.ratingCount = count;
    await writeJsonPath(entryPath(id), fresh);
  }

  return { ok: true, average, count };
}

/**
 * Get aggregated ratings (average, distribution, reviews) for a template.
 * @param {string} galleryId
 * @returns {Promise<{ average: number, count: number, distribution: object, reviews: object[] }>}
 */
export async function getRatings(galleryId) {
  const id = sanitizeId(galleryId);
  if (!id) {
    return { average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, reviews: [] };
  }
  const data = await readJsonPath(ratingsPath(id), { ratings: [] });
  const ratings = Array.isArray(data.ratings) ? data.ratings : [];
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of ratings) {
    const v = Number(r.rating);
    if (Number.isInteger(v) && v >= 1 && v <= 5) {
      distribution[v] += 1;
      sum += v;
    }
  }
  const count = ratings.length;
  const average = count > 0 ? Number((sum / count).toFixed(2)) : 0;
  const reviews = ratings
    .filter((r) => r.review && typeof r.review === "string")
    .map((r) => ({
      userId: r.userId,
      rating: r.rating,
      review: r.review,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return { average, count, distribution, reviews };
}

/**
 * Get all templates published by a given user.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function getPublisherTemplates(userId) {
  if (!userId) return [];
  const items = await loadIndex();
  return items
    .filter((e) => String(e.publisherUserId) === String(userId))
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
}

/**
 * Aggregate gallery statistics.
 * @returns {Promise<{ totalTemplates: number, totalDownloads: number, totalPublishers: number, topCategories: object[] }>}
 */
export async function getGalleryStats() {
  const items = await loadIndex();
  const totalTemplates = items.length;
  let totalDownloads = 0;
  const publishers = new Set();
  const catCounts = new Map();
  for (const e of items) {
    totalDownloads += Number(e.downloads || 0);
    if (e.publisherUserId) publishers.add(String(e.publisherUserId));
    const c = e.category || "general";
    catCounts.set(c, (catCounts.get(c) || 0) + 1);
  }
  const topCategories = [...catCounts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    totalTemplates,
    totalDownloads,
    totalPublishers: publishers.size,
    topCategories,
  };
}
