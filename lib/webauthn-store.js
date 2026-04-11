/**
 * Phase 37.4: Durable storage for WebAuthn credentials.
 *
 * Records look like:
 *   {
 *     credentialId: string,       // base64url
 *     userId: string,
 *     publicKey: string,          // base64url COSE_Key
 *     counter: number,            // monotonic sign counter (replay protection)
 *     transports: string[],       // ["internal", "usb", "nfc", "ble", "hybrid"]
 *     createdAt: string,          // ISO timestamp
 *     lastUsed: string | null,    // ISO timestamp
 *   }
 *
 * Storage routes through lib/json-path-store so Postgres/SQLite/JSON all work.
 */
import { join } from "path";
import { getDataDir, readJsonPath, writeJsonPath, withPathLock } from "./json-path-store.js";

function credentialsPath() {
  return join(getDataDir(), "webauthn-credentials.json");
}

function parseCredentials(data) {
  return Array.isArray(data?.credentials) ? data.credentials : [];
}

async function loadAll() {
  return parseCredentials(await readJsonPath(credentialsPath(), { credentials: [], _version: 1 }));
}

/**
 * Store (insert or replace) a credential for a user.
 * @param {string} userId
 * @param {{ credentialId: string, publicKey: string, counter?: number, transports?: string[] }} credential
 */
export async function storeCredential(userId, credential) {
  if (!userId) throw new Error("userId required");
  if (!credential?.credentialId) throw new Error("credentialId required");
  if (!credential?.publicKey) throw new Error("publicKey required");

  const path = credentialsPath();
  return withPathLock(path, async () => {
    const all = parseCredentials(await readJsonPath(path, { credentials: [], _version: 1 }));
    const filtered = all.filter((c) => c.credentialId !== credential.credentialId);
    const entry = {
      credentialId: credential.credentialId,
      userId,
      publicKey: credential.publicKey,
      counter: credential.counter || 0,
      transports: Array.isArray(credential.transports) ? credential.transports : [],
      createdAt: new Date().toISOString(),
      lastUsed: null,
    };
    filtered.push(entry);
    await writeJsonPath(path, { credentials: filtered, _version: 1 });
    return entry;
  });
}

/**
 * Look up a credential by its ID.
 * @param {string} credentialId
 * @returns {Promise<object | null>}
 */
export async function getCredential(credentialId) {
  if (!credentialId) return null;
  const all = await loadAll();
  return all.find((c) => c.credentialId === credentialId) || null;
}

/**
 * List credentials registered for a user.
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
export async function getUserCredentials(userId) {
  if (!userId) return [];
  const all = await loadAll();
  return all.filter((c) => c.userId === userId);
}

/**
 * Bump the stored counter for a credential and update lastUsed.
 * @param {string} credentialId
 * @param {number} newCounter
 */
export async function updateCounter(credentialId, newCounter) {
  if (!credentialId) throw new Error("credentialId required");
  if (typeof newCounter !== "number" || newCounter < 0) throw new Error("newCounter must be a non-negative number");

  const path = credentialsPath();
  return withPathLock(path, async () => {
    const all = parseCredentials(await readJsonPath(path, { credentials: [], _version: 1 }));
    let updated = null;
    for (const cred of all) {
      if (cred.credentialId === credentialId) {
        cred.counter = newCounter;
        cred.lastUsed = new Date().toISOString();
        updated = cred;
        break;
      }
    }
    if (!updated) return { ok: false, error: "credential not found" };
    await writeJsonPath(path, { credentials: all, _version: 1 });
    return { ok: true, credential: updated };
  });
}

/**
 * Delete a credential by ID.
 * @param {string} credentialId
 */
export async function deleteCredential(credentialId) {
  if (!credentialId) return { ok: false, error: "credentialId required" };
  const path = credentialsPath();
  return withPathLock(path, async () => {
    const all = parseCredentials(await readJsonPath(path, { credentials: [], _version: 1 }));
    const next = all.filter((c) => c.credentialId !== credentialId);
    if (next.length === all.length) return { ok: false, error: "credential not found" };
    await writeJsonPath(path, { credentials: next, _version: 1 });
    return { ok: true };
  });
}

/**
 * Clear all stored credentials. Intended for tests.
 */
export async function _clearAllForTesting() {
  const path = credentialsPath();
  return withPathLock(path, async () => {
    await writeJsonPath(path, { credentials: [], _version: 1 });
  });
}
