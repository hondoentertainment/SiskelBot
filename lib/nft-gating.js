// @ts-check
/**
 * Phase 48.2: NFT-gated workspaces.
 *
 * Workspaces can optionally be gated by NFT ownership. A workspace admin
 * configures which NFT contract(s)/collections grant access. Users who
 * connect a wallet holding a matching NFT get access.
 *
 * This module ships a pluggable ownership-checker interface:
 *
 *   1. `mockChecker` — reads from the local ownership registry (claims
 *      that callers have persisted via `claimNftOwnership`). Suitable for
 *      tests and local development.
 *
 *   2. `httpChecker`  — calls a configurable JSON HTTP endpoint via native
 *      `fetch` when `NFT_RPC_URL_<CHAIN>` env vars are set. Results are
 *      cached by (wallet, contract) with a TTL.
 *
 *   3. Custom checkers may be registered per-chain via
 *      `registerOwnershipChecker(chain, fn)`.
 *
 * Storage: JSON-backed via `json-path-store.js` so the module works across
 * file, SQLite, or Postgres KV backends without code changes.
 *
 * @module nft-gating
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_HTTP_TIMEOUT_MS = 8000;

function storePath() {
  return join(getDataDir(), "nft-gating.json");
}

function now() {
  return Date.now();
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    gates: base.gates && typeof base.gates === "object" ? base.gates : {},
    claims: base.claims && typeof base.claims === "object" ? base.claims : {},
    cache: base.cache && typeof base.cache === "object" ? base.cache : {},
  };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), { _version: STORE_VERSION, gates: {}, claims: {}, cache: {} }),
  );
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

async function mutate(fn) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  });
}

function normalizeChain(chain) {
  return String(chain || "").toLowerCase().trim();
}

function normalizeAddress(addr) {
  return String(addr || "").toLowerCase().trim();
}

function normalizeContract(contract) {
  return String(contract || "").toLowerCase().trim();
}

function cacheKey(walletAddress, contract, chain) {
  return `${normalizeChain(chain)}:${normalizeContract(contract)}:${normalizeAddress(walletAddress)}`;
}

function claimKey(walletAddress, contract, chain) {
  return `${normalizeChain(chain)}:${normalizeContract(contract)}:${normalizeAddress(walletAddress)}`;
}

// ---- Gate configuration ----

/**
 * Persist a gate configuration for a workspace.
 * @param {string} workspaceId
 * @param {{chain: string, contract: string, tokenIds?: (string|number)[], minBalance?: number, collection?: string}} gate
 * @returns {Promise<object>}
 */
export async function setNftGate(workspaceId, gate) {
  if (!workspaceId || typeof workspaceId !== "string") {
    throw new Error("workspaceId is required");
  }
  if (!gate || typeof gate !== "object") {
    throw new Error("gate is required");
  }
  const chain = normalizeChain(gate.chain);
  const contract = normalizeContract(gate.contract);
  if (!chain) throw new Error("gate.chain is required");
  if (!contract) throw new Error("gate.contract is required");

  const tokenIds = Array.isArray(gate.tokenIds)
    ? gate.tokenIds.map((t) => String(t))
    : null;
  const minBalance = Number.isFinite(Number(gate.minBalance)) && Number(gate.minBalance) > 0
    ? Math.floor(Number(gate.minBalance))
    : 1;
  const collection = gate.collection ? String(gate.collection) : null;

  const normalized = {
    workspaceId,
    chain,
    contract,
    tokenIds,
    minBalance,
    collection,
    createdAt: now(),
    updatedAt: now(),
  };

  return mutate(async (store) => {
    const existing = store.gates[workspaceId];
    if (existing && existing.createdAt) {
      normalized.createdAt = existing.createdAt;
    }
    store.gates[workspaceId] = normalized;
    return normalized;
  });
}

/**
 * @param {string} workspaceId
 * @returns {Promise<object|null>}
 */
export async function getNftGate(workspaceId) {
  if (!workspaceId) return null;
  const store = await loadStore();
  return store.gates[workspaceId] || null;
}

/**
 * @param {string} workspaceId
 * @returns {Promise<boolean>} true if a gate existed and was removed
 */
export async function removeNftGate(workspaceId) {
  if (!workspaceId) return false;
  return mutate(async (store) => {
    if (!store.gates[workspaceId]) return false;
    delete store.gates[workspaceId];
    return true;
  });
}

/**
 * List all gated workspaces (optionally filtered by chain).
 * @param {string|null} [chain]
 * @returns {Promise<object[]>}
 */
export async function listGatedWorkspaces(chain = null) {
  const store = await loadStore();
  const wanted = chain ? normalizeChain(chain) : null;
  return Object.values(store.gates).filter((g) => !wanted || g.chain === wanted);
}

// ---- Local ownership registry ----

/**
 * Persist an ownership claim to the local registry. This is used by the
 * mock checker and as a fallback when no RPC checker is configured.
 * @param {string} walletAddress
 * @param {string} contract
 * @param {string|number} tokenId
 * @param {string} chain
 * @returns {Promise<object>} the stored claim
 */
export async function claimNftOwnership(walletAddress, contract, tokenId, chain) {
  if (!walletAddress) throw new Error("walletAddress is required");
  if (!contract) throw new Error("contract is required");
  if (tokenId === undefined || tokenId === null) throw new Error("tokenId is required");
  if (!chain) throw new Error("chain is required");

  const key = claimKey(walletAddress, contract, chain);
  const tokenStr = String(tokenId);

  return mutate(async (store) => {
    const bucket = store.claims[key] || {
      walletAddress: normalizeAddress(walletAddress),
      contract: normalizeContract(contract),
      chain: normalizeChain(chain),
      tokenIds: [],
      createdAt: now(),
      updatedAt: now(),
    };
    if (!Array.isArray(bucket.tokenIds)) bucket.tokenIds = [];
    if (!bucket.tokenIds.includes(tokenStr)) bucket.tokenIds.push(tokenStr);
    bucket.updatedAt = now();
    store.claims[key] = bucket;
    return bucket;
  });
}

async function getLocalClaim(walletAddress, contract, chain) {
  const store = await loadStore();
  return store.claims[claimKey(walletAddress, contract, chain)] || null;
}

// ---- Ownership cache ----

/**
 * Cache an ownership result for (wallet, contract, chain) with an explicit TTL.
 * @param {string} walletAddress
 * @param {string} contract
 * @param {string|null} tokenId
 * @param {string} chain
 * @param {number} expiresInMs
 * @returns {Promise<object>}
 */
export async function cacheOwnership(walletAddress, contract, tokenId, chain, expiresInMs) {
  const ttl = Number.isFinite(Number(expiresInMs)) && Number(expiresInMs) > 0
    ? Number(expiresInMs)
    : DEFAULT_CACHE_TTL_MS;
  const key = cacheKey(walletAddress, contract, chain);
  return mutate(async (store) => {
    store.cache[key] = {
      walletAddress: normalizeAddress(walletAddress),
      contract: normalizeContract(contract),
      chain: normalizeChain(chain),
      tokenId: tokenId === null || tokenId === undefined ? null : String(tokenId),
      cachedAt: now(),
      expiresAt: now() + ttl,
    };
    return store.cache[key];
  });
}

/**
 * @param {string} walletAddress
 * @param {string} contract
 * @param {string} [chain]
 * @returns {Promise<object|null>} cached entry if still valid, else null
 */
export async function getCachedOwnership(walletAddress, contract, chain = "") {
  const key = cacheKey(walletAddress, contract, chain);
  const store = await loadStore();
  const entry = store.cache[key];
  if (!entry) return null;
  if (typeof entry.expiresAt === "number" && entry.expiresAt < now()) {
    return null;
  }
  return entry;
}

// ---- Pluggable ownership checkers ----

const checkers = new Map();

/**
 * Register a custom ownership checker for a specific chain. The checker
 * receives `(walletAddress, gate, options)` and must return
 * `{owns, tokenIds, balance, verifiedAt}`.
 * @param {string} chain
 * @param {Function} checkerFn
 */
export function registerOwnershipChecker(chain, checkerFn) {
  if (!chain) throw new Error("chain is required");
  if (typeof checkerFn !== "function") throw new Error("checkerFn must be a function");
  checkers.set(normalizeChain(chain), checkerFn);
}

/**
 * @param {string} chain
 * @returns {Function|null}
 */
export function getOwnershipChecker(chain) {
  return checkers.get(normalizeChain(chain)) || null;
}

/**
 * Built-in mock checker: verifies ownership by consulting the local registry
 * populated via `claimNftOwnership`.
 * @param {string} walletAddress
 * @param {{chain: string, contract: string, tokenIds?: string[], minBalance?: number}} gate
 * @returns {Promise<{owns: boolean, tokenIds: string[], balance: number, verifiedAt: number}>}
 */
export const mockChecker = async (walletAddress, gate) => {
  const claim = await getLocalClaim(walletAddress, gate.contract, gate.chain);
  const tokenIds = claim && Array.isArray(claim.tokenIds) ? [...claim.tokenIds] : [];
  const balance = tokenIds.length;

  let owns = balance >= (gate.minBalance || 1);

  if (owns && Array.isArray(gate.tokenIds) && gate.tokenIds.length > 0) {
    const wanted = new Set(gate.tokenIds.map((t) => String(t)));
    const matching = tokenIds.filter((t) => wanted.has(t));
    owns = matching.length >= (gate.minBalance || 1);
    return { owns, tokenIds: matching, balance: matching.length, verifiedAt: now() };
  }

  return { owns, tokenIds, balance, verifiedAt: now() };
};

function rpcUrlForChain(chain) {
  const key = `NFT_RPC_URL_${String(chain || "").toUpperCase()}`;
  return process.env[key] || process.env.NFT_RPC_URL || null;
}

/**
 * Built-in HTTP checker: POSTs a JSON body describing the ownership query
 * to `NFT_RPC_URL_<CHAIN>` (or `NFT_RPC_URL`) and expects a response of
 * shape `{owns: bool, tokenIds?: [], balance?: number}`.
 *
 * This does NOT speak EVM JSON-RPC directly; callers may deploy a small
 * adapter service in front of their actual chain node. This keeps us
 * dependency-free while still exercising the full verification path.
 *
 * @param {string} walletAddress
 * @param {{chain: string, contract: string, tokenIds?: string[], minBalance?: number}} gate
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{owns: boolean, tokenIds: string[], balance: number, verifiedAt: number}>}
 */
export const httpChecker = async (walletAddress, gate, options = {}) => {
  const url = rpcUrlForChain(gate.chain);
  if (!url) {
    throw new Error(`No RPC URL configured for chain "${gate.chain}" (set NFT_RPC_URL_${String(gate.chain || "").toUpperCase()})`);
  }
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_HTTP_TIMEOUT_MS;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: gate.chain,
        contract: gate.contract,
        walletAddress,
        tokenIds: gate.tokenIds || null,
        minBalance: gate.minBalance || 1,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`RPC checker returned HTTP ${res.status}`);
    }
    const data = await res.json();
    const tokenIds = Array.isArray(data?.tokenIds) ? data.tokenIds.map((t) => String(t)) : [];
    const balance = Number.isFinite(Number(data?.balance))
      ? Number(data.balance)
      : tokenIds.length;
    const owns = Boolean(data?.owns) && balance >= (gate.minBalance || 1);
    return { owns, tokenIds, balance, verifiedAt: now() };
  } finally {
    clearTimeout(t);
  }
};

// Register the mock checker by default so unknown chains still verify
// against the local registry (used by tests and development).
registerOwnershipChecker("mock", mockChecker);

// ---- Public verification API ----

/**
 * Check ownership via the configured checker for the gate's chain, with
 * caching. Options:
 *   - `useCache`  (default true)
 *   - `cacheTtlMs`
 *   - `checker`   — override selection of the chain-specific checker
 *   - `timeoutMs` — passed through to HTTP checkers
 *
 * @param {string} walletAddress
 * @param {{chain: string, contract: string, tokenIds?: string[], minBalance?: number}} gate
 * @param {object} [options]
 * @returns {Promise<{owns: boolean, tokenIds: string[], balance: number, verifiedAt: number, cached?: boolean, reason?: string}>}
 */
export async function checkOwnership(walletAddress, gate, options = {}) {
  if (!walletAddress) throw new Error("walletAddress is required");
  if (!gate || typeof gate !== "object") throw new Error("gate is required");
  if (!gate.chain) throw new Error("gate.chain is required");
  if (!gate.contract) throw new Error("gate.contract is required");

  const chain = normalizeChain(gate.chain);
  const useCache = options.useCache !== false;

  if (useCache) {
    const cached = await getCachedOwnership(walletAddress, gate.contract, chain);
    if (cached) {
      return {
        owns: true,
        tokenIds: cached.tokenId ? [cached.tokenId] : [],
        balance: cached.tokenId ? 1 : 0,
        verifiedAt: cached.cachedAt,
        cached: true,
      };
    }
  }

  const checker =
    (typeof options.checker === "function" ? options.checker : null) ||
    getOwnershipChecker(chain) ||
    getOwnershipChecker("mock");

  if (!checker) {
    return { owns: false, tokenIds: [], balance: 0, verifiedAt: now(), reason: `no checker registered for chain "${chain}"` };
  }

  let result;
  try {
    result = await checker(walletAddress, { ...gate, chain }, options);
  } catch (err) {
    return {
      owns: false,
      tokenIds: [],
      balance: 0,
      verifiedAt: now(),
      reason: `checker failed: ${err.message || String(err)}`,
    };
  }

  const normalized = {
    owns: Boolean(result?.owns),
    tokenIds: Array.isArray(result?.tokenIds) ? result.tokenIds.map((t) => String(t)) : [],
    balance: Number.isFinite(Number(result?.balance)) ? Number(result.balance) : 0,
    verifiedAt: Number.isFinite(Number(result?.verifiedAt)) ? Number(result.verifiedAt) : now(),
  };

  if (normalized.owns && useCache) {
    const ttl = Number.isFinite(Number(options.cacheTtlMs)) && Number(options.cacheTtlMs) > 0
      ? Number(options.cacheTtlMs)
      : DEFAULT_CACHE_TTL_MS;
    try {
      await cacheOwnership(
        walletAddress,
        gate.contract,
        normalized.tokenIds[0] || null,
        chain,
        ttl,
      );
    } catch (_) {
      // cache write failures must not block verification
    }
  }

  return normalized;
}

/**
 * Decide whether a wallet may access a workspace. Workspaces without a
 * configured gate are unrestricted.
 *
 * @param {string} walletAddress
 * @param {string} workspaceId
 * @param {object} [options]
 * @returns {Promise<{allowed: boolean, reason: string, verifiedAt: number, gate?: object, ownership?: object}>}
 */
export async function verifyWorkspaceAccess(walletAddress, workspaceId, options = {}) {
  if (!workspaceId) {
    return { allowed: false, reason: "workspaceId is required", verifiedAt: now() };
  }
  const gate = await getNftGate(workspaceId);
  if (!gate) {
    return { allowed: true, reason: "no gate configured", verifiedAt: now() };
  }
  if (!walletAddress) {
    return { allowed: false, reason: "walletAddress is required for gated workspace", verifiedAt: now(), gate };
  }
  const ownership = await checkOwnership(walletAddress, gate, options);
  if (ownership.owns) {
    return {
      allowed: true,
      reason: "ownership verified",
      verifiedAt: ownership.verifiedAt,
      gate,
      ownership,
    };
  }
  return {
    allowed: false,
    reason: ownership.reason || "wallet does not own required NFT",
    verifiedAt: ownership.verifiedAt,
    gate,
    ownership,
  };
}

// ---- Internals for tests ----

export const _internals = {
  storePath,
  loadStore,
  saveStore,
  checkers,
  DEFAULT_CACHE_TTL_MS,
};
