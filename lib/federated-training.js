// @ts-check
/**
 * Phase 45.1: Federated training coordinator.
 *
 * Coordinates rounds of federated learning across opted-in clients without
 * performing any actual model training on the server. Clients compute
 * gradients locally, upload them here, and the coordinator aggregates the
 * updates with FedAvg (see `lib/fedavg.js`) to produce a new global model
 * that clients then pull.
 *
 * Round lifecycle:
 *   created → open (clients may join and submit) → aggregating → completed
 *
 * All state is persisted under `data/federated-training.json` so rounds
 * survive restarts in multi-replica deployments (combined with leader
 * election for the aggregation step).
 *
 * @module federated-training
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { federatedAverage } from "./fedavg.js";

const STORE_VERSION = 1;
const DEFAULT_MIN_CLIENTS = 2;
const DEFAULT_MAX_CLIENTS = 100;
const MAX_PERSISTED_ROUNDS = Math.min(
  10_000,
  Math.max(50, Number(process.env.FEDERATED_MAX_ROUNDS) || 500),
);

const STATE_CREATED = "created";
const STATE_OPEN = "open";
const STATE_AGGREGATING = "aggregating";
const STATE_COMPLETED = "completed";
const STATE_CANCELLED = "cancelled";

function storePath() {
  return join(getDataDir(), "federated-training.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  const rounds =
    base.rounds && typeof base.rounds === "object" && !Array.isArray(base.rounds) ? base.rounds : {};
  const order = Array.isArray(base.order) ? base.order.filter((x) => typeof x === "string") : [];
  return { _version: STORE_VERSION, rounds, order };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), { _version: STORE_VERSION, rounds: {}, order: [] }),
  );
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

function sanitizeClientCapabilities(caps) {
  if (!caps || typeof caps !== "object") return {};
  const out = {};
  if (typeof caps.platform === "string") out.platform = caps.platform.slice(0, 64);
  if (typeof caps.modelId === "string") out.modelId = caps.modelId.slice(0, 128);
  if (Number.isFinite(Number(caps.maxSamples))) out.maxSamples = Number(caps.maxSamples);
  if (Number.isFinite(Number(caps.bandwidthKbps))) out.bandwidthKbps = Number(caps.bandwidthKbps);
  if (Array.isArray(caps.features)) {
    out.features = caps.features.filter((f) => typeof f === "string").slice(0, 32);
  }
  return out;
}

function sanitizeGradients(gradients) {
  if (!gradients || typeof gradients !== "object" || Array.isArray(gradients)) return null;
  /** @type {Record<string, number | number[]>} */
  const out = {};
  for (const [k, v] of Object.entries(gradients)) {
    if (typeof k !== "string" || k.length === 0 || k.length > 256) continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      const arr = v
        .map((x) => {
          const n = Number(x);
          return Number.isFinite(n) ? n : 0;
        })
        .slice(0, 100_000);
      out[k] = arr;
    }
  }
  return out;
}

/**
 * Create a new federated training round.
 *
 * @param {object} config
 * @param {string} [config.modelId] - identifier for the model being trained
 * @param {number} [config.minClients] - minimum client count required to aggregate
 * @param {number} [config.maxClients] - maximum client count accepted
 * @param {number} [config.targetRoundMs] - soft deadline after which the round may be aggregated
 * @param {object} [config.initialWeights] - starting model weights served to clients
 * @param {string} [config.createdBy]
 * @returns {Promise<object>} the created round
 */
export async function createFederatedRound(config = {}) {
  const cfg = config && typeof config === "object" ? config : {};
  const modelId = typeof cfg.modelId === "string" && cfg.modelId ? cfg.modelId : "default";
  const minClients = Math.max(1, Number(cfg.minClients) || DEFAULT_MIN_CLIENTS);
  const maxClients = Math.max(minClients, Math.min(DEFAULT_MAX_CLIENTS, Number(cfg.maxClients) || DEFAULT_MAX_CLIENTS));
  const targetRoundMs = Number.isFinite(Number(cfg.targetRoundMs))
    ? Math.max(0, Number(cfg.targetRoundMs))
    : 0;

  const initialWeights =
    cfg.initialWeights && typeof cfg.initialWeights === "object" ? cfg.initialWeights : {};

  const round = {
    id: newId("fed"),
    modelId,
    state: STATE_OPEN,
    minClients,
    maxClients,
    targetRoundMs,
    createdAt: nowIso(),
    createdBy: typeof cfg.createdBy === "string" ? cfg.createdBy : null,
    updatedAt: nowIso(),
    completedAt: null,
    clients: {}, // clientId -> { userId, joinedAt, capabilities, submitted, submittedAt, metadata }
    submissions: {}, // clientId -> { gradients, sampleCount, metadata, submittedAt }
    weights: initialWeights,
    aggregated: null, // result of federatedAverage (after aggregation)
    totalSamples: 0,
    error: null,
  };

  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.rounds[round.id] = round;
    store.order.push(round.id);
    while (store.order.length > MAX_PERSISTED_ROUNDS) {
      const drop = store.order.shift();
      if (drop && drop !== round.id) delete store.rounds[drop];
    }
    await saveStore(store);
  });

  return round;
}

/**
 * Opt a client into an open round.
 *
 * @param {string} roundId
 * @param {string} userId
 * @param {object} [clientCapabilities]
 * @returns {Promise<{ clientId: string, round: object }>}
 */
export async function joinRound(roundId, userId, clientCapabilities = {}) {
  if (typeof roundId !== "string" || !roundId) throw new Error("roundId required");
  if (typeof userId !== "string" || !userId) throw new Error("userId required");

  let result;
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    const round = store.rounds[roundId];
    if (!round) throw new Error(`round ${roundId} not found`);
    if (round.state !== STATE_OPEN) {
      throw new Error(`round ${roundId} is not open (state=${round.state})`);
    }
    const currentCount = Object.keys(round.clients).length;
    if (currentCount >= round.maxClients) {
      throw new Error(`round ${roundId} is full (${currentCount}/${round.maxClients})`);
    }
    const clientId = newId("client");
    round.clients[clientId] = {
      clientId,
      userId,
      joinedAt: nowIso(),
      capabilities: sanitizeClientCapabilities(clientCapabilities),
      submitted: false,
      submittedAt: null,
    };
    round.updatedAt = nowIso();
    store.rounds[roundId] = round;
    await saveStore(store);
    result = { clientId, round };
  });
  // @ts-ignore — result assigned inside the lock
  return result;
}

/**
 * Submit gradients from a client.
 *
 * @param {string} roundId
 * @param {string} clientId
 * @param {object} gradients
 * @param {object} [metadata]
 * @returns {Promise<object>} the updated round
 */
export async function submitGradients(roundId, clientId, gradients, metadata = {}) {
  if (typeof roundId !== "string" || !roundId) throw new Error("roundId required");
  if (typeof clientId !== "string" || !clientId) throw new Error("clientId required");
  const clean = sanitizeGradients(gradients);
  if (!clean || Object.keys(clean).length === 0) {
    throw new Error("gradients must be a non-empty object of numbers or number arrays");
  }
  const sampleCount =
    metadata && Number.isFinite(Number(metadata.sampleCount))
      ? Math.max(0, Number(metadata.sampleCount))
      : 1;

  let updated;
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    const round = store.rounds[roundId];
    if (!round) throw new Error(`round ${roundId} not found`);
    if (round.state !== STATE_OPEN) {
      throw new Error(`round ${roundId} is not accepting submissions (state=${round.state})`);
    }
    const client = round.clients[clientId];
    if (!client) throw new Error(`client ${clientId} has not joined round ${roundId}`);
    if (client.submitted) {
      throw new Error(`client ${clientId} already submitted for round ${roundId}`);
    }
    round.submissions[clientId] = {
      clientId,
      gradients: clean,
      sampleCount,
      metadata: metadata && typeof metadata === "object" ? { ...metadata, sampleCount } : { sampleCount },
      submittedAt: nowIso(),
    };
    client.submitted = true;
    client.submittedAt = nowIso();
    round.updatedAt = nowIso();
    store.rounds[roundId] = round;
    await saveStore(store);
    updated = round;
  });
  // @ts-ignore
  return updated;
}

/**
 * Aggregate all submitted gradients for a round using FedAvg.
 * Transitions the round from `open` → `aggregating` → back to `open`
 * (with updated `weights` and an `aggregated` snapshot). Callers may then
 * `completeRound` once no further aggregation is needed.
 *
 * @param {string} roundId
 * @returns {Promise<object>} the round after aggregation
 */
export async function aggregateGradients(roundId) {
  if (typeof roundId !== "string" || !roundId) throw new Error("roundId required");

  let aggregated;
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    const round = store.rounds[roundId];
    if (!round) throw new Error(`round ${roundId} not found`);
    if (round.state !== STATE_OPEN) {
      throw new Error(`round ${roundId} cannot aggregate (state=${round.state})`);
    }
    const submissions = Object.values(round.submissions || {});
    if (submissions.length < round.minClients) {
      throw new Error(
        `round ${roundId} has ${submissions.length} submissions, need >= ${round.minClients}`,
      );
    }

    round.state = STATE_AGGREGATING;
    round.updatedAt = nowIso();
    store.rounds[roundId] = round;
    await saveStore(store);

    // Perform FedAvg.
    const updates = submissions.map((s) => ({
      gradients: s.gradients,
      sampleCount: Number(s.sampleCount) || 1,
    }));
    const result = federatedAverage(updates);

    // Apply averaged gradients to current weights. For scalar keys, add the
    // averaged value; for array keys, elementwise add. Missing keys in the
    // current weights are initialized from the averaged update.
    const nextWeights = { ...(round.weights || {}) };
    for (const [k, v] of Object.entries(result.averaged)) {
      const prev = nextWeights[k];
      if (Array.isArray(v)) {
        if (Array.isArray(prev)) {
          const len = Math.max(prev.length, v.length);
          const merged = new Array(len).fill(0);
          for (let i = 0; i < len; i++) {
            const p = i < prev.length ? Number(prev[i]) || 0 : 0;
            const g = i < v.length ? Number(v[i]) || 0 : 0;
            merged[i] = p + g;
          }
          nextWeights[k] = merged;
        } else {
          nextWeights[k] = v.slice();
        }
      } else if (typeof v === "number") {
        const p = typeof prev === "number" && Number.isFinite(prev) ? prev : 0;
        nextWeights[k] = p + v;
      }
    }

    round.weights = nextWeights;
    round.aggregated = {
      averaged: result.averaged,
      totalSamples: result.totalSamples,
      clientCount: result.clientCount,
      at: nowIso(),
    };
    round.totalSamples = result.totalSamples;
    round.state = STATE_OPEN;
    round.updatedAt = nowIso();
    store.rounds[roundId] = round;
    await saveStore(store);
    aggregated = round;
  });
  // @ts-ignore
  return aggregated;
}

/**
 * Serve updated model weights to a client participating in a round.
 * Records the distribution so we can tell which clients have pulled.
 *
 * @param {string} roundId
 * @param {string} clientId
 * @returns {Promise<{ modelId: string, weights: object, version: number, roundId: string }>}
 */
export async function distributeModel(roundId, clientId) {
  if (typeof roundId !== "string" || !roundId) throw new Error("roundId required");
  if (typeof clientId !== "string" || !clientId) throw new Error("clientId required");

  let payload;
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    const round = store.rounds[roundId];
    if (!round) throw new Error(`round ${roundId} not found`);
    const client = round.clients[clientId];
    if (!client) throw new Error(`client ${clientId} has not joined round ${roundId}`);
    client.lastDistributedAt = nowIso();
    client.distributions = (Number(client.distributions) || 0) + 1;
    round.updatedAt = nowIso();
    store.rounds[roundId] = round;
    await saveStore(store);
    payload = {
      modelId: round.modelId,
      roundId: round.id,
      version: round.aggregated ? 1 : 0,
      weights: round.weights || {},
    };
  });
  // @ts-ignore
  return payload;
}

/**
 * Finalize a round and record metrics.
 *
 * @param {string} roundId
 * @returns {Promise<object>} the completed round with metrics
 */
export async function completeRound(roundId) {
  if (typeof roundId !== "string" || !roundId) throw new Error("roundId required");

  let completed;
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    const round = store.rounds[roundId];
    if (!round) throw new Error(`round ${roundId} not found`);
    if (round.state === STATE_COMPLETED) {
      completed = round;
      return;
    }
    const clients = Object.values(round.clients || {});
    const submissions = Object.values(round.submissions || {});
    const participatingClients = clients.length;
    const submittedClients = submissions.length;
    const totalSamples = submissions.reduce((a, s) => a + (Number(s.sampleCount) || 0), 0);
    const participationRate = participatingClients > 0 ? submittedClients / participatingClients : 0;
    const durationMs =
      new Date(nowIso()).getTime() - new Date(round.createdAt).getTime();

    round.state = STATE_COMPLETED;
    round.completedAt = nowIso();
    round.updatedAt = round.completedAt;
    round.metrics = {
      participatingClients,
      submittedClients,
      totalSamples,
      participationRate,
      durationMs,
      aggregationCount: round.aggregated ? 1 : 0,
    };
    store.rounds[roundId] = round;
    await saveStore(store);
    completed = round;
  });
  // @ts-ignore
  return completed;
}

/**
 * Cancel a round without aggregating. Mostly for administrative cleanup.
 * @param {string} roundId
 * @returns {Promise<object|null>}
 */
export async function cancelRound(roundId) {
  if (typeof roundId !== "string" || !roundId) throw new Error("roundId required");
  let result = null;
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    const round = store.rounds[roundId];
    if (!round) return;
    if (round.state === STATE_COMPLETED) {
      result = round;
      return;
    }
    round.state = STATE_CANCELLED;
    round.updatedAt = nowIso();
    round.completedAt = nowIso();
    store.rounds[roundId] = round;
    await saveStore(store);
    result = round;
  });
  return result;
}

/**
 * @param {string} roundId
 * @returns {Promise<object|null>}
 */
export async function getRound(roundId) {
  if (typeof roundId !== "string" || !roundId) return null;
  const store = await loadStore();
  return store.rounds[roundId] || null;
}

/**
 * @param {{ limit?: number, state?: string }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listRounds(opts = {}) {
  const store = await loadStore();
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
  const state = typeof opts.state === "string" ? opts.state : null;
  const ids = store.order.slice(-limit).reverse();
  const rounds = ids.map((id) => store.rounds[id]).filter(Boolean);
  return state ? rounds.filter((r) => r.state === state) : rounds;
}

/**
 * @param {string} roundId
 * @returns {Promise<boolean>}
 */
export async function deleteRound(roundId) {
  if (typeof roundId !== "string" || !roundId) return false;
  let removed = false;
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    if (!store.rounds[roundId]) return;
    delete store.rounds[roundId];
    store.order = store.order.filter((x) => x !== roundId);
    await saveStore(store);
    removed = true;
  });
  return removed;
}

export const FederatedRoundStates = Object.freeze({
  CREATED: STATE_CREATED,
  OPEN: STATE_OPEN,
  AGGREGATING: STATE_AGGREGATING,
  COMPLETED: STATE_COMPLETED,
  CANCELLED: STATE_CANCELLED,
});

export default {
  createFederatedRound,
  joinRound,
  submitGradients,
  aggregateGradients,
  distributeModel,
  completeRound,
  cancelRound,
  getRound,
  listRounds,
  deleteRound,
  FederatedRoundStates,
};
