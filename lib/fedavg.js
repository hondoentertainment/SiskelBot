// @ts-check
/**
 * Phase 45.1: FedAvg algorithm.
 *
 * Implements the classic Federated Averaging algorithm from McMahan et al.
 * (2017): a weighted average of client gradient updates where each client's
 * weight is proportional to the number of samples it trained on.
 *
 * This module is purely numerical — it does not know anything about
 * networking, storage, or HTTP. It is imported by `lib/federated-training.js`
 * to aggregate gradients from participating clients.
 *
 * A "gradient update" is represented as a plain object with numeric keys
 * mapping to either numbers or numeric arrays. Example:
 *
 *   { "layer1.bias": 0.12, "layer1.weight": [0.1, -0.2, 0.4] }
 *
 * @module fedavg
 */

/**
 * Compute per-client normalized weights from their sample counts.
 * Weights sum to 1 (or 0 if every count is zero/invalid).
 *
 * @param {number[]} sampleCounts - number of training samples per client
 * @returns {number[]} normalized weights
 */
export function computeWeights(sampleCounts) {
  if (!Array.isArray(sampleCounts) || sampleCounts.length === 0) return [];
  const safe = sampleCounts.map((n) => {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  const total = safe.reduce((a, b) => a + b, 0);
  if (total <= 0) return safe.map(() => 0);
  return safe.map((v) => v / total);
}

/**
 * Compute a weighted element-wise average of several gradient updates.
 *
 * Each update has the form:
 *   { gradients: { key: number | number[] }, sampleCount: number }
 *
 * Updates without a `sampleCount` are treated as having a count of 1.
 * Missing keys in some updates are treated as contributing zero for that key.
 * Mismatched array lengths are right-padded with zeros up to the max length.
 *
 * @param {Array<{ gradients: object, sampleCount?: number }>} updates
 * @returns {{ averaged: object, totalSamples: number, clientCount: number }}
 */
export function federatedAverage(updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { averaged: {}, totalSamples: 0, clientCount: 0 };
  }

  const clean = updates.filter((u) => u && u.gradients && typeof u.gradients === "object");
  if (clean.length === 0) {
    return { averaged: {}, totalSamples: 0, clientCount: 0 };
  }

  const sampleCounts = clean.map((u) => {
    const v = Number(u.sampleCount);
    return Number.isFinite(v) && v > 0 ? v : 1;
  });
  const weights = computeWeights(sampleCounts);
  const totalSamples = sampleCounts.reduce((a, b) => a + b, 0);

  // Determine key space and per-key array length.
  /** @type {Map<string, number>} */
  const keyLengths = new Map();
  for (const u of clean) {
    for (const [k, v] of Object.entries(u.gradients)) {
      if (Array.isArray(v)) {
        const prev = keyLengths.get(k) ?? 0;
        if (v.length > prev) keyLengths.set(k, v.length);
      } else if (typeof v === "number") {
        // Scalar keys have "length" 0 (meaning scalar).
        if (!keyLengths.has(k)) keyLengths.set(k, 0);
      }
    }
  }

  /** @type {Record<string, number | number[]>} */
  const averaged = {};
  for (const [key, len] of keyLengths.entries()) {
    if (len === 0) {
      // Scalar accumulation.
      let acc = 0;
      for (let i = 0; i < clean.length; i++) {
        const raw = clean[i].gradients[key];
        const num = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
        acc += num * weights[i];
      }
      averaged[key] = acc;
    } else {
      const arr = new Array(len).fill(0);
      for (let i = 0; i < clean.length; i++) {
        const raw = clean[i].gradients[key];
        if (Array.isArray(raw)) {
          for (let j = 0; j < len; j++) {
            const v = j < raw.length ? Number(raw[j]) : 0;
            if (Number.isFinite(v)) arr[j] += v * weights[i];
          }
        }
        // If the update is missing this key entirely, it contributes 0.
      }
      averaged[key] = arr;
    }
  }

  return { averaged, totalSamples, clientCount: clean.length };
}

export default { federatedAverage, computeWeights };
