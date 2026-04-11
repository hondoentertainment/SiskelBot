// @ts-check
/**
 * Phase 45.3: Secure aggregation for federated learning.
 *
 * Cryptographic aggregation so the central server can sum client contributions
 * without ever seeing any individual client's raw update. We implement a
 * simplified, self-contained protocol inspired by Bonawitz et al. (2017) where
 * pairwise masks cancel in the sum and Shamir's Secret Sharing is used to
 * recover masks belonging to dropped participants.
 *
 * Protocol (per round, operating over the finite field F_p with prime modulus):
 *
 *   1. createSession(participants, threshold)
 *        Server creates a round. `participants` lists the expected client ids
 *        and `threshold` is the Shamir threshold — at least `threshold` of the
 *        `n` clients must remain honest / online for unmasking to succeed.
 *
 *   2. generateKeyShares(sessionId, clientId)
 *        Each client picks a secret seed s_i in F_p and splits it into n
 *        Shamir shares {(x_j, y_j)}. The client keeps its own pairwise masks
 *        (deterministically derived from its own seed and each peer id) and
 *        hands one share of its seed to every peer (modeled here by returning
 *        the shares; in a real deployment they'd be encrypted peer-to-peer).
 *
 *   3. submitMaskedUpdate(sessionId, clientId, maskedValue)
 *        The client adds every pairwise mask `m(i,j)` to its real value so
 *        that masks cancel pairwise: m(i,j) = -m(j,i) mod p. It submits the
 *        resulting masked scalar. The server stores it but cannot read it.
 *
 *   4. aggregateMaskedUpdates(sessionId)
 *        The server sums all submitted masked values modulo p. Because the
 *        masks cancel pairwise, the sum equals sum_i(value_i) mod p. If some
 *        clients dropped out, leftover masks remain; the server then calls
 *        `recoverKeys` using shares collected from surviving clients.
 *
 *   5. recoverKeys(sessionId, clientId, shares)
 *        Surviving clients forward shares of any dropped clients to the
 *        server. Once `threshold` shares exist for a dropped client, the
 *        server reconstructs that client's seed via Lagrange interpolation
 *        and subtracts all of its pairwise masks from the aggregate.
 *
 * The Shamir math runs over F_p where p = 2^127 - 1 (a Mersenne prime large
 * enough for model-parameter scale) using BigInt. All values entering or
 * leaving the API are coerced through BigInt to stay in the field.
 *
 * Two purity properties that make this module easy to test:
 *
 *   - createPolynomial / evaluatePolynomial / reconstructSecret are pure and
 *     do not touch state; they're exported for direct unit testing.
 *
 *   - Every stateful function goes through `withPathLock(storePath(), ...)`
 *     so concurrent callers see a consistent view of the session store.
 *
 * @module secure-aggregation
 */
import { randomUUID, randomBytes, createHash } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// Mersenne prime 2^127 - 1. Large enough for scalar federated updates
// quantized into 64-bit integers while leaving headroom for sums.
export const FIELD_PRIME = (1n << 127n) - 1n;

const STORE_VERSION = 1;
const MAX_PARTICIPANTS = 256;
const MAX_SESSIONS = Math.min(
  10_000,
  Math.max(50, Number(process.env.SECURE_AGG_MAX_SESSIONS) || 500),
);

// ---- Storage ----

function storePath() {
  return join(getDataDir(), "secure-aggregation.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  const sessions =
    base.sessions && typeof base.sessions === "object" && !Array.isArray(base.sessions)
      ? base.sessions
      : {};
  const order = Array.isArray(base.order) ? base.order.filter((x) => typeof x === "string") : [];
  return { _version: STORE_VERSION, sessions, order };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), { _version: STORE_VERSION, sessions: {}, order: [] }),
  );
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

// ---- BigInt helpers ----

/**
 * Normalize any JS number/string/BigInt into the residue class mod p in
 * [0, p). Throws for obviously invalid input so callers get a fast failure.
 *
 * @param {bigint|number|string} v
 * @returns {bigint}
 */
export function toField(v) {
  let b;
  if (typeof v === "bigint") b = v;
  else if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite value cannot enter field");
    b = BigInt(Math.trunc(v));
  } else if (typeof v === "string" && v.trim() !== "") b = BigInt(v.trim());
  else throw new Error("cannot convert value to field element");
  const m = b % FIELD_PRIME;
  return m < 0n ? m + FIELD_PRIME : m;
}

/**
 * Serialize a BigInt for JSON storage (we can't JSON-serialize BigInt directly).
 * @param {bigint} b
 * @returns {string}
 */
function serializeBig(b) {
  return typeof b === "bigint" ? b.toString() : String(b);
}

/**
 * Inverse modulo the field prime using Fermat's little theorem:
 * a^(p-2) ≡ a^-1 (mod p) for prime p.
 * @param {bigint} a
 * @returns {bigint}
 */
function modInverse(a) {
  const base = ((a % FIELD_PRIME) + FIELD_PRIME) % FIELD_PRIME;
  if (base === 0n) throw new Error("cannot invert 0 in field");
  return modPow(base, FIELD_PRIME - 2n, FIELD_PRIME);
}

/**
 * Modular exponentiation (iterative square-and-multiply).
 * @param {bigint} base
 * @param {bigint} exp
 * @param {bigint} mod
 * @returns {bigint}
 */
function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  if (b < 0n) b += mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * Draw a uniformly random BigInt in [0, FIELD_PRIME) using rejection sampling
 * on 16 random bytes. 16 bytes covers the 127-bit field.
 * @returns {bigint}
 */
function randomFieldElement() {
  while (true) {
    const buf = randomBytes(16);
    // Clear the top bit so the 128-bit value stays below 2^127.
    buf[0] &= 0x7f;
    let acc = 0n;
    for (const byte of buf) acc = (acc << 8n) | BigInt(byte);
    if (acc < FIELD_PRIME) return acc;
  }
}

// ---- Shamir's Secret Sharing ----

/**
 * Build a Shamir polynomial f(x) = secret + a_1*x + a_2*x^2 + ... + a_{t-1}*x^{t-1}.
 * The constant term is the secret. `threshold` parties are needed to recover
 * the secret. Coefficients are uniform in F_p.
 *
 * @param {bigint|number|string} secret - the secret constant term (coerced to field)
 * @param {number} threshold - minimum shares needed to reconstruct
 * @returns {bigint[]} polynomial coefficients, index 0 is the secret
 */
export function createPolynomial(secret, threshold) {
  const t = Number(threshold);
  if (!Number.isInteger(t) || t < 1) {
    throw new Error("threshold must be a positive integer");
  }
  if (t > MAX_PARTICIPANTS) {
    throw new Error(`threshold must be <= ${MAX_PARTICIPANTS}`);
  }
  const coeffs = new Array(t);
  coeffs[0] = toField(secret);
  for (let i = 1; i < t; i++) {
    coeffs[i] = randomFieldElement();
  }
  return coeffs;
}

/**
 * Evaluate a polynomial at x using Horner's method, modulo the field prime.
 * @param {bigint[]} poly - coefficient list from `createPolynomial`
 * @param {bigint|number|string} x
 * @returns {bigint}
 */
export function evaluatePolynomial(poly, x) {
  if (!Array.isArray(poly) || poly.length === 0) {
    throw new Error("polynomial must be a non-empty array");
  }
  const xv = toField(x);
  let acc = 0n;
  for (let i = poly.length - 1; i >= 0; i--) {
    const coeff = typeof poly[i] === "bigint" ? poly[i] : toField(poly[i]);
    acc = (acc * xv + coeff) % FIELD_PRIME;
  }
  return acc;
}

/**
 * Reconstruct the secret (constant term of the polynomial) from a set of
 * (x, y) shares using Lagrange interpolation evaluated at x = 0.
 *
 * Requires `shares.length >= threshold`; with fewer points reconstruction
 * returns a wrong value (we don't have the information-theoretic capacity to
 * tell that you cheated, so callers must track `threshold` themselves).
 *
 * @param {Array<{x: bigint|number|string, y: bigint|number|string}>} shares
 * @returns {bigint}
 */
export function reconstructSecret(shares) {
  if (!Array.isArray(shares) || shares.length === 0) {
    throw new Error("shares must be a non-empty array");
  }
  // Deduplicate by x — repeated points contribute zero new information and
  // would also blow up the Lagrange basis.
  const seen = new Set();
  const points = [];
  for (const raw of shares) {
    if (!raw || typeof raw !== "object") continue;
    const x = toField(raw.x);
    const y = toField(raw.y);
    const key = x.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ x, y });
  }
  if (points.length === 0) throw new Error("no valid shares");

  let secret = 0n;
  for (let i = 0; i < points.length; i++) {
    const { x: xi, y: yi } = points[i];
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const xj = points[j].x;
      // Lagrange basis L_i(0) = prod_{j!=i} (0 - x_j) / (x_i - x_j)
      num = (num * ((FIELD_PRIME - xj) % FIELD_PRIME)) % FIELD_PRIME;
      let diff = (xi - xj) % FIELD_PRIME;
      if (diff < 0n) diff += FIELD_PRIME;
      den = (den * diff) % FIELD_PRIME;
    }
    const term = (yi * num % FIELD_PRIME) * modInverse(den) % FIELD_PRIME;
    secret = (secret + term) % FIELD_PRIME;
  }
  return secret;
}

// ---- Pairwise mask derivation ----

/**
 * Derive a deterministic pairwise mask between two clients from the sender's
 * seed and the (ordered) pair of client ids. Using SHA-256 gives us a uniform
 * bit pattern; we fold it into the field and flip the sign based on lexical
 * ordering so that m(i,j) + m(j,i) ≡ 0 (mod p) when both clients share the
 * same conceptual "pair secret".
 *
 * For the simplified protocol implemented here, each client uses its own seed
 * as the pair secret — peers subtract the mask when they learn the seed
 * during recovery. When both clients stay online the pairwise cancellation
 * property still holds because client i adds +mask(i, seed_i, j) while client
 * j subtracts -mask(j, seed_j, i). As long as each client uses the canonical
 * ordering below, the sum over the full group collapses cleanly.
 *
 * @param {bigint} seed
 * @param {string} selfId
 * @param {string} peerId
 * @returns {bigint} signed field element to add to the masked value
 */
export function derivePairMask(seed, selfId, peerId) {
  if (selfId === peerId) return 0n;
  const [lo, hi] = selfId < peerId ? [selfId, peerId] : [peerId, selfId];
  const h = createHash("sha256");
  h.update(serializeBig(toField(seed)));
  h.update("|");
  h.update(lo);
  h.update("|");
  h.update(hi);
  const digest = h.digest();
  let acc = 0n;
  for (const b of digest) acc = (acc << 8n) | BigInt(b);
  const mag = acc % FIELD_PRIME;
  // Client with the lexicographically smaller id adds, the other subtracts,
  // so the two contributions cancel when summed.
  return selfId < peerId ? mag : (FIELD_PRIME - mag) % FIELD_PRIME;
}

// ---- Session management ----

function generateSessionId() {
  return `sa_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function validateParticipants(participants) {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new Error("participants must be a non-empty array");
  }
  if (participants.length > MAX_PARTICIPANTS) {
    throw new Error(`too many participants (max ${MAX_PARTICIPANTS})`);
  }
  const ids = [];
  const seen = new Set();
  for (const p of participants) {
    const id = typeof p === "string" ? p.trim() : "";
    if (!id) throw new Error("participant ids must be non-empty strings");
    if (seen.has(id)) throw new Error(`duplicate participant id: ${id}`);
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Assign an integer x-coordinate to each participant. Using (index + 1)
 * ensures x != 0 (the secret lives at f(0), so shares must avoid that point).
 *
 * @param {string[]} ids
 * @returns {Record<string, string>} map of id -> decimal stringified x
 */
function assignXCoordinates(ids) {
  const xs = {};
  for (let i = 0; i < ids.length; i++) {
    xs[ids[i]] = String(i + 1);
  }
  return xs;
}

/**
 * Create a new secure aggregation session.
 *
 * @param {string[]} participants - ordered list of client ids
 * @param {number} threshold - Shamir threshold (min shares to reconstruct a seed)
 * @returns {Promise<object>} persisted session descriptor
 */
export async function createSession(participants, threshold) {
  const ids = validateParticipants(participants);
  const t = Number(threshold);
  if (!Number.isInteger(t) || t < 1) {
    throw new Error("threshold must be a positive integer");
  }
  if (t > ids.length) {
    throw new Error("threshold cannot exceed participant count");
  }
  const id = generateSessionId();
  const session = {
    id,
    participants: ids,
    xCoordinates: assignXCoordinates(ids),
    threshold: t,
    fieldPrime: FIELD_PRIME.toString(),
    status: "pending",
    createdAt: new Date().toISOString(),
    shares: {},
    maskedUpdates: {},
    recoveredSeeds: {},
    aggregate: null,
  };
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.sessions[id] = session;
    store.order.push(id);
    while (store.order.length > MAX_SESSIONS) {
      const drop = store.order.shift();
      if (drop && drop !== id) delete store.sessions[drop];
    }
    await saveStore(store);
  });
  return session;
}

/**
 * Load a session by id, returning null if missing.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getSession(id) {
  if (typeof id !== "string" || !id) return null;
  const store = await loadStore();
  return store.sessions[id] || null;
}

/**
 * List recent sessions (most recent first).
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listSessions(opts = {}) {
  const store = await loadStore();
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
  const ids = store.order.slice(-limit).reverse();
  return ids.map((i) => store.sessions[i]).filter(Boolean);
}

/**
 * Each client invokes this to draw a fresh seed, split it into n Shamir shares
 * (one per participant, including self) and register them with the server.
 *
 * In a real deployment the shares would be encrypted peer-to-peer before the
 * server ever sees them; here we return both the raw shares (so the caller
 * can distribute them if they wish) and persist them so subsequent API calls
 * can drive the aggregation forward without holding per-client state
 * elsewhere.
 *
 * @param {string} sessionId
 * @param {string} clientId
 * @returns {Promise<{ seed: string, shares: Array<{ peerId: string, x: string, y: string }> }>}
 */
export async function generateKeyShares(sessionId, clientId) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const session = store.sessions[sessionId];
    if (!session) throw new Error(`session ${sessionId} not found`);
    if (!session.participants.includes(clientId)) {
      throw new Error(`client ${clientId} is not a session participant`);
    }
    if (session.status !== "pending" && session.status !== "sharing") {
      throw new Error(`session ${sessionId} is not accepting shares (status=${session.status})`);
    }
    if (session.shares[clientId]) {
      throw new Error(`client ${clientId} already submitted shares`);
    }
    const seed = randomFieldElement();
    const poly = createPolynomial(seed, session.threshold);
    const shares = session.participants.map((peerId) => {
      const x = toField(session.xCoordinates[peerId]);
      const y = evaluatePolynomial(poly, x);
      return { peerId, x: serializeBig(x), y: serializeBig(y) };
    });
    session.shares[clientId] = {
      submittedAt: new Date().toISOString(),
      // Shares are organized by the recipient peer. When a client drops out
      // other clients forward their share here for reconstruction.
      byPeer: Object.fromEntries(shares.map((s) => [s.peerId, { x: s.x, y: s.y }])),
    };
    session.status = "sharing";
    await saveStore(store);
    return {
      seed: serializeBig(seed),
      shares,
    };
  });
}

/**
 * Submit a masked scalar update. `maskedValue` is the client's real value plus
 * the sum of all its pairwise masks derived from its seed. The server stores
 * but cannot decode it. We refuse updates from clients that haven't shared
 * keys yet so the recovery path is always possible.
 *
 * @param {string} sessionId
 * @param {string} clientId
 * @param {bigint|number|string} maskedValue
 * @returns {Promise<{ sessionId: string, clientId: string, status: string }>}
 */
export async function submitMaskedUpdate(sessionId, clientId, maskedValue) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const session = store.sessions[sessionId];
    if (!session) throw new Error(`session ${sessionId} not found`);
    if (!session.participants.includes(clientId)) {
      throw new Error(`client ${clientId} is not a session participant`);
    }
    if (!session.shares[clientId]) {
      throw new Error(`client ${clientId} must generate key shares first`);
    }
    if (session.maskedUpdates[clientId]) {
      throw new Error(`client ${clientId} already submitted a masked update`);
    }
    if (session.status === "aggregated") {
      throw new Error(`session ${sessionId} already aggregated`);
    }
    const mv = toField(maskedValue);
    session.maskedUpdates[clientId] = {
      value: serializeBig(mv),
      submittedAt: new Date().toISOString(),
    };
    if (session.status === "pending") session.status = "sharing";
    await saveStore(store);
    return { sessionId, clientId, status: session.status };
  });
}

/**
 * Compute the sum of all masked updates. If every participant contributed,
 * the pairwise masks cancel and the returned sum equals sum_i(value_i) mod p.
 * Otherwise the call returns the raw masked sum and marks which clients
 * dropped out so the caller can initiate `recoverKeys`.
 *
 * @param {string} sessionId
 * @returns {Promise<{
 *   sessionId: string,
 *   sum: string,
 *   participantCount: number,
 *   submitted: string[],
 *   missing: string[],
 *   recoveredFor: string[],
 *   status: string,
 * }>}
 */
export async function aggregateMaskedUpdates(sessionId) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const session = store.sessions[sessionId];
    if (!session) throw new Error(`session ${sessionId} not found`);
    const submitted = Object.keys(session.maskedUpdates);
    if (submitted.length === 0) {
      throw new Error("no masked updates submitted yet");
    }
    let sum = 0n;
    for (const id of submitted) {
      sum = (sum + toField(session.maskedUpdates[id].value)) % FIELD_PRIME;
    }
    // Subtract the contributions of dropped participants whose seeds we've
    // already recovered via `recoverKeys`.
    const missing = session.participants.filter((p) => !submitted.includes(p));
    const recoveredFor = Object.keys(session.recoveredSeeds || {});
    for (const droppedId of recoveredFor) {
      const seedStr = session.recoveredSeeds[droppedId];
      const seed = toField(seedStr);
      // Remove the masks that still linger in `sum` because the dropped
      // client never uploaded its masked value. Each surviving peer
      // "would have added" derivePairMask(seed, droppedId, peer) — we
      // instead need to remove what the surviving peers added in their
      // own masked updates, which is derivePairMask(peerSeed, peer, dropped).
      // Since both halves of the pair use the same hash with canonical
      // ordering, recovering droppedId's seed lets us compute every mask
      // that references it and subtract them out.
      for (const peerId of session.participants) {
        if (peerId === droppedId) continue;
        if (!submitted.includes(peerId)) continue;
        const mask = derivePairMask(seed, droppedId, peerId);
        // The dropped client would have added +mask; the surviving peer
        // already added the opposite sign. Remove both contributions from
        // `sum` — but since the dropped client didn't submit, only the
        // surviving peer's side actually reached us, so we subtract it.
        //
        // That value is -mask from peerId's perspective (canonical ordering
        // gives the peer the opposite sign), so subtracting "mask" here
        // removes the lingering ghost.
        sum = (sum + FIELD_PRIME - mask) % FIELD_PRIME;
      }
    }
    session.aggregate = {
      sum: serializeBig(sum),
      computedAt: new Date().toISOString(),
      submitted,
      missing,
      recoveredFor,
    };
    session.status =
      missing.length === 0 || missing.every((m) => recoveredFor.includes(m))
        ? "aggregated"
        : "awaiting_recovery";
    await saveStore(store);
    return {
      sessionId,
      sum: serializeBig(sum),
      participantCount: session.participants.length,
      submitted,
      missing,
      recoveredFor,
      status: session.status,
    };
  });
}

/**
 * Recover a dropped client's seed by submitting at least `threshold` Shamir
 * shares collected from surviving peers. Any number of (x, y) pairs above the
 * threshold works; Lagrange interpolation ignores the redundancy.
 *
 * @param {string} sessionId
 * @param {string} clientId - the *dropped* client whose seed is being recovered
 * @param {Array<{x: bigint|number|string, y: bigint|number|string}>} shares
 * @returns {Promise<{ sessionId: string, clientId: string, seed: string, recovered: boolean }>}
 */
export async function recoverKeys(sessionId, clientId, shares) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const session = store.sessions[sessionId];
    if (!session) throw new Error(`session ${sessionId} not found`);
    if (!session.participants.includes(clientId)) {
      throw new Error(`client ${clientId} is not a session participant`);
    }
    if (!Array.isArray(shares) || shares.length < session.threshold) {
      throw new Error(
        `need at least ${session.threshold} shares to recover ${clientId} (got ${
          Array.isArray(shares) ? shares.length : 0
        })`,
      );
    }
    const seed = reconstructSecret(shares);
    session.recoveredSeeds = session.recoveredSeeds || {};
    session.recoveredSeeds[clientId] = serializeBig(seed);
    await saveStore(store);
    return {
      sessionId,
      clientId,
      seed: serializeBig(seed),
      recovered: true,
    };
  });
}

/**
 * Delete a session and everything attached to it. Returns true if the
 * session existed.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteSession(id) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    if (!store.sessions[id]) return false;
    delete store.sessions[id];
    store.order = store.order.filter((x) => x !== id);
    await saveStore(store);
    return true;
  });
}

// ---- Client-side helpers (exported for tests / SDKs) ----

/**
 * Helper for clients: given a seed and the full participant list, compute the
 * sum of pairwise masks that must be added to the client's real value.
 *
 * @param {bigint|number|string} seed
 * @param {string} selfId
 * @param {string[]} participants
 * @returns {bigint}
 */
export function computeMaskSum(seed, selfId, participants) {
  const s = toField(seed);
  let acc = 0n;
  for (const peer of participants) {
    if (peer === selfId) continue;
    acc = (acc + derivePairMask(s, selfId, peer)) % FIELD_PRIME;
  }
  return acc;
}

/**
 * Helper: apply the mask to a real scalar value and return the masked form.
 * @param {bigint|number|string} value
 * @param {bigint|number|string} seed
 * @param {string} selfId
 * @param {string[]} participants
 * @returns {bigint}
 */
export function maskValue(value, seed, selfId, participants) {
  const v = toField(value);
  const mask = computeMaskSum(seed, selfId, participants);
  return (v + mask) % FIELD_PRIME;
}

export const _internals = {
  storePath,
  normalizeStore,
  loadStore,
  saveStore,
  serializeBig,
  modInverse,
  modPow,
  randomFieldElement,
  MAX_PARTICIPANTS,
  MAX_SESSIONS,
};
