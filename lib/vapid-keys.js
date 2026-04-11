/**
 * Phase 37.3: VAPID key generation helper for Web Push.
 *
 * VAPID (Voluntary Application Server Identification) uses an ECDSA P-256
 * keypair. The public key is shared with browsers so they can verify the
 * application server identity; the private key signs push notifications.
 *
 * Keys are persisted to STORAGE_PATH/push/vapid-keys.json on first
 * generation. They can also be provided via VAPID_PUBLIC_KEY and
 * VAPID_PRIVATE_KEY env vars.
 */
import { generateKeyPairSync, createPublicKey, createPrivateKey } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let _cached = null;

function toBase64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function vapidKeysPath() {
  return join(getDataDir(), "push", "vapid-keys.json");
}

/**
 * Generate a new VAPID keypair (P-256 ECDSA). Returns base64url-encoded
 * uncompressed public key (65 bytes, 0x04 prefix) and 32-byte private key.
 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });

  // Export the raw uncompressed public key (0x04 || X || Y = 65 bytes)
  const pubJwk = publicKey.export({ format: "jwk" });
  const xBuf = Buffer.from(pubJwk.x, "base64");
  const yBuf = Buffer.from(pubJwk.y, "base64");
  const rawPublic = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);

  // Export the raw private scalar (32 bytes)
  const privJwk = privateKey.export({ format: "jwk" });
  const rawPrivate = Buffer.from(privJwk.d, "base64");

  return {
    publicKey: toBase64Url(rawPublic),
    privateKey: toBase64Url(rawPrivate),
  };
}

/**
 * Load VAPID keys from env, cache, or disk. Generate and persist if missing.
 */
export async function getVapidKeys() {
  if (_cached) return _cached;

  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) {
    _cached = { publicKey: envPub, privateKey: envPriv, subject: VAPID_SUBJECT };
    return _cached;
  }

  const path = vapidKeysPath();
  const stored = await readJsonPath(path, {});
  if (stored && stored.publicKey && stored.privateKey) {
    _cached = { publicKey: stored.publicKey, privateKey: stored.privateKey, subject: VAPID_SUBJECT };
    return _cached;
  }

  const generated = await withPathLock(path, async () => {
    const current = await readJsonPath(path, {});
    if (current && current.publicKey && current.privateKey) return current;
    const keys = generateVapidKeys();
    await writeJsonPath(path, keys);
    return keys;
  });

  _cached = { publicKey: generated.publicKey, privateKey: generated.privateKey, subject: VAPID_SUBJECT };
  return _cached;
}

/**
 * Return the public VAPID key (base64url). Generates keys if not yet set.
 */
export async function getVapidPublicKey() {
  const keys = await getVapidKeys();
  return keys.publicKey;
}

/**
 * Reset cache (for tests).
 */
export function _resetVapidCache() {
  _cached = null;
}
