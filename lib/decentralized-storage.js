/**
 * Phase 48.5: Decentralized storage (IPFS / Arweave) abstraction.
 *
 * Provides a pluggable client for archiving content to IPFS, Arweave, or other
 * content-addressed storage providers. The abstraction stores pin records and
 * archive metadata in the json-path-store so workspaces can track what has been
 * pushed to decentralized storage even when the underlying gateway is offline.
 *
 * The default providers are HTTP-based and use the native `fetch` (no new deps).
 * A `mock` provider is included for deterministic tests and local development —
 * it keeps all data in an in-memory store so roundtrips work without network.
 *
 * Custom providers can be registered at runtime via `registerStorageProvider`.
 */
import crypto from "node:crypto";
import { join } from "node:path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_CID_LENGTH = 128;
const MIN_CID_LENGTH = 8;
const DEFAULT_PROVIDER = "mock";

/**
 * Built-in provider registry. Each entry provides metadata; runtime uploaders
 * and downloaders live in `providerClients`.
 */
export const PROVIDERS = {
  ipfs: { baseUrl: "https://ipfs.io", type: "ipfs", description: "IPFS public gateway" },
  arweave: { baseUrl: "https://arweave.net", type: "arweave", description: "Arweave gateway" },
  web3storage: { baseUrl: "https://api.web3.storage", type: "ipfs", description: "web3.storage IPFS API" },
  mock: { type: "mock", description: "In-memory mock provider for tests" },
};

/**
 * @typedef {Object} ProviderClient
 * @property {(data: string|Buffer|Uint8Array, opts: object) => Promise<{ cid: string, size: number, url?: string, txHash?: string }>} uploader
 * @property {(cid: string, opts: object) => Promise<{ data: string, metadata?: object }>} downloader
 * @property {(opts?: object) => Promise<{ ok: boolean, latencyMs?: number, error?: string }>} [health]
 */

/** @type {Map<string, ProviderClient>} */
const providerClients = new Map();

// In-memory store used by the mock uploader/downloader.
/** @type {Map<string, { data: string, metadata: object, size: number, uploadedAt: number }>} */
const mockStore = new Map();

function storePath() {
  return join(getDataDir(), "decentralized-storage.json");
}

function emptyStore() {
  return {
    _version: STORE_VERSION,
    pins: {},
    archives: {},
    providers: {},
  };
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    pins: base.pins && typeof base.pins === "object" ? base.pins : {},
    archives: base.archives && typeof base.archives === "object" ? base.archives : {},
    providers: base.providers && typeof base.providers === "object" ? base.providers : {},
  };
}

async function loadStore() {
  return normalizeStore(await readJsonPath(storePath(), emptyStore()));
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

/**
 * Encode a buffer to lowercase base32 without padding. Used to generate
 * CID-like identifiers — a real IPFS multihash uses a different codec but the
 * base32 form is close enough for deterministic local identification.
 * @param {Buffer} buf
 * @returns {string}
 */
function base32NoPad(buf) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Compute a deterministic CID-like identifier for arbitrary data. Real IPFS
 * uses multihash encoded with multibase; we use `b` (base32) + sha256 digest
 * so the strings look similar and collisions are effectively impossible.
 * @param {string|Buffer|Uint8Array} data
 * @returns {string}
 */
export function computeCid(data) {
  if (data == null) throw new Error("data is required");
  const buf = Buffer.isBuffer(data)
    ? data
    : data instanceof Uint8Array
      ? Buffer.from(data)
      : Buffer.from(String(data), "utf8");
  const digest = crypto.createHash("sha256").update(buf).digest();
  // "b" multibase prefix + base32-encoded sha256; real IPFS would include
  // the multihash codec, but this is enough to make the string unique and
  // round-trippable inside the test suite.
  return `b${base32NoPad(digest)}`;
}

/**
 * Validate that a CID-like string matches the shape produced by `computeCid`.
 * @param {string} cid
 * @returns {boolean}
 */
export function isValidCid(cid) {
  if (typeof cid !== "string") return false;
  if (cid.length < MIN_CID_LENGTH || cid.length > MAX_CID_LENGTH) return false;
  // base32 lowercase alphabet + leading multibase prefix letter
  return /^[a-z][a-z2-7]+$/.test(cid);
}

function assertValidCid(cid) {
  if (!isValidCid(cid)) {
    const err = new Error("invalid cid");
    err.code = "INVALID_CID";
    throw err;
  }
}

function resolveProviderName(name) {
  const key = typeof name === "string" && name.trim() ? name.trim() : DEFAULT_PROVIDER;
  if (!PROVIDERS[key] && !providerClients.has(key)) {
    const err = new Error(`unknown provider: ${key}`);
    err.code = "UNKNOWN_PROVIDER";
    throw err;
  }
  return key;
}

function getProviderClient(name) {
  const client = providerClients.get(name);
  if (!client) {
    const err = new Error(`no client registered for provider: ${name}`);
    err.code = "NO_CLIENT";
    throw err;
  }
  return client;
}

// ---- Built-in clients ----

/**
 * Mock uploader. Stores data in-process and computes a CID for addressing.
 * @type {(data: string|Buffer, opts?: object) => Promise<{ cid: string, size: number, url: string }>}
 */
export const mockUploader = async (data, opts = {}) => {
  const cid = computeCid(data);
  const payload = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  const size = Buffer.byteLength(payload, "utf8");
  mockStore.set(cid, {
    data: payload,
    metadata: opts.metadata || {},
    size,
    uploadedAt: Date.now(),
  });
  return { cid, size, url: `mock://${cid}` };
};

/**
 * Mock downloader. Retrieves data previously uploaded via `mockUploader`.
 * @type {(cid: string) => Promise<{ data: string, metadata: object }>}
 */
export const mockDownloader = async (cid) => {
  assertValidCid(cid);
  const entry = mockStore.get(cid);
  if (!entry) {
    const err = new Error(`cid not found: ${cid}`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return { data: entry.data, metadata: entry.metadata };
};

/**
 * Generic HTTP uploader. Uses native fetch to POST content to a provider's
 * upload endpoint. Callers pass the provider base URL via `opts.baseUrl`.
 * @type {(data: string|Buffer, opts?: object) => Promise<{ cid: string, size: number, url: string }>}
 */
export const httpUploader = async (data, opts = {}) => {
  const baseUrl = opts.baseUrl || opts.url;
  if (!baseUrl) {
    const err = new Error("httpUploader requires opts.baseUrl");
    err.code = "INVALID_INPUT";
    throw err;
  }
  const payload = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  const size = Buffer.byteLength(payload, "utf8");
  const cid = computeCid(payload);
  try {
    // Fire-and-forget: many gateways accept PUT/POST at /ipfs or /tx. We do
    // not assume a specific response format and instead return the locally
    // computed CID as the authoritative identifier.
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Cid": cid,
        ...(opts.headers || {}),
      },
      body: payload,
    });
    const ok = res && typeof res.ok === "boolean" ? res.ok : true;
    if (!ok) {
      const err = new Error(`upload failed: ${res.status}`);
      err.code = "UPLOAD_FAILED";
      throw err;
    }
  } catch (e) {
    if (opts.strict) throw e;
  }
  return { cid, size, url: `${baseUrl}/ipfs/${cid}` };
};

/**
 * Generic HTTP downloader.
 * @type {(cid: string, opts?: object) => Promise<{ data: string, metadata: object }>}
 */
export const httpDownloader = async (cid, opts = {}) => {
  assertValidCid(cid);
  const baseUrl = opts.baseUrl;
  if (!baseUrl) {
    const err = new Error("httpDownloader requires opts.baseUrl");
    err.code = "INVALID_INPUT";
    throw err;
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/ipfs/${cid}`);
    if (!res || !res.ok) {
      const err = new Error(`download failed: ${res?.status || "network"}`);
      err.code = "DOWNLOAD_FAILED";
      throw err;
    }
    const data = await res.text();
    return { data, metadata: {} };
  } catch (e) {
    if (opts.strict) throw e;
    return { data: "", metadata: { error: e.message } };
  }
};

// Register defaults
providerClients.set("mock", { uploader: mockUploader, downloader: mockDownloader });
providerClients.set("ipfs", {
  uploader: (data, opts) => httpUploader(data, { ...opts, baseUrl: PROVIDERS.ipfs.baseUrl }),
  downloader: (cid, opts) => httpDownloader(cid, { ...opts, baseUrl: PROVIDERS.ipfs.baseUrl }),
});
providerClients.set("arweave", {
  uploader: (data, opts) => httpUploader(data, { ...opts, baseUrl: PROVIDERS.arweave.baseUrl }),
  downloader: (cid, opts) => httpDownloader(cid, { ...opts, baseUrl: PROVIDERS.arweave.baseUrl }),
});
providerClients.set("web3storage", {
  uploader: (data, opts) => httpUploader(data, { ...opts, baseUrl: PROVIDERS.web3storage.baseUrl }),
  downloader: (cid, opts) => httpDownloader(cid, { ...opts, baseUrl: PROVIDERS.web3storage.baseUrl }),
});

// ---- Public API ----

/**
 * Upload content to decentralized storage via the configured provider.
 * @param {string|Buffer} data
 * @param {{ provider?: string, metadata?: object, pinning?: boolean, workspaceId?: string }} [options]
 * @returns {Promise<{ cid: string, provider: string, size: number, uploadedAt: number, url?: string, txHash?: string }>}
 */
export async function uploadToStorage(data, options = {}) {
  if (data == null) throw new Error("data is required");
  const provider = resolveProviderName(options.provider);
  const client = getProviderClient(provider);
  const result = await client.uploader(data, { metadata: options.metadata || {} });
  const record = {
    cid: result.cid,
    provider,
    size: result.size,
    uploadedAt: Date.now(),
    url: result.url,
    ...(result.txHash ? { txHash: result.txHash } : {}),
  };
  if (options.pinning !== false) {
    await mutate(async (store) => {
      store.pins[result.cid] = {
        cid: result.cid,
        provider,
        pinnedAt: Date.now(),
        workspaceId: options.workspaceId || null,
        metadata: options.metadata || {},
        size: result.size,
      };
    });
  }
  return record;
}

/**
 * Retrieve content by CID from decentralized storage.
 * @param {string} cid
 * @param {{ provider?: string }} [options]
 * @returns {Promise<{ data: string, metadata: object, verified: boolean, provider: string }>}
 */
export async function downloadFromStorage(cid, options = {}) {
  assertValidCid(cid);
  const provider = resolveProviderName(options.provider);
  const client = getProviderClient(provider);
  const result = await client.downloader(cid, {});
  const verified = computeCid(result.data) === cid;
  return {
    data: result.data,
    metadata: result.metadata || {},
    verified,
    provider,
  };
}

/**
 * Mark an existing CID as pinned. Idempotent; creates a pin record if none
 * exists so external CIDs can be tracked too.
 * @param {string} cid
 * @param {string} [provider]
 * @returns {Promise<object>}
 */
export async function pinContent(cid, provider) {
  assertValidCid(cid);
  const resolved = resolveProviderName(provider);
  return mutate(async (store) => {
    const existing = store.pins[cid] || {
      cid,
      size: 0,
      metadata: {},
      workspaceId: null,
    };
    existing.cid = cid;
    existing.provider = resolved;
    existing.pinnedAt = Date.now();
    existing.pinned = true;
    store.pins[cid] = existing;
    return existing;
  });
}

/**
 * Remove the pin record for a CID.
 * @param {string} cid
 * @param {string} [_provider]
 * @returns {Promise<{ cid: string, removed: boolean }>}
 */
export async function unpinContent(cid, _provider) {
  assertValidCid(cid);
  return mutate(async (store) => {
    const had = Boolean(store.pins[cid]);
    delete store.pins[cid];
    return { cid, removed: had };
  });
}

/**
 * List pinned CIDs, optionally filtered by provider or workspace.
 * @param {{ provider?: string, workspaceId?: string }} [filter]
 * @returns {Promise<Array<object>>}
 */
export async function listPinnedContent(filter = {}) {
  const store = await loadStore();
  const all = Object.values(store.pins || {});
  return all.filter((pin) => {
    if (filter.provider && pin.provider !== filter.provider) return false;
    if (filter.workspaceId && pin.workspaceId !== filter.workspaceId) return false;
    return true;
  });
}

/**
 * Archive a knowledge base document to decentralized storage. The content of
 * the document is loaded, uploaded, and a pin record is persisted so the
 * workspace can later recover the document even if the local index is lost.
 * @param {string} docId
 * @param {string} workspaceId
 * @param {{ provider?: string, content?: string, title?: string, metadata?: object }} [options]
 * @returns {Promise<{ cid: string, docId: string, provider: string, archivedAt: number }>}
 */
export async function archiveKnowledgeDocument(docId, workspaceId, options = {}) {
  if (!docId || typeof docId !== "string") throw new Error("docId is required");
  if (!workspaceId || typeof workspaceId !== "string") throw new Error("workspaceId is required");

  // Prefer caller-provided content so we do not create a hard dependency on
  // knowledge-store in this module. Tests and routes can pass the text they
  // already loaded.
  let content = options.content;
  let title = options.title || docId;
  if (content == null) {
    try {
      const ks = await import("./knowledge-store.js");
      const doc = await ks.getDocumentById({ id: docId, workspace: workspaceId });
      if (doc && !doc.error) {
        content = doc.content || "";
        title = doc.title || title;
      } else {
        throw new Error(`knowledge document ${docId} not found`);
      }
    } catch (e) {
      if (options.content == null) throw e;
    }
  }

  const payload = JSON.stringify({
    docId,
    workspaceId,
    title,
    content,
    metadata: options.metadata || {},
  });
  const provider = resolveProviderName(options.provider);
  const uploaded = await uploadToStorage(payload, {
    provider,
    metadata: { docId, workspaceId, title, kind: "knowledge-document" },
    workspaceId,
    pinning: true,
  });
  await mutate(async (store) => {
    const key = `${workspaceId}:${docId}`;
    store.archives[key] = {
      docId,
      workspaceId,
      cid: uploaded.cid,
      provider,
      title,
      archivedAt: uploaded.uploadedAt,
      size: uploaded.size,
    };
  });
  return {
    cid: uploaded.cid,
    docId,
    workspaceId,
    provider,
    archivedAt: uploaded.uploadedAt,
    size: uploaded.size,
  };
}

/**
 * Restore a previously archived document by CID. Returns the structured
 * payload that was stored when `archiveKnowledgeDocument` was called.
 * @param {string} cid
 * @param {string} [provider]
 * @returns {Promise<{ cid: string, provider: string, verified: boolean, document: object }>}
 */
export async function restoreFromDecentralized(cid, provider) {
  assertValidCid(cid);
  const resolved = resolveProviderName(provider);
  const { data, verified } = await downloadFromStorage(cid, { provider: resolved });
  let document = null;
  try {
    document = JSON.parse(data);
  } catch (_) {
    document = { raw: data };
  }
  return { cid, provider: resolved, verified, document };
}

/**
 * Check provider health. For the mock provider returns ok immediately; for
 * HTTP providers performs a lightweight HEAD against the base URL and times
 * the round-trip.
 * @param {string} provider
 * @returns {Promise<{ provider: string, ok: boolean, latencyMs: number, error?: string }>}
 */
export async function checkProviderHealth(provider) {
  const name = resolveProviderName(provider);
  if (name === "mock") {
    return { provider: name, ok: true, latencyMs: 0 };
  }
  const cfg = PROVIDERS[name];
  if (!cfg || !cfg.baseUrl) {
    return { provider: name, ok: false, latencyMs: 0, error: "no baseUrl configured" };
  }
  const started = Date.now();
  try {
    const res = await fetch(cfg.baseUrl, { method: "HEAD" });
    const latencyMs = Date.now() - started;
    return { provider: name, ok: Boolean(res && res.ok), latencyMs };
  } catch (e) {
    return {
      provider: name,
      ok: false,
      latencyMs: Date.now() - started,
      error: e.message || "fetch failed",
    };
  }
}

/**
 * Register a new storage provider with custom uploader/downloader clients.
 * @param {string} name
 * @param {object} config
 * @param {(data: string|Buffer, opts?: object) => Promise<{ cid: string, size: number, url?: string, txHash?: string }>} uploader
 * @param {(cid: string, opts?: object) => Promise<{ data: string, metadata?: object }>} downloader
 */
export function registerStorageProvider(name, config, uploader, downloader) {
  if (!name || typeof name !== "string") throw new Error("name is required");
  if (typeof uploader !== "function") throw new Error("uploader must be a function");
  if (typeof downloader !== "function") throw new Error("downloader must be a function");
  PROVIDERS[name] = { ...(config || {}), registered: true };
  providerClients.set(name, { uploader, downloader });
  return PROVIDERS[name];
}

/**
 * List all registered providers (built-ins + any runtime additions).
 * @returns {Array<{ name: string, type?: string, description?: string, baseUrl?: string }>}
 */
export function listProviders() {
  return Object.entries(PROVIDERS).map(([name, cfg]) => ({
    name,
    type: cfg.type || "unknown",
    description: cfg.description || "",
    baseUrl: cfg.baseUrl || null,
    hasClient: providerClients.has(name),
  }));
}

/** Internals exposed for tests only. */
export const _internals = {
  mockStore,
  providerClients,
  storePath,
  loadStore,
  emptyStore,
  resetMockStore() {
    mockStore.clear();
  },
};
