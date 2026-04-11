/**
 * Phase 37.4: WebAuthn/Passkey tests.
 *
 * Uses Node crypto to synthesize real ES256 WebAuthn attestation and
 * assertion payloads, so the verification path is actually exercised
 * (no mocked verifier).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate storage before importing modules that read STORAGE_PATH.
const tempDir = mkdtempSync(join(tmpdir(), "webauthn-test-"));
const origStoragePath = process.env.STORAGE_PATH;
const origStorageBackend = process.env.STORAGE_BACKEND;
const origRpId = process.env.WEBAUTHN_RP_ID;
process.env.STORAGE_PATH = tempDir;
delete process.env.STORAGE_BACKEND;
process.env.WEBAUTHN_RP_ID = "localhost";

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (origStoragePath !== undefined) process.env.STORAGE_PATH = origStoragePath;
  else delete process.env.STORAGE_PATH;
  if (origStorageBackend !== undefined) process.env.STORAGE_BACKEND = origStorageBackend;
  if (origRpId !== undefined) process.env.WEBAUTHN_RP_ID = origRpId;
  else delete process.env.WEBAUTHN_RP_ID;
});

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";

function b64url(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Minimal CBOR encoder for COSE_Key structures ---

function cborUint(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cborInt(n) {
  if (n >= 0) return cborUint(0, n);
  return cborUint(1, -1 - n);
}
function cborBytes(buf) {
  return Buffer.concat([cborUint(2, buf.length), buf]);
}
function cborMap(entries) {
  // entries: Array<[keyBuf, valBuf]>
  const head = cborUint(5, entries.length);
  const body = Buffer.concat(entries.flatMap(([k, v]) => [k, v]));
  return Buffer.concat([head, body]);
}

/**
 * Build a COSE_Key for an EC2 / P-256 / ES256 public key given raw X and Y.
 * Map keys:
 *   1  (kty)  = 2  (EC2)
 *   3  (alg)  = -7 (ES256)
 *   -1 (crv)  = 1  (P-256)
 *   -2 (x)    = bytes(32)
 *   -3 (y)    = bytes(32)
 */
function buildCoseEcKey(x, y) {
  return cborMap([
    [cborInt(1), cborInt(2)],   // kty = 2 (EC2)
    [cborInt(3), cborInt(-7)],  // alg = -7 (ES256)
    [cborInt(-1), cborInt(1)],  // crv = 1 (P-256)
    [cborInt(-2), cborBytes(x)],
    [cborInt(-3), cborBytes(y)],
  ]);
}

/**
 * Extract raw 32-byte X and Y from an SPKI-encoded EC P-256 public key.
 * The 27-byte header is: 3059301306072a8648ce3d020106082a8648ce3d03010703420004
 * followed by X (32) then Y (32).
 */
function extractEcXY(spki) {
  // Node always emits this header for named curve P-256.
  const offset = spki.length - 64;
  return { x: spki.subarray(offset, offset + 32), y: spki.subarray(offset + 32, offset + 64) };
}

/**
 * Build an authenticatorData buffer.
 *   rpIdHash(32) | flags(1) | signCount(4) | [aaguid(16) | credIdLen(2) | credId | credPubKey]
 */
function buildAuthData({ rpId, flags, signCount, credentialId, publicKeyCose }) {
  const rpIdH = createHash("sha256").update(rpId).digest();
  const flagsBuf = Buffer.from([flags]);
  const signBuf = Buffer.alloc(4);
  signBuf.writeUInt32BE(signCount, 0);
  const parts = [rpIdH, flagsBuf, signBuf];
  if (credentialId && publicKeyCose) {
    const aaguid = Buffer.alloc(16); // all zeros
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(credentialId.length, 0);
    parts.push(aaguid, credLen, credentialId, publicKeyCose);
  }
  return Buffer.concat(parts);
}

test("challenge generation: registration options include base64url challenge and user handle", async () => {
  const { generateRegistrationOptions, _clearChallengesForTesting } = await import("../lib/webauthn.js");
  _clearChallengesForTesting();
  const opts = generateRegistrationOptions("user-1", "alice", "Alice");
  assert.equal(typeof opts.challenge, "string");
  assert.ok(opts.challenge.length > 16);
  assert.equal(opts.rp.id, "localhost");
  assert.equal(opts.user.name, "alice");
  assert.equal(opts.user.displayName, "Alice");
  // No padding or + / characters (base64url)
  assert.ok(!/[+/=]/.test(opts.challenge));
  // The algorithm list must include ES256.
  assert.ok(opts.pubKeyCredParams.some((p) => p.alg === -7));
});

test("challenge generation: authentication options return a fresh challenge", async () => {
  const { generateAuthenticationOptions } = await import("../lib/webauthn.js");
  const opts1 = generateAuthenticationOptions("user-1", []);
  const opts2 = generateAuthenticationOptions("user-1", []);
  assert.notEqual(opts1.challenge, opts2.challenge);
  assert.equal(opts1.rpId, "localhost");
});

test("registration options: missing userId/userName throws", async () => {
  const { generateRegistrationOptions } = await import("../lib/webauthn.js");
  assert.throws(() => generateRegistrationOptions(null, "u"), /userId/);
  assert.throws(() => generateRegistrationOptions("u", null), /userName/);
});

test("credential store CRUD: store, get, list, delete", async () => {
  const store = await import("../lib/webauthn-store.js");
  await store._clearAllForTesting();

  const credId = "cred-" + randomBytes(8).toString("hex");
  const stored = await store.storeCredential("user-a", {
    credentialId: credId,
    publicKey: "pk-fake",
    counter: 0,
    transports: ["internal"],
  });
  assert.equal(stored.credentialId, credId);
  assert.equal(stored.userId, "user-a");
  assert.ok(stored.createdAt);

  const fetched = await store.getCredential(credId);
  assert.ok(fetched);
  assert.equal(fetched.userId, "user-a");

  const list = await store.getUserCredentials("user-a");
  assert.equal(list.length, 1);
  assert.equal(list[0].credentialId, credId);

  const del = await store.deleteCredential(credId);
  assert.equal(del.ok, true);
  assert.equal(await store.getCredential(credId), null);
});

test("credential store: storeCredential replaces existing entry with same id (upsert)", async () => {
  const store = await import("../lib/webauthn-store.js");
  await store._clearAllForTesting();

  const credId = "cred-upsert";
  await store.storeCredential("u", { credentialId: credId, publicKey: "pk1" });
  await store.storeCredential("u", { credentialId: credId, publicKey: "pk2", counter: 5 });

  const list = await store.getUserCredentials("u");
  assert.equal(list.length, 1);
  assert.equal(list[0].publicKey, "pk2");
  assert.equal(list[0].counter, 5);
});

test("credential store: updateCounter bumps counter and sets lastUsed (replay protection)", async () => {
  const store = await import("../lib/webauthn-store.js");
  await store._clearAllForTesting();

  const credId = "cred-counter";
  await store.storeCredential("u", { credentialId: credId, publicKey: "pk", counter: 0 });

  const result = await store.updateCounter(credId, 5);
  assert.equal(result.ok, true);
  assert.equal(result.credential.counter, 5);
  assert.ok(result.credential.lastUsed);

  const again = await store.updateCounter(credId, 10);
  assert.equal(again.credential.counter, 10);

  // missing credential
  const missing = await store.updateCounter("does-not-exist", 1);
  assert.equal(missing.ok, false);

  // invalid inputs
  await assert.rejects(() => store.updateCounter("", 1), /credentialId required/);
  await assert.rejects(() => store.updateCounter(credId, -1), /non-negative/);
});

test("credential store: deleteCredential returns ok:false for unknown id", async () => {
  const store = await import("../lib/webauthn-store.js");
  const result = await store.deleteCredential("does-not-exist-xyz");
  assert.equal(result.ok, false);
});

test("registration verify: accepts a well-formed attestation (authData-only)", async () => {
  const { generateRegistrationOptions, verifyRegistration, _clearChallengesForTesting } = await import("../lib/webauthn.js");
  _clearChallengesForTesting();

  const opts = generateRegistrationOptions("user-reg", "bob", "Bob");

  // Build a fake authenticator with a real ES256 keypair.
  const kp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = kp.publicKey.export({ format: "der", type: "spki" });
  const { x, y } = extractEcXY(spki);
  const coseKey = buildCoseEcKey(x, y);

  const credentialId = Buffer.from("fake-cred-id-0001");
  // flags: UP (0x01) | UV (0x04) | AT (0x40) = 0x45
  const authData = buildAuthData({
    rpId: RP_ID,
    flags: 0x45,
    signCount: 0,
    credentialId,
    publicKeyCose: coseKey,
  });

  const clientData = {
    type: "webauthn.create",
    challenge: opts.challenge,
    origin: ORIGIN,
  };
  const clientDataJSON = Buffer.from(JSON.stringify(clientData));

  const credential = {
    id: b64url(credentialId),
    rawId: b64url(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      transports: ["internal"],
    },
  };

  const result = await verifyRegistration(credential, opts.challenge, ORIGIN, { rpId: RP_ID });
  assert.equal(result.verified, true, result.error || "");
  assert.ok(result.credentialId);
  assert.ok(result.publicKey);
  assert.equal(result.counter, 0);
});

test("registration verify: rejects mismatched challenge", async () => {
  const { verifyRegistration } = await import("../lib/webauthn.js");
  const kp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = kp.publicKey.export({ format: "der", type: "spki" });
  const { x, y } = extractEcXY(spki);
  const coseKey = buildCoseEcKey(x, y);
  const credentialId = Buffer.from("cred");
  const authData = buildAuthData({ rpId: RP_ID, flags: 0x45, signCount: 0, credentialId, publicKeyCose: coseKey });
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.create",
    challenge: "aaa",
    origin: ORIGIN,
  }));

  const result = await verifyRegistration({
    id: b64url(credentialId),
    response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData) },
  }, "bbb", ORIGIN, { rpId: RP_ID });
  assert.equal(result.verified, false);
  assert.match(result.error, /challenge mismatch/);
});

test("registration verify: rejects wrong rpIdHash", async () => {
  const { verifyRegistration } = await import("../lib/webauthn.js");
  const kp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = kp.publicKey.export({ format: "der", type: "spki" });
  const { x, y } = extractEcXY(spki);
  const coseKey = buildCoseEcKey(x, y);
  const credentialId = Buffer.from("cred");
  // Build with the wrong RP ID.
  const authData = buildAuthData({ rpId: "other.example", flags: 0x45, signCount: 0, credentialId, publicKeyCose: coseKey });
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.create", challenge: "chal", origin: ORIGIN,
  }));
  const result = await verifyRegistration({
    id: b64url(credentialId),
    response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData) },
  }, "chal", ORIGIN, { rpId: RP_ID });
  assert.equal(result.verified, false);
  assert.match(result.error, /rpIdHash/);
});

test("authentication verify: end-to-end ES256 signature check", async () => {
  const {
    generateRegistrationOptions,
    verifyRegistration,
    generateAuthenticationOptions,
    verifyAuthentication,
    persistVerifiedCredential,
    findCredential,
    recordAuthentication,
    _clearChallengesForTesting,
  } = await import("../lib/webauthn.js");
  const store = await import("../lib/webauthn-store.js");
  await store._clearAllForTesting();
  _clearChallengesForTesting();

  // 1. Register a credential.
  const regOpts = generateRegistrationOptions("user-auth", "carol", "Carol");
  const kp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = kp.publicKey.export({ format: "der", type: "spki" });
  const { x, y } = extractEcXY(spki);
  const coseKey = buildCoseEcKey(x, y);
  const credentialId = Buffer.from("auth-cred-0001");

  const regAuthData = buildAuthData({
    rpId: RP_ID,
    flags: 0x45,
    signCount: 0,
    credentialId,
    publicKeyCose: coseKey,
  });
  const regClientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.create", challenge: regOpts.challenge, origin: ORIGIN,
  }));

  const regResult = await verifyRegistration({
    id: b64url(credentialId),
    response: { clientDataJSON: b64url(regClientDataJSON), authenticatorData: b64url(regAuthData) },
  }, regOpts.challenge, ORIGIN, { rpId: RP_ID });
  assert.equal(regResult.verified, true, regResult.error || "");

  await persistVerifiedCredential("user-auth", regResult);

  // 2. Begin authentication.
  const authOpts = generateAuthenticationOptions("user-auth", [{ id: b64url(credentialId) }]);

  // 3. Build an assertion signed with the authenticator's private key.
  //    signedData = authenticatorData || sha256(clientDataJSON)
  const assertAuthData = buildAuthData({
    rpId: RP_ID,
    flags: 0x05, // UP + UV, no AT
    signCount: 1,
  });
  const assertClientData = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: authOpts.challenge, origin: ORIGIN,
  }));
  const clientDataHash = createHash("sha256").update(assertClientData).digest();
  const signedData = Buffer.concat([assertAuthData, clientDataHash]);

  const signer = createSign("sha256");
  signer.update(signedData);
  signer.end();
  const signature = signer.sign(kp.privateKey); // DER-encoded ECDSA

  // 4. Verify.
  const stored = await findCredential(b64url(credentialId));
  assert.ok(stored, "credential should be stored");
  const authResult = await verifyAuthentication({
    id: b64url(credentialId),
    response: {
      clientDataJSON: b64url(assertClientData),
      authenticatorData: b64url(assertAuthData),
      signature: b64url(signature),
    },
  }, authOpts.challenge, stored, { rpId: RP_ID, expectedOrigin: ORIGIN });

  assert.equal(authResult.verified, true, authResult.error || "");
  assert.equal(authResult.newCounter, 1);

  // 5. Replay protection: verify with the same counter should fail.
  await recordAuthentication(stored.credentialId, authResult.newCounter);
  const stored2 = await findCredential(b64url(credentialId));
  assert.equal(stored2.counter, 1);

  const replayResult = await verifyAuthentication({
    id: b64url(credentialId),
    response: {
      clientDataJSON: b64url(assertClientData),
      authenticatorData: b64url(assertAuthData), // same signCount=1
      signature: b64url(signature),
    },
  }, authOpts.challenge, stored2, { rpId: RP_ID, expectedOrigin: ORIGIN });
  assert.equal(replayResult.verified, false);
  assert.match(replayResult.error, /replay|counter/i);
});

test("authentication verify: rejects signature from wrong key", async () => {
  const {
    verifyAuthentication,
  } = await import("../lib/webauthn.js");

  const kpGood = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const kpWrong = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { x, y } = extractEcXY(kpGood.publicKey.export({ format: "der", type: "spki" }));
  const coseKey = buildCoseEcKey(x, y);

  const authData = buildAuthData({ rpId: RP_ID, flags: 0x05, signCount: 2 });
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: "chal", origin: ORIGIN,
  }));
  const signedData = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
  const signer = createSign("sha256");
  signer.update(signedData);
  signer.end();
  const signature = signer.sign(kpWrong.privateKey);

  const result = await verifyAuthentication({
    id: "x",
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(signature),
    },
  }, "chal", { publicKey: b64url(coseKey), counter: 0 }, { rpId: RP_ID, expectedOrigin: ORIGIN });

  assert.equal(result.verified, false);
});

test("listUserCredentials and deleteCredential (via lib/webauthn public API)", async () => {
  const { listUserCredentials, deleteCredential, persistVerifiedCredential } = await import("../lib/webauthn.js");
  const store = await import("../lib/webauthn-store.js");
  await store._clearAllForTesting();

  await persistVerifiedCredential("u-del", { credentialId: "c1", publicKey: "pk", counter: 0 });
  await persistVerifiedCredential("u-del", { credentialId: "c2", publicKey: "pk", counter: 0 });
  await persistVerifiedCredential("u-other", { credentialId: "c3", publicKey: "pk", counter: 0 });

  const list = await listUserCredentials("u-del");
  assert.equal(list.length, 2);

  // Ownership check: can't delete another user's credential.
  const bad = await deleteCredential("u-del", "c3");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /does not belong/);

  const good = await deleteCredential("u-del", "c1");
  assert.equal(good.ok, true);
  const after = await listUserCredentials("u-del");
  assert.equal(after.length, 1);
  assert.equal(after[0].credentialId, "c2");

  // Missing credential
  const missing = await deleteCredential("u-del", "nope");
  assert.equal(missing.ok, false);
});
