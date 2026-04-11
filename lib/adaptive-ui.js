// @ts-check
/**
 * Phase 69.2: Adaptive UI.
 *
 * Records which UI features each user actually uses, then surfaces
 * the ones they use most (and hides the ones they never touch).
 * Ranking is by a blended usage score:
 *
 *   score = uses * recencyBoost
 *
 * where `recencyBoost` ranges from 1.0 for "used today" down to 0.1
 * for "last used 30+ days ago".
 *
 * Exports:
 *   - recordFeatureUse
 *   - getSurfacedFeatures
 *   - rankFeatures
 *   - resetUsage
 *   - listUsers
 *
 * @module adaptive-ui
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function storePath() {
  return join(getDataDir(), "adaptive-ui.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, users: {} });
  if (!data.users || typeof data.users !== "object") data.users = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), { version: STORE_VERSION, users: data.users || {} });
}

function ensureUser(data, userId) {
  if (!data.users[userId]) {
    const now = new Date().toISOString();
    data.users[userId] = {
      userId,
      features: {},
      createdAt: now,
      updatedAt: now,
    };
  }
  return data.users[userId];
}

function recencyBoost(lastUsedAt, now = Date.now()) {
  if (!lastUsedAt) return 0.1;
  const parsed = Date.parse(lastUsedAt);
  if (!Number.isFinite(parsed)) return 0.1;
  const ageDays = (now - parsed) / DAY_MS;
  if (ageDays <= 1) return 1.0;
  if (ageDays >= 30) return 0.1;
  return Math.max(0.1, 1.0 - ageDays / 30);
}

/**
 * Record that a user used a given feature.
 *
 * @param {string} userId
 * @param {string} featureId
 * @param {{ weight?: number }} [opts]
 * @returns {Promise<object>}
 */
export async function recordFeatureUse(userId, featureId, opts = {}) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  if (!featureId || typeof featureId !== "string") throw new Error("featureId is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const user = ensureUser(data, userId);
    const now = new Date().toISOString();
    const w = Number.isFinite(opts.weight) ? opts.weight : 1;
    const cur = user.features[featureId] || { uses: 0, firstUsedAt: now, lastUsedAt: null };
    cur.uses += w;
    cur.lastUsedAt = now;
    user.features[featureId] = cur;
    user.updatedAt = now;
    data.users[userId] = user;
    await saveStore(data);
    return cur;
  });
}

/**
 * Return the features surfaced for a user, ranked by usage score.
 *
 * @param {string} userId
 * @param {{ limit?: number, hideThreshold?: number }} [opts]
 * @returns {Promise<Array<{ featureId: string, uses: number, score: number, lastUsedAt: string | null }>>}
 */
export async function getSurfacedFeatures(userId, opts = {}) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 10;
  const hideThreshold = Number.isFinite(opts.hideThreshold) ? opts.hideThreshold : 0;
  const data = await loadStore();
  const user = data.users[userId];
  if (!user) return [];
  const ranked = rankFeatures(user.features || {});
  return ranked
    .filter((r) => r.score > hideThreshold)
    .slice(0, limit);
}

/**
 * Convert a features map into a ranked array. Pure function so tests
 * can exercise scoring without setting up storage.
 *
 * @param {Record<string, { uses?: number, lastUsedAt?: string | null }>} features
 * @param {number} [now]
 * @returns {Array<{ featureId: string, uses: number, score: number, lastUsedAt: string | null }>}
 */
export function rankFeatures(features, now = Date.now()) {
  if (!features || typeof features !== "object") return [];
  const rows = Object.entries(features).map(([featureId, v]) => {
    const uses = Number(v?.uses) || 0;
    const last = v?.lastUsedAt || null;
    const score = uses * recencyBoost(last, now);
    return {
      featureId,
      uses,
      score: Math.round(score * 10000) / 10000,
      lastUsedAt: last,
    };
  });
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

/**
 * Reset usage counters for a user (all features or a specific one).
 *
 * @param {string} userId
 * @param {{ featureId?: string }} [opts]
 * @returns {Promise<{ cleared: number }>}
 */
export async function resetUsage(userId, opts = {}) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const user = data.users[userId];
    if (!user) return { cleared: 0 };
    let cleared = 0;
    if (opts.featureId) {
      if (user.features[opts.featureId]) {
        delete user.features[opts.featureId];
        cleared = 1;
      }
    } else {
      cleared = Object.keys(user.features || {}).length;
      user.features = {};
    }
    user.updatedAt = new Date().toISOString();
    data.users[userId] = user;
    await saveStore(data);
    return { cleared };
  });
}

/**
 * Return every user id tracked in the adaptive-ui store.
 *
 * @returns {Promise<string[]>}
 */
export async function listUsers() {
  const data = await loadStore();
  return Object.keys(data.users || {});
}
