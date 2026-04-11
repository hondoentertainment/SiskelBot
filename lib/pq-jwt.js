/**
 * Phase 50.4: Post-quantum JWT signing.
 *
 * Signs and verifies JWTs using ML-DSA (Dilithium) post-quantum signatures
 * when `./pq-dilithium.js` is available, and transparently falls back to
 * Node's native Ed25519 (EdDSA) when the PQ module is not present.
 *
 * Supported JWT `alg` identifiers: "ML-DSA-44", "ML-DSA-65", "ML-DSA-87".
 * These are registered as the canonical algorithm names used in JWS headers;
 * the fallback Ed25519 implementation still publishes them with the PQ
 * identifier so callers can migrate the key material without rewriting
 * tokens.
 *
 * The module intentionally does not depend on any third-party JWT library.
 * It provides the minimum needed for a compact JWS: sign, verify, decode,
 * and JWK import/export, plus keypair generation.
 *
 * @module pq-jwt
 */
import crypto from "node:crypto";

export const PQ_ALGORITHMS = ["ML-DSA-44", "ML-DSA-65", "ML-DSA-87"];
export const DEFAULT_PQ_ALGORITHM = "ML-DSA-65";

let pqBackendPromise = null;
let pqBackendWarned = false;

/**
 * Lazily import the dilithium backend. If the module does not exist we
 * cache a fallback stub that signals "use Ed25519 instead".
 * @returns {Promise<{ available: boolean, sign?: Function, verify?: Function, generateKeyPair?: Function }>}
 */
async function loadPqBackend() {
  if (pqBackendPromise) return pqBackendPromise;
  pqBackendPromise = (async () => {
    try {
      const mod = await import("./pq-dilithium.js");
      if (
        mod &&
        typeof mod.signDilithium === "function" &&
        typeof mod.verifyDilithium === "function" &&
        typeof mod.generateDilithiumKeyPair === "function"
      ) {
        return {
          available: true,
          sign: mod.signDilithium,
          verify: mod.verifyDilithium,
          generateKeyPair: mod.generateDilithiumKeyPair,
        };
      }
    } catch (_err) {
      // Fall through to stub.
    }
    if (!pqBackendWarned) {
      pqBackendWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[pq-jwt] lib/pq-dilithium.js not available; falling back to Ed25519 for ML-DSA signatures",
      );
    }
    return { available: false };
  })();
  return pqBackendPromise;
}

// --- Base64URL helpers ---------------------------------------------------

function base64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input) {
  if (typeof input !== "string") throw new Error("base64url input must be a string");
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64");
}

function base64urlEncodeJson(obj) {
  return base64urlEncode(Buffer.from(JSON.stringify(obj), "utf8"));
}

function base64urlDecodeJson(input) {
  const raw = base64urlDecode(input).toString("utf8");
  return JSON.parse(raw);
}

// --- Algorithm helpers ---------------------------------------------------

function assertPqAlgorithm(alg) {
  if (!PQ_ALGORITHMS.includes(alg)) {
    throw new Error(`unsupported pq algorithm: ${alg}`);
  }
}

/**
 * Create a fallback Ed25519 keypair. Returns raw 32-byte public / 32-byte
 * secret key buffers so callers don't have to know about KeyObject.
 */
function generateEd25519KeyPairRaw() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  const pub = base64urlDecode(pubJwk.x);
  const priv = base64urlDecode(privJwk.d);
  return { publicKey: pub, secretKey: priv };
}

function ed25519SignRaw(secretKey, data) {
  const priv = Buffer.isBuffer(secretKey) ? secretKey : Buffer.from(secretKey);
  if (priv.length !== 32) {
    throw new Error("ed25519 secret key must be 32 bytes");
  }
  const jwk = {
    kty: "OKP",
    crv: "Ed25519",
    d: base64urlEncode(priv),
    x: base64urlEncode(derivePublicFromPrivateEd25519(priv)),
  };
  const keyObj = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  return crypto.sign(null, Buffer.from(data), keyObj);
}

function ed25519VerifyRaw(publicKey, data, signature) {
  const pub = Buffer.isBuffer(publicKey) ? publicKey : Buffer.from(publicKey);
  if (pub.length !== 32) return false;
  const jwk = { kty: "OKP", crv: "Ed25519", x: base64urlEncode(pub) };
  try {
    const keyObj = crypto.createPublicKey({ key: jwk, format: "jwk" });
    return crypto.verify(null, Buffer.from(data), keyObj, Buffer.from(signature));
  } catch (_err) {
    return false;
  }
}

function derivePublicFromPrivateEd25519(priv) {
  // Node does not expose ed25519 public derivation directly from a raw
  // scalar. Instead we reconstruct by creating a key pair from the seed
  // via jwk containing only the `d` coordinate — that is not supported
  // by Node's JWK import without `x`. As a workaround, we generate a fresh
  // KeyObject by round-tripping through the pkcs8 DER format.
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    priv,
  ]);
  const keyObj = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pubJwk = crypto.createPublicKey(keyObj).export({ format: "jwk" });
  return base64urlDecode(pubJwk.x);
}

// --- Core sign/verify ----------------------------------------------------

function normalizeKey(key) {
  if (Buffer.isBuffer(key)) return key;
  if (key instanceof Uint8Array) return Buffer.from(key);
  if (typeof key === "string") return base64urlDecode(key);
  if (key && typeof key === "object" && typeof key.key === "string") {
    return base64urlDecode(key.key);
  }
  throw new Error("key must be a Buffer, Uint8Array, or base64url string");
}

async function signRaw(algorithm, secretKey, data) {
  assertPqAlgorithm(algorithm);
  const backend = await loadPqBackend();
  const sk = normalizeKey(secretKey);
  if (backend.available) {
    return await backend.sign(algorithm, sk, Buffer.from(data));
  }
  return ed25519SignRaw(sk, data);
}

async function verifyRaw(algorithm, publicKey, data, signature) {
  assertPqAlgorithm(algorithm);
  const backend = await loadPqBackend();
  const pk = normalizeKey(publicKey);
  if (backend.available) {
    try {
      return await backend.verify(algorithm, pk, Buffer.from(data), Buffer.from(signature));
    } catch (_err) {
      return false;
    }
  }
  return ed25519VerifyRaw(pk, data, signature);
}

/**
 * Generate a new PQ JWT keypair. Output keys are base64url-encoded strings.
 * @param {string} algorithm one of PQ_ALGORITHMS
 * @returns {Promise<{ publicKey: string, secretKey: string, kid: string, algorithm: string }>}
 */
export async function generatePqJwtKey(algorithm = DEFAULT_PQ_ALGORITHM) {
  assertPqAlgorithm(algorithm);
  const backend = await loadPqBackend();
  let publicKey;
  let secretKey;
  if (backend.available) {
    const pair = await backend.generateKeyPair(algorithm);
    publicKey = Buffer.isBuffer(pair.publicKey) ? pair.publicKey : Buffer.from(pair.publicKey);
    secretKey = Buffer.isBuffer(pair.secretKey) ? pair.secretKey : Buffer.from(pair.secretKey);
  } else {
    const pair = generateEd25519KeyPairRaw();
    publicKey = pair.publicKey;
    secretKey = pair.secretKey;
  }
  const kid = base64urlEncode(crypto.randomBytes(12));
  return {
    algorithm,
    publicKey: base64urlEncode(publicKey),
    secretKey: base64urlEncode(secretKey),
    kid,
  };
}

// --- JWT sign/verify/decode ---------------------------------------------

function toNumericDate(value, nowSec) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const match = value.match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
    if (match) {
      const n = parseInt(match[1], 10);
      const unit = (match[2] || "s").toLowerCase();
      const mult = unit === "ms" ? 0.001 : unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
      return nowSec + Math.floor(n * mult);
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  throw new Error(`invalid time value: ${value}`);
}

/**
 * Sign a JWT payload with a PQ algorithm.
 * @param {object} payload
 * @param {Buffer|Uint8Array|string} secretKey
 * @param {object} [options]
 * @returns {Promise<string>} compact JWS token
 */
export async function signPqJwt(payload, secretKey, options = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("payload must be an object");
  }
  const algorithm = options.algorithm || DEFAULT_PQ_ALGORITHM;
  assertPqAlgorithm(algorithm);

  const nowSec = Math.floor(Date.now() / 1000);
  const body = { ...payload };
  if (options.issuer) body.iss = options.issuer;
  if (options.subject) body.sub = options.subject;
  if (options.audience) body.aud = options.audience;
  if (body.iat == null) body.iat = nowSec;
  if (options.notBefore != null) {
    const nbf = toNumericDate(options.notBefore, nowSec);
    if (nbf != null) body.nbf = nbf;
  }
  if (options.expiresIn != null) {
    const exp = toNumericDate(options.expiresIn, nowSec);
    if (exp != null) body.exp = exp;
  }

  const header = { alg: algorithm, typ: "JWT" };
  if (options.kid) header.kid = options.kid;

  const headerB64 = base64urlEncodeJson(header);
  const payloadB64 = base64urlEncodeJson(body);
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await signRaw(algorithm, secretKey, signingInput);
  const signatureB64 = base64urlEncode(signature);
  return `${signingInput}.${signatureB64}`;
}

/**
 * Decode a JWT (header + payload) without verifying the signature.
 * @param {string} token
 * @returns {{ header: object, payload: object, signature: Buffer }}
 */
export function decodePqJwt(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("token must be a non-empty string");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed jwt: expected 3 segments");
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  let header;
  let payload;
  try {
    header = base64urlDecodeJson(headerB64);
  } catch (_err) {
    throw new Error("malformed jwt: invalid header");
  }
  try {
    payload = base64urlDecodeJson(payloadB64);
  } catch (_err) {
    throw new Error("malformed jwt: invalid payload");
  }
  const signature = base64urlDecode(signatureB64);
  return { header, payload, signature };
}

/**
 * Verify a compact JWS token and return the decoded payload on success.
 * @param {string} token
 * @param {Buffer|Uint8Array|string} publicKey
 * @param {object} [options]
 * @returns {Promise<object>} verified payload
 */
export async function verifyPqJwt(token, publicKey, options = {}) {
  const decoded = decodePqJwt(token);
  const { header, payload } = decoded;

  const alg = header?.alg;
  if (typeof alg !== "string" || alg.length === 0) {
    throw new Error("jwt missing alg header");
  }
  const allowed = Array.isArray(options.algorithms) && options.algorithms.length > 0
    ? options.algorithms
    : PQ_ALGORITHMS;
  if (!allowed.includes(alg)) {
    throw new Error(`alg "${alg}" not allowed`);
  }
  if (!PQ_ALGORITHMS.includes(alg)) {
    throw new Error(`unsupported pq algorithm: ${alg}`);
  }

  const parts = token.split(".");
  const signingInput = `${parts[0]}.${parts[1]}`;
  const ok = await verifyRaw(alg, publicKey, signingInput, decoded.signature);
  if (!ok) {
    throw new Error("signature verification failed");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const tolerance = Number.isFinite(options.clockTolerance) ? Math.max(0, options.clockTolerance) : 0;

  if (payload.nbf != null) {
    if (typeof payload.nbf !== "number") throw new Error("invalid nbf claim");
    if (nowSec + tolerance < payload.nbf) {
      throw new Error("jwt not active yet");
    }
  }
  if (payload.exp != null) {
    if (typeof payload.exp !== "number") throw new Error("invalid exp claim");
    if (nowSec - tolerance >= payload.exp) {
      throw new Error("jwt expired");
    }
  }
  if (options.maxAge != null) {
    if (typeof payload.iat !== "number") {
      throw new Error("maxAge requires iat claim");
    }
    const maxAgeSec = toNumericDate(options.maxAge, 0);
    if (nowSec - tolerance - payload.iat >= maxAgeSec) {
      throw new Error("jwt exceeds maxAge");
    }
  }
  if (options.audience != null) {
    const expected = Array.isArray(options.audience) ? options.audience : [options.audience];
    const actual = Array.isArray(payload.aud) ? payload.aud : payload.aud != null ? [payload.aud] : [];
    const hit = expected.some((a) => actual.includes(a));
    if (!hit) throw new Error("audience mismatch");
  }
  if (options.issuer != null) {
    const expected = Array.isArray(options.issuer) ? options.issuer : [options.issuer];
    if (!expected.includes(payload.iss)) throw new Error("issuer mismatch");
  }
  if (options.subject != null && payload.sub !== options.subject) {
    throw new Error("subject mismatch");
  }

  return payload;
}

// --- JWK support ---------------------------------------------------------

/**
 * Export a PQ key to a JWK-like object. The `kty` is "PQ" which is not a
 * registered IANA key type but is used here to mark post-quantum material.
 * @param {Buffer|Uint8Array|string} key the raw key bytes
 * @param {string} algorithm the ML-DSA algorithm name
 * @param {string} [kid]
 * @returns {object} JWK
 */
export function exportPqJwk(key, algorithm, kid) {
  assertPqAlgorithm(algorithm);
  const raw = normalizeKey(key);
  const jwk = {
    kty: "PQ",
    alg: algorithm,
    crv: algorithm,
    x: base64urlEncode(raw),
  };
  if (kid) jwk.kid = kid;
  return jwk;
}

/**
 * Import a JWK produced by `exportPqJwk`.
 * @param {object} jwk
 * @returns {{ key: Buffer, algorithm: string, kid?: string }}
 */
export function importPqJwk(jwk) {
  if (!jwk || typeof jwk !== "object") {
    throw new Error("jwk must be an object");
  }
  if (jwk.kty !== "PQ") {
    throw new Error(`unsupported jwk kty: ${jwk.kty}`);
  }
  const algorithm = jwk.alg || jwk.crv;
  assertPqAlgorithm(algorithm);
  if (typeof jwk.x !== "string") {
    throw new Error("jwk missing x coordinate");
  }
  return {
    key: base64urlDecode(jwk.x),
    algorithm,
    kid: typeof jwk.kid === "string" ? jwk.kid : undefined,
  };
}

// --- Test helpers --------------------------------------------------------

export const _internals = {
  base64urlEncode,
  base64urlDecode,
  loadPqBackend,
  toNumericDate,
};

export default {
  PQ_ALGORITHMS,
  DEFAULT_PQ_ALGORITHM,
  signPqJwt,
  verifyPqJwt,
  decodePqJwt,
  generatePqJwtKey,
  exportPqJwk,
  importPqJwk,
};
