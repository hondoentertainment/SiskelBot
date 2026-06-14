/**
 * Phase 50.1: CRYSTALS-Kyber (ML-KEM) quantum-resistant KEM tests.
 *
 * Exercises the transitional hybrid stub in `lib/pq-kyber.js`: key generation
 * for all three parameter sets, serialization roundtrips, end-to-end
 * encapsulate/decapsulate, implicit rejection on tampering, hybrid KEM,
 * and input validation.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  KYBER_PARAMS,
  KYBER_SIZES,
  generateKyberKeyPair,
  kyberEncapsulate,
  kyberDecapsulate,
  serializeKyberKey,
  deserializeKyberKey,
  hybridKeyExchange,
  hybridKeyExchangeOpen,
  kyberInfo,
} from "../lib/pq-kyber.js";

const LEVELS = ["ml-kem-512", "ml-kem-768", "ml-kem-1024"];

test("KYBER_PARAMS exposes all three standard parameter sets", () => {
  for (const level of LEVELS) {
    const p = KYBER_PARAMS[level];
    assert.ok(p, `missing params for ${level}`);
    assert.equal(p.n, 256);
    assert.equal(p.q, 3329);
    assert.ok(p.k >= 2 && p.k <= 4);
  }
});

test("generateKyberKeyPair produces correctly sized keys for each level", () => {
  for (const level of LEVELS) {
    const { publicKey, secretKey, level: outLevel } = generateKyberKeyPair(level);
    assert.equal(outLevel, level);
    assert.ok(publicKey instanceof Uint8Array);
    assert.ok(secretKey instanceof Uint8Array);
    assert.equal(publicKey.length, KYBER_SIZES[level].publicKey);
    assert.equal(secretKey.length, KYBER_SIZES[level].secretKey);
  }
});

test("two successive key generations produce distinct keys", () => {
  const a = generateKyberKeyPair("ml-kem-768");
  const b = generateKyberKeyPair("ml-kem-768");
  assert.notEqual(
    Buffer.from(a.publicKey).toString("hex"),
    Buffer.from(b.publicKey).toString("hex"),
  );
  assert.notEqual(
    Buffer.from(a.secretKey).toString("hex"),
    Buffer.from(b.secretKey).toString("hex"),
  );
});

test("serializeKyberKey/deserializeKyberKey roundtrip preserves bytes", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const pkB64 = serializeKyberKey(kp.publicKey);
  const skB64 = serializeKyberKey(kp.secretKey);
  assert.equal(typeof pkB64, "string");
  assert.equal(typeof skB64, "string");
  const pk2 = deserializeKyberKey(pkB64);
  const sk2 = deserializeKyberKey(skB64);
  assert.deepEqual(Buffer.from(pk2), Buffer.from(kp.publicKey));
  assert.deepEqual(Buffer.from(sk2), Buffer.from(kp.secretKey));
});

test("encapsulate -> decapsulate yields matching shared secret (ml-kem-512)", () => {
  const kp = generateKyberKeyPair("ml-kem-512");
  const { ciphertext, sharedSecret } = kyberEncapsulate(kp.publicKey, "ml-kem-512");
  assert.equal(sharedSecret.length, 32);
  assert.equal(ciphertext.length, KYBER_SIZES["ml-kem-512"].ciphertext);
  const recovered = kyberDecapsulate(ciphertext, kp.secretKey, "ml-kem-512");
  assert.equal(recovered.length, 32);
  assert.deepEqual(Buffer.from(recovered), Buffer.from(sharedSecret));
});

test("encapsulate -> decapsulate yields matching shared secret (ml-kem-768)", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const { ciphertext, sharedSecret } = kyberEncapsulate(kp.publicKey);
  const recovered = kyberDecapsulate(ciphertext, kp.secretKey);
  assert.deepEqual(Buffer.from(recovered), Buffer.from(sharedSecret));
});

test("encapsulate -> decapsulate yields matching shared secret (ml-kem-1024)", () => {
  const kp = generateKyberKeyPair("ml-kem-1024");
  const { ciphertext, sharedSecret } = kyberEncapsulate(kp.publicKey, "ml-kem-1024");
  const recovered = kyberDecapsulate(ciphertext, kp.secretKey, "ml-kem-1024");
  assert.deepEqual(Buffer.from(recovered), Buffer.from(sharedSecret));
});

test("encapsulate omits level argument and infers from key", () => {
  const kp = generateKyberKeyPair("ml-kem-1024");
  const { ciphertext, sharedSecret, level } = kyberEncapsulate(kp.publicKey);
  assert.equal(level, "ml-kem-1024");
  const recovered = kyberDecapsulate(ciphertext, kp.secretKey);
  assert.deepEqual(Buffer.from(recovered), Buffer.from(sharedSecret));
});

test("different recipients produce different shared secrets", () => {
  const a = generateKyberKeyPair("ml-kem-768");
  const b = generateKyberKeyPair("ml-kem-768");
  const encA = kyberEncapsulate(a.publicKey);
  const encB = kyberEncapsulate(b.publicKey);
  assert.notEqual(
    Buffer.from(encA.sharedSecret).toString("hex"),
    Buffer.from(encB.sharedSecret).toString("hex"),
  );
});

test("two successive encapsulations to the same key differ (ephemeral randomness)", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const e1 = kyberEncapsulate(kp.publicKey);
  const e2 = kyberEncapsulate(kp.publicKey);
  assert.notEqual(
    Buffer.from(e1.ciphertext).toString("hex"),
    Buffer.from(e2.ciphertext).toString("hex"),
  );
  assert.notEqual(
    Buffer.from(e1.sharedSecret).toString("hex"),
    Buffer.from(e2.sharedSecret).toString("hex"),
  );
  // And both still decap correctly.
  assert.deepEqual(
    Buffer.from(kyberDecapsulate(e1.ciphertext, kp.secretKey)),
    Buffer.from(e1.sharedSecret),
  );
  assert.deepEqual(
    Buffer.from(kyberDecapsulate(e2.ciphertext, kp.secretKey)),
    Buffer.from(e2.sharedSecret),
  );
});

test("tampered ciphertext produces a different (rejection) secret", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const { ciphertext, sharedSecret } = kyberEncapsulate(kp.publicKey);
  const tampered = Buffer.from(ciphertext);
  // Flip a byte in the ephemeral-public region (index ~10).
  tampered[10] ^= 0xff;
  const recovered = kyberDecapsulate(tampered, kp.secretKey);
  assert.equal(recovered.length, 32);
  assert.notDeepEqual(Buffer.from(recovered), Buffer.from(sharedSecret));
});

test("ciphertext with wrong magic decapsulates to rejection secret (no throw)", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const { ciphertext, sharedSecret } = kyberEncapsulate(kp.publicKey);
  const broken = Buffer.from(ciphertext);
  broken[0] ^= 0xff; // break magic header
  const recovered = kyberDecapsulate(broken, kp.secretKey);
  assert.equal(recovered.length, 32);
  assert.notDeepEqual(Buffer.from(recovered), Buffer.from(sharedSecret));
});

test("tampered ciphertext is detected deterministically (same tamper -> same rejection)", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const { ciphertext } = kyberEncapsulate(kp.publicKey);
  const tampered = Buffer.from(ciphertext);
  tampered[50] ^= 0x01;
  const r1 = kyberDecapsulate(tampered, kp.secretKey);
  const r2 = kyberDecapsulate(tampered, kp.secretKey);
  assert.deepEqual(Buffer.from(r1), Buffer.from(r2));
});

test("decapsulating with the wrong secret key produces a non-matching secret", () => {
  const alice = generateKyberKeyPair("ml-kem-768");
  const mallory = generateKyberKeyPair("ml-kem-768");
  const { ciphertext, sharedSecret } = kyberEncapsulate(alice.publicKey);
  const wrong = kyberDecapsulate(ciphertext, mallory.secretKey);
  assert.notDeepEqual(Buffer.from(wrong), Buffer.from(sharedSecret));
});

test("hybridKeyExchange produces a 32-byte shared secret and opens correctly", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const { publicKey, sharedSecret, level } = hybridKeyExchange(kp.publicKey);
  assert.equal(level, "ml-kem-768");
  assert.equal(sharedSecret.length, 32);
  assert.ok(publicKey.length > 32, "hybrid wire should contain eph pub + ct");
  const opened = hybridKeyExchangeOpen(publicKey, kp.secretKey, "ml-kem-768");
  assert.deepEqual(Buffer.from(opened), Buffer.from(sharedSecret));
});

test("hybridKeyExchange works for all three levels", () => {
  for (const level of LEVELS) {
    const kp = generateKyberKeyPair(level);
    const h = hybridKeyExchange(kp.publicKey, level);
    const opened = hybridKeyExchangeOpen(h.publicKey, kp.secretKey, level);
    assert.equal(h.sharedSecret.length, 32);
    assert.deepEqual(Buffer.from(opened), Buffer.from(h.sharedSecret));
  }
});

test("invalid level name is rejected with a clear error", () => {
  assert.throws(() => generateKyberKeyPair("kyber-999"), /invalid ML-KEM level/);
  assert.throws(() => generateKyberKeyPair(""), /invalid ML-KEM level/);
  assert.throws(() => generateKyberKeyPair(null), /invalid ML-KEM level/);
});

test("encapsulate rejects mismatched level argument", () => {
  const kp = generateKyberKeyPair("ml-kem-512");
  assert.throws(() => kyberEncapsulate(kp.publicKey, "ml-kem-1024"), /level mismatch/);
});

test("decapsulate rejects ciphertext whose length is wrong for the key", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const tooShort = new Uint8Array(10);
  assert.throws(() => kyberDecapsulate(tooShort, kp.secretKey), /ciphertext length/);
});

test("parsePublicKey rejects a key with mangled magic header", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const broken = Buffer.from(kp.publicKey);
  broken[0] = 0x00;
  assert.throws(() => kyberEncapsulate(broken), /invalid magic header/);
});

test("parseSecretKey rejects a key whose length does not match level", () => {
  const kp = generateKyberKeyPair("ml-kem-768");
  const truncated = Buffer.from(kp.secretKey).subarray(0, kp.secretKey.length - 5);
  const { ciphertext } = kyberEncapsulate(kp.publicKey);
  assert.throws(() => kyberDecapsulate(ciphertext, truncated), /secretKey length/);
});

test("invalid input types are rejected by deserializeKyberKey", () => {
  assert.throws(() => deserializeKyberKey(123), /base64 string/);
  assert.throws(() => deserializeKyberKey("!!not-base64!!"), /invalid base64/);
});

test("serializeKyberKey/deserializeKyberKey usable over the wire", () => {
  const alice = generateKyberKeyPair("ml-kem-768");
  // Sender receives only base64.
  const pkWire = serializeKyberKey(alice.publicKey);
  const pkRecv = deserializeKyberKey(pkWire);
  const { ciphertext, sharedSecret } = kyberEncapsulate(pkRecv);
  const ctWire = serializeKyberKey(ciphertext);
  // Receiver deserializes and decapsulates.
  const ctRecv = deserializeKyberKey(ctWire);
  const recovered = kyberDecapsulate(ctRecv, alice.secretKey);
  assert.deepEqual(Buffer.from(recovered), Buffer.from(sharedSecret));
});

test("kyberInfo reports all supported levels and flags as non-production PQ", () => {
  const info = kyberInfo();
  assert.equal(info.isProductionPQ, false);
  for (const level of LEVELS) {
    assert.ok(info.levels[level], `missing ${level}`);
    assert.equal(info.levels[level].sizes.sharedSecret, 32);
  }
});
