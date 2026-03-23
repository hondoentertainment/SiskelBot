/**
 * Phase 75: Idempotency keys for safe POST retries (24h TTL, json-path-store).
 */
import { createHash } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { join } from "path";

const TTL_MS = Math.max(60_000, Number(process.env.IDEMPOTENCY_TTL_MS) || 86_400_000);

function storePath() {
  return join(getDataDir(), "idempotency-keys.json");
}

function hashKey(key) {
  return createHash("sha256").update(String(key).trim(), "utf8").digest("hex").slice(0, 32);
}

function prune(entries) {
  const now = Date.now();
  const out = {};
  for (const [h, row] of Object.entries(entries)) {
    if (!row || typeof row !== "object") continue;
    const t = Number(row.savedAt) || 0;
    if (now - t < TTL_MS) out[h] = row;
  }
  return out;
}

/**
 * @param {string} key - Idempotency-Key header
 * @param {string} routeKey - e.g. "POST:/api/workspaces"
 * @param {string} userId
 * @returns {Promise<{ hit: boolean, status?: number, body?: object }>}
 */
export async function idempotencyLookup(key, routeKey, userId) {
  if (!key || typeof key !== "string" || key.trim().length < 8) return { hit: false };
  const h = hashKey(`${routeKey}:${userId}:${key.trim()}`);
  const path = storePath();
  const data = await readJsonPath(path, { _version: 1, entries: {} });
  let entries = prune(data.entries || {});
  const row = entries[h];
  if (!row || typeof row.body === "undefined") return { hit: false };
  return { hit: true, status: row.status || 201, body: row.body };
}

/**
 * @param {string} key
 * @param {string} routeKey
 * @param {string} userId
 * @param {number} status
 * @param {object} body - JSON body to replay
 */
export async function idempotencyStore(key, routeKey, userId, status, body) {
  if (!key || typeof key !== "string" || key.trim().length < 8) return;
  const h = hashKey(`${routeKey}:${userId}:${key.trim()}`);
  const path = storePath();
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { _version: 1, entries: {} });
    let entries = prune(data.entries || {});
    entries[h] = { savedAt: Date.now(), status, body };
    entries = prune(entries);
    await writeJsonPath(path, { _version: 1, entries });
  });
}
