// @ts-check
/**
 * Phase 59.3: Degradation tiers.
 *
 * Graceful brownout system. Features are tagged with a tier (`P0`, `P1`,
 * `P2`). A global active tier defines which features are enabled:
 *
 *   - tier = `P0` → only P0 features enabled (deep brownout)
 *   - tier = `P1` → P0 + P1 features enabled
 *   - tier = `P2` → P0 + P1 + P2 features enabled (normal)
 *
 * Feature toggles can also be manually overridden per-feature. The
 * combined decision is exposed via `isFeatureEnabled`.
 *
 * The module exposes:
 *   - `setTier(tier, opts?)`
 *   - `getTier()`
 *   - `isFeatureEnabled(name)`
 *   - `registerFeature(spec)`
 *   - `listFeatures()`
 *
 * @module degradation
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const VALID_TIERS = ["P0", "P1", "P2"];

function statePath() {
  return join(getDataDir(), "degradation-state.json");
}

function tierRank(tier) {
  if (tier === "P0") return 0;
  if (tier === "P1") return 1;
  if (tier === "P2") return 2;
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadState() {
  const data = await readJsonPath(statePath(), {
    version: STORE_VERSION,
    tier: "P2",
    features: {},
    history: [],
  });
  if (!data.features || typeof data.features !== "object") data.features = {};
  if (!Array.isArray(data.history)) data.history = [];
  return data;
}

async function saveState(data) {
  await writeJsonPath(statePath(), {
    version: STORE_VERSION,
    tier: data.tier,
    features: data.features,
    history: data.history,
    updatedAt: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Tier control                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Change the active brownout tier. Records a history entry so
 * operators can audit state transitions.
 *
 * @param {string} tier       One of "P0", "P1", "P2".
 * @param {{ reason?: string, actor?: string }} [opts]
 * @returns {Promise<{ tier: string, updatedAt: string }>}
 */
export async function setTier(tier, opts = {}) {
  if (!VALID_TIERS.includes(tier)) {
    throw new Error(`tier must be one of: ${VALID_TIERS.join(", ")}`);
  }
  const path = statePath();
  return withPathLock(path, async () => {
    const data = await loadState();
    const prev = data.tier;
    data.tier = tier;
    const entry = {
      from: prev,
      to: tier,
      at: new Date().toISOString(),
      reason: typeof opts.reason === "string" ? opts.reason : null,
      actor: typeof opts.actor === "string" ? opts.actor : null,
    };
    data.history.push(entry);
    if (data.history.length > 200) data.history = data.history.slice(-200);
    await saveState(data);
    return { tier, updatedAt: entry.at };
  });
}

/**
 * Read the current active tier.
 *
 * @returns {Promise<string>}
 */
export async function getTier() {
  const data = await loadState();
  return data.tier || "P2";
}

/* -------------------------------------------------------------------------- */
/* Feature registration                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} FeatureSpec
 * @property {string} name
 * @property {string} tier           One of "P0", "P1", "P2".
 * @property {boolean} [enabled]     Manual override (true forces on, false forces off).
 * @property {string} [description]
 */

/**
 * Register or update a feature.
 *
 * @param {FeatureSpec} spec
 * @returns {Promise<object>}
 */
export async function registerFeature(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.name || typeof spec.name !== "string") {
    throw new Error("feature name is required");
  }
  if (!VALID_TIERS.includes(spec.tier)) {
    throw new Error(`feature tier must be one of: ${VALID_TIERS.join(", ")}`);
  }
  const path = statePath();
  return withPathLock(path, async () => {
    const data = await loadState();
    const now = new Date().toISOString();
    const existing = data.features[spec.name] || {
      name: spec.name,
      createdAt: now,
    };
    const rec = {
      ...existing,
      name: spec.name,
      tier: spec.tier,
      description: typeof spec.description === "string" ? spec.description : existing.description ?? null,
      enabled: typeof spec.enabled === "boolean" ? spec.enabled : existing.enabled ?? null,
      updatedAt: now,
    };
    data.features[spec.name] = rec;
    await saveState(data);
    return rec;
  });
}

/**
 * List all registered features with their effective on/off state
 * against the current tier.
 *
 * @returns {Promise<object[]>}
 */
export async function listFeatures() {
  const data = await loadState();
  const tier = data.tier || "P2";
  const activeRank = tierRank(tier);
  return Object.values(data.features || {}).map((f) => {
    const effective = resolveEnabled(f, activeRank);
    return { ...f, effective };
  });
}

function resolveEnabled(feature, activeRank) {
  if (feature.enabled === false) return false;
  const featureRank = tierRank(feature.tier);
  if (featureRank < 0) return false;
  const onByTier = featureRank <= activeRank;
  if (feature.enabled === true) return true;
  return onByTier;
}

/**
 * Check whether a single feature is currently enabled.
 *
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function isFeatureEnabled(name) {
  if (!name || typeof name !== "string") return false;
  const data = await loadState();
  const feature = data.features[name];
  if (!feature) return false;
  const activeRank = tierRank(data.tier || "P2");
  return resolveEnabled(feature, activeRank);
}

/**
 * Return the recent tier-change history.
 *
 * @param {number} [limit]
 */
export async function getTierHistory(limit = 50) {
  const data = await loadState();
  const h = Array.isArray(data.history) ? data.history : [];
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  return h.slice(-n);
}
