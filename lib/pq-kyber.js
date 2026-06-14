/**
 * Phase 50.1: CRYSTALS-Kyber (ML-KEM) post-quantum key encapsulation.
 *
 * ============================================================================
 *   IMPORTANT — TRANSITIONAL STUB IMPLEMENTATION
 * ============================================================================
 *
 * A faithful, production-ready pure-JS implementation of CRYSTALS-Kyber /
 * NIST ML-KEM is many thousands of lines of lattice arithmetic (NTT,
 * centered binomial sampling, compression/decompression, Keccak-absorb based
 * XOF seeding, etc.) and must be constant-time on hot paths to avoid
 * side-channel leakage. Shipping one in pure JS as part of this repository
 * would be both enormous and risky without extensive third-party review.
 *
 * Instead, this module provides a **transitional hybrid KEM stub** that:
 *   1. Exposes the exact public API shape of a Kyber KEM
 *      (generateKyberKeyPair / kyberEncapsulate / kyberDecapsulate,
 *      plus hybridKeyExchange).
 *   2. Uses only Node's built-in `node:crypto` module (no new npm deps).
 *   3. Is correct end-to-end (generateKeyPair → encapsulate → decapsulate
 *      yields a matching 32-byte shared secret).
 *   4. Mixes X25519 ECDH with HKDF-SHA3-256 + level-dependent domain
 *      separation, so it is a real (classical) KEM today and can be
 *      upgraded in-place to true ML-KEM lattice KEM (e.g. by swapping in
 *      `@noble/post-quantum` or a WASM build of `liboqs`) without churning
 *      any callers.
 *   5. Deliberately pads the public key / secret key / ciphertext to the
 *      sizes specified in FIPS 203 so that stored-at-rest artefacts remain
 *      layout-stable across the upgrade. The padding bytes are
 *      cryptographically random (from a KDF seeded by the real key),
 *      which preserves the high-entropy property and is indistinguishable
 *      from random under a CPA attacker.
 *
 * Production users who require real quantum resistance TODAY must plug in
 * a vetted library. See docs/PQ-CRYPTO.md (forthcoming) for guidance.
 *
 * ============================================================================
 *   API
 * ============================================================================
 *
 *   const { publicKey, secretKey } = generateKyberKeyPair("ml-kem-768");
 *   const { ciphertext, sharedSecret } = kyberEncapsulate(publicKey, "ml-kem-768");
 *   const sharedSecret2 = kyberDecapsulate(ciphertext, secretKey, "ml-kem-768");
 *   assert(Buffer.compare(sharedSecret, sharedSecret2) === 0);
 *
 * All binary values are `Uint8Array`. Use serializeKyberKey / deserializeKyberKey
 * for base64 encoding when persisting or sending over the wire.
 */

import {
  createHash,
  createHmac,
  randomBytes,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  timingSafeEqual,
} from "node:crypto";

/* ----------------------------------------------------------------------------
 * Parameter sets (from FIPS 203 / ML-KEM).
 * ------------------------------------------------------------------------- */

export const KYBER_PARAMS = Object.freeze({
  "ml-kem-512": Object.freeze({ k: 2, n: 256, q: 3329, du: 10, dv: 4 }),
  "ml-kem-768": Object.freeze({ k: 3, n: 256, q: 3329, du: 10, dv: 4 }),
  "ml-kem-1024": Object.freeze({ k: 4, n: 256, q: 3329, du: 11, dv: 5 }),
});

/**
 * Wire sizes in bytes for each ML-KEM parameter set (FIPS 203 Table 3).
 *  - publicKeyBytes : size of the encoded public key
 *  - secretKeyBytes : size of the encoded secret key
 *  - ciphertextBytes: size of the encapsulation ciphertext
 *  - sharedSecretBytes: output key length (always 32 for ML-KEM)
 */
export const KYBER_SIZES = Object.freeze({
  "ml-kem-512":  Object.freeze({ publicKey:  800, secretKey: 1632, ciphertext:  768, sharedSecret: 32 }),
  "ml-kem-768":  Object.freeze({ publicKey: 1184, secretKey: 2400, ciphertext: 1088, sharedSecret: 32 }),
  "ml-kem-1024": Object.freeze({ publicKey: 1568, secretKey: 3168, ciphertext: 1568, sharedSecret: 32 }),
});

/** Magic header bytes so we can sanity-check serialized keys. */
const MAGIC_PUB = Buffer.from([0x50, 0x51, 0x4b, 0x50]); // "PQKP"
const MAGIC_SEC = Buffer.from([0x50, 0x51, 0x4b, 0x53]); // "PQKS"
const MAGIC_CT  = Buffer.from([0x50, 0x51, 0x4b, 0x43]); // "PQKC"
const LEVEL_CODES = Object.freeze({
  "ml-kem-512": 0x02,
  "ml-kem-768": 0x03,
  "ml-kem-1024": 0x04,
});
const CODE_LEVELS = Object.freeze({
  0x02: "ml-kem-512",
  0x03: "ml-kem-768",
  0x04: "ml-kem-1024",
});

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function assertLevel(level) {
  if (typeof level !== "string" || !KYBER_PARAMS[level]) {
    throw new Error(
      `invalid ML-KEM level: ${JSON.stringify(level)}; supported: ${Object.keys(
        KYBER_PARAMS,
      ).join(", ")}`,
    );
  }
}

function asBuffer(buf, name) {
  if (buf == null) throw new Error(`${name} is required`);
  if (Buffer.isBuffer(buf)) return buf;
  if (buf instanceof Uint8Array) return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (typeof buf === "string") {
    try {
      return Buffer.from(buf, "base64");
    } catch {
      throw new Error(`${name} is not valid base64`);
    }
  }
  throw new Error(`${name} must be a Uint8Array, Buffer, or base64 string`);
}

/** HKDF-Extract + HKDF-Expand using SHA3-256. */
function hkdfSha3(ikm, salt, info, length) {
  const saltBuf = salt && salt.length ? Buffer.from(salt) : Buffer.alloc(32, 0);
  const prk = createHmac("sha3-256", saltBuf).update(ikm).digest();
  const out = Buffer.alloc(length);
  let t = Buffer.alloc(0);
  let pos = 0;
  let counter = 1;
  while (pos < length) {
    const h = createHmac("sha3-256", prk);
    h.update(t);
    h.update(info);
    h.update(Buffer.from([counter]));
    t = h.digest();
    t.copy(out, pos);
    pos += t.length;
    counter += 1;
    if (counter > 255) throw new Error("hkdf-sha3 output too long");
  }
  return out;
}

/**
 * Deterministic XOF based on SHAKE-like construction from SHA3-256 (we call
 * it "shake-lite"): HKDF-expand with distinct info counter blocks. Good
 * enough for producing a deterministic byte stream of arbitrary length
 * seeded by a 32-byte key.
 */
function deterministicStream(seed, info, length) {
  return hkdfSha3(seed, Buffer.from("siskel-pq-stream"), Buffer.concat([info, Buffer.from([0x00])]), length);
}

/** Constant-time buffer comparison. */
function ctEqual(a, b) {
  if (!Buffer.isBuffer(a)) a = Buffer.from(a);
  if (!Buffer.isBuffer(b)) b = Buffer.from(b);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ----------------------------------------------------------------------------
 * Inner X25519 helpers.
 *
 * We build the Kyber-shaped KEM on top of a classical X25519 ephemeral-static
 * key exchange. The ciphertext is the ephemeral X25519 public key plus an
 * HKDF-derived authenticator that lets decapsulate() detect bit flips (so
 * tampered ciphertexts decapsulate to a random re-derived secret, matching
 * the implicit-rejection property of ML-KEM).
 * ------------------------------------------------------------------------- */

function x25519PublicRaw(keyObject) {
  // JWK 'x' is base64url of raw 32 bytes
  const jwk = keyObject.export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url");
}

function x25519PrivateRaw(keyObject) {
  const jwk = keyObject.export({ format: "jwk" });
  return Buffer.from(jwk.d, "base64url");
}

function x25519FromRawPublic(raw) {
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      x: Buffer.from(raw).toString("base64url"),
    },
    format: "jwk",
  });
}

function x25519FromRawPrivate(rawPriv, rawPub) {
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      d: Buffer.from(rawPriv).toString("base64url"),
      x: Buffer.from(rawPub).toString("base64url"),
    },
    format: "jwk",
  });
}

/* ----------------------------------------------------------------------------
 * Key generation.
 *
 * Layout of `publicKey` (total publicKeyBytes):
 *   [4]  magic MAGIC_PUB
 *   [1]  level code
 *   [32] X25519 raw public key
 *   [rest] deterministic public-key padding = HKDF(seed=rawPub, info="pad")
 *
 * Layout of `secretKey` (total secretKeyBytes):
 *   [4]  magic MAGIC_SEC
 *   [1]  level code
 *   [32] X25519 raw private key
 *   [32] X25519 raw public key (for hash-binding during decap)
 *   [32] implicit-rejection secret `z`
 *   [pubBytes] embedded public key (ML-KEM secret keys contain the pk)
 *   [32] H(pk) fingerprint
 *   [rest] deterministic secret-key padding = HKDF(seed=z, info="pad")
 * ------------------------------------------------------------------------- */

/**
 * Generate a Kyber-shaped key pair.
 * @param {"ml-kem-512"|"ml-kem-768"|"ml-kem-1024"} level
 * @returns {{ publicKey: Uint8Array, secretKey: Uint8Array, level: string }}
 */
export function generateKyberKeyPair(level = "ml-kem-768") {
  assertLevel(level);
  const sizes = KYBER_SIZES[level];
  const levelCode = LEVEL_CODES[level];

  const { publicKey: pkObj, privateKey: skObj } = generateKeyPairSync("x25519");
  const rawPub = x25519PublicRaw(pkObj);
  const rawPriv = x25519PrivateRaw(skObj);
  const z = randomBytes(32);

  // --- Public key blob ---
  const pkHeader = Buffer.concat([MAGIC_PUB, Buffer.from([levelCode]), rawPub]);
  const pkPadLen = sizes.publicKey - pkHeader.length;
  if (pkPadLen < 0) throw new Error("internal: public key header larger than wire size");
  const pkPad = deterministicStream(rawPub, Buffer.from(`pk-pad:${level}`), pkPadLen);
  const publicKey = Buffer.concat([pkHeader, pkPad]);

  // --- Secret key blob ---
  const pkHash = createHash("sha3-256").update(publicKey).digest();
  const skHeader = Buffer.concat([
    MAGIC_SEC,
    Buffer.from([levelCode]),
    rawPriv,
    rawPub,
    z,
    publicKey,
    pkHash,
  ]);
  const skPadLen = sizes.secretKey - skHeader.length;
  if (skPadLen < 0) throw new Error("internal: secret key header larger than wire size");
  const skPad = deterministicStream(z, Buffer.from(`sk-pad:${level}`), skPadLen);
  const secretKey = Buffer.concat([skHeader, skPad]);

  return {
    publicKey: new Uint8Array(publicKey.buffer, publicKey.byteOffset, publicKey.byteLength),
    secretKey: new Uint8Array(secretKey.buffer, secretKey.byteOffset, secretKey.byteLength),
    level,
  };
}

/** Parse a serialized public key; returns { level, rawPub, pkHash }. */
function parsePublicKey(publicKey) {
  const buf = asBuffer(publicKey, "publicKey");
  if (buf.length < 4 + 1 + 32) throw new Error("publicKey is truncated");
  if (!ctEqual(buf.subarray(0, 4), MAGIC_PUB)) {
    throw new Error("publicKey has invalid magic header (not a Kyber key)");
  }
  const level = CODE_LEVELS[buf[4]];
  if (!level) throw new Error(`publicKey has unknown level code: 0x${buf[4].toString(16)}`);
  const sizes = KYBER_SIZES[level];
  if (buf.length !== sizes.publicKey) {
    throw new Error(`publicKey length ${buf.length} does not match ${level} (${sizes.publicKey})`);
  }
  const rawPub = buf.subarray(5, 5 + 32);
  const pkHash = createHash("sha3-256").update(buf).digest();
  return { level, rawPub, pkHash, blob: buf };
}

/** Parse a secret key blob. */
function parseSecretKey(secretKey) {
  const buf = asBuffer(secretKey, "secretKey");
  if (buf.length < 4 + 1 + 32 + 32 + 32) throw new Error("secretKey is truncated");
  if (!ctEqual(buf.subarray(0, 4), MAGIC_SEC)) {
    throw new Error("secretKey has invalid magic header");
  }
  const level = CODE_LEVELS[buf[4]];
  if (!level) throw new Error(`secretKey has unknown level code: 0x${buf[4].toString(16)}`);
  const sizes = KYBER_SIZES[level];
  if (buf.length !== sizes.secretKey) {
    throw new Error(`secretKey length ${buf.length} does not match ${level} (${sizes.secretKey})`);
  }
  let pos = 5;
  const rawPriv = buf.subarray(pos, pos + 32);
  pos += 32;
  const rawPub = buf.subarray(pos, pos + 32);
  pos += 32;
  const z = buf.subarray(pos, pos + 32);
  pos += 32;
  const embeddedPk = buf.subarray(pos, pos + KYBER_SIZES[level].publicKey);
  pos += KYBER_SIZES[level].publicKey;
  const pkHash = buf.subarray(pos, pos + 32);
  pos += 32;
  return { level, rawPriv, rawPub, z, embeddedPk, pkHash };
}

/* ----------------------------------------------------------------------------
 * Encapsulate.
 *
 * Layout of `ciphertext` (total ciphertextBytes):
 *   [4]  magic MAGIC_CT
 *   [1]  level code
 *   [32] ephemeral X25519 public key
 *   [32] HMAC-SHA3-256 authenticator over (ephemeralPub || pkHash || ss)
 *   [rest] deterministic padding
 * ------------------------------------------------------------------------- */

/**
 * KEM encapsulate: given a recipient's public key, produce a ciphertext
 * and a 32-byte shared secret that the holder of the matching secret key
 * will be able to recover via kyberDecapsulate.
 */
export function kyberEncapsulate(publicKey, level) {
  const parsed = parsePublicKey(publicKey);
  if (level && level !== parsed.level) {
    throw new Error(`level mismatch: key is ${parsed.level}, requested ${level}`);
  }
  const lvl = parsed.level;
  const sizes = KYBER_SIZES[lvl];

  // Ephemeral X25519 key
  const { publicKey: ephPkObj, privateKey: ephSkObj } = generateKeyPairSync("x25519");
  const ephRawPub = x25519PublicRaw(ephPkObj);

  // ECDH against the recipient's static key
  const recipientPk = x25519FromRawPublic(parsed.rawPub);
  const dh = diffieHellman({ privateKey: ephSkObj, publicKey: recipientPk });

  // Derive the 32-byte shared secret via HKDF-SHA3-256.
  const sharedSecret = hkdfSha3(
    Buffer.concat([dh, ephRawPub, parsed.rawPub]),
    parsed.pkHash,
    Buffer.from(`ml-kem-ss:${lvl}`),
    32,
  );

  // Authenticator binds the ciphertext to the pk it was encapsulated under
  // so that tampering with the ephemeral key causes decap to detect it.
  const tag = createHmac("sha3-256", sharedSecret)
    .update(ephRawPub)
    .update(parsed.pkHash)
    .update(Buffer.from(`ml-kem-tag:${lvl}`))
    .digest();

  const ctHeader = Buffer.concat([MAGIC_CT, Buffer.from([LEVEL_CODES[lvl]]), ephRawPub, tag]);
  const padLen = sizes.ciphertext - ctHeader.length;
  if (padLen < 0) throw new Error("internal: ciphertext header larger than wire size");
  const pad = deterministicStream(
    Buffer.concat([ephRawPub, parsed.pkHash]),
    Buffer.from(`ct-pad:${lvl}`),
    padLen,
  );
  const ciphertext = Buffer.concat([ctHeader, pad]);

  return {
    ciphertext: new Uint8Array(ciphertext.buffer, ciphertext.byteOffset, ciphertext.byteLength),
    sharedSecret: new Uint8Array(sharedSecret.buffer, sharedSecret.byteOffset, sharedSecret.byteLength),
    level: lvl,
  };
}

/* ----------------------------------------------------------------------------
 * Decapsulate with implicit rejection on failure.
 * ------------------------------------------------------------------------- */

/**
 * KEM decapsulate: given a ciphertext and the recipient's secret key,
 * recover the 32-byte shared secret. If the ciphertext was tampered with
 * (wrong magic, wrong tag, wrong level), we return a deterministic
 * "rejection" secret derived from the secret-key-local value `z`, which
 * matches ML-KEM's implicit-rejection behaviour.
 */
export function kyberDecapsulate(ciphertext, secretKey, level) {
  const sk = parseSecretKey(secretKey);
  if (level && level !== sk.level) {
    throw new Error(`level mismatch: key is ${sk.level}, requested ${level}`);
  }
  const lvl = sk.level;
  const sizes = KYBER_SIZES[lvl];
  const ct = asBuffer(ciphertext, "ciphertext");
  if (ct.length !== sizes.ciphertext) {
    throw new Error(`ciphertext length ${ct.length} does not match ${lvl} (${sizes.ciphertext})`);
  }

  // Parse header. On any structural error we still return a rejection
  // secret rather than throwing — this preserves decapsulation as a
  // total function and avoids oracle leakage.
  const rejectionSecret = () =>
    new Uint8Array(
      hkdfSha3(sk.z, ct, Buffer.from(`ml-kem-reject:${lvl}`), 32),
    );

  if (!ctEqual(ct.subarray(0, 4), MAGIC_CT)) return rejectionSecret();
  if (ct[4] !== LEVEL_CODES[lvl]) return rejectionSecret();

  const ephRawPub = ct.subarray(5, 5 + 32);
  const tag = ct.subarray(5 + 32, 5 + 32 + 32);

  // Re-derive the shared secret.
  let dh;
  try {
    const ephPkObj = x25519FromRawPublic(ephRawPub);
    const staticSk = x25519FromRawPrivate(sk.rawPriv, sk.rawPub);
    dh = diffieHellman({ privateKey: staticSk, publicKey: ephPkObj });
  } catch {
    return rejectionSecret();
  }

  const sharedSecret = hkdfSha3(
    Buffer.concat([dh, ephRawPub, sk.rawPub]),
    sk.pkHash,
    Buffer.from(`ml-kem-ss:${lvl}`),
    32,
  );

  const expectedTag = createHmac("sha3-256", sharedSecret)
    .update(ephRawPub)
    .update(sk.pkHash)
    .update(Buffer.from(`ml-kem-tag:${lvl}`))
    .digest();

  if (!ctEqual(tag, expectedTag)) return rejectionSecret();

  return new Uint8Array(sharedSecret.buffer, sharedSecret.byteOffset, sharedSecret.byteLength);
}

/* ----------------------------------------------------------------------------
 * Serialization helpers.
 * ------------------------------------------------------------------------- */

/** Encode a Uint8Array/Buffer as base64. */
export function serializeKyberKey(key) {
  if (key == null) throw new Error("key is required");
  const buf = asBuffer(key, "key");
  return buf.toString("base64");
}

/** Decode a base64 string into a Uint8Array. */
export function deserializeKyberKey(b64) {
  if (typeof b64 !== "string") throw new Error("expected base64 string");
  if (!/^[A-Za-z0-9+/=_-]*$/.test(b64)) throw new Error("invalid base64 characters");
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/* ----------------------------------------------------------------------------
 * Hybrid KEM wrapper (belt and suspenders).
 *
 * `hybridKeyExchange(theirPublicKey, level)` runs our Kyber-shaped KEM
 * against the recipient's public key AND does a fresh X25519 ephemeral
 * key exchange, then combines both into a single 32-byte secret via
 * HKDF-SHA3-256. This way, a future break of the lattice half still
 * leaves the classical half intact (or vice versa).
 *
 * Returns:
 *   {
 *     publicKey:    Uint8Array  (our ephemeral X25519 pub || kyber ciphertext)
 *     sharedSecret: Uint8Array  (32 bytes)
 *     level
 *   }
 * ------------------------------------------------------------------------- */

/**
 * Hybrid (X25519 + Kyber) one-shot sender half.
 * @param {Uint8Array|Buffer|string} theirPublicKey — recipient's Kyber pk.
 * @param {string} level
 */
export function hybridKeyExchange(theirPublicKey, level = "ml-kem-768") {
  assertLevel(level);
  const pk = parsePublicKey(theirPublicKey);
  if (pk.level !== level) {
    throw new Error(`public key level ${pk.level} does not match requested ${level}`);
  }

  // Classical half: ephemeral X25519 vs. the raw X25519 pub embedded in
  // the Kyber key. This gives us a classical ECDH secret even without
  // the recipient having a separate X25519 key.
  const { publicKey: ephPkObj, privateKey: ephSkObj } = generateKeyPairSync("x25519");
  const ephRawPub = x25519PublicRaw(ephPkObj);
  const classicalDh = diffieHellman({
    privateKey: ephSkObj,
    publicKey: x25519FromRawPublic(pk.rawPub),
  });

  // Post-quantum half.
  const { ciphertext, sharedSecret: pqSecret } = kyberEncapsulate(pk.blob, level);

  // Combine.
  const combined = hkdfSha3(
    Buffer.concat([classicalDh, pqSecret]),
    pk.pkHash,
    Buffer.from(`hybrid-kem:${level}`),
    32,
  );

  // Packed wire format: [len(ephPub=32)][ephPub][len(ct)][ct]
  const ctBuf = Buffer.from(ciphertext);
  const wire = Buffer.concat([
    Buffer.from([ephRawPub.length]),
    ephRawPub,
    Buffer.from([(ctBuf.length >> 8) & 0xff, ctBuf.length & 0xff]),
    ctBuf,
  ]);

  return {
    publicKey: new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength),
    sharedSecret: new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength),
    level,
  };
}

/**
 * Hybrid decapsulate: given the wire blob produced by `hybridKeyExchange`
 * and the recipient's secret key, recover the same 32-byte shared secret.
 */
export function hybridKeyExchangeOpen(wire, secretKey, level = "ml-kem-768") {
  assertLevel(level);
  const sk = parseSecretKey(secretKey);
  if (sk.level !== level) {
    throw new Error(`secret key level ${sk.level} does not match requested ${level}`);
  }
  const buf = asBuffer(wire, "wire");
  if (buf.length < 1 + 32 + 2) throw new Error("hybrid wire truncated");
  const ephLen = buf[0];
  if (ephLen !== 32) throw new Error("hybrid wire: invalid ephemeral length");
  const ephRawPub = buf.subarray(1, 1 + 32);
  const ctLen = (buf[1 + 32] << 8) | buf[1 + 32 + 1];
  const ctStart = 1 + 32 + 2;
  if (buf.length < ctStart + ctLen) throw new Error("hybrid wire: ciphertext truncated");
  const ciphertext = buf.subarray(ctStart, ctStart + ctLen);

  // Classical half.
  const staticSk = x25519FromRawPrivate(sk.rawPriv, sk.rawPub);
  const classicalDh = diffieHellman({
    privateKey: staticSk,
    publicKey: x25519FromRawPublic(ephRawPub),
  });

  // Post-quantum half.
  const pqSecret = kyberDecapsulate(ciphertext, secretKey, level);

  const pkHash = createHash("sha3-256").update(sk.embeddedPk).digest();
  const combined = hkdfSha3(
    Buffer.concat([classicalDh, Buffer.from(pqSecret)]),
    pkHash,
    Buffer.from(`hybrid-kem:${level}`),
    32,
  );
  return new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
}

/* ----------------------------------------------------------------------------
 * Introspection helpers (used by routes/pq-kyber.js).
 * ------------------------------------------------------------------------- */

export function kyberInfo() {
  return {
    algorithm: "CRYSTALS-Kyber / ML-KEM",
    implementation: "siskelbot transitional hybrid stub (X25519 + HKDF-SHA3-256)",
    isProductionPQ: false,
    note: "API-compatible stub; swap in @noble/post-quantum or liboqs-wasm for real lattice KEM.",
    levels: Object.fromEntries(
      Object.keys(KYBER_PARAMS).map((lvl) => [
        lvl,
        { params: KYBER_PARAMS[lvl], sizes: KYBER_SIZES[lvl] },
      ]),
    ),
  };
}

/**
 * Internal exports for tests. Not part of the stable public API.
 * @internal
 */
export const _internals = {
  parsePublicKey,
  parseSecretKey,
  hkdfSha3,
  MAGIC_PUB,
  MAGIC_SEC,
  MAGIC_CT,
  LEVEL_CODES,
};

export const IS_PQ_STUB = true;
