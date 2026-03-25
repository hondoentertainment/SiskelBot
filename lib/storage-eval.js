/**
 * Phase 68: Eval set CRUD through the json-path-store abstraction.
 * Migrates from direct file I/O (data/eval-sets/*.json, data/eval-sets.json)
 * to durable Postgres / SQLite / file storage via json-path-store.
 *
 * On first access, if the KV store has no eval-sets key, the module reads legacy
 * on-disk files and seeds the store (one-time migration).
 */
import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

function evalSetsPath() {
  return join(getDataDir(), "eval-sets-store.json");
}

/**
 * One-time migration: read legacy on-disk eval-sets and seed the KV store.
 * @returns {Promise<object>} The migrated data (or empty default).
 */
async function migrateLegacyIfNeeded() {
  const path = evalSetsPath();
  const existing = await readJsonPath(path, null);
  if (existing && existing._version) return existing;

  const dataDir = getDataDir();
  const setsDir = join(dataDir, "eval-sets");
  const singleFile = join(dataDir, "eval-sets.json");
  const sets = [];

  // Read legacy single file
  if (existsSync(singleFile)) {
    try {
      const raw = readFileSync(singleFile, "utf8");
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : data.sets ? data.sets : [data];
      for (const s of items) {
        if (s && s.id) sets.push(s);
      }
    } catch (_) {}
  }

  // Read legacy directory
  if (existsSync(setsDir)) {
    try {
      const files = readdirSync(setsDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const p = join(setsDir, f);
          const raw = readFileSync(p, "utf8");
          const s = JSON.parse(raw);
          if (s && s.id && !sets.some((r) => r.id === s.id)) {
            sets.push(s);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  const store = { _version: STORE_VERSION, sets };
  if (sets.length > 0) {
    await writeJsonPath(path, store);
    console.log(`[storage-eval] Migrated ${sets.length} legacy eval set(s) to durable store`);
  }
  return store;
}

/**
 * List available eval sets (id, name).
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listEvalSets() {
  const path = evalSetsPath();
  let data = await readJsonPath(path, null);
  if (!data || !data._version) {
    data = await migrateLegacyIfNeeded();
  }
  const sets = Array.isArray(data.sets) ? data.sets : [];
  return sets.map((s) => ({ id: s.id, name: s.name || s.id }));
}

/**
 * Load a full eval set by id.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function loadEvalSet(id) {
  if (!id || typeof id !== "string") return null;
  const path = evalSetsPath();
  let data = await readJsonPath(path, null);
  if (!data || !data._version) {
    data = await migrateLegacyIfNeeded();
  }
  const sets = Array.isArray(data.sets) ? data.sets : [];
  return sets.find((s) => s && s.id === id) || null;
}

/**
 * Save (create or update) an eval set.
 * @param {object} evalSet - Must have { id, name?, cases? }
 * @returns {Promise<object>} The saved eval set.
 */
export async function saveEvalSet(evalSet) {
  if (!evalSet || typeof evalSet !== "object") throw new Error("evalSet object required");
  const id = evalSet.id || randomUUID();
  const path = evalSetsPath();
  return withPathLock(path, async () => {
    let data = await readJsonPath(path, null);
    if (!data || !data._version) {
      data = await migrateLegacyIfNeeded();
    }
    const sets = Array.isArray(data.sets) ? [...data.sets] : [];
    const idx = sets.findIndex((s) => s && s.id === id);
    const entry = { ...evalSet, id, updatedAt: new Date().toISOString() };
    if (!entry.createdAt) entry.createdAt = new Date().toISOString();
    if (idx >= 0) {
      sets[idx] = entry;
    } else {
      sets.push(entry);
    }
    data = { _version: STORE_VERSION, sets };
    await writeJsonPath(path, data);
    return entry;
  });
}

/**
 * Remove an eval set by id.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function removeEvalSet(id) {
  if (!id || typeof id !== "string") return false;
  const path = evalSetsPath();
  return withPathLock(path, async () => {
    let data = await readJsonPath(path, null);
    if (!data || !data._version) {
      data = await migrateLegacyIfNeeded();
    }
    const sets = Array.isArray(data.sets) ? data.sets : [];
    const before = sets.length;
    const filtered = sets.filter((s) => s && s.id !== id);
    if (filtered.length >= before) return false;
    await writeJsonPath(path, { _version: STORE_VERSION, sets: filtered });
    return true;
  });
}
