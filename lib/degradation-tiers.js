// @ts-check
/**
 * Phase 59.3: Degradation tiers — P0/P1/P2 feature flags for brown-outs.
 *
 * Features are registered with a priority tier (P0 Essential, P1 Important,
 * P2 Nice-to-have, P3 Luxury). A global brown-out level (green/yellow/orange/
 * red) determines which tiers are disabled. Degraded requests return 503 via
 * the featureGateMiddleware; callers can register fallbacks to serve a degraded
 * experience instead of failing outright.
 *
 * Storage: JSON-backed via json-path-store. Fallback functions and policy
 * overrides live in-memory (fallbacks are not serializable); the rest of the
 * state is durable across restarts.
 *
 * @module degradation-tiers
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const HISTORY_MAX = 500;

/** Priority tier metadata. Ordered from most to least essential. */
export const TIERS = {
  P0: { name: "Essential", description: "Core functionality never disabled" },
  P1: { name: "Important", description: "Disabled only in severe brownout" },
  P2: { name: "Nice-to-have", description: "Disabled in moderate brownout" },
  P3: { name: "Luxury", description: "First to go" },
};

/** Brown-out level definitions. */
export const BROWNOUT_LEVELS = {
  green: { disabledTiers: [] },
  yellow: { disabledTiers: ["P3"] },
  orange: { disabledTiers: ["P2", "P3"] },
  red: { disabledTiers: ["P1", "P2", "P3"] },
};

// Fallbacks and policy overrides are process-local. Fallback functions are
// not serializable, and policy overrides are typically set by ops during an
// active incident.
const FALLBACKS = new Map();
const OVERRIDES = new Map();

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function storePath() {
  return join(getDataDir(), "degradation-tiers.json");
}

function emptyStore() {
  return {
    _version: STORE_VERSION,
    features: {},
    brownout: { level: "green", reason: null, updatedAt: null },
    history: [],
    usage: {},
  };
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    features: base.features && typeof base.features === "object" ? base.features : {},
    brownout:
      base.brownout && typeof base.brownout === "object"
        ? {
            level: typeof base.brownout.level === "string" ? base.brownout.level : "green",
            reason: base.brownout.reason ?? null,
            updatedAt: base.brownout.updatedAt ?? null,
          }
        : { level: "green", reason: null, updatedAt: null },
    history: Array.isArray(base.history) ? base.history : [],
    usage: base.usage && typeof base.usage === "object" ? base.usage : {},
  };
}

async function loadStore() {
  return normalizeStore(await readJsonPath(storePath(), emptyStore()));
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateTier(tier) {
  if (!Object.prototype.hasOwnProperty.call(TIERS, tier)) {
    throw new Error(`invalid tier: ${tier} (expected one of ${Object.keys(TIERS).join(", ")})`);
  }
}

function validateLevel(level) {
  if (!Object.prototype.hasOwnProperty.call(BROWNOUT_LEVELS, level)) {
    throw new Error(
      `invalid brownout level: ${level} (expected one of ${Object.keys(BROWNOUT_LEVELS).join(", ")})`,
    );
  }
}

function validateFeatureName(name) {
  if (!name || typeof name !== "string") throw new Error("feature name is required");
}

// ---------------------------------------------------------------------------
// Feature registry
// ---------------------------------------------------------------------------

/**
 * Register a feature with a priority tier.
 * @param {string} name
 * @param {"P0"|"P1"|"P2"|"P3"} tier
 * @param {object} [metadata]
 */
export async function registerFeature(name, tier, metadata = {}) {
  validateFeatureName(name);
  validateTier(tier);
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const existing = store.features[name] || null;
    const entry = {
      name,
      tier,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      registeredAt: existing?.registeredAt || Date.now(),
      updatedAt: Date.now(),
    };
    store.features[name] = entry;
    await saveStore(store);
    return entry;
  });
}

/**
 * Remove a registered feature.
 * @param {string} name
 */
export async function unregisterFeature(name) {
  validateFeatureName(name);
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    if (!store.features[name]) return false;
    delete store.features[name];
    await saveStore(store);
    FALLBACKS.delete(name);
    OVERRIDES.delete(name);
    return true;
  });
}

/**
 * Fetch a feature by name.
 * @param {string} name
 */
export async function getFeature(name) {
  validateFeatureName(name);
  const store = await loadStore();
  return store.features[name] || null;
}

/**
 * List features, optionally filtered by tier.
 * @param {{ tier?: string }} [filter]
 */
export async function listFeatures(filter = {}) {
  const store = await loadStore();
  const all = Object.values(store.features);
  if (filter && filter.tier) {
    validateTier(filter.tier);
    return all.filter((f) => f.tier === filter.tier);
  }
  return all;
}

/**
 * Change a feature's tier.
 * @param {string} name
 * @param {"P0"|"P1"|"P2"|"P3"} tier
 */
export async function updateFeatureTier(name, tier) {
  validateFeatureName(name);
  validateTier(tier);
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const existing = store.features[name];
    if (!existing) throw new Error(`feature not found: ${name}`);
    existing.tier = tier;
    existing.updatedAt = Date.now();
    await saveStore(store);
    return existing;
  });
}

// ---------------------------------------------------------------------------
// Brownout state
// ---------------------------------------------------------------------------

/** Current brown-out level and context. */
export async function getBrownoutLevel() {
  const store = await loadStore();
  return { ...store.brownout };
}

/**
 * Set the brown-out level. Records a history event as a side-effect.
 * @param {"green"|"yellow"|"orange"|"red"} level
 * @param {string|null} [reason]
 */
export async function setBrownoutLevel(level, reason = null) {
  validateLevel(level);
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const previous = store.brownout.level;
    store.brownout = { level, reason: reason ?? null, updatedAt: Date.now() };
    store.history.push({
      type: "level-change",
      from: previous,
      to: level,
      reason: reason ?? null,
      at: Date.now(),
    });
    if (store.history.length > HISTORY_MAX) {
      store.history = store.history.slice(-HISTORY_MAX);
    }
    await saveStore(store);
    return { ...store.brownout };
  });
}

/**
 * Auto-adjust the brown-out level based on system health signals.
 *
 * Signal shape (all values 0–1 or raw numbers, tolerated):
 *   { cpu, memory, errorRate, p95LatencyMs }
 *
 * Thresholds (matches common SRE practice):
 *   - red:    cpu>=0.95 OR memory>=0.95 OR errorRate>=0.20
 *   - orange: cpu>=0.85 OR memory>=0.85 OR errorRate>=0.10
 *   - yellow: cpu>=0.70 OR memory>=0.70 OR errorRate>=0.05
 *   - green:  otherwise
 *
 * @param {{ cpu?: number, memory?: number, errorRate?: number, p95LatencyMs?: number }} signals
 */
export async function autoAdjustBrownoutLevel(signals) {
  const s = signals && typeof signals === "object" ? signals : {};
  const cpu = Number(s.cpu) || 0;
  const memory = Number(s.memory) || 0;
  const errorRate = Number(s.errorRate) || 0;
  const p95 = Number(s.p95LatencyMs) || 0;

  let level = "green";
  if (cpu >= 0.95 || memory >= 0.95 || errorRate >= 0.2 || p95 >= 10000) {
    level = "red";
  } else if (cpu >= 0.85 || memory >= 0.85 || errorRate >= 0.1 || p95 >= 5000) {
    level = "orange";
  } else if (cpu >= 0.7 || memory >= 0.7 || errorRate >= 0.05 || p95 >= 2000) {
    level = "yellow";
  }

  const reason = `auto: cpu=${cpu.toFixed(2)} memory=${memory.toFixed(2)} errorRate=${errorRate.toFixed(3)} p95=${p95}ms`;
  return setBrownoutLevel(level, reason);
}

// ---------------------------------------------------------------------------
// Feature availability
// ---------------------------------------------------------------------------

/** Shared availability check used by middleware and direct callers. */
export async function isFeatureAvailable(name) {
  validateFeatureName(name);
  const store = await loadStore();
  const feature = store.features[name];
  // Unregistered features default to available — callers must opt in by
  // registering the feature before gating it.
  if (!feature) return true;

  const override = OVERRIDES.get(name);
  if (override) {
    if (override.forceEnabled) return true;
    if (override.forceDisabled) return false;
  }

  // P0 is always available regardless of brown-out level.
  if (feature.tier === "P0") return true;

  const level = store.brownout.level || "green";
  const disabledTiers = BROWNOUT_LEVELS[level]?.disabledTiers || [];
  return !disabledTiers.includes(feature.tier);
}

/** Return the names of every feature currently disabled by the brown-out level. */
export async function getDisabledFeatures() {
  const store = await loadStore();
  const level = store.brownout.level || "green";
  const disabledTiers = BROWNOUT_LEVELS[level]?.disabledTiers || [];
  const out = [];
  for (const feature of Object.values(store.features)) {
    const override = OVERRIDES.get(feature.name);
    if (override?.forceEnabled) continue;
    if (override?.forceDisabled) {
      out.push(feature);
      continue;
    }
    if (feature.tier === "P0") continue;
    if (disabledTiers.includes(feature.tier)) out.push(feature);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Usage stats (ring-buffer-ish counters)
// ---------------------------------------------------------------------------

async function recordUsage(name, outcome) {
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    const stat = store.usage[name] || { name, attempts: 0, blocked: 0, fallback: 0, success: 0 };
    stat.attempts += 1;
    if (outcome === "blocked") stat.blocked += 1;
    else if (outcome === "fallback") stat.fallback += 1;
    else if (outcome === "success") stat.success += 1;
    stat.lastSeenAt = Date.now();
    store.usage[name] = stat;
    await saveStore(store);
  });
}

/** Return per-feature usage counters. */
export async function getFeatureUsageStats(featureName) {
  const store = await loadStore();
  if (featureName) {
    validateFeatureName(featureName);
    return store.usage[featureName] || null;
  }
  return Object.values(store.usage);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware factory. Returns 503 FEATURE_DEGRADED when the feature
 * is disabled by the current brown-out level.
 */
export function featureGateMiddleware(featureName, options = {}) {
  const { onDegraded } = options && typeof options === "object" ? options : {};
  return async (req, res, next) => {
    try {
      const available = await isFeatureAvailable(featureName);
      if (!available) {
        await recordUsage(featureName, "blocked").catch(() => {});
        if (typeof onDegraded === "function") {
          try {
            await onDegraded(req, res);
            if (res.headersSent) return;
          } catch (_) {
            // fall through to default response
          }
        }
        const level = (await getBrownoutLevel()).level;
        return res.status(503).json({
          error: "FEATURE_DEGRADED",
          feature: featureName,
          brownoutLevel: level,
        });
      }
      await recordUsage(featureName, "success").catch(() => {});
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Fallback implementations
// ---------------------------------------------------------------------------

/**
 * Register a fallback function for a feature. Fallback functions are held in
 * memory only (not persisted).
 * @param {string} featureName
 * @param {Function} fallbackFn
 */
export async function registerFallback(featureName, fallbackFn) {
  validateFeatureName(featureName);
  if (typeof fallbackFn !== "function") throw new Error("fallbackFn must be a function");
  FALLBACKS.set(featureName, fallbackFn);
  return true;
}

/** Retrieve a previously registered fallback. */
export async function getFallback(featureName) {
  validateFeatureName(featureName);
  return FALLBACKS.get(featureName) || null;
}

/**
 * Call primaryFn when the feature is available; otherwise call the registered
 * fallback (if any). Args may be an array (spread) or a single value.
 * @template T
 * @param {string} featureName
 * @param {(...args: any[]) => T | Promise<T>} primaryFn
 * @param {any[]} [args]
 * @returns {Promise<T>}
 */
export async function callWithFallback(featureName, primaryFn, args = []) {
  validateFeatureName(featureName);
  if (typeof primaryFn !== "function") throw new Error("primaryFn must be a function");
  const callArgs = Array.isArray(args) ? args : [args];
  const available = await isFeatureAvailable(featureName);
  if (available) {
    await recordUsage(featureName, "success").catch(() => {});
    return primaryFn(...callArgs);
  }
  const fallback = FALLBACKS.get(featureName);
  if (fallback) {
    await recordUsage(featureName, "fallback").catch(() => {});
    return fallback(...callArgs);
  }
  await recordUsage(featureName, "blocked").catch(() => {});
  const err = new Error(`feature degraded: ${featureName}`);
  /** @type {any} */ (err).code = "FEATURE_DEGRADED";
  throw err;
}

// ---------------------------------------------------------------------------
// History & observability
// ---------------------------------------------------------------------------

/**
 * Record an arbitrary brown-out event. Events are appended to a bounded
 * history buffer (HISTORY_MAX).
 */
export async function recordBrownoutEvent(event) {
  const payload = event && typeof event === "object" ? event : { message: String(event) };
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.history.push({ at: Date.now(), ...payload });
    if (store.history.length > HISTORY_MAX) {
      store.history = store.history.slice(-HISTORY_MAX);
    }
    await saveStore(store);
    return store.history[store.history.length - 1];
  });
}

/**
 * Return brown-out history, optionally filtered by time range.
 * @param {{ since?: number, until?: number, limit?: number }} [timeRange]
 */
export async function getBrownoutHistory(timeRange = {}) {
  const store = await loadStore();
  let entries = store.history.slice();
  const { since, until, limit } = timeRange || {};
  if (Number.isFinite(since)) entries = entries.filter((e) => (e.at ?? 0) >= since);
  if (Number.isFinite(until)) entries = entries.filter((e) => (e.at ?? 0) <= until);
  if (Number.isFinite(limit) && limit > 0) entries = entries.slice(-limit);
  return entries;
}

// ---------------------------------------------------------------------------
// Policy overrides
// ---------------------------------------------------------------------------

/**
 * Force a feature on or off, bypassing tier-based checks until cleared.
 * override shape: { forceEnabled?: boolean, forceDisabled?: boolean, reason?: string }
 */
export async function setPolicyOverride(featureName, override) {
  validateFeatureName(featureName);
  if (!override || typeof override !== "object") throw new Error("override object is required");
  const entry = {
    forceEnabled: !!override.forceEnabled,
    forceDisabled: !!override.forceDisabled,
    reason: typeof override.reason === "string" ? override.reason : null,
    setAt: Date.now(),
  };
  if (entry.forceEnabled && entry.forceDisabled) {
    throw new Error("override cannot set both forceEnabled and forceDisabled");
  }
  OVERRIDES.set(featureName, entry);
  await recordBrownoutEvent({ type: "policy-override", feature: featureName, override: entry }).catch(
    () => {},
  );
  return entry;
}

/** Clear a previously set policy override. */
export async function clearPolicyOverride(featureName) {
  validateFeatureName(featureName);
  const existed = OVERRIDES.delete(featureName);
  if (existed) {
    await recordBrownoutEvent({ type: "policy-override-clear", feature: featureName }).catch(() => {});
  }
  return existed;
}

/** Test-only: wipe in-memory caches (fallbacks + overrides). */
export function _resetInMemoryState() {
  FALLBACKS.clear();
  OVERRIDES.clear();
}
