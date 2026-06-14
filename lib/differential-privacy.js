// @ts-check
/**
 * Phase 45.2: Differential privacy primitives.
 *
 * Implements the core building blocks needed to train models or answer
 * aggregate queries under an (epsilon, delta)-differential privacy guarantee:
 *
 *   - Gaussian mechanism      addGaussianNoise(vector, sigma)
 *   - Laplace mechanism       addLaplaceNoise(vector, scale)
 *   - L2 gradient clipping    clipGradients(gradients, maxNorm)
 *   - Privacy budget tracker  computePrivacyBudget(epsilon, delta, iterations)
 *   - DP-SGD step             dpSGDStep(gradients, clipNorm, noiseMultiplier)
 *   - Privacy accountant      getPrivacyAccountant()   (singleton-by-name)
 *   - Query leak analysis     analyzePrivacyLeak(query, dataset)
 *
 * The accountant is persisted via json-path-store so cumulative privacy loss
 * survives server restarts. Noise sampling uses Node's crypto.randomBytes for
 * cryptographic quality; the Box-Muller transform generates Gaussian samples
 * and the inverse-CDF method generates Laplace samples.
 *
 * All routines treat inputs defensively: non-finite entries are coerced to 0
 * and bad shapes return empty arrays rather than throwing, so an incorrect
 * caller never corrupts the training pipeline.
 *
 * @module differential-privacy
 */
import { randomBytes } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_ACCOUNTANT = "default";
const MAX_ACCOUNTANTS = 256;

// ---- Secure random sampling ----

/**
 * Draw a uniform float in (0, 1) from cryptographic randomness. The open
 * interval avoids log(0) issues in downstream transforms.
 *
 * @returns {number}
 */
function secureUniform() {
  // 6 bytes of entropy ~= 48 bits; divide by 2^48 for a float.
  const buf = randomBytes(6);
  const n =
    buf[0] * 2 ** 40 +
    buf[1] * 2 ** 32 +
    buf[2] * 2 ** 24 +
    buf[3] * 2 ** 16 +
    buf[4] * 2 ** 8 +
    buf[5];
  // Map to (0, 1) exclusive on both ends.
  return (n + 1) / (2 ** 48 + 2);
}

/**
 * Box-Muller transform: two standard-normal samples per call. The second sample
 * is cached so alternating calls cost one transform each.
 * @returns {number}
 */
let gaussianCache = null;
function sampleStandardNormal() {
  if (gaussianCache !== null) {
    const v = gaussianCache;
    gaussianCache = null;
    return v;
  }
  const u1 = secureUniform();
  const u2 = secureUniform();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  gaussianCache = r * Math.sin(theta);
  return r * Math.cos(theta);
}

/**
 * Laplace sample via inverse CDF. For u in (0, 1), Laplace(0, b) =
 * -b * sign(u - 0.5) * log(1 - 2|u - 0.5|).
 * @param {number} scale
 * @returns {number}
 */
function sampleLaplace(scale) {
  const u = secureUniform() - 0.5;
  const sign = u < 0 ? -1 : 1;
  // Clamp 1 - 2|u| into (epsilon, 1] to avoid log(0).
  const inner = Math.max(1e-300, 1 - 2 * Math.abs(u));
  return -scale * sign * Math.log(inner);
}

// ---- Mechanisms ----

/**
 * Add i.i.d. Gaussian noise with stddev `sigma` to each entry of `vector`.
 * Returns a brand-new array; the input is never mutated.
 *
 * @param {number[]} vector
 * @param {number} sigma - standard deviation of the noise (>= 0)
 * @returns {number[]}
 */
export function addGaussianNoise(vector, sigma) {
  if (!Array.isArray(vector)) return [];
  const s = Number.isFinite(sigma) && sigma >= 0 ? Number(sigma) : 0;
  const out = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const x = Number(vector[i]);
    const base = Number.isFinite(x) ? x : 0;
    out[i] = s === 0 ? base : base + s * sampleStandardNormal();
  }
  return out;
}

/**
 * Add i.i.d. Laplace noise with scale parameter `scale` (b in the common
 * Laplace(0, b) parameterization). The Laplace mechanism achieves pure
 * epsilon-DP when `scale = sensitivity / epsilon`.
 *
 * @param {number[]} vector
 * @param {number} scale
 * @returns {number[]}
 */
export function addLaplaceNoise(vector, scale) {
  if (!Array.isArray(vector)) return [];
  const b = Number.isFinite(scale) && scale >= 0 ? Number(scale) : 0;
  const out = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const x = Number(vector[i]);
    const base = Number.isFinite(x) ? x : 0;
    out[i] = b === 0 ? base : base + sampleLaplace(b);
  }
  return out;
}

// ---- Clipping ----

/**
 * L2-norm clip a gradient (or a list of gradients). If a single numeric vector
 * is supplied, scales it so its L2 norm is at most `maxNorm`. If an array of
 * vectors is supplied, each vector is clipped independently.
 *
 * Returns the clipped gradients along with their original and clipped norms
 * (useful for accountant bookkeeping).
 *
 * @param {number[] | number[][]} gradients
 * @param {number} maxNorm
 * @returns {{ gradients: number[] | number[][], originalNorms: number[], clippedNorms: number[] }}
 */
export function clipGradients(gradients, maxNorm) {
  const max = Number.isFinite(maxNorm) && maxNorm > 0 ? Number(maxNorm) : 1;
  if (!Array.isArray(gradients)) {
    return { gradients: [], originalNorms: [], clippedNorms: [] };
  }

  const clipOne = (vec) => {
    if (!Array.isArray(vec)) return { clipped: [], original: 0, after: 0 };
    let sumSq = 0;
    const safe = new Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
      const v = Number(vec[i]);
      const s = Number.isFinite(v) ? v : 0;
      safe[i] = s;
      sumSq += s * s;
    }
    const norm = Math.sqrt(sumSq);
    if (norm <= max || norm === 0) {
      return { clipped: safe, original: norm, after: norm };
    }
    const factor = max / norm;
    const clipped = new Array(safe.length);
    for (let i = 0; i < safe.length; i++) clipped[i] = safe[i] * factor;
    return { clipped, original: norm, after: max };
  };

  // Detect a flat numeric vector vs. an array of vectors.
  const isListOfVectors = gradients.length > 0 && Array.isArray(gradients[0]);
  if (!isListOfVectors) {
    // @ts-ignore: flat numeric path
    const { clipped, original, after } = clipOne(gradients);
    return { gradients: clipped, originalNorms: [original], clippedNorms: [after] };
  }

  const outGrads = [];
  const originalNorms = [];
  const clippedNorms = [];
  for (const g of gradients) {
    const { clipped, original, after } = clipOne(g);
    outGrads.push(clipped);
    originalNorms.push(original);
    clippedNorms.push(after);
  }
  return { gradients: outGrads, originalNorms, clippedNorms };
}

// ---- Privacy budget math ----

/**
 * Compute the (epsilon, delta)-DP budget consumed over `iterations` of a
 * Gaussian-mechanism release under simple (strong) composition:
 *
 *   totalEpsilon = sqrt(2 * iterations * ln(1/delta_prime)) * epsilon
 *                  + iterations * epsilon * (e^epsilon - 1)
 *   totalDelta   = iterations * delta + delta_prime
 *
 * with delta_prime = delta (the usual choice). This is intentionally
 * conservative — more sophisticated accounting (moments accountant, RDP)
 * returns smaller bounds but requires extra state. Callers that need those
 * can supply their own sigmas; this helper simply reports the composed bound.
 *
 * @param {number} epsilon   per-iteration epsilon
 * @param {number} delta     per-iteration delta
 * @param {number} iterations
 * @returns {{ totalEpsilon: number, totalDelta: number, perIterationEpsilon: number, perIterationDelta: number, iterations: number }}
 */
export function computePrivacyBudget(epsilon, delta, iterations) {
  const eps = Number.isFinite(epsilon) && epsilon >= 0 ? Number(epsilon) : 0;
  const del = Number.isFinite(delta) && delta >= 0 ? Number(delta) : 0;
  const n = Number.isFinite(iterations) && iterations > 0 ? Math.floor(iterations) : 0;

  if (n === 0 || eps === 0) {
    return {
      totalEpsilon: 0,
      totalDelta: n * del,
      perIterationEpsilon: eps,
      perIterationDelta: del,
      iterations: n,
    };
  }

  // Strong composition (Dwork et al. 2010, Theorem III.3).
  const deltaPrime = del > 0 ? del : 1e-9;
  const adv = Math.sqrt(2 * n * Math.log(1 / deltaPrime)) * eps + n * eps * (Math.exp(eps) - 1);
  // Basic composition: linear sum; report the tighter of the two bounds.
  const basic = n * eps;
  const totalEpsilon = Math.min(adv, basic);
  const totalDelta = n * del + deltaPrime;

  return {
    totalEpsilon,
    totalDelta,
    perIterationEpsilon: eps,
    perIterationDelta: del,
    iterations: n,
  };
}

// ---- DP-SGD step ----

/**
 * One DP-SGD step: clip each per-example gradient to `clipNorm`, sum them,
 * add Gaussian noise with stddev `clipNorm * noiseMultiplier`, and return the
 * noisy average. Expects `gradients` as an array of per-example vectors of
 * matching dimensionality.
 *
 * Returns both the noisy gradient and metadata (clipped norms, noise stddev,
 * epsilon-delta numbers for a single step under the Gaussian mechanism with
 * sampling rate 1).
 *
 * @param {number[][]} gradients
 * @param {number} clipNorm
 * @param {number} noiseMultiplier
 * @returns {{
 *   noisyGradient: number[],
 *   meanGradient: number[],
 *   clippedNorms: number[],
 *   noiseStddev: number,
 *   batchSize: number,
 *   dimension: number,
 * }}
 */
export function dpSGDStep(gradients, clipNorm, noiseMultiplier) {
  const C = Number.isFinite(clipNorm) && clipNorm > 0 ? Number(clipNorm) : 1;
  const mult = Number.isFinite(noiseMultiplier) && noiseMultiplier >= 0 ? Number(noiseMultiplier) : 1;

  if (!Array.isArray(gradients) || gradients.length === 0) {
    return {
      noisyGradient: [],
      meanGradient: [],
      clippedNorms: [],
      noiseStddev: 0,
      batchSize: 0,
      dimension: 0,
    };
  }

  const dim = Array.isArray(gradients[0]) ? gradients[0].length : 0;
  if (dim === 0) {
    return {
      noisyGradient: [],
      meanGradient: [],
      clippedNorms: [],
      noiseStddev: 0,
      batchSize: 0,
      dimension: 0,
    };
  }

  const clipped = clipGradients(gradients, C);
  const clippedVectors = /** @type {number[][]} */ (clipped.gradients);

  const sum = new Array(dim).fill(0);
  for (const g of clippedVectors) {
    if (!Array.isArray(g)) continue;
    for (let i = 0; i < dim; i++) {
      const v = Number(g[i]);
      if (Number.isFinite(v)) sum[i] += v;
    }
  }

  // Gaussian noise with stddev sigma = C * noiseMultiplier, added to the sum.
  const sigma = C * mult;
  const noisySum = addGaussianNoise(sum, sigma);

  // Return the noisy *mean* (sum / batchSize) so downstream optimizers can use
  // it interchangeably with a plain mini-batch gradient.
  const batchSize = clippedVectors.length;
  const noisyGradient = new Array(dim);
  const meanGradient = new Array(dim);
  for (let i = 0; i < dim; i++) {
    noisyGradient[i] = noisySum[i] / batchSize;
    meanGradient[i] = sum[i] / batchSize;
  }

  return {
    noisyGradient,
    meanGradient,
    clippedNorms: clipped.clippedNorms,
    noiseStddev: sigma,
    batchSize,
    dimension: dim,
  };
}

// ---- Privacy accountant ----

function accountantStorePath() {
  return join(getDataDir(), "differential-privacy.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  const accountants =
    base.accountants && typeof base.accountants === "object" && !Array.isArray(base.accountants)
      ? base.accountants
      : {};
  const order = Array.isArray(base.order) ? base.order.filter((x) => typeof x === "string") : [];
  return { _version: STORE_VERSION, accountants, order };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(accountantStorePath(), { _version: STORE_VERSION, accountants: {}, order: [] }),
  );
}

async function saveStore(store) {
  await writeJsonPath(accountantStorePath(), store);
}

function makeAccountant(name) {
  return {
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: 0,
    totalEpsilon: 0,
    totalDelta: 0,
    events: [], // compact ring buffer; capped below
  };
}

const MAX_EVENTS_PER_ACCOUNTANT = 500;

/**
 * Return a privacy accountant keyed by `name`. The returned object exposes
 * `record(epsilon, delta, metadata?)`, `snapshot()`, and `reset()`. All three
 * are async because state is persisted to disk.
 *
 * Multiple callers using the same `name` share the same underlying state.
 *
 * @param {string} [name]
 * @returns {{
 *   name: string,
 *   record: (epsilon: number, delta: number, metadata?: object) => Promise<object>,
 *   snapshot: () => Promise<object>,
 *   reset: () => Promise<object>,
 * }}
 */
export function getPrivacyAccountant(name = DEFAULT_ACCOUNTANT) {
  const key = typeof name === "string" && name.trim() ? name.trim().slice(0, 128) : DEFAULT_ACCOUNTANT;

  async function ensure(store) {
    if (!store.accountants[key]) {
      store.accountants[key] = makeAccountant(key);
      store.order.push(key);
      while (store.order.length > MAX_ACCOUNTANTS) {
        const drop = store.order.shift();
        if (drop && drop !== key) delete store.accountants[drop];
      }
    }
    return store.accountants[key];
  }

  return {
    name: key,
    async record(epsilon, delta, metadata) {
      const eps = Number.isFinite(epsilon) && epsilon >= 0 ? Number(epsilon) : 0;
      const del = Number.isFinite(delta) && delta >= 0 ? Number(delta) : 0;
      return withPathLock(accountantStorePath(), async () => {
        const store = await loadStore();
        const acc = await ensure(store);
        acc.steps += 1;
        // Under basic composition the totals are a simple linear sum.
        acc.totalEpsilon += eps;
        acc.totalDelta += del;
        acc.updatedAt = Date.now();
        const event = {
          at: Date.now(),
          epsilon: eps,
          delta: del,
          metadata: metadata && typeof metadata === "object" ? metadata : undefined,
        };
        acc.events.push(event);
        while (acc.events.length > MAX_EVENTS_PER_ACCOUNTANT) acc.events.shift();
        await saveStore(store);
        return { ...acc, events: acc.events.slice() };
      });
    },
    async snapshot() {
      const store = await loadStore();
      const acc = store.accountants[key];
      if (!acc) {
        return { name: key, steps: 0, totalEpsilon: 0, totalDelta: 0, events: [], exists: false };
      }
      return { ...acc, events: acc.events.slice(), exists: true };
    },
    async reset() {
      return withPathLock(accountantStorePath(), async () => {
        const store = await loadStore();
        store.accountants[key] = makeAccountant(key);
        if (!store.order.includes(key)) store.order.push(key);
        await saveStore(store);
        return { ...store.accountants[key], events: [] };
      });
    },
  };
}

/**
 * List known accountants (their names and current cumulative loss).
 * @returns {Promise<Array<{ name: string, steps: number, totalEpsilon: number, totalDelta: number, updatedAt: number }>>}
 */
export async function listPrivacyAccountants() {
  const store = await loadStore();
  return Object.values(store.accountants).map((a) => ({
    name: a.name,
    steps: a.steps || 0,
    totalEpsilon: a.totalEpsilon || 0,
    totalDelta: a.totalDelta || 0,
    updatedAt: a.updatedAt || 0,
  }));
}

// ---- Query leak analysis ----

/**
 * Estimate the sensitivity of a query and report whether it leaks too much
 * information about any single record in `dataset`. The `query` is a function
 * `(rows) => number` that accepts an array of dataset rows and returns a
 * scalar. We compute `query(dataset)` and then `query(dataset without row i)`
 * for every row; the maximum absolute delta is the empirical L1 sensitivity.
 *
 * This is an O(n * cost(query)) check meant for auditing small datasets or
 * sanity-checking new queries — NOT a replacement for real DP analysis, but a
 * useful red-flag detector for accidentally-unbounded queries.
 *
 * `maxAllowedSensitivity` defaults to 1 (the standard assumption for
 * count/sum queries on bounded columns).
 *
 * @param {(rows: any[]) => number} query
 * @param {any[]} dataset
 * @param {{ maxAllowedSensitivity?: number, sampleLimit?: number }} [options]
 * @returns {{
 *   sensitivity: number,
 *   maxAllowed: number,
 *   leaks: boolean,
 *   baseline: number,
 *   worstIndex: number,
 *   inspected: number,
 *   error?: string,
 * }}
 */
export function analyzePrivacyLeak(query, dataset, options = {}) {
  const maxAllowed = Number.isFinite(options.maxAllowedSensitivity) && options.maxAllowedSensitivity >= 0
    ? Number(options.maxAllowedSensitivity)
    : 1;
  const sampleLimit = Number.isFinite(options.sampleLimit) && options.sampleLimit > 0
    ? Math.floor(options.sampleLimit)
    : 1024;

  if (typeof query !== "function") {
    return {
      sensitivity: 0,
      maxAllowed,
      leaks: false,
      baseline: 0,
      worstIndex: -1,
      inspected: 0,
      error: "query must be a function",
    };
  }
  if (!Array.isArray(dataset) || dataset.length === 0) {
    return { sensitivity: 0, maxAllowed, leaks: false, baseline: 0, worstIndex: -1, inspected: 0 };
  }

  let baseline;
  try {
    const v = query(dataset);
    baseline = Number.isFinite(Number(v)) ? Number(v) : 0;
  } catch (err) {
    return {
      sensitivity: 0,
      maxAllowed,
      leaks: false,
      baseline: 0,
      worstIndex: -1,
      inspected: 0,
      error: String(err?.message || err),
    };
  }

  const n = Math.min(dataset.length, sampleLimit);
  let maxDelta = 0;
  let worstIndex = -1;

  for (let i = 0; i < n; i++) {
    const subset = dataset.slice(0, i).concat(dataset.slice(i + 1));
    let alt;
    try {
      alt = Number(query(subset));
    } catch {
      continue;
    }
    if (!Number.isFinite(alt)) continue;
    const delta = Math.abs(baseline - alt);
    if (delta > maxDelta) {
      maxDelta = delta;
      worstIndex = i;
    }
  }

  return {
    sensitivity: maxDelta,
    maxAllowed,
    leaks: maxDelta > maxAllowed,
    baseline,
    worstIndex,
    inspected: n,
  };
}

// ---- Exported internals (testing) ----

export const _internals = {
  sampleStandardNormal,
  sampleLaplace,
  secureUniform,
  accountantStorePath,
  MAX_ACCOUNTANTS,
  MAX_EVENTS_PER_ACCOUNTANT,
};
