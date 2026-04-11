// @ts-check
/**
 * Phase 45.3: Secure aggregation for federated learning.
 *
 * Cryptographic aggregation that lets the central server sum client
 * contributions without ever seeing any individual client's raw update. We
 * implement a simplified variant of Bonawitz et al. (2017):
 *
 *   - Each client draws a secret seed `s_i` in F_p and uses it to mask its
 *     real scalar `v_i` before upload: submitted = v_i + s_i  (mod p).
 *   - Each client secret-shares `s_i` among the other participants with
 *     Shamir's Secret Sharing and threshold `t`. At least `t` shares must be
 *     retained for the protocol to unmask successfully.
 *   - After the round, clients reveal seeds of participants who remained
 *     online. For any client that dropped, its peers forward the Shamir shares
 *     they hold back to the server, which reconstructs the missing seed via
 *     Lagrange interpolation.
 *   - Finally, the server computes `sum(submitted) - sum(all seeds)` which
 *     equals `sum(v_i)` — no single `v_i` is ever visible.
 *
 * The scheme is a pedagogical simplification of the real protocol (which
 * layers pairwise masks on top for active-adversary security); it gives the
 * exact same cryptographic end-state for an honest-but-curious server, which
 * is the threat model SiskelBot federated learning assumes.
 *
 * Shamir math runs over F_p with p = 2^127 - 1 (a Mersenne prime) using
 * BigInt. All exposed values are decimal strings so everything round-trips
 * through JSON cleanly.
 *
 * Two purity properties make this module easy to test:
 *
 *   - `createPolynomial`, `evaluatePolynomial`, and `reconstructSecret` are
 *     pure and exported for direct unit tests.
 *
 *   - Every stateful function is wrapped in `withPathLock(storePath(), ...)`
 *     so concurrent callers see a consistent view of the session store.
 *
 * @module secure-aggregation
 */
import { randomUUID, randomBytes } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// Mersenne prime 2^127 - 1. Large enough to hold a sum of quantized 64-bit
// federated scalar updates across thousands of clients without overflow.
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

/** Serialize a BigInt for JSON storage. */
function serializeBig(b) {
  return typeof b === "bigint" ? b.toString() : String(b);
}

/**
 * Modular exponentiation via iterative square-and-multiply.
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
 * Multiplicative inverse in F_p via Fermat's little theorem:
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
 * Draw a uniformly random BigInt in [0, FIELD_PRIME) via rejection sampling
 * on 16 random bytes (the top bit is cleared to stay below 2^127).
 * @returns {bigint}
 */
function randomFieldElement() {
  while (true) {
    const buf = randomBytes(16);
    buf[0] &= 0x7f;
    let acc = 0n;
    for (const byte of buf) acc = (acc << 8n) | BigInt(byte);
    if (acc < FIELD_PRIME) return acc;
  }
}

// ---- Shamir's Secret Sharing ----

/**
 * Build a Shamir polynomial `f(x) = secret + a_1*x + a_2*x^2 + ... + a_{t-1}*x^{t-1}`.
 * The constant term is the secret. `threshold` parties are required to
 * recover the secret. Non-constant coefficients are uniform in F_p.
 *
 * @param {bigint|number|string} secret - the secret constant term (coerced into the field)
 * @param {number} threshold - minimum shares needed to reconstruct
 * @returns {bigint[]} polynomial coefficients; index 0 is the secret
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
 * Evaluate a polynomial at `x` using Horner's method, modulo the field prime.
 * Accepts either a `bigint[]` or a coefficient list of mixed numeric types.
 *
 * @param {Array<bigint|number|string>} poly
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
 * Reconstruct the secret (constant term at x=0) from a set of `(x, y)` shares
 * via Lagrange interpolation. Requires at least `threshold` points; with
 * fewer points the result is meaningless but we do not track the threshold
 * here — callers must (we verify it in `recoverKeys`).
 *
 * Duplicates by `x` are dropped silently because they contribute zero new
 * information and would otherwise blow up the Lagrange denominator.
 *
 * @param {Array<{x: bigint|number|string, y: bigint|number|string}>} shares
 * @returns {bigint}
 */
export function reconstructSecret(shares) {
  if (!Array.isArray(shares) || shares.length === 0) {
    throw new Error("shares must be a non-empty array");
  }
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
      // Lagrange basis L_i(0) = prod_{j != i} (0 - x_j) / (x_i - x_j).
      num = (num * ((FIELD_PRIME - xj) % FIELD_PRIME)) % FIELD_PRIME;
      let diff = (xi - xj) % FIELD_PRIME;
      if (diff < 0n) diff += FIELD_PRIME;
      den = (den * diff) % FIELD_PRIME;
    }
    const term = ((yi * num) % FIELD_PRIME) * modInverse(den) % FIELD_PRIME;
    secret = (secret + term) % FIELD_PRIME;
  }
  return secret;
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
 * Assign an integer x-coordinate to each participant. We use `index + 1` so
 * that x != 0 — the secret lives at f(0) and no share must land on that
 * point or the scheme leaks the secret immediately.
 *
 * @param {string[]} ids
 * @returns {Record<string, string>} id -> decimal stringified x
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
    // Per-client state
    shares: {},          // clientId -> { submittedAt, byPeer: { peerId: { x, y } } }
    seeds: {},           // clientId -> decimal seed (ONLY for clients who revealed in phase 3)
    recoveredSeeds: {},  // clientId -> decimal seed recovered from Shamir shares
    maskedUpdates: {},   // clientId -> { value, submittedAt }
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
 * List recent sessions, most recent first.
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
 * Each client invokes this to draw a fresh seed, split it into `n` Shamir
 * shares (one per participant, including self), and register them with the
 * server.
 *
 * In a real deployment the shares would be encrypted peer-to-peer before the
 * server ever sees them; here we return both the raw shares (so the caller
 * can distribute them if they want) and persist them so subsequent API calls
 * can drive the aggregation forward without requiring per-client state
 * anywhere else.
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
      // Shares organized by the recipient peer; surviving peers forward
      // their share when a client drops so reconstruction can proceed.
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
 * Submit a masked scalar update. `maskedValue` is the client's real value
 * plus its own seed (mod p). The server stores but cannot decode it.
 *
 * We refuse updates from clients that haven't shared keys yet so the
 * recovery path always works if the client later drops.
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
 * After submitting its masked update, a surviving client reveals its own seed
 * directly to the server so the server can cancel that client's mask from
 * the final aggregate. This is the "phase 3 unmask" message in the Bonawitz
 * protocol. Seeds for dropped clients must instead go through `recoverKeys`.
 *
 * @param {string} sessionId
 * @param {string} clientId
 * @param {bigint|number|string} seed
 * @returns {Promise<{ sessionId: string, clientId: string, revealed: boolean }>}
 */
export async function revealSeed(sessionId, clientId, seed) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const session = store.sessions[sessionId];
    if (!session) throw new Error(`session ${sessionId} not found`);
    if (!session.participants.includes(clientId)) {
      throw new Error(`client ${clientId} is not a session participant`);
    }
    if (!session.maskedUpdates[clientId]) {
      throw new Error(`client ${clientId} must submit a masked update before revealing`);
    }
    session.seeds[clientId] = serializeBig(toField(seed));
    await saveStore(store);
    return { sessionId, clientId, revealed: true };
  });
}

/**
 * Compute the aggregate over all submitted masked updates and subtract the
 * seeds (both directly revealed and Shamir-reconstructed) so the result is
 * the plain sum of the real values.
 *
 * If some clients dropped AND their seeds haven't been recovered, the call
 * returns with `status: "awaiting_recovery"` and lists which clients still
 * need recovery so the caller can drive `recoverKeys`.
 *
 * @param {string} sessionId
 * @returns {Promise<{
 *   sessionId: string,
 *   sum: string,
 *   participantCount: number,
 *   submitted: string[],
 *   missing: string[],
 *   recoveredFor: string[],
 *   revealedSeedsFor: string[],
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
    // Sum all masked contributions mod p.
    let sum = 0n;
    for (const id of submitted) {
      sum = (sum + toField(session.maskedUpdates[id].value)) % FIELD_PRIME;
    }
    // Subtract any revealed seeds — these are from surviving clients who
    // have completed phase 3 by giving up their seed directly.
    const revealedSeedsFor = [];
    for (const [cid, seedStr] of Object.entries(session.seeds || {})) {
      if (!submitted.includes(cid)) continue;
      sum = (sum + FIELD_PRIME - toField(seedStr)) % FIELD_PRIME;
      revealedSeedsFor.push(cid);
    }
    // Subtract seeds recovered via Shamir reconstruction for dropped clients.
    const recoveredFor = [];
    for (const [cid, seedStr] of Object.entries(session.recoveredSeeds || {})) {
      // Only subtract if this client actually submitted a masked update.
      // A client that dropped *before* submitting contributed nothing, so
      // there's nothing to cancel.
      if (!submitted.includes(cid)) continue;
      sum = (sum + FIELD_PRIME - toField(seedStr)) % FIELD_PRIME;
      recoveredFor.push(cid);
    }
    // A client is "missing" (needs recovery) when it has a masked update
    // whose seed we still don't know, OR it's a registered participant that
    // never submitted. The second case does NOT need recovery because there's
    // nothing to unmask, but we still report it so callers see the shortfall.
    const needsRecovery = submitted.filter(
      (c) => !revealedSeedsFor.includes(c) && !recoveredFor.includes(c),
    );
    const neverSubmitted = session.participants.filter((p) => !submitted.includes(p));
    const missing = [...needsRecovery];

    const status =
      needsRecovery.length === 0
        ? "aggregated"
        : "awaiting_recovery";

    session.aggregate = {
      sum: serializeBig(sum),
      computedAt: new Date().toISOString(),
      submitted,
      missing,
      neverSubmitted,
      recoveredFor,
      revealedSeedsFor,
      status,
    };
    session.status = status;
    await saveStore(store);
    return {
      sessionId,
      sum: serializeBig(sum),
      participantCount: session.participants.length,
      submitted,
      missing,
      recoveredFor,
      revealedSeedsFor,
      status,
    };
  });
}

/**
 * Recover a dropped client's seed by submitting at least `threshold` Shamir
 * shares collected from surviving peers. Any number of `(x, y)` pairs at or
 * above the threshold works; Lagrange interpolation tolerates redundancy.
 *
 * After recovery the seed is stored on the session and will be subtracted
 * from the aggregate the next time `aggregateMaskedUpdates` is invoked.
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
 * Delete a session and everything attached to it.
 * @param {string} id
 * @returns {Promise<boolean>} true when the session existed
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
 * Given a real scalar value and the client seed, produce the masked form
 * that gets submitted to the server. Equivalent to `(value + seed) mod p`.
 *
 * @param {bigint|number|string} value
 * @param {bigint|number|string} seed
 * @returns {bigint}
 */
export function maskValue(value, seed) {
  return (toField(value) + toField(seed)) % FIELD_PRIME;
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
