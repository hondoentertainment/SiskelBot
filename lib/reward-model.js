// @ts-check
/**
 * Phase 56.5: Reward model training.
 *
 * A tiny preference-learning pipeline that stays entirely in JavaScript
 * — no tensor runtimes, no autograd. Features are extracted via a
 * deterministic hashed bag-of-words, and the model is a logistic
 * regression trained by mini-batch gradient descent on pairwise
 * preferences (Bradley–Terry loss).
 *
 * Exports:
 *   - collectPreference({chosen, rejected, context, rater})
 *   - trainRewardModel({epochs, lr, dim, ...})
 *   - predictReward(text)
 *   - exportModel() / importModel(json)
 *   - clearPreferences() (test helper)
 *
 * @module reward-model
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_DIM = 256;
const DEFAULT_EPOCHS = 20;
const DEFAULT_LR = 0.1;

function storePath() {
  return join(getDataDir(), "reward-model.json");
}

function now() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const raw = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    preferences: [],
    model: null,
  });
  if (!raw || typeof raw !== "object") {
    return { version: STORE_VERSION, preferences: [], model: null };
  }
  if (!Array.isArray(raw.preferences)) raw.preferences = [];
  if (raw.model === undefined) raw.model = null;
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    preferences: store.preferences || [],
    model: store.model || null,
  });
}

/* -------------------------------------------------------------------------- */
/* Featurization                                                              */
/* -------------------------------------------------------------------------- */

function tokenize(text) {
  if (text == null) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && t.length > 1);
}

/**
 * Deterministic 32-bit FNV-1a hash so feature indices are stable across
 * runs and processes.
 * @param {string} s
 */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Hash a text into a sparse bag-of-words feature vector of length `dim`.
 * Bias feature is always on at index 0.
 * @param {string} text
 * @param {number} dim
 */
export function featurize(text, dim = DEFAULT_DIM) {
  const vec = new Array(dim).fill(0);
  vec[0] = 1; // bias
  const toks = tokenize(text);
  for (const t of toks) {
    const h = hash32(t) % (dim - 1);
    vec[1 + h] += 1;
  }
  // L2 normalize to tame long inputs
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function sigmoid(z) {
  if (z > 20) return 1 - 1e-9;
  if (z < -20) return 1e-9;
  return 1 / (1 + Math.exp(-z));
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Store a (chosen, rejected) preference pair.
 * @param {object} pref
 */
export async function collectPreference(pref) {
  if (!pref || typeof pref !== "object") throw new Error("pref required");
  const chosen = typeof pref.chosen === "string" ? pref.chosen : "";
  const rejected = typeof pref.rejected === "string" ? pref.rejected : "";
  if (!chosen.trim() || !rejected.trim()) {
    throw new Error("chosen and rejected text required");
  }
  const rec = {
    id: randomId("pref"),
    chosen,
    rejected,
    context: typeof pref.context === "string" ? pref.context : "",
    rater: typeof pref.rater === "string" ? pref.rater : "anonymous",
    at: now(),
  };
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.preferences.push(rec);
    if (store.preferences.length > 100000) {
      store.preferences = store.preferences.slice(-100000);
    }
    await saveStore(store);
  });
  return rec;
}

/** Return the number of stored preferences. */
export async function countPreferences() {
  const store = await loadStore();
  return store.preferences.length;
}

/** Clear all preferences and model. */
export async function clearPreferences() {
  await withPathLock(storePath(), async () => {
    await saveStore({ preferences: [], model: null });
  });
}

/* -------------------------------------------------------------------------- */
/* Training                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Train a logistic regression reward model using Bradley–Terry pairwise
 * loss:   -log σ(w·f(chosen) − w·f(rejected))
 *
 * @param {object} [opts]
 */
export async function trainRewardModel(opts = {}) {
  const dim = Number.isFinite(opts.dim) && opts.dim > 4 ? Math.floor(opts.dim) : DEFAULT_DIM;
  const epochs = Number.isFinite(opts.epochs) && opts.epochs > 0 ? Math.floor(opts.epochs) : DEFAULT_EPOCHS;
  const lr = Number.isFinite(opts.lr) && opts.lr > 0 ? opts.lr : DEFAULT_LR;
  const l2 = Number.isFinite(opts.l2) && opts.l2 >= 0 ? opts.l2 : 1e-4;

  const store = await loadStore();
  const prefs = store.preferences || [];
  if (prefs.length === 0) {
    throw new Error("no preferences collected — call collectPreference first");
  }

  // Featurize once up-front.
  const featA = prefs.map((p) => featurize(p.chosen, dim));
  const featB = prefs.map((p) => featurize(p.rejected, dim));

  const weights = new Array(dim).fill(0);
  let loss = 0;
  const lossHistory = [];
  for (let epoch = 0; epoch < epochs; epoch++) {
    loss = 0;
    // Shuffle indices deterministically via a seed-ish hash.
    const order = featA.map((_, i) => i);
    // Fisher-Yates with a cheap rng
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(((epoch + 1) * 2654435761 + i) >>> 0) % (i + 1);
      const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    for (const idx of order) {
      const a = featA[idx];
      const b = featB[idx];
      const diff = new Array(dim);
      for (let k = 0; k < dim; k++) diff[k] = a[k] - b[k];
      const z = dot(weights, diff);
      const p = sigmoid(z);
      const err = 1 - p; // we want sigmoid(z) -> 1
      loss += -Math.log(Math.max(1e-12, p));
      for (let k = 0; k < dim; k++) {
        const grad = err * diff[k] - l2 * weights[k];
        weights[k] += lr * grad;
      }
    }
    lossHistory.push(Math.round((loss / prefs.length) * 10000) / 10000);
  }

  // Accuracy on training pairs.
  let correct = 0;
  for (let i = 0; i < featA.length; i++) {
    const sa = dot(weights, featA[i]);
    const sb = dot(weights, featB[i]);
    if (sa > sb) correct += 1;
  }
  const accuracy = featA.length > 0 ? correct / featA.length : 0;

  const model = {
    version: 1,
    dim,
    weights,
    trainedAt: now(),
    preferenceCount: prefs.length,
    epochs,
    lr,
    l2,
    accuracy: Math.round(accuracy * 10000) / 10000,
    finalLoss: lossHistory[lossHistory.length - 1],
    lossHistory,
  };

  await withPathLock(storePath(), async () => {
    const cur = await loadStore();
    cur.model = model;
    await saveStore(cur);
  });

  return model;
}

/* -------------------------------------------------------------------------- */
/* Inference                                                                  */
/* -------------------------------------------------------------------------- */

let _cachedModel = /** @type {any} */ (null);

/**
 * Predict a scalar reward for a text input. Returns 0 if no model has
 * been trained yet.
 * @param {string} text
 */
export async function predictReward(text) {
  if (typeof text !== "string" || !text.trim()) return 0;
  const model = _cachedModel || (await getStoredModel());
  if (!model) return 0;
  _cachedModel = model;
  const v = featurize(text, model.dim);
  return Math.round(dot(model.weights, v) * 10000) / 10000;
}

async function getStoredModel() {
  const store = await loadStore();
  return store.model || null;
}

/** Invalidate the in-memory cache (used after import/clear). */
export function _invalidateCache() {
  _cachedModel = null;
}

/* -------------------------------------------------------------------------- */
/* Import / export                                                            */
/* -------------------------------------------------------------------------- */

/** Serialize the currently trained model as plain JSON. */
export async function exportModel() {
  const store = await loadStore();
  if (!store.model) throw new Error("no trained model to export");
  return JSON.parse(JSON.stringify(store.model));
}

/**
 * Load a previously exported model. Returns the imported model record.
 * @param {object} model
 */
export async function importModel(model) {
  if (!model || typeof model !== "object") throw new Error("model required");
  if (!Array.isArray(model.weights)) throw new Error("model.weights required");
  if (!Number.isFinite(model.dim) || model.dim !== model.weights.length) {
    throw new Error("model.dim must match weights length");
  }
  const clean = {
    version: 1,
    dim: model.dim,
    weights: model.weights.slice(),
    trainedAt: model.trainedAt || now(),
    preferenceCount: Number(model.preferenceCount) || 0,
    epochs: Number(model.epochs) || 0,
    lr: Number(model.lr) || 0,
    l2: Number(model.l2) || 0,
    accuracy: Number(model.accuracy) || 0,
    finalLoss: Number(model.finalLoss) || 0,
    lossHistory: Array.isArray(model.lossHistory) ? model.lossHistory.slice() : [],
  };
  await withPathLock(storePath(), async () => {
    const cur = await loadStore();
    cur.model = clean;
    await saveStore(cur);
  });
  _invalidateCache();
  return clean;
}
