// @ts-check
/**
 * Phase 69.1: Preference modeling.
 *
 * Captures both implicit preferences (derived from user activity) and
 * explicit preferences (set directly by the user) into a per-user
 * profile. Implicit preferences are stored as category -> weight and
 * decay over time; explicit preferences are stored as key -> value.
 *
 * Exports:
 *   - recordPreference
 *   - getUserProfile
 *   - updateProfile
 *   - listPreferences
 *   - mergePreferences
 *
 * @module preference-modeling
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function profilesPath() {
  return join(getDataDir(), "preference-modeling-profiles.json");
}

async function loadProfiles() {
  const data = await readJsonPath(profilesPath(), { version: STORE_VERSION, profiles: {} });
  if (!data.profiles || typeof data.profiles !== "object") data.profiles = {};
  return data;
}

async function saveProfiles(data) {
  await writeJsonPath(profilesPath(), { version: STORE_VERSION, profiles: data.profiles || {} });
}

function ensureProfile(data, userId) {
  if (!data.profiles[userId]) {
    const now = new Date().toISOString();
    data.profiles[userId] = {
      userId,
      implicit: {},
      explicit: {},
      createdAt: now,
      updatedAt: now,
    };
  }
  return data.profiles[userId];
}

/**
 * Record a single preference signal.
 *
 *   recordPreference(u, { type: "implicit", key: "topic.food", weight: 1 })
 *   recordPreference(u, { type: "explicit", key: "theme", value: "dark" })
 *
 * Implicit signals accumulate weight; explicit signals overwrite.
 *
 * @param {string} userId
 * @param {{ type: "implicit" | "explicit", key: string, weight?: number, value?: any }} signal
 * @returns {Promise<object>}
 */
export async function recordPreference(userId, signal) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  if (!signal || typeof signal !== "object") throw new Error("signal is required");
  if (!signal.key || typeof signal.key !== "string") throw new Error("key is required");
  if (signal.type !== "implicit" && signal.type !== "explicit") {
    throw new Error("type must be 'implicit' or 'explicit'");
  }
  const path = profilesPath();
  return withPathLock(path, async () => {
    const data = await loadProfiles();
    const profile = ensureProfile(data, userId);
    const now = new Date().toISOString();
    if (signal.type === "implicit") {
      const w = Number.isFinite(signal.weight) ? signal.weight : 1;
      const cur = profile.implicit[signal.key] || { weight: 0, count: 0, lastAt: null };
      cur.weight += w;
      cur.count += 1;
      cur.lastAt = now;
      profile.implicit[signal.key] = cur;
    } else {
      profile.explicit[signal.key] = {
        value: signal.value,
        updatedAt: now,
      };
    }
    profile.updatedAt = now;
    data.profiles[userId] = profile;
    await saveProfiles(data);
    return profile;
  });
}

/**
 * Fetch the full profile for a user, creating an empty one if missing.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function getUserProfile(userId) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const data = await loadProfiles();
  const profile = data.profiles[userId];
  if (!profile) {
    return { userId, implicit: {}, explicit: {}, createdAt: null, updatedAt: null };
  }
  return profile;
}

/**
 * Replace or merge explicit profile fields. Use this for bulk edits
 * (e.g., saving a settings page).
 *
 * @param {string} userId
 * @param {{ explicit?: Record<string, any>, replace?: boolean }} updates
 * @returns {Promise<object>}
 */
export async function updateProfile(userId, updates) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  if (!updates || typeof updates !== "object") throw new Error("updates is required");
  const path = profilesPath();
  return withPathLock(path, async () => {
    const data = await loadProfiles();
    const profile = ensureProfile(data, userId);
    const now = new Date().toISOString();
    if (updates.replace === true) {
      profile.explicit = {};
    }
    if (updates.explicit && typeof updates.explicit === "object") {
      for (const [k, v] of Object.entries(updates.explicit)) {
        profile.explicit[k] = { value: v, updatedAt: now };
      }
    }
    profile.updatedAt = now;
    data.profiles[userId] = profile;
    await saveProfiles(data);
    return profile;
  });
}

/**
 * List the top-N implicit preferences for a user, ranked by weight.
 *
 * @param {string} userId
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ key: string, weight: number, count: number, lastAt: string | null }>>}
 */
export async function listPreferences(userId, opts = {}) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 20;
  const data = await loadProfiles();
  const profile = data.profiles[userId];
  if (!profile || !profile.implicit) return [];
  const rows = Object.entries(profile.implicit).map(([k, v]) => ({
    key: k,
    weight: Number(v.weight) || 0,
    count: Number(v.count) || 0,
    lastAt: v.lastAt || null,
  }));
  rows.sort((a, b) => b.weight - a.weight);
  return rows.slice(0, limit);
}

/**
 * Merge two profiles (useful for user-merge flows). Implicit weights
 * are summed, explicit values from `overrides` win. Returns the merged
 * profile and persists it to `targetUserId`.
 *
 * @param {string} targetUserId
 * @param {string} sourceUserId
 * @returns {Promise<object>}
 */
export async function mergePreferences(targetUserId, sourceUserId) {
  if (!targetUserId || !sourceUserId) throw new Error("both user ids are required");
  if (targetUserId === sourceUserId) throw new Error("ids must differ");
  const path = profilesPath();
  return withPathLock(path, async () => {
    const data = await loadProfiles();
    const tgt = ensureProfile(data, targetUserId);
    const src = data.profiles[sourceUserId];
    if (!src) return tgt;
    const now = new Date().toISOString();
    for (const [k, v] of Object.entries(src.implicit || {})) {
      const cur = tgt.implicit[k] || { weight: 0, count: 0, lastAt: null };
      cur.weight += Number(v.weight) || 0;
      cur.count += Number(v.count) || 0;
      cur.lastAt = v.lastAt || cur.lastAt;
      tgt.implicit[k] = cur;
    }
    for (const [k, v] of Object.entries(src.explicit || {})) {
      if (!tgt.explicit[k]) tgt.explicit[k] = { ...v, updatedAt: now };
    }
    tgt.updatedAt = now;
    data.profiles[targetUserId] = tgt;
    await saveProfiles(data);
    return tgt;
  });
}
