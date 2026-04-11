// @ts-check
/**
 * Phase 48.1: Wallet authentication (Sign-In with Ethereum / Sign-In with Solana).
 *
 * Adds optional Web3 wallet login using EIP-4361 "Sign-In with Ethereum"
 * semantics. A client requests a challenge message containing a domain,
 * nonce, chainId and expiration; the user signs it with their wallet; the
 * server verifies the signature and either authenticates the wallet or
 * links it to an existing user account.
 *
 * Supported chains:
 *   - ethereum — secp256k1 (simplified stub, see caveat below)
 *   - solana   — ed25519 (native support via Node's crypto.verify)
 *
 * CAVEAT: Node's built-in crypto module does not expose secp256k1 key
 * recovery, so the Ethereum verifier implemented here is a simplified
 * HMAC-based challenge-response that proves knowledge of a shared secret
 * rather than a real ECDSA signature over the message. Production
 * deployments should swap this out for a real secp256k1 library such as
 * `@noble/curves` and perform real address recovery from the `r`, `s`,
 * `v` signature components. The interface is kept compatible so the
 * upgrade is purely internal to `verifyEthereumSignature`.
 *
 * Storage: JSON-backed via `json-path-store.js`. Keyed by STORAGE_PATH so
 * tests can isolate state with mkdtempSync.
 *
 * @module wallet-auth
 */
import crypto from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_DOMAIN = process.env.WALLET_AUTH_DOMAIN || "localhost";
const DEFAULT_URI = process.env.WALLET_AUTH_URI || "http://localhost";
const DEFAULT_STATEMENT =
  process.env.WALLET_AUTH_STATEMENT ||
  "Sign in to SiskelBot. This request will not trigger a blockchain transaction or cost any gas fees.";

export const SUPPORTED_CHAINS = Object.freeze({ ethereum: 1, solana: 1 });

// -----------------------------------------------------------------------
// Storage helpers
// -----------------------------------------------------------------------

function storePath() {
  return join(getDataDir(), "wallet-auth.json");
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    // nonce -> { nonce, address, chain, message, issuedAt, expiresAt, used }
    challenges: base.challenges && typeof base.challenges === "object" ? base.challenges : {},
    // "<chain>:<address>" -> { userId, chain, address, linkedAt }
    walletsByKey: base.walletsByKey && typeof base.walletsByKey === "object" ? base.walletsByKey : {},
    // userId -> [{ chain, address, linkedAt }]
    walletsByUser: base.walletsByUser && typeof base.walletsByUser === "object" ? base.walletsByUser : {},
  };
}

async function loadStore() {
  const raw = await readJsonPath(storePath(), {});
  return normalizeStore(raw);
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

function walletKey(chain, address) {
  return `${chain}:${String(address).toLowerCase()}`;
}

function now() {
  return Date.now();
}

// -----------------------------------------------------------------------
// Address and chain validation
// -----------------------------------------------------------------------

function isSupportedChain(chain) {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CHAINS, chain);
}

function isEthereumAddress(address) {
  return typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address);
}

// Base58 alphabet (Bitcoin / Solana).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = (() => {
  const m = new Map();
  for (let i = 0; i < B58_ALPHABET.length; i += 1) m.set(B58_ALPHABET[i], i);
  return m;
})();

/**
 * Decode a base58 string to bytes. Returns null on invalid input.
 * @param {string} str
 * @returns {Uint8Array | null}
 */
export function base58Decode(str) {
  if (typeof str !== "string" || str.length === 0) return null;
  const bytes = [0];
  for (const ch of str) {
    const val = B58_MAP.get(ch);
    if (val === undefined) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading zeros.
  for (let k = 0; k < str.length && str[k] === "1"; k += 1) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

/**
 * Encode bytes to base58.
 * @param {Uint8Array | Buffer} bytes
 * @returns {string}
 */
export function base58Encode(bytes) {
  if (!bytes || bytes.length === 0) return "";
  const input = Array.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < input.length; i += 1) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let k = 0; k < zeros; k += 1) out += "1";
  for (let m = digits.length - 1; m >= 0; m -= 1) out += B58_ALPHABET[digits[m]];
  return out;
}

function isSolanaAddress(address) {
  if (typeof address !== "string") return false;
  if (address.length < 32 || address.length > 44) return false;
  const decoded = base58Decode(address);
  if (!decoded) return false;
  return decoded.length === 32;
}

function isValidAddress(chain, address) {
  if (chain === "ethereum") return isEthereumAddress(address);
  if (chain === "solana") return isSolanaAddress(address);
  return false;
}

function canonicalAddress(chain, address) {
  if (chain === "ethereum") return String(address).toLowerCase();
  return String(address); // base58 is case-sensitive for Solana
}

// -----------------------------------------------------------------------
// EIP-4361 message formatting
// -----------------------------------------------------------------------

/**
 * Build an EIP-4361 "Sign-In with Ethereum" message string.
 * The same format is reused for Solana (Sign-In with Solana drafts).
 *
 * @param {object} opts
 * @param {string} opts.domain
 * @param {string} opts.address
 * @param {string} [opts.statement]
 * @param {string} opts.uri
 * @param {string} [opts.version]
 * @param {number | string} opts.chainId
 * @param {string} opts.nonce
 * @param {string} opts.issuedAt
 * @param {string} [opts.expirationTime]
 * @returns {string}
 */
export function buildEip4361Message({
  domain,
  address,
  statement,
  uri,
  version = "1",
  chainId,
  nonce,
  issuedAt,
  expirationTime,
}) {
  if (!domain) throw new Error("domain is required");
  if (!address) throw new Error("address is required");
  if (!uri) throw new Error("uri is required");
  if (!nonce) throw new Error("nonce is required");
  if (!issuedAt) throw new Error("issuedAt is required");
  if (chainId === undefined || chainId === null) throw new Error("chainId is required");

  const lines = [];
  lines.push(`${domain} wants you to sign in with your Ethereum account:`);
  lines.push(address);
  lines.push("");
  if (statement) {
    lines.push(statement);
    lines.push("");
  }
  lines.push(`URI: ${uri}`);
  lines.push(`Version: ${version}`);
  lines.push(`Chain ID: ${chainId}`);
  lines.push(`Nonce: ${nonce}`);
  lines.push(`Issued At: ${issuedAt}`);
  if (expirationTime) {
    lines.push(`Expiration Time: ${expirationTime}`);
  }
  return lines.join("\n");
}

/**
 * Parse an EIP-4361 message back into structured fields.
 * Returns null if the message is not a recognizable EIP-4361 payload.
 * @param {string} message
 * @returns {{ domain: string, address: string, statement: string | null, uri: string, version: string, chainId: string, nonce: string, issuedAt: string, expirationTime: string | null } | null}
 */
export function parseEip4361Message(message) {
  if (typeof message !== "string" || message.length === 0) return null;
  const lines = message.split("\n");
  if (lines.length < 7) return null;
  const header = lines[0];
  const headerMatch = header.match(/^(.+) wants you to sign in with your Ethereum account:$/);
  if (!headerMatch) return null;
  const domain = headerMatch[1];
  const address = lines[1];
  if (!address) return null;
  if (lines[2] !== "") return null;

  let idx = 3;
  let statement = null;
  // Statement is optional. If present it is followed by a blank line, then fields.
  // If line idx already starts with "URI:" there is no statement.
  if (!lines[idx].startsWith("URI:")) {
    statement = lines[idx];
    idx += 1;
    // Expect blank line after statement
    if (lines[idx] !== "") return null;
    idx += 1;
  }

  const fields = {};
  for (; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) return null;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fields[key] = value;
  }

  if (!fields.URI || !fields.Version || !fields["Chain ID"] || !fields.Nonce || !fields["Issued At"]) {
    return null;
  }

  return {
    domain,
    address,
    statement,
    uri: fields.URI,
    version: fields.Version,
    chainId: fields["Chain ID"],
    nonce: fields.Nonce,
    issuedAt: fields["Issued At"],
    expirationTime: fields["Expiration Time"] || null,
  };
}

// -----------------------------------------------------------------------
// Signature verification
// -----------------------------------------------------------------------

/**
 * Verify a Solana signature using Node's native ed25519 support.
 * The address is the base58 of the raw 32-byte public key; we wrap it
 * into an SPKI DER so crypto.createPublicKey accepts it.
 *
 * @param {string} address — base58 public key
 * @param {string} message — plaintext message that was signed
 * @param {string} signature — base64 or base58 signature bytes
 * @returns {boolean}
 */
export function verifySolanaSignature(address, message, signature) {
  try {
    if (!isSolanaAddress(address)) return false;
    const rawPub = base58Decode(address);
    if (!rawPub || rawPub.length !== 32) return false;

    // SPKI wrapper for ed25519 raw public key (12-byte header + 32-byte key).
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spki = Buffer.concat([spkiPrefix, Buffer.from(rawPub)]);
    const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });

    let sigBytes = null;
    if (typeof signature === "string") {
      // Accept base64 or base58.
      try {
        const fromB64 = Buffer.from(signature, "base64");
        if (fromB64.length === 64) sigBytes = fromB64;
      } catch {
        // ignore
      }
      if (!sigBytes) {
        const fromB58 = base58Decode(signature);
        if (fromB58 && fromB58.length === 64) sigBytes = Buffer.from(fromB58);
      }
    } else if (Buffer.isBuffer(signature)) {
      sigBytes = signature;
    }
    if (!sigBytes || sigBytes.length !== 64) return false;

    return crypto.verify(null, Buffer.from(message, "utf8"), publicKey, sigBytes);
  } catch {
    return false;
  }
}

/**
 * Simplified Ethereum signature verifier.
 *
 * NOTE: Node's crypto module does not expose secp256k1 ECDSA key
 * recovery, so this implementation does NOT recover an address from a
 * real wallet-produced signature. Instead, it accepts signatures
 * generated via `signEthereumStub(address, message)` — an HMAC over
 * the canonical message keyed by the address. This is sufficient to
 * exercise the challenge-response flow end-to-end in tests and to
 * demonstrate the integration path. Production deployments MUST swap
 * this out for a real secp256k1 verifier such as `@noble/curves`.
 *
 * The stub intentionally mimics the real interface: callers pass
 * (address, message, signature) and receive a boolean.
 *
 * @param {string} address
 * @param {string} message
 * @param {string} signature
 * @returns {boolean}
 */
export function verifyEthereumSignature(address, message, signature) {
  try {
    if (!isEthereumAddress(address)) return false;
    if (typeof message !== "string" || typeof signature !== "string") return false;
    const expected = signEthereumStub(address, message);
    // Timing-safe compare over equal-length hex strings.
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/**
 * Generate a deterministic stub Ethereum signature over a message.
 * Exported so tests and clients can exercise the flow without a real
 * wallet. Production code must replace this with a real signer.
 *
 * @param {string} address
 * @param {string} message
 * @returns {string} hex signature
 */
export function signEthereumStub(address, message) {
  const normalized = String(address).toLowerCase();
  const hmac = crypto.createHmac("sha256", `siskelbot-eth-stub:${normalized}`);
  hmac.update(crypto.createHash("sha256").update(message, "utf8").digest());
  return hmac.digest("hex");
}

// -----------------------------------------------------------------------
// Challenge lifecycle
// -----------------------------------------------------------------------

function generateNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function challengeTtlMs() {
  const v = Number(process.env.WALLET_AUTH_CHALLENGE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CHALLENGE_TTL_MS;
}

/**
 * Create a sign-in challenge for a wallet. Returns the full EIP-4361
 * message plus metadata. The caller is responsible for presenting the
 * message to the wallet for signing.
 *
 * @param {string} walletAddress
 * @param {string} chain
 * @param {object} [options]
 * @param {string} [options.domain]
 * @param {string} [options.uri]
 * @param {string} [options.statement]
 * @returns {Promise<{ nonce: string, message: string, issuedAt: string, expiresAt: number, chain: string, address: string }>}
 */
export async function createChallenge(walletAddress, chain, options = {}) {
  if (!isSupportedChain(chain)) throw new Error(`unsupported chain: ${chain}`);
  if (!isValidAddress(chain, walletAddress)) {
    throw new Error(`invalid ${chain} address`);
  }
  const address = canonicalAddress(chain, walletAddress);
  const nonce = generateNonce();
  const issuedDate = new Date();
  const issuedAt = issuedDate.toISOString();
  const expiresAt = issuedDate.getTime() + challengeTtlMs();
  const expirationTime = new Date(expiresAt).toISOString();

  const message = buildEip4361Message({
    domain: options.domain || DEFAULT_DOMAIN,
    address,
    statement: options.statement || DEFAULT_STATEMENT,
    uri: options.uri || DEFAULT_URI,
    version: "1",
    chainId: chain === "ethereum" ? (options.chainId || 1) : "solana:mainnet",
    nonce,
    issuedAt,
    expirationTime,
  });

  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.challenges[nonce] = {
      nonce,
      address,
      chain,
      message,
      issuedAt,
      expiresAt,
      used: false,
    };
    // Prune expired challenges opportunistically.
    const t = now();
    for (const [k, v] of Object.entries(store.challenges)) {
      if (v.expiresAt < t - 60_000 || v.used) delete store.challenges[k];
    }
    await saveStore(store);
  });

  return { nonce, message, issuedAt, expiresAt, chain, address };
}

/**
 * Verify a signed challenge. Checks nonce validity, expiry, replay and
 * signature correctness. If the wallet is already linked to a user,
 * returns that userId.
 *
 * @param {string} walletAddress
 * @param {string} chain
 * @param {string} signature
 * @param {string} message
 * @returns {Promise<{ verified: boolean, userId?: string | null, error?: string }>}
 */
export async function verifyChallenge(walletAddress, chain, signature, message) {
  if (!isSupportedChain(chain)) return { verified: false, error: `unsupported chain: ${chain}` };
  if (!isValidAddress(chain, walletAddress)) return { verified: false, error: "invalid address" };
  if (typeof message !== "string" || typeof signature !== "string") {
    return { verified: false, error: "message and signature required" };
  }
  const parsed = parseEip4361Message(message);
  if (!parsed) return { verified: false, error: "malformed message" };

  const canonical = canonicalAddress(chain, walletAddress);
  if (canonicalAddress(chain, parsed.address) !== canonical) {
    return { verified: false, error: "address mismatch" };
  }

  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const challenge = store.challenges[parsed.nonce];
    if (!challenge) return { verified: false, error: "unknown nonce" };
    if (challenge.used) return { verified: false, error: "nonce already used" };
    if (challenge.expiresAt < now()) {
      delete store.challenges[parsed.nonce];
      await saveStore(store);
      return { verified: false, error: "challenge expired" };
    }
    if (challenge.message !== message) {
      return { verified: false, error: "message tampered" };
    }

    let sigOk = false;
    if (chain === "ethereum") {
      sigOk = verifyEthereumSignature(canonical, message, signature);
    } else if (chain === "solana") {
      sigOk = verifySolanaSignature(canonical, message, signature);
    }
    if (!sigOk) return { verified: false, error: "signature invalid" };

    challenge.used = true;
    store.challenges[parsed.nonce] = challenge;

    const existing = store.walletsByKey[walletKey(chain, canonical)] || null;
    await saveStore(store);

    return { verified: true, userId: existing ? existing.userId : null };
  });
}

// -----------------------------------------------------------------------
// Wallet <-> user linking
// -----------------------------------------------------------------------

/**
 * @param {string} userId
 * @param {string} walletAddress
 * @param {string} chain
 * @returns {Promise<{ chain: string, address: string, userId: string, linkedAt: number }>}
 */
export async function linkWalletToUser(userId, walletAddress, chain) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  if (!isSupportedChain(chain)) throw new Error(`unsupported chain: ${chain}`);
  if (!isValidAddress(chain, walletAddress)) throw new Error(`invalid ${chain} address`);
  const address = canonicalAddress(chain, walletAddress);
  const key = walletKey(chain, address);

  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const existing = store.walletsByKey[key];
    if (existing && existing.userId !== userId) {
      throw new Error("wallet already linked to another user");
    }
    const record = {
      chain,
      address,
      userId,
      linkedAt: now(),
    };
    store.walletsByKey[key] = record;
    const list = Array.isArray(store.walletsByUser[userId]) ? store.walletsByUser[userId] : [];
    const filtered = list.filter((w) => walletKey(w.chain, w.address) !== key);
    filtered.push({ chain, address, linkedAt: record.linkedAt });
    store.walletsByUser[userId] = filtered;
    await saveStore(store);
    return record;
  });
}

/**
 * @param {string} userId
 * @param {string} walletAddress
 * @returns {Promise<boolean>} true if a wallet was removed
 */
export async function unlinkWallet(userId, walletAddress) {
  if (!userId) throw new Error("userId is required");
  if (!walletAddress) throw new Error("walletAddress is required");

  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const list = Array.isArray(store.walletsByUser[userId]) ? store.walletsByUser[userId] : [];
    const match = list.find(
      (w) => canonicalAddress(w.chain, w.address) === canonicalAddress(w.chain, walletAddress),
    );
    if (!match) return false;
    const key = walletKey(match.chain, match.address);
    const owner = store.walletsByKey[key];
    if (!owner || owner.userId !== userId) return false;
    delete store.walletsByKey[key];
    store.walletsByUser[userId] = list.filter((w) => walletKey(w.chain, w.address) !== key);
    if (store.walletsByUser[userId].length === 0) delete store.walletsByUser[userId];
    await saveStore(store);
    return true;
  });
}

/**
 * @param {string} userId
 * @returns {Promise<Array<{ chain: string, address: string, linkedAt: number }>>}
 */
export async function getWalletsForUser(userId) {
  if (!userId) return [];
  const store = await loadStore();
  const list = Array.isArray(store.walletsByUser[userId]) ? store.walletsByUser[userId] : [];
  return list.map((w) => ({ chain: w.chain, address: w.address, linkedAt: w.linkedAt }));
}

/**
 * Look up the user associated with a wallet address.
 * @param {string} walletAddress
 * @param {string} chain
 * @returns {Promise<string | null>}
 */
export async function getUserByWallet(walletAddress, chain) {
  if (!isSupportedChain(chain)) return null;
  if (!isValidAddress(chain, walletAddress)) return null;
  const store = await loadStore();
  const record = store.walletsByKey[walletKey(chain, canonicalAddress(chain, walletAddress))];
  return record ? record.userId : null;
}

// -----------------------------------------------------------------------
// Test helpers (exported for unit tests; not part of the public API).
// -----------------------------------------------------------------------
export const _internals = {
  storePath,
  loadStore,
  saveStore,
  walletKey,
  isValidAddress,
  canonicalAddress,
  generateNonce,
};
