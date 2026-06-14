/**
 * Phase 37.4: WebAuthn/FIDO2 implementation for passwordless auth.
 *
 * Supports biometric auth (Face ID, Touch ID, Windows Hello) and hardware
 * security keys (YubiKey). Implemented with the Node crypto module only —
 * no SimpleWebAuthn or other heavy dependencies.
 *
 * Spec references:
 *   https://www.w3.org/TR/webauthn-2/
 *   https://fidoalliance.org/specs/fido-v2.1-ps-20210615/fido-client-to-authenticator-protocol-v2.1-ps-errata-20220621.html
 *
 * Supported COSE algorithms:
 *   -7  (ES256, ECDSA over P-256 with SHA-256)
 *   -257 (RS256, RSASSA-PKCS1-v1_5 with SHA-256)
 *
 * Challenges are stored in-process with a short TTL.
 */
import { createHash, createVerify, randomBytes } from "crypto";
import {
  storeCredential,
  getCredential,
  getUserCredentials,
  updateCounter,
  deleteCredential as storeDeleteCredential,
} from "./webauthn-store.js";

const DEFAULT_RP_NAME = process.env.WEBAUTHN_RP_NAME || "SiskelBot";
const DEFAULT_RP_ID = process.env.WEBAUTHN_RP_ID || "localhost";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_BYTES = 32;

// Supported COSE algorithm identifiers, in preference order.
const SUPPORTED_ALGS = [
  { type: "public-key", alg: -7 },   // ES256 (ECDSA P-256 + SHA-256)
  { type: "public-key", alg: -257 }, // RS256 (RSA PKCS1-v1_5 + SHA-256)
];

/** @type {Map<string, { challenge: string, userId: string, expiresAt: number, type: string }>} */
const challengeStore = new Map();

function pruneChallenges() {
  const now = Date.now();
  for (const [k, v] of challengeStore) {
    if (v.expiresAt < now) challengeStore.delete(k);
  }
}

function base64urlEncode(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str) {
  if (str == null) return Buffer.alloc(0);
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  return Buffer.from(s, "base64");
}

function rpIdHash(rpId = DEFAULT_RP_ID) {
  return createHash("sha256").update(rpId).digest();
}

function storeChallenge(key, challenge, userId, type) {
  pruneChallenges();
  challengeStore.set(key, {
    challenge,
    userId,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    type,
  });
}

/**
 * Consume a challenge (one-time use). Returns null if missing/expired/mismatched.
 */
function consumeChallenge(key, expected) {
  pruneChallenges();
  const row = challengeStore.get(key);
  if (!row) return null;
  challengeStore.delete(key);
  if (row.expiresAt < Date.now()) return null;
  if (expected && row.challenge !== expected) return null;
  return row;
}

export function _clearChallengesForTesting() {
  challengeStore.clear();
}

/**
 * Generate registration options for navigator.credentials.create().
 * @param {string} userId
 * @param {string} userName
 * @param {string} [displayName]
 * @param {object} [opts]
 * @returns {object} WebAuthn PublicKeyCredentialCreationOptions (base64url-encoded bytes).
 */
export function generateRegistrationOptions(userId, userName, displayName, opts = {}) {
  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required");
  }
  if (!userName || typeof userName !== "string") {
    throw new Error("userName is required");
  }

  const rpName = opts.rpName || DEFAULT_RP_NAME;
  const rpId = opts.rpId || DEFAULT_RP_ID;

  const challengeBuf = randomBytes(CHALLENGE_BYTES);
  const challenge = base64urlEncode(challengeBuf);

  // Use a hash of the userId as the binary user handle so it is stable
  // across registrations but does not leak raw identifiers.
  const userHandleBuf = createHash("sha256").update(userId).digest().subarray(0, 32);
  const userHandle = base64urlEncode(userHandleBuf);

  storeChallenge(`reg:${userId}`, challenge, userId, "registration");

  return {
    challenge,
    rp: { name: rpName, id: rpId },
    user: {
      id: userHandle,
      name: userName,
      displayName: displayName || userName,
    },
    pubKeyCredParams: SUPPORTED_ALGS,
    timeout: 60_000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials: [],
  };
}

/**
 * Parse the attestedCredentialData from an authenticatorData buffer.
 * authData layout (WebAuthn §6.1):
 *   rpIdHash (32) | flags (1) | signCount (4) | [attestedCredentialData] | [extensions]
 * attestedCredentialData:
 *   aaguid (16) | credentialIdLength (2, BE) | credentialId | credentialPublicKey (CBOR COSE_Key)
 */
function parseAuthenticatorData(authData) {
  if (!Buffer.isBuffer(authData) || authData.length < 37) {
    throw new Error("authenticatorData too short");
  }
  const rpIdHashBuf = authData.subarray(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  const result = { rpIdHash: rpIdHashBuf, flags, signCount };
  const flagUP = (flags & 0x01) !== 0;
  const flagUV = (flags & 0x04) !== 0;
  const flagAT = (flags & 0x40) !== 0;
  result.userPresent = flagUP;
  result.userVerified = flagUV;
  result.attestedCredentialDataIncluded = flagAT;

  if (flagAT) {
    if (authData.length < 55) throw new Error("attestedCredentialData truncated");
    const aaguid = authData.subarray(37, 53);
    const credIdLen = authData.readUInt16BE(53);
    const credIdEnd = 55 + credIdLen;
    if (authData.length < credIdEnd) throw new Error("credentialId truncated");
    const credentialId = authData.subarray(55, credIdEnd);
    const publicKeyCose = authData.subarray(credIdEnd);
    result.aaguid = aaguid;
    result.credentialId = credentialId;
    result.publicKeyCose = publicKeyCose;
  }
  return result;
}

/**
 * Verify a registration response from navigator.credentials.create().
 * @param {object} credential - response from the browser (base64url strings).
 * @param {string} expectedChallenge
 * @param {string} expectedOrigin
 * @param {object} [opts]
 * @returns {Promise<{ verified: boolean, credentialId?: string, publicKey?: string, counter?: number, error?: string }>}
 */
export async function verifyRegistration(credential, expectedChallenge, expectedOrigin, opts = {}) {
  try {
    if (!credential || !credential.response) {
      return { verified: false, error: "missing credential response" };
    }
    const clientDataJSON = base64urlDecode(credential.response.clientDataJSON).toString("utf8");
    const clientData = JSON.parse(clientDataJSON);

    if (clientData.type !== "webauthn.create") {
      return { verified: false, error: `unexpected clientData.type ${clientData.type}` };
    }
    if (expectedChallenge && clientData.challenge !== expectedChallenge) {
      return { verified: false, error: "challenge mismatch" };
    }
    if (expectedOrigin && clientData.origin !== expectedOrigin) {
      return { verified: false, error: "origin mismatch" };
    }

    const authData = base64urlDecode(credential.response.authenticatorData
      || credential.response.attestationObject && null
      || "");

    // Most browser responses wrap authData inside attestationObject (CBOR).
    // We support either: flat authenticatorData OR extracted from attestationObject
    // via opts.authenticatorData. For attestation "none" we don't need to
    // parse the attestation statement itself.
    let parsedAuth;
    if (authData.length > 0) {
      parsedAuth = parseAuthenticatorData(authData);
    } else if (opts.authenticatorData) {
      parsedAuth = parseAuthenticatorData(base64urlDecode(opts.authenticatorData));
    } else {
      return { verified: false, error: "authenticatorData missing (attestationObject parsing not implemented)" };
    }

    if (!parsedAuth.userPresent) {
      return { verified: false, error: "user not present" };
    }
    if (!parsedAuth.attestedCredentialDataIncluded || !parsedAuth.credentialId) {
      return { verified: false, error: "attested credential data missing" };
    }

    const rpId = opts.rpId || DEFAULT_RP_ID;
    const expectedRpIdHash = rpIdHash(rpId);
    if (!parsedAuth.rpIdHash.equals(expectedRpIdHash)) {
      return { verified: false, error: "rpIdHash mismatch" };
    }

    const credentialId = base64urlEncode(parsedAuth.credentialId);
    const publicKey = base64urlEncode(parsedAuth.publicKeyCose);
    return {
      verified: true,
      credentialId,
      publicKey,
      counter: parsedAuth.signCount,
    };
  } catch (err) {
    return { verified: false, error: err.message };
  }
}

/**
 * Generate authentication options for navigator.credentials.get().
 * @param {string} userId
 * @param {Array<{ id: string, transports?: string[] }>} [allowCredentials]
 * @param {object} [opts]
 */
export function generateAuthenticationOptions(userId, allowCredentials = [], opts = {}) {
  const rpId = opts.rpId || DEFAULT_RP_ID;
  const challengeBuf = randomBytes(CHALLENGE_BYTES);
  const challenge = base64urlEncode(challengeBuf);

  const key = userId ? `auth:${userId}` : `auth:__anon__:${challenge}`;
  storeChallenge(key, challenge, userId || null, "authentication");

  return {
    challenge,
    rpId,
    timeout: 60_000,
    userVerification: "preferred",
    allowCredentials: (allowCredentials || []).map((c) => ({
      id: c.id,
      type: "public-key",
      transports: c.transports || ["internal", "usb", "nfc", "ble"],
    })),
  };
}

/**
 * Minimal COSE_Key → public key extraction. We only need enough to verify
 * ES256 (P-256 ECDSA) and RS256 (RSA) signatures. CBOR here is hand-parsed
 * to avoid a dependency — we only support the small subset of CBOR that
 * WebAuthn COSE keys use (small ints, small byte strings, maps).
 */
function parseCoseKey(buf) {
  // Very small CBOR parser scoped to WebAuthn COSE_Key structures.
  let offset = 0;
  function readType() {
    const b = buf[offset++];
    const major = b >> 5;
    const info = b & 0x1f;
    return { major, info };
  }
  function readLen(info) {
    if (info < 24) return info;
    if (info === 24) { const v = buf[offset]; offset += 1; return v; }
    if (info === 25) { const v = buf.readUInt16BE(offset); offset += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(offset); offset += 4; return v; }
    throw new Error("CBOR length not supported: " + info);
  }
  function readValue() {
    const { major, info } = readType();
    if (major === 0) return readLen(info); // unsigned int
    if (major === 1) return -1 - readLen(info); // negative int
    if (major === 2) { const n = readLen(info); const v = buf.subarray(offset, offset + n); offset += n; return v; } // bytes
    if (major === 3) { const n = readLen(info); const v = buf.subarray(offset, offset + n).toString("utf8"); offset += n; return v; } // text
    if (major === 5) { // map
      const n = readLen(info);
      const m = new Map();
      for (let i = 0; i < n; i++) {
        const k = readValue();
        const v = readValue();
        m.set(k, v);
      }
      return m;
    }
    throw new Error("CBOR major type not supported: " + major);
  }
  const m = readValue();
  if (!(m instanceof Map)) throw new Error("COSE key must be a map");
  const kty = m.get(1);
  const alg = m.get(3);
  if (kty === 2) {
    // EC2 (kty=2). Needs crv(-1), x(-2), y(-3).
    return {
      kty: "EC2",
      alg,
      crv: m.get(-1),
      x: m.get(-2),
      y: m.get(-3),
    };
  }
  if (kty === 3) {
    // RSA (kty=3). Needs n(-1), e(-2).
    return { kty: "RSA", alg, n: m.get(-1), e: m.get(-2) };
  }
  throw new Error("COSE kty not supported: " + kty);
}

/**
 * Build an SPKI DER blob for an EC P-256 public key. Required so Node's
 * crypto.createPublicKey({ key, format: 'der', type: 'spki' }) can load it.
 */
function ec256PublicKeyToSpki(x, y) {
  // SPKI header for id-ecPublicKey + secp256r1 named curve + BIT STRING (04||X||Y)
  const header = Buffer.from(
    "3059301306072a8648ce3d020106082a8648ce3d03010703420004",
    "hex",
  );
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error("EC coordinates missing");
  return Buffer.concat([header, x, y]);
}

/**
 * Build an SPKI DER blob for an RSA public key from modulus (n) and exponent (e).
 */
function rsaPublicKeyToSpki(nBuf, eBuf) {
  // Strip leading zeros from modulus where appropriate and ensure positive sign byte.
  function encodeLength(len) {
    if (len < 0x80) return Buffer.from([len]);
    const bytes = [];
    let tmp = len;
    while (tmp > 0) { bytes.unshift(tmp & 0xff); tmp >>= 8; }
    return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
  }
  function encodeInteger(buf) {
    let b = buf;
    // Ensure positive: prepend 0x00 if the high bit is set.
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return Buffer.concat([Buffer.from([0x02]), encodeLength(b.length), b]);
  }
  const n = encodeInteger(nBuf);
  const e = encodeInteger(eBuf);
  const rsaKey = Buffer.concat([Buffer.from([0x30]), encodeLength(n.length + e.length), n, e]);
  const bitString = Buffer.concat([Buffer.from([0x03]), encodeLength(rsaKey.length + 1), Buffer.from([0x00]), rsaKey]);
  const algId = Buffer.from("300d06092a864886f70d0101010500", "hex"); // rsaEncryption NULL
  const spkiBody = Buffer.concat([algId, bitString]);
  return Buffer.concat([Buffer.from([0x30]), encodeLength(spkiBody.length), spkiBody]);
}

/**
 * DER-encode an ECDSA (r,s) signature from raw 64-byte (P-256) form.
 * Node's crypto.verify for ECDSA expects DER by default.
 */
function rawEcdsaToDer(sig) {
  if (sig.length !== 64) return sig; // already DER or unknown form
  const r = sig.subarray(0, 32);
  const s = sig.subarray(32, 64);
  function trim(buf) {
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) i++;
    let t = buf.subarray(i);
    if (t[0] & 0x80) t = Buffer.concat([Buffer.from([0x00]), t]);
    return t;
  }
  const rT = trim(r);
  const sT = trim(s);
  const body = Buffer.concat([
    Buffer.from([0x02, rT.length]), rT,
    Buffer.from([0x02, sT.length]), sT,
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Verify an authentication (login) response.
 * @param {object} credential - response from navigator.credentials.get().
 * @param {string} expectedChallenge
 * @param {{ publicKey: string, counter: number }} credentialData - stored credential.
 * @param {object} [opts]
 * @returns {Promise<{ verified: boolean, newCounter?: number, error?: string }>}
 */
export async function verifyAuthentication(credential, expectedChallenge, credentialData, opts = {}) {
  try {
    if (!credential || !credential.response) {
      return { verified: false, error: "missing credential response" };
    }
    if (!credentialData || !credentialData.publicKey) {
      return { verified: false, error: "credential public key missing" };
    }

    const clientDataJSONBuf = base64urlDecode(credential.response.clientDataJSON);
    const clientData = JSON.parse(clientDataJSONBuf.toString("utf8"));

    if (clientData.type !== "webauthn.get") {
      return { verified: false, error: `unexpected clientData.type ${clientData.type}` };
    }
    if (expectedChallenge && clientData.challenge !== expectedChallenge) {
      return { verified: false, error: "challenge mismatch" };
    }
    if (opts.expectedOrigin && clientData.origin !== opts.expectedOrigin) {
      return { verified: false, error: "origin mismatch" };
    }

    const authDataBuf = base64urlDecode(credential.response.authenticatorData);
    const parsedAuth = parseAuthenticatorData(authDataBuf);
    if (!parsedAuth.userPresent) {
      return { verified: false, error: "user not present" };
    }

    const rpId = opts.rpId || DEFAULT_RP_ID;
    if (!parsedAuth.rpIdHash.equals(rpIdHash(rpId))) {
      return { verified: false, error: "rpIdHash mismatch" };
    }

    // Replay protection: signCount must be strictly greater than the stored counter,
    // unless both are 0 (which indicates the authenticator doesn't maintain a counter).
    if (parsedAuth.signCount !== 0 || (credentialData.counter || 0) !== 0) {
      if (parsedAuth.signCount <= (credentialData.counter || 0)) {
        return { verified: false, error: "signature counter did not increase (possible replay)" };
      }
    }

    const clientDataHash = createHash("sha256").update(clientDataJSONBuf).digest();
    const signedData = Buffer.concat([authDataBuf, clientDataHash]);

    const coseBuf = base64urlDecode(credentialData.publicKey);
    const cose = parseCoseKey(coseBuf);

    const sigBuf = base64urlDecode(credential.response.signature);

    let verified = false;
    if (cose.kty === "EC2" && cose.alg === -7) {
      const spki = ec256PublicKeyToSpki(cose.x, cose.y);
      const verifier = createVerify("sha256");
      verifier.update(signedData);
      verifier.end();
      const derSig = sigBuf.length === 64 ? rawEcdsaToDer(sigBuf) : sigBuf;
      verified = verifier.verify({ key: spki, format: "der", type: "spki" }, derSig);
    } else if (cose.kty === "RSA" && cose.alg === -257) {
      const spki = rsaPublicKeyToSpki(cose.n, cose.e);
      const verifier = createVerify("RSA-SHA256");
      verifier.update(signedData);
      verifier.end();
      verified = verifier.verify({ key: spki, format: "der", type: "spki" }, sigBuf);
    } else {
      return { verified: false, error: `unsupported COSE kty/alg ${cose.kty}/${cose.alg}` };
    }

    if (!verified) return { verified: false, error: "signature verification failed" };
    return { verified: true, newCounter: parsedAuth.signCount };
  } catch (err) {
    return { verified: false, error: err.message };
  }
}

/** List credentials registered for a user. */
export async function listUserCredentials(userId) {
  return getUserCredentials(userId);
}

/** Delete a credential owned by the given user. Returns { ok, error? }. */
export async function deleteCredential(userId, credentialId) {
  const cred = await getCredential(credentialId);
  if (!cred) return { ok: false, error: "credential not found" };
  if (cred.userId !== userId) return { ok: false, error: "credential does not belong to user" };
  await storeDeleteCredential(credentialId);
  return { ok: true };
}

/**
 * Internal helpers exposed for routes/tests.
 */
export const _internals = {
  base64urlEncode,
  base64urlDecode,
  parseAuthenticatorData,
  parseCoseKey,
  storeChallenge,
  consumeChallenge,
  rpIdHash,
};

/** Persist a verified credential for a user. Used by the register/verify route. */
export async function persistVerifiedCredential(userId, { credentialId, publicKey, counter, transports }) {
  return storeCredential(userId, {
    credentialId,
    publicKey,
    counter: counter || 0,
    transports: transports || [],
  });
}

/**
 * Look up a stored credential by its ID (base64url-encoded).
 */
export async function findCredential(credentialId) {
  return getCredential(credentialId);
}

/**
 * Record a successful authentication by bumping the stored counter.
 */
export async function recordAuthentication(credentialId, newCounter) {
  return updateCounter(credentialId, newCounter);
}
