/**
 * Phase 50.4: Post-quantum JWT signing tests.
 *
 * Exercises sign/verify roundtrip, tampering detection, temporal claims,
 * audience/issuer/subject checks, algorithm confusion prevention, decode,
 * JWK import/export, and kid header behaviour. The suite runs against the
 * Ed25519 fallback path when `lib/pq-dilithium.js` is absent.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  PQ_ALGORITHMS,
  DEFAULT_PQ_ALGORITHM,
  signPqJwt,
  verifyPqJwt,
  decodePqJwt,
  generatePqJwtKey,
  exportPqJwk,
  importPqJwk,
  _internals,
} = await import("../lib/pq-jwt.js");

async function freshKey(algorithm = DEFAULT_PQ_ALGORITHM) {
  return generatePqJwtKey(algorithm);
}

test("sign then verify roundtrip returns the original payload", async () => {
  const key = await freshKey();
  const token = await signPqJwt(
    { user: "alice", role: "admin" },
    key.secretKey,
    { kid: key.kid, issuer: "siskelbot", audience: "api" },
  );
  const payload = await verifyPqJwt(token, key.publicKey, {
    issuer: "siskelbot",
    audience: "api",
  });
  assert.equal(payload.user, "alice");
  assert.equal(payload.role, "admin");
  assert.equal(payload.iss, "siskelbot");
  assert.equal(payload.aud, "api");
  assert.equal(typeof payload.iat, "number");
});

test("tampered payload is rejected", async () => {
  const key = await freshKey();
  const token = await signPqJwt({ user: "alice" }, key.secretKey, { kid: key.kid });
  const parts = token.split(".");
  // Craft a new payload that decodes cleanly but changes a claim.
  const forged = Buffer.from(JSON.stringify({ user: "mallory" }), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const tampered = `${parts[0]}.${forged}.${parts[2]}`;
  await assert.rejects(
    () => verifyPqJwt(tampered, key.publicKey),
    /signature verification failed/,
  );
});

test("token signed by wrong key is rejected", async () => {
  const keyA = await freshKey();
  const keyB = await freshKey();
  const token = await signPqJwt({ user: "alice" }, keyA.secretKey, { kid: keyA.kid });
  await assert.rejects(
    () => verifyPqJwt(token, keyB.publicKey),
    /signature verification failed/,
  );
});

test("expired token is rejected", async () => {
  const key = await freshKey();
  // Sign with an exp in the past by setting iat/exp manually.
  const token = await signPqJwt(
    { user: "alice", exp: Math.floor(Date.now() / 1000) - 10 },
    key.secretKey,
    { kid: key.kid },
  );
  await assert.rejects(
    () => verifyPqJwt(token, key.publicKey),
    /jwt expired/,
  );
});

test("not-yet-valid (nbf) token is rejected", async () => {
  const key = await freshKey();
  const nbf = Math.floor(Date.now() / 1000) + 600;
  const token = await signPqJwt({ user: "alice", nbf }, key.secretKey, { kid: key.kid });
  await assert.rejects(
    () => verifyPqJwt(token, key.publicKey),
    /jwt not active yet/,
  );
});

test("wrong audience is rejected", async () => {
  const key = await freshKey();
  const token = await signPqJwt({ user: "alice" }, key.secretKey, {
    audience: "api",
  });
  await assert.rejects(
    () => verifyPqJwt(token, key.publicKey, { audience: "other" }),
    /audience mismatch/,
  );
});

test("wrong issuer is rejected", async () => {
  const key = await freshKey();
  const token = await signPqJwt({ user: "alice" }, key.secretKey, {
    issuer: "siskelbot",
  });
  await assert.rejects(
    () => verifyPqJwt(token, key.publicKey, { issuer: "other" }),
    /issuer mismatch/,
  );
});

test("algorithm confusion attack: HS256 token is rejected", async () => {
  const key = await freshKey();
  // Construct a fake HS256 token — the header says HS256, the signature is
  // a plain HMAC over the signing input using the public key bytes as the
  // HMAC secret (the classic alg-confusion payload). verifyPqJwt must
  // refuse to accept it because its alg is not in PQ_ALGORITHMS.
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { user: "mallory", iat: Math.floor(Date.now() / 1000) };
  const b64u = (buf) =>
    Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const headerB64 = b64u(JSON.stringify(header));
  const payloadB64 = b64u(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const crypto = await import("node:crypto");
  const hmac = crypto.createHmac("sha256", Buffer.from(key.publicKey)).update(signingInput).digest();
  const token = `${signingInput}.${b64u(hmac)}`;
  await assert.rejects(
    () => verifyPqJwt(token, key.publicKey),
    /alg "HS256" not allowed/,
  );
});

test("decode without verify works for well-formed tokens", async () => {
  const key = await freshKey();
  const token = await signPqJwt(
    { user: "alice", scope: "read" },
    key.secretKey,
    { kid: key.kid, algorithm: "ML-DSA-65" },
  );
  const decoded = decodePqJwt(token);
  assert.equal(decoded.header.alg, "ML-DSA-65");
  assert.equal(decoded.header.typ, "JWT");
  assert.equal(decoded.header.kid, key.kid);
  assert.equal(decoded.payload.user, "alice");
  assert.equal(decoded.payload.scope, "read");
  assert.ok(Buffer.isBuffer(decoded.signature));
});

test("JWK export/import roundtrip preserves key material", async () => {
  const key = await freshKey("ML-DSA-65");
  const jwk = exportPqJwk(key.publicKey, "ML-DSA-65", key.kid);
  assert.equal(jwk.kty, "PQ");
  assert.equal(jwk.alg, "ML-DSA-65");
  assert.equal(jwk.kid, key.kid);
  assert.equal(typeof jwk.x, "string");
  const imported = importPqJwk(jwk);
  assert.equal(imported.algorithm, "ML-DSA-65");
  assert.equal(imported.kid, key.kid);
  // verify that the imported key still verifies a token signed with the
  // original secret
  const token = await signPqJwt({ ok: true }, key.secretKey, { kid: key.kid });
  const payload = await verifyPqJwt(token, imported.key);
  assert.equal(payload.ok, true);
});

test("multiple PQ algorithms supported end-to-end", async () => {
  for (const alg of PQ_ALGORITHMS) {
    const key = await freshKey(alg);
    const token = await signPqJwt({ alg }, key.secretKey, { algorithm: alg, kid: key.kid });
    const dec = decodePqJwt(token);
    assert.equal(dec.header.alg, alg);
    const payload = await verifyPqJwt(token, key.publicKey, { algorithms: [alg] });
    assert.equal(payload.alg, alg);
  }
});

test("clock tolerance allows slightly expired tokens", async () => {
  const key = await freshKey();
  const token = await signPqJwt(
    { user: "alice", exp: Math.floor(Date.now() / 1000) - 5 },
    key.secretKey,
  );
  // Default tolerance 0 rejects
  await assert.rejects(() => verifyPqJwt(token, key.publicKey), /jwt expired/);
  // 30s tolerance accepts
  const payload = await verifyPqJwt(token, key.publicKey, { clockTolerance: 30 });
  assert.equal(payload.user, "alice");
});

test("maxAge enforces token freshness even without exp", async () => {
  const key = await freshKey();
  const oldIat = Math.floor(Date.now() / 1000) - 120;
  const token = await signPqJwt({ user: "alice", iat: oldIat }, key.secretKey);
  await assert.rejects(
    () => verifyPqJwt(token, key.publicKey, { maxAge: "60s" }),
    /jwt exceeds maxAge/,
  );
  // Larger maxAge allows it
  const payload = await verifyPqJwt(token, key.publicKey, { maxAge: "10m" });
  assert.equal(payload.user, "alice");
});

test("empty or malformed token is rejected", async () => {
  const key = await freshKey();
  await assert.rejects(() => verifyPqJwt("", key.publicKey), /non-empty string/);
  await assert.rejects(() => verifyPqJwt("not.a.jwt.extra", key.publicKey), /3 segments/);
  await assert.rejects(() => verifyPqJwt("abc.def", key.publicKey), /3 segments/);
  // Header that isn't valid base64-json
  await assert.rejects(
    () => verifyPqJwt("$$$.$$$.$$$", key.publicKey),
    /malformed jwt/,
  );
});

test("kid header roundtrip preserves the key id", async () => {
  const key = await freshKey();
  const token = await signPqJwt({ user: "alice" }, key.secretKey, { kid: key.kid });
  const decoded = decodePqJwt(token);
  assert.equal(decoded.header.kid, key.kid);
  // And verification still succeeds
  const payload = await verifyPqJwt(token, key.publicKey);
  assert.equal(payload.user, "alice");
});

test("subject option enforces sub claim match", async () => {
  const key = await freshKey();
  const token = await signPqJwt({ user: "alice" }, key.secretKey, {
    subject: "user:alice",
  });
  const payload = await verifyPqJwt(token, key.publicKey, { subject: "user:alice" });
  assert.equal(payload.sub, "user:alice");
  await assert.rejects(
    () => verifyPqJwt(token, key.publicKey, { subject: "user:bob" }),
    /subject mismatch/,
  );
});

test("generatePqJwtKey returns base64 keys and distinct kids", async () => {
  const k1 = await generatePqJwtKey();
  const k2 = await generatePqJwtKey();
  assert.equal(typeof k1.publicKey, "string");
  assert.equal(typeof k1.secretKey, "string");
  assert.equal(typeof k1.kid, "string");
  assert.notEqual(k1.kid, k2.kid);
  assert.equal(k1.algorithm, DEFAULT_PQ_ALGORITHM);
  // Ensure returned strings are valid base64url
  assert.ok(_internals.base64urlDecode(k1.publicKey).length > 0);
  assert.ok(_internals.base64urlDecode(k1.secretKey).length > 0);
});

test("unsupported algorithm is rejected on sign and verify", async () => {
  const key = await freshKey();
  await assert.rejects(
    () => signPqJwt({ u: 1 }, key.secretKey, { algorithm: "ML-DSA-99" }),
    /unsupported pq algorithm/,
  );
  const token = await signPqJwt({ u: 1 }, key.secretKey, { algorithm: "ML-DSA-65" });
  await assert.rejects(
    () => verifyPqJwt(token, key.publicKey, { algorithms: ["ML-DSA-44"] }),
    /alg "ML-DSA-65" not allowed/,
  );
});
