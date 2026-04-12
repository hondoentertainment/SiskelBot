/**
 * Phase 67.1: Hash-based detection — provider interface (STUB ONLY).
 *
 * IMPORTANT: This module intentionally ships NO hash lists. It defines an
 * interface that operators can implement with an approved third-party service
 * (e.g. CSAM hash databases from credentialed partners). The default provider
 * returns `{ match: false, reason: "no_provider_configured" }` so the server
 * never fails-open silently against a real check and never fails-closed in
 * default installs.
 *
 * A provider is a function `check(hash, kind, options) => Promise<Result>` or
 * an object exposing `check`. Providers must be registered explicitly.
 *
 * Storage:
 *   data/hash-detection/{providerId}.json  — per-provider metadata (no hashes)
 *   data/hash-detection/_index.json        — registry
 */
import { join } from "path";
import { createHash } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const providers = new Map();

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function providerPath(id) {
  return join(getDataDir(), "hash-detection", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "hash-detection", "_index.json");
}

async function updateIndex(id, remove = false, entry = null) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { providers: [] });
    const list = Array.isArray(idx.providers) ? idx.providers : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { providers: filtered });
  });
}

// ─── Hash helpers ──────────────────────────────────────────────────────────

export const SUPPORTED_ALGORITHMS = ["sha256", "sha1", "md5"];

export function isValidHash(value, algorithm = "sha256") {
  if (typeof value !== "string" || value.length === 0) return false;
  const lower = value.toLowerCase();
  if (!/^[0-9a-f]+$/.test(lower)) return false;
  const expected = algorithm === "sha256" ? 64 : algorithm === "sha1" ? 40 : algorithm === "md5" ? 32 : null;
  if (expected == null) return false;
  return lower.length === expected;
}

export function hashBuffer(buf, algorithm = "sha256") {
  if (!SUPPORTED_ALGORITHMS.includes(algorithm)) {
    throw new Error(`unsupported algorithm ${algorithm}`);
  }
  return createHash(algorithm).update(buf).digest("hex");
}

// ─── Provider registry ────────────────────────────────────────────────────

/**
 * Register a provider. Operators should call this at startup with an approved
 * implementation. The stub provider below is always available by default.
 *
 * @param {string} id
 * @param {object} provider - { check(hash, kind, opts)=>Promise<{match,...}> }
 * @param {object} [meta]   - non-sensitive metadata about the provider
 */
export async function registerProvider(id, provider, meta = {}) {
  if (!id || typeof id !== "string") {
    throw new Error("provider id is required");
  }
  if (!provider || typeof provider.check !== "function") {
    throw new Error("provider.check function is required");
  }
  providers.set(id, provider);
  const now = new Date().toISOString();
  const record = {
    id,
    name: String(meta.name || id),
    description: String(meta.description || ""),
    kinds: Array.isArray(meta.kinds) ? meta.kinds.map(String) : [],
    algorithms: Array.isArray(meta.algorithms)
      ? meta.algorithms.filter((a) => SUPPORTED_ALGORITHMS.includes(a))
      : ["sha256"],
    registeredAt: now,
  };
  await writeJsonPath(providerPath(id), record);
  await updateIndex(id, false, { id, registeredAt: now });
  return record;
}

export async function unregisterProvider(id) {
  providers.delete(id);
  await writeJsonPath(providerPath(id), { _deleted: true });
  await updateIndex(id, true);
  return { ok: true };
}

export async function listProviders() {
  const idx = await readJsonPath(indexPath(), { providers: [] });
  const entries = Array.isArray(idx.providers) ? idx.providers : [];
  const records = [];
  for (const entry of entries) {
    const data = await readJsonPath(providerPath(entry.id), null);
    if (!data || !data.id || data._deleted) continue;
    records.push({ ...data, active: providers.has(data.id) });
  }
  return records;
}

/**
 * Default provider — always returns { match: false, reason: "no_provider_configured" }.
 * Exported so tests and operators can swap it out.
 */
export const DEFAULT_PROVIDER = {
  async check(/* hash, kind, options */) {
    return { match: false, reason: "no_provider_configured" };
  },
};

/**
 * Check a hash against a named provider. When no provider is registered under
 * that id (or none at all), the default provider is used.
 */
export async function checkHash(hash, kind, { providerId, algorithm = "sha256", metadata } = {}) {
  if (!isValidHash(hash, algorithm)) {
    const err = new Error(`invalid ${algorithm} hash`);
    err.code = "INVALID_INPUT";
    throw err;
  }
  const normalized = String(hash).toLowerCase();
  if (providerId) {
    const p = providers.get(providerId);
    if (!p) {
      return {
        match: false,
        reason: "provider_not_found",
        providerId,
        algorithm,
      };
    }
    const result = await Promise.resolve(p.check(normalized, kind, { metadata }));
    return {
      providerId,
      algorithm,
      kind: kind || null,
      ...result,
    };
  }
  // No providerId → try all registered providers, or fall back to the default.
  if (providers.size === 0) {
    const r = await DEFAULT_PROVIDER.check(normalized, kind, { metadata });
    return { providerId: "default", algorithm, kind: kind || null, ...r };
  }
  for (const [id, p] of providers) {
    const r = await Promise.resolve(p.check(normalized, kind, { metadata }));
    if (r?.match) {
      return { providerId: id, algorithm, kind: kind || null, ...r };
    }
  }
  return { match: false, reason: "no_provider_match", algorithm, kind: kind || null };
}

export const _internals = { providerPath, indexPath, providers };
