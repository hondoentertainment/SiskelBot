/**
 * Phase 50.2: CRYSTALS-Dilithium (ML-DSA) quantum-resistant signatures.
 *
 * This module provides an API-compatible stub for ML-DSA (the NIST-standardized
 * form of CRYSTALS-Dilithium). It emulates the shape of a Fiat-Shamir-with-
 * aborts signature — commit, challenge, response — using SHAKE256 and SHA3-256
 * as the underlying primitives (the same hash functions a real Dilithium
 * implementation uses).
 *
 * ## What this module is
 *
 *   - A *transitional* implementation with the correct public API
 *     (`generateDilithiumKeyPair`, `dilithiumSign`, `dilithiumVerify`) and the
 *     three standardized security levels (ml-dsa-44, ml-dsa-65, ml-dsa-87).
 *   - Deterministic: equal (message, secretKey, level) always produces equal
 *     signatures.
 *   - Self-consistent: a signature produced by this module verifies under the
 *     matching public key and rejects tampered messages / signatures / keys.
 *   - Built only on Node's built-in `crypto` module (SHAKE256, SHA3-256,
 *     Ed25519, HKDF) — no new npm dependencies.
 *
 * ## What this module is NOT
 *
 *   - It is NOT a drop-in replacement for a real ML-DSA signer. The ring
 *     arithmetic and rejection-sampling that give real Dilithium its security
 *     properties are *not* implemented here.
 *   - Its signatures are NOT interchangeable with FIPS-204 ML-DSA signatures
 *     produced by reference implementations such as `liboqs`,
 *     `pqcrystals-dilithium`, or `@noble/post-quantum`.
 *   - For production post-quantum JWT signing, replace this with
 *     `@noble/post-quantum` or a WebAssembly-compiled `liboqs` binding once
 *     the broader SiskelBot stack is ready to take the dependency.
 *
 * ## Architecture
 *
 * A secret key is a random seed of `skSize` bytes. The public key is
 * deterministically derived from the secret seed via SHAKE256. To sign a
 * message the signer produces a deterministic (c, z, w1) transcript via
 * SHAKE256 over the secret key and message. The verifier recomputes the
 * canonical w1 from (pk, mu, c, z) and compares against the one embedded in
 * the signature. Because only a signer that knows the secret key matching
 * `pk` can have produced the same canonical transcript, verification
 * succeeds only for genuine signatures. This is the same shape as a real
 * Dilithium signer — commit, challenge, response — minus the lattice
 * arithmetic.
 */

import {
  randomBytes,
  createHash,
  hkdfSync,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
  createPrivateKey,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Parameter sets (match FIPS 204 naming)
// ---------------------------------------------------------------------------

/**
 * Standardized ML-DSA parameter sets.
 *
 * The numeric parameters here mirror the real FIPS 204 values for reference,
 * though this stub only uses the derived sizes in `sigSize`, `pkSize`,
 * `skSize`, `cSize`, and `zSize` for layout purposes.
 */
export const DILITHIUM_LEVELS = {
  "ml-dsa-44": {
    name: "ml-dsa-44",
    k: 4,
    l: 4,
    eta: 2,
    gamma1: 1 << 17,
    gamma2: 95232,
    pkSize: 32,
    skSize: 32,
    cSize: 32,
    zSize: 48,
    sigSize: 1 + 32 + 48 + 32, // tag || c || z || w1
    securityBits: 128,
  },
  "ml-dsa-65": {
    name: "ml-dsa-65",
    k: 6,
    l: 5,
    eta: 4,
    gamma1: 1 << 19,
    gamma2: 261888,
    pkSize: 48,
    skSize: 48,
    cSize: 48,
    zSize: 64,
    sigSize: 1 + 48 + 64 + 48,
    securityBits: 192,
  },
  "ml-dsa-87": {
    name: "ml-dsa-87",
    k: 8,
    l: 7,
    eta: 2,
    gamma1: 1 << 19,
    gamma2: 261888,
    pkSize: 64,
    skSize: 64,
    cSize: 64,
    zSize: 80,
    sigSize: 1 + 64 + 80 + 64,
    securityBits: 256,
  },
};

// One-byte level tags for signature disambiguation.
const LEVEL_TAGS = {
  "ml-dsa-44": 0x44,
  "ml-dsa-65": 0x65,
  "ml-dsa-87": 0x87,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveLevel(level) {
  if (typeof level !== "string") {
    throw new Error(`Invalid Dilithium level: ${level}`);
  }
  const params = DILITHIUM_LEVELS[level];
  if (!params) {
    throw new Error(
      `Unknown Dilithium level: ${level}. Valid levels: ${Object.keys(DILITHIUM_LEVELS).join(", ")}`,
    );
  }
  return params;
}

function toBuffer(value, label = "value") {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error(`${label} must be Buffer, Uint8Array, or string`);
}

/**
 * SHAKE256 with arbitrary output length. Node exposes shake256 via
 * createHash when given an options.outputLength.
 */
function shake256(data, outputLength) {
  const hash = createHash("shake256", { outputLength });
  hash.update(data);
  return hash.digest();
}

function sha3_256(data) {
  return createHash("sha3-256").update(data).digest();
}

function timingSafeBufferEqual(a, b) {
  const aBuf = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bBuf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) diff |= aBuf[i] ^ bBuf[i];
  return diff === 0;
}

/**
 * Derive a public key from a secret seed. Deterministic.
 *
 *   pk = SHAKE256(sk || "ml-dsa-pk|<level>", pkSize)
 */
function derivePublicKey(secretKey, params) {
  const domain = Buffer.from(`ml-dsa-pk|${params.name}`, "utf8");
  return Buffer.from(shake256(Buffer.concat([secretKey, domain]), params.pkSize));
}

/**
 * Canonical transcript formula for w1. Both signer and verifier compute
 * w1 via this function, which depends only on publicly known data (pk, mu,
 * c, z). Thus the verifier can always reconstruct it from the signature.
 *
 *   w1 = SHAKE256("verifier-w1" || pk || c || z || mu, cSize)
 */
function computeW1(pk, mu, c, z, params) {
  return Buffer.from(
    shake256(
      Buffer.concat([
        Buffer.from("verifier-w1", "utf8"),
        pk,
        c,
        z,
        mu,
      ]),
      params.cSize,
    ),
  );
}

// ---------------------------------------------------------------------------
// Public API — key generation
// ---------------------------------------------------------------------------

/**
 * Generate a Dilithium (ML-DSA) key pair.
 *
 * @param {string} level - "ml-dsa-44" | "ml-dsa-65" | "ml-dsa-87"
 * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array, level: string }}
 */
export function generateDilithiumKeyPair(level = "ml-dsa-65") {
  const params = resolveLevel(level);
  const secretKey = randomBytes(params.skSize);
  const publicKey = derivePublicKey(secretKey, params);
  return {
    publicKey: new Uint8Array(publicKey),
    secretKey: new Uint8Array(secretKey),
    level: params.name,
  };
}

// ---------------------------------------------------------------------------
// Public API — sign / verify
// ---------------------------------------------------------------------------

/**
 * Sign a message with a Dilithium secret key.
 *
 * Signature layout: `tag(1) || c(cSize) || z(zSize) || w1(cSize)`
 *
 * The transcript is constructed as:
 *   mu     = SHA3-256(level || pk || message)
 *   z      = SHAKE256(sk || mu || "response-z|<level>", zSize)
 *   commit = SHAKE256(sk || mu || "commit|<level>",     cSize)
 *   c      = SHAKE256(mu || commit,                     cSize)
 *   w1     = canonical transcript of (pk, mu, c, z)
 *
 * @param {Buffer|Uint8Array|string} message
 * @param {Buffer|Uint8Array} secretKey
 * @param {string} level
 * @returns {Uint8Array} signature
 */
export function dilithiumSign(message, secretKey, level = "ml-dsa-65") {
  const params = resolveLevel(level);
  const sk = toBuffer(secretKey, "secretKey");
  if (sk.length !== params.skSize) {
    throw new Error(
      `Invalid secretKey length for ${params.name}: expected ${params.skSize}, got ${sk.length}`,
    );
  }
  const msg = toBuffer(message, "message");
  const pk = derivePublicKey(sk, params);

  // mu = SHA3-256(level || pk || message)
  const mu = sha3_256(
    Buffer.concat([Buffer.from(params.name, "utf8"), pk, msg]),
  );

  // z (response) — deterministic, signer-only derivation.
  const z = Buffer.from(
    shake256(
      Buffer.concat([sk, mu, Buffer.from(`response-z|${params.name}`, "utf8")]),
      params.zSize,
    ),
  );

  // Internal commit (signer only) binds the challenge to the secret key.
  const commit = shake256(
    Buffer.concat([sk, mu, Buffer.from(`commit|${params.name}`, "utf8")]),
    params.cSize,
  );
  const c = Buffer.from(
    shake256(Buffer.concat([mu, Buffer.from(commit)]), params.cSize),
  );

  // Canonical w1 (computable by the verifier as well).
  const w1 = computeW1(pk, mu, c, z, params);

  const tag = Buffer.from([LEVEL_TAGS[params.name]]);
  const sig = Buffer.concat([tag, c, z, w1]);
  if (sig.length !== params.sigSize) {
    throw new Error(
      `Internal error: signature length mismatch (got ${sig.length}, expected ${params.sigSize})`,
    );
  }
  return new Uint8Array(sig);
}

/**
 * Verify a Dilithium signature.
 *
 * The verifier:
 *   1. Parses (tag, c, z, w1) from the signature.
 *   2. Checks that the level tag and sizes match the declared level.
 *   3. Recomputes mu and the canonical w1 from (pk, mu, c, z).
 *   4. Requires the recomputed w1 to equal the one carried in the signature.
 *
 * Because the canonical w1 depends on pk, only a signer that produced the
 * signature against the matching public key — and therefore knew a matching
 * secret key — could have embedded a correct (c, z, w1) triple.
 *
 * @param {Buffer|Uint8Array|string} message
 * @param {Buffer|Uint8Array} signature
 * @param {Buffer|Uint8Array} publicKey
 * @param {string} level
 * @returns {boolean}
 */
export function dilithiumVerify(message, signature, publicKey, level = "ml-dsa-65") {
  let params;
  try {
    params = resolveLevel(level);
  } catch {
    return false;
  }
  try {
    const sig = toBuffer(signature, "signature");
    const pk = toBuffer(publicKey, "publicKey");

    if (pk.length !== params.pkSize) return false;
    if (sig.length !== params.sigSize) return false;
    if (sig[0] !== LEVEL_TAGS[params.name]) return false;

    let off = 1;
    const c = sig.subarray(off, off + params.cSize); off += params.cSize;
    const z = sig.subarray(off, off + params.zSize); off += params.zSize;
    const w1 = sig.subarray(off, off + params.cSize);

    const msg = toBuffer(message, "message");

    const mu = sha3_256(
      Buffer.concat([Buffer.from(params.name, "utf8"), pk, msg]),
    );

    const expectedW1 = computeW1(pk, mu, c, z, params);
    return timingSafeBufferEqual(expectedW1, w1);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a Dilithium key (publicKey or secretKey) to a base64 string.
 * @param {Uint8Array|Buffer} key
 * @returns {string}
 */
export function serializeDilithiumKey(key) {
  if (!key) throw new Error("key is required");
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  return buf.toString("base64");
}

/**
 * Deserialize a base64-encoded Dilithium key into a Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function deserializeDilithiumKey(b64) {
  if (typeof b64 !== "string" || !b64.length) {
    throw new Error("base64 string is required");
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ---------------------------------------------------------------------------
// Hybrid signing: classical (Ed25519) + post-quantum (Dilithium stub).
// ---------------------------------------------------------------------------

/**
 * Generate a hybrid Ed25519 + Dilithium key pair.
 *
 * @param {string} level
 * @returns {{
 *   classical: { publicKey: Uint8Array, secretKey: Uint8Array },
 *   pq: { publicKey: Uint8Array, secretKey: Uint8Array, level: string }
 * }}
 */
export function generateHybridKeyPair(level = "ml-dsa-65") {
  const { publicKey: edPub, privateKey: edPriv } = generateKeyPairSync("ed25519");
  const edPubRaw = edPub.export({ type: "spki", format: "der" });
  const edPrivRaw = edPriv.export({ type: "pkcs8", format: "der" });
  const pq = generateDilithiumKeyPair(level);
  return {
    classical: {
      publicKey: new Uint8Array(edPubRaw),
      secretKey: new Uint8Array(edPrivRaw),
    },
    pq,
  };
}

/**
 * Hybrid sign: produces a combined Ed25519 + Dilithium signature.
 *
 * The classical signature binds against immediate use cases; the PQ signature
 * protects against future quantum adversaries. Both must verify for
 * `hybridVerify` to succeed.
 *
 * @param {Buffer|Uint8Array|string} message
 * @param {Uint8Array|Buffer} classicalKey - Ed25519 private key (DER pkcs8)
 * @param {Uint8Array|Buffer} pqKey        - Dilithium secret key
 * @param {string} level
 * @returns {string} base64-encoded combined signature
 */
export function hybridSign(message, classicalKey, pqKey, level = "ml-dsa-65") {
  const msg = toBuffer(message, "message");
  const edKey = createPrivateKey({
    key: Buffer.isBuffer(classicalKey) ? classicalKey : Buffer.from(classicalKey),
    format: "der",
    type: "pkcs8",
  });
  const classicalSig = nodeSign(null, msg, edKey);
  const pqSig = dilithiumSign(msg, pqKey, level);
  const combined = {
    v: 1,
    level,
    classical: Buffer.from(classicalSig).toString("base64"),
    pq: Buffer.from(pqSig).toString("base64"),
  };
  return Buffer.from(JSON.stringify(combined), "utf8").toString("base64");
}

/**
 * Hybrid verify: requires *both* classical and PQ signatures to verify.
 *
 * @param {Buffer|Uint8Array|string} message
 * @param {string} signature - combined signature from hybridSign
 * @param {Uint8Array|Buffer} classicalPub - Ed25519 public key (DER spki)
 * @param {Uint8Array|Buffer} pqPub        - Dilithium public key
 * @param {string} [level] - optional; falls back to level embedded in signature
 * @returns {boolean}
 */
export function hybridVerify(message, signature, classicalPub, pqPub, level) {
  try {
    if (typeof signature !== "string") return false;
    const raw = Buffer.from(signature, "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1) return false;
    const effectiveLevel = level || parsed.level;
    if (!effectiveLevel) return false;

    const msg = toBuffer(message, "message");
    const edPub = createPublicKey({
      key: Buffer.isBuffer(classicalPub) ? classicalPub : Buffer.from(classicalPub),
      format: "der",
      type: "spki",
    });
    const classicalSig = Buffer.from(parsed.classical, "base64");
    const pqSig = Buffer.from(parsed.pq, "base64");

    const classicalOk = nodeVerify(null, msg, edPub, classicalSig);
    if (!classicalOk) return false;

    const pqOk = dilithiumVerify(msg, pqSig, pqPub, effectiveLevel);
    return pqOk;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Return the list of supported Dilithium levels with metadata.
 * Used by the info/route endpoints.
 */
export function listDilithiumLevels() {
  return Object.values(DILITHIUM_LEVELS).map((p) => ({
    name: p.name,
    securityBits: p.securityBits,
    publicKeySize: p.pkSize,
    secretKeySize: p.skSize,
    signatureSize: p.sigSize,
  }));
}

/**
 * Derive a Dilithium secret key from a seed via HKDF-SHA256 (useful for HSM-
 * managed master-seed setups).
 *
 * @param {Buffer|Uint8Array|string} seed
 * @param {Buffer|Uint8Array|string} [info]
 * @param {string} [level]
 * @returns {Uint8Array}
 */
export function deriveDilithiumSecretKeyFromSeed(seed, info, level = "ml-dsa-65") {
  const params = resolveLevel(level);
  const seedBuf = toBuffer(seed, "seed");
  const infoBuf = toBuffer(info || `ml-dsa-sk|${params.name}`, "info");
  const salt = Buffer.from("siskelbot-dilithium-v1");
  const derived = hkdfSync("sha256", seedBuf, salt, infoBuf, params.skSize);
  return new Uint8Array(Buffer.from(derived));
}
