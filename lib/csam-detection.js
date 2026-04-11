// @ts-check
/**
 * Phase 67.1: CSAM (child-safety) hash detection.
 *
 * This module implements a SHA-256 hash allowlist / denylist check. It
 * never inspects media content directly: callers supply precomputed
 * digests (e.g. from an external PhotoDNA or NCMEC partner) and the
 * module simply checks whether they appear on a list.
 *
 * Any production deployment must integrate with an authoritative list
 * provider. This module provides the scaffolding and persistence only.
 *
 * Exports:
 *   - addHashToList
 *   - checkHash
 *   - removeHash
 *   - listHashes
 *   - scanBatch
 *
 * @module csam-detection
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const VALID_LISTS = new Set(["denylist", "allowlist"]);

function storePath() {
  return join(getDataDir(), "csam-hash-lists.json");
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    hashes: {}, // digest -> { list, source, addedAt, notes }
  });
  if (!data.hashes || typeof data.hashes !== "object") data.hashes = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    hashes: data.hashes || {},
  });
}

/**
 * Normalize a supplied digest to lowercase hex. Accepts strings only;
 * strict SHA-256 is 64 hex chars, but callers may pass truncated
 * digests for testing — we only enforce hex characters.
 *
 * @param {string} digest
 * @returns {string}
 */
export function normalizeDigest(digest) {
  if (!digest || typeof digest !== "string") {
    throw new Error("digest must be a non-empty string");
  }
  const s = digest.trim().toLowerCase();
  if (!/^[a-f0-9]+$/.test(s)) {
    throw new Error("digest must be hex");
  }
  return s;
}

/**
 * Add a digest to a named list.
 *
 * @param {string} digest - SHA-256 hex digest
 * @param {{list?: "denylist"|"allowlist", source?: string, notes?: string}} [options]
 * @returns {Promise<object>}
 */
export async function addHashToList(digest, options = {}) {
  const hex = normalizeDigest(digest);
  const list = String(options.list || "denylist").toLowerCase();
  if (!VALID_LISTS.has(list)) {
    throw new Error(`list must be one of ${[...VALID_LISTS].join(", ")}`);
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const existing = data.hashes[hex];
    const ts = nowIso();
    const record = {
      digest: hex,
      list,
      source: options.source ? String(options.source) : existing?.source || "manual",
      notes: options.notes ? String(options.notes) : existing?.notes || "",
      addedAt: existing?.addedAt || ts,
      updatedAt: ts,
    };
    data.hashes[hex] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Check a single digest against both lists.
 *
 * @param {string} digest
 * @returns {Promise<{digest: string, matched: boolean, list: string | null, source: string | null, notes: string | null}>}
 */
export async function checkHash(digest) {
  const hex = normalizeDigest(digest);
  const data = await loadStore();
  const rec = data.hashes[hex];
  if (!rec) {
    return { digest: hex, matched: false, list: null, source: null, notes: null };
  }
  return {
    digest: hex,
    matched: true,
    list: rec.list,
    source: rec.source || null,
    notes: rec.notes || null,
  };
}

/**
 * Remove a digest from the store.
 *
 * @param {string} digest
 * @returns {Promise<boolean>}
 */
export async function removeHash(digest) {
  const hex = normalizeDigest(digest);
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.hashes[hex]) return false;
    delete data.hashes[hex];
    await saveStore(data);
    return true;
  });
}

/**
 * List persisted hashes (metadata only). For security reasons the
 * default list size is capped; production deployments should page.
 *
 * @param {{list?: string, limit?: number, source?: string}} [filter]
 * @returns {Promise<object[]>}
 */
export async function listHashes(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.hashes || {});
  if (filter.list) {
    all = all.filter((h) => h.list === filter.list);
  }
  if (filter.source) {
    all = all.filter((h) => h.source === filter.source);
  }
  all.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  const limit = Number.isFinite(filter.limit) && filter.limit > 0 ? Math.floor(filter.limit) : 1000;
  return all.slice(0, limit);
}

/**
 * Scan a batch of digests and return matches.
 *
 * @param {string[]} digests
 * @returns {Promise<{matches: object[], scanned: number, deny: number, allow: number}>}
 */
export async function scanBatch(digests) {
  if (!Array.isArray(digests)) throw new Error("digests array required");
  const data = await loadStore();
  const matches = [];
  let deny = 0;
  let allow = 0;
  for (const d of digests) {
    if (typeof d !== "string") continue;
    let hex;
    try {
      hex = normalizeDigest(d);
    } catch {
      continue;
    }
    const rec = data.hashes[hex];
    if (rec) {
      matches.push({
        digest: hex,
        list: rec.list,
        source: rec.source || null,
      });
      if (rec.list === "denylist") deny += 1;
      if (rec.list === "allowlist") allow += 1;
    }
  }
  return { matches, scanned: digests.length, deny, allow };
}
