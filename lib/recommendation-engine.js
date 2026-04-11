// @ts-check
/**
 * Phase 69.3: Recommendation engine.
 *
 * Hybrid content-based + collaborative filter over items (agents,
 * recipes, documents). Users register interactions (view, like,
 * dislike); items carry tags used by the content similarity score.
 *
 * The recommendation for a user is computed by:
 *
 *   1. Content-based: tag-overlap between items the user has liked
 *      and every other item.
 *   2. Collaborative: items liked by other users whose like-sets
 *      intersect with the target user.
 *
 * Final score = 0.6 * content + 0.4 * collaborative, blended and
 * sorted descending.
 *
 * Exports:
 *   - registerItem
 *   - recordInteraction
 *   - recommend
 *   - listItems
 *   - getItemStats
 *
 * @module recommendation-engine
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "recommendation-engine.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    items: {},
    interactions: {},
  });
  if (!data.items || typeof data.items !== "object") data.items = {};
  if (!data.interactions || typeof data.interactions !== "object") data.interactions = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    items: data.items || {},
    interactions: data.interactions || {},
  });
}

/**
 * Register (or update) an item in the catalog.
 *
 * @param {{ id: string, title?: string, tags?: string[], kind?: string }} spec
 * @returns {Promise<object>}
 */
export async function registerItem(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.id || typeof spec.id !== "string") throw new Error("id is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const existing = data.items[spec.id] || { createdAt: now };
    const record = {
      id: spec.id,
      title: typeof spec.title === "string" ? spec.title : existing.title || spec.id,
      tags: Array.isArray(spec.tags) ? spec.tags.map((t) => String(t).toLowerCase()) : existing.tags || [],
      kind: typeof spec.kind === "string" ? spec.kind : existing.kind || "item",
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
    data.items[spec.id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Record a user interaction with an item. Kinds:
 *   - view:    weight 1
 *   - like:    weight 3
 *   - dislike: weight -3
 * Custom weights can be passed.
 *
 * @param {string} userId
 * @param {string} itemId
 * @param {{ kind?: "view" | "like" | "dislike", weight?: number }} [opts]
 * @returns {Promise<object>}
 */
export async function recordInteraction(userId, itemId, opts = {}) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  if (!itemId || typeof itemId !== "string") throw new Error("itemId is required");
  const kind = opts.kind || "view";
  let weight = Number.isFinite(opts.weight) ? opts.weight : (kind === "like" ? 3 : kind === "dislike" ? -3 : 1);
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.interactions[userId]) data.interactions[userId] = {};
    const cur = data.interactions[userId][itemId] || { score: 0, views: 0, kinds: {} };
    cur.score += weight;
    if (kind === "view") cur.views = (cur.views || 0) + 1;
    cur.kinds[kind] = (cur.kinds[kind] || 0) + 1;
    cur.lastAt = new Date().toISOString();
    data.interactions[userId][itemId] = cur;
    await saveStore(data);
    return cur;
  });
}

function tagOverlap(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const t of a) if (setB.has(t)) hits += 1;
  return hits / Math.sqrt(a.length * b.length);
}

/**
 * Generate recommendations for a user.
 *
 * @param {string} userId
 * @param {{ k?: number, excludeSeen?: boolean }} [opts]
 * @returns {Promise<Array<{ itemId: string, score: number, content: number, collaborative: number, title: string }>>}
 */
export async function recommend(userId, opts = {}) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const k = Number.isFinite(opts.k) && opts.k > 0 ? Math.floor(opts.k) : 5;
  const excludeSeen = opts.excludeSeen !== false;
  const data = await loadStore();
  const items = Object.values(data.items || {});
  const userInteractions = data.interactions[userId] || {};
  // Items the user has positively interacted with.
  const likedItemIds = Object.entries(userInteractions)
    .filter(([, v]) => Number(v?.score) > 0)
    .map(([id]) => id);
  const likedItems = likedItemIds.map((id) => data.items[id]).filter(Boolean);

  /** @type {Map<string, { content: number, collaborative: number }>} */
  const scores = new Map();

  // Content-based.
  for (const item of items) {
    if (excludeSeen && userInteractions[item.id]) continue;
    let best = 0;
    for (const liked of likedItems) {
      const sim = tagOverlap(liked.tags || [], item.tags || []);
      if (sim > best) best = sim;
    }
    if (best > 0) {
      scores.set(item.id, { content: best, collaborative: 0 });
    }
  }

  // Collaborative filter: find peer users with overlapping likes.
  const userLiked = new Set(likedItemIds);
  for (const [peerId, peerInt] of Object.entries(data.interactions)) {
    if (peerId === userId) continue;
    const peerLiked = Object.entries(peerInt || {})
      .filter(([, v]) => Number(v?.score) > 0)
      .map(([id]) => id);
    let overlapCount = 0;
    for (const id of peerLiked) if (userLiked.has(id)) overlapCount += 1;
    if (overlapCount === 0) continue;
    const sim = overlapCount / Math.sqrt(Math.max(1, userLiked.size) * Math.max(1, peerLiked.length));
    for (const id of peerLiked) {
      if (userLiked.has(id)) continue;
      if (excludeSeen && userInteractions[id]) continue;
      const cur = scores.get(id) || { content: 0, collaborative: 0 };
      cur.collaborative = Math.max(cur.collaborative, sim);
      scores.set(id, cur);
    }
  }

  /** @type {Array<{ itemId: string, score: number, content: number, collaborative: number, title: string }>} */
  const out = [];
  for (const [itemId, parts] of scores.entries()) {
    const total = 0.6 * parts.content + 0.4 * parts.collaborative;
    if (total <= 0) continue;
    const item = data.items[itemId];
    out.push({
      itemId,
      score: Math.round(total * 10000) / 10000,
      content: Math.round(parts.content * 10000) / 10000,
      collaborative: Math.round(parts.collaborative * 10000) / 10000,
      title: item?.title || itemId,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

/**
 * List every registered item.
 * @returns {Promise<object[]>}
 */
export async function listItems() {
  const data = await loadStore();
  return Object.values(data.items || {});
}

/**
 * Aggregate stats for a single item across all users.
 * @param {string} itemId
 * @returns {Promise<{ id: string, views: number, likes: number, dislikes: number, totalScore: number } | null>}
 */
export async function getItemStats(itemId) {
  if (!itemId || typeof itemId !== "string") return null;
  const data = await loadStore();
  if (!data.items[itemId]) return null;
  let views = 0;
  let likes = 0;
  let dislikes = 0;
  let totalScore = 0;
  for (const userInt of Object.values(data.interactions || {})) {
    const rec = userInt[itemId];
    if (!rec) continue;
    views += Number(rec.kinds?.view) || 0;
    likes += Number(rec.kinds?.like) || 0;
    dislikes += Number(rec.kinds?.dislike) || 0;
    totalScore += Number(rec.score) || 0;
  }
  return { id: itemId, views, likes, dislikes, totalScore };
}
