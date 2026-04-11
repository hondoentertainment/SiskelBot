// @ts-check
/**
 * Phase 69.4: Personalized prompts.
 *
 * Per-user system prompts are composed from a base template plus a
 * set of "traits" (tone, domain focus, language preference, etc.).
 * Traits are stored per user and reused until revoked.
 *
 * Exports:
 *   - buildSystemPrompt
 *   - registerTrait
 *   - listTraits
 *   - clearTraits
 *   - getPromptForUser
 *
 * @module personalized-prompts
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const DEFAULT_BASE = "You are SiskelBot, a helpful assistant.";

function storePath() {
  return join(getDataDir(), "personalized-prompts.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    users: {},
    base: DEFAULT_BASE,
  });
  if (!data.users || typeof data.users !== "object") data.users = {};
  if (typeof data.base !== "string") data.base = DEFAULT_BASE;
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    users: data.users || {},
    base: data.base || DEFAULT_BASE,
  });
}

/**
 * Compose a system prompt from a base string and an array of traits.
 * Pure function — no storage access.
 *
 * @param {string} base
 * @param {Array<{ key: string, value: string }>} traits
 * @returns {string}
 */
export function buildSystemPrompt(base, traits) {
  const header = typeof base === "string" && base.trim() ? base.trim() : DEFAULT_BASE;
  if (!Array.isArray(traits) || traits.length === 0) return header;
  const lines = [header];
  for (const t of traits) {
    if (!t || typeof t !== "object") continue;
    const k = String(t.key || "").trim();
    const v = String(t.value || "").trim();
    if (!k || !v) continue;
    lines.push(`- ${k}: ${v}`);
  }
  return lines.join("\n");
}

/**
 * Register (or update) a trait for a user.
 *
 * @param {string} userId
 * @param {{ key: string, value: string }} trait
 * @returns {Promise<object>}
 */
export async function registerTrait(userId, trait) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  if (!trait || typeof trait !== "object") throw new Error("trait is required");
  if (!trait.key || typeof trait.key !== "string") throw new Error("trait.key is required");
  if (typeof trait.value !== "string") throw new Error("trait.value must be a string");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.users[userId]) data.users[userId] = { traits: {}, createdAt: new Date().toISOString() };
    const user = data.users[userId];
    const now = new Date().toISOString();
    user.traits[trait.key] = { value: trait.value, updatedAt: now };
    user.updatedAt = now;
    await saveStore(data);
    return user;
  });
}

/**
 * List all traits for a given user.
 *
 * @param {string} userId
 * @returns {Promise<Array<{ key: string, value: string, updatedAt: string }>>}
 */
export async function listTraits(userId) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const data = await loadStore();
  const user = data.users[userId];
  if (!user) return [];
  return Object.entries(user.traits || {}).map(([k, v]) => ({
    key: k,
    value: v.value,
    updatedAt: v.updatedAt || null,
  }));
}

/**
 * Remove one or all traits for a user.
 *
 * @param {string} userId
 * @param {{ key?: string }} [opts]
 * @returns {Promise<{ cleared: number }>}
 */
export async function clearTraits(userId, opts = {}) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const user = data.users[userId];
    if (!user) return { cleared: 0 };
    let cleared = 0;
    if (opts.key) {
      if (user.traits[opts.key]) {
        delete user.traits[opts.key];
        cleared = 1;
      }
    } else {
      cleared = Object.keys(user.traits || {}).length;
      user.traits = {};
    }
    user.updatedAt = new Date().toISOString();
    data.users[userId] = user;
    await saveStore(data);
    return { cleared };
  });
}

/**
 * Compose and return the full personalized system prompt for a user.
 *
 * @param {string} userId
 * @param {{ base?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function getPromptForUser(userId, opts = {}) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const data = await loadStore();
  const base = typeof opts.base === "string" && opts.base ? opts.base : data.base || DEFAULT_BASE;
  const user = data.users[userId];
  const traits = user ? Object.entries(user.traits || {}).map(([k, v]) => ({ key: k, value: v.value })) : [];
  return buildSystemPrompt(base, traits);
}
