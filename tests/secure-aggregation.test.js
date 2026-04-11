/**
 * Phase 45.3: Secure aggregation tests.
 *
 * Covers Shamir's Secret Sharing primitives (polynomial creation, evaluation,
 * Lagrange reconstruction) plus the full session lifecycle: share generation,
 * masked update submission, aggregate roundtrip, dropped-client recovery,
 * and edge-case validation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate STORAGE_PATH so persisted sessions don't collide with the project
// data directory or with other tests.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-secure-agg-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  FIELD_PRIME,
  toField,
  createPolynomial,
  evaluatePolynomial,
  reconstructSecret,
  createSession,
  getSession,
  listSessions,
  generateKeyShares,
  submitMaskedUpdate,
  revealSeed,
  aggregateMaskedUpdates,
  recoverKeys,
  deleteSession,
  maskValue,
  _internals,
} = await import("../lib/secure-aggregation.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- Field helpers ----

test("toField normalizes numbers, strings, and BigInts into [0, p)", () => {
  assert.equal(toField(0), 0n);
  assert.equal(toField(42), 42n);
  assert.equal(toField("100"), 100n);
  assert.equal(toField(123n), 123n);
  // Negative number wraps into the field.
  const neg = toField(-1);
  assert.equal(neg, FIELD_PRIME - 1n);
  assert.ok(neg >= 0n && neg < FIELD_PRIME);
});

test("toField rejects non-finite numbers and empty strings", () => {
  assert.throws(() => toField(NaN), /non-finite/);
  assert.throws(() => toField(Infinity), /non-finite/);
  assert.throws(() => toField(""), /cannot convert/);
  assert.throws(() => toField(null), /cannot convert/);
});

// ---- Shamir primitives ----

test("createPolynomial places the secret at x=0", () => {
  const poly = createPolynomial(12345n, 3);
  assert.equal(poly.length, 3);
  assert.equal(poly[0], 12345n);
  // Evaluating at 0 must recover the secret.
  assert.equal(evaluatePolynomial(poly, 0), 12345n);
});

test("createPolynomial rejects non-positive or non-integer thresholds", () => {
  assert.throws(() => createPolynomial(1n, 0), /positive integer/);
  assert.throws(() => createPolynomial(1n, -5), /positive integer/);
  assert.throws(() => createPolynomial(1n, 1.5), /positive integer/);
});

test("evaluatePolynomial is deterministic and matches Horner expansion", () => {
  // f(x) = 7 + 3x + 5x^2
  const poly = [7n, 3n, 5n];
  assert.equal(evaluatePolynomial(poly, 0), 7n);
  assert.equal(evaluatePolynomial(poly, 1), 15n);
  assert.equal(evaluatePolynomial(poly, 2), 33n);
  assert.equal(evaluatePolynomial(poly, 3), 61n);
});

test("evaluatePolynomial handles big numeric input inside the field", () => {
  const poly = createPolynomial(999n, 2);
  const y = evaluatePolynomial(poly, 7);
  assert.ok(y >= 0n && y < FIELD_PRIME);
});

test("reconstructSecret recovers the secret from exactly threshold shares", () => {
  const secret = 987654321n;
  const poly = createPolynomial(secret, 3);
  const shares = [1, 2, 3, 4, 5].map((x) => ({ x, y: evaluatePolynomial(poly, x) }));
  // Any 3 shares should reconstruct.
  const recovered1 = reconstructSecret(shares.slice(0, 3));
  const recovered2 = reconstructSecret(shares.slice(2, 5));
  const recovered3 = reconstructSecret([shares[0], shares[2], shares[4]]);
  assert.equal(recovered1, secret);
  assert.equal(recovered2, secret);
  assert.equal(recovered3, secret);
});

test("reconstructSecret with more than threshold shares still works", () => {
  const secret = 4242n;
  const poly = createPolynomial(secret, 2);
  const shares = [1, 2, 3, 4, 5, 6, 7].map((x) => ({ x, y: evaluatePolynomial(poly, x) }));
  assert.equal(reconstructSecret(shares), secret);
});

test("reconstructSecret deduplicates repeated x-coordinates", () => {
  const secret = 11n;
  const poly = createPolynomial(secret, 2);
  const s1 = { x: 1, y: evaluatePolynomial(poly, 1) };
  const s2 = { x: 2, y: evaluatePolynomial(poly, 2) };
  // Duplicate s1 should not explode the Lagrange denominator.
  assert.equal(reconstructSecret([s1, s1, s2]), secret);
});

test("reconstructSecret rejects empty input", () => {
  assert.throws(() => reconstructSecret([]), /non-empty/);
  assert.throws(() => reconstructSecret([null]), /no valid shares/);
});

test("reconstructSecret fails to recover from fewer shares than threshold (returns wrong value)", () => {
  const secret = 31415n;
  const poly = createPolynomial(secret, 4);
  // Only 3 shares < threshold=4: reconstruction is mathematically
  // under-determined and must not accidentally coincide with the secret.
  const under = [1, 2, 3].map((x) => ({ x, y: evaluatePolynomial(poly, x) }));
  const guess = reconstructSecret(under);
  // With random coefficients it's astronomically unlikely to equal the secret
  // (probability ~1/p ≈ 2^-127).
  assert.notEqual(guess, secret);
  // But 4 shares should succeed.
  const ok = [1, 2, 3, 4].map((x) => ({ x, y: evaluatePolynomial(poly, x) }));
  assert.equal(reconstructSecret(ok), secret);
});

// ---- Session lifecycle ----

test("createSession validates participants and threshold", async () => {
  await assert.rejects(createSession([], 1), /non-empty/);
  await assert.rejects(createSession(["a", "a"], 1), /duplicate/);
  await assert.rejects(createSession(["a", "b"], 0), /positive integer/);
  await assert.rejects(createSession(["a", "b"], 5), /cannot exceed/);
});

test("createSession persists the session and lists it", async () => {
  const s = await createSession(["alice", "bob", "carol"], 2);
  assert.ok(s.id.startsWith("sa_"));
  assert.equal(s.threshold, 2);
  assert.deepEqual(s.participants, ["alice", "bob", "carol"]);
  assert.equal(s.status, "pending");
  const loaded = await getSession(s.id);
  assert.ok(loaded);
  assert.equal(loaded.id, s.id);
  const listed = await listSessions({ limit: 100 });
  assert.ok(listed.some((x) => x.id === s.id));
});

test("generateKeyShares produces one share per participant and rejects non-members", async () => {
  const s = await createSession(["a", "b", "c"], 2);
  const result = await generateKeyShares(s.id, "a");
  assert.ok(typeof result.seed === "string");
  assert.equal(result.shares.length, 3);
  const peers = result.shares.map((x) => x.peerId).sort();
  assert.deepEqual(peers, ["a", "b", "c"]);
  // Non-participant rejected.
  await assert.rejects(generateKeyShares(s.id, "mallory"), /not a session participant/);
  // Double-submission rejected.
  await assert.rejects(generateKeyShares(s.id, "a"), /already submitted/);
});

test("submitMaskedUpdate requires prior key share generation", async () => {
  const s = await createSession(["a", "b"], 2);
  await assert.rejects(submitMaskedUpdate(s.id, "a", 100), /must generate key shares first/);
  await generateKeyShares(s.id, "a");
  const r = await submitMaskedUpdate(s.id, "a", 100);
  assert.equal(r.clientId, "a");
  await assert.rejects(submitMaskedUpdate(s.id, "a", 200), /already submitted/);
});

test("aggregateMaskedUpdates recovers the plain sum when all clients reveal seeds", async () => {
  const s = await createSession(["a", "b", "c"], 2);
  const seeds = {};
  for (const id of ["a", "b", "c"]) {
    const { seed } = await generateKeyShares(s.id, id);
    seeds[id] = seed;
  }
  const values = { a: 100n, b: 250n, c: 42n };
  for (const id of ["a", "b", "c"]) {
    const masked = maskValue(values[id], seeds[id]);
    await submitMaskedUpdate(s.id, id, masked);
    await revealSeed(s.id, id, seeds[id]);
  }
  const agg = await aggregateMaskedUpdates(s.id);
  assert.equal(agg.status, "aggregated");
  assert.equal(BigInt(agg.sum), 100n + 250n + 42n);
  assert.deepEqual(agg.submitted.sort(), ["a", "b", "c"]);
  assert.deepEqual(agg.missing, []);
});

test("aggregateMaskedUpdates recovers the sum when one client drops out", async () => {
  const s = await createSession(["a", "b", "c", "d"], 2);
  // All four clients generate shares.
  const shareSets = {};
  const seeds = {};
  for (const id of ["a", "b", "c", "d"]) {
    const r = await generateKeyShares(s.id, id);
    shareSets[id] = r.shares;
    seeds[id] = r.seed;
  }
  const values = { a: 10n, b: 20n, c: 30n, d: 40n };
  // a, b, c submit and reveal; d drops out before submitting.
  for (const id of ["a", "b", "c"]) {
    const masked = maskValue(values[id], seeds[id]);
    await submitMaskedUpdate(s.id, id, masked);
    await revealSeed(s.id, id, seeds[id]);
  }
  // d never submits => d contributed nothing, nothing to unmask.
  const agg = await aggregateMaskedUpdates(s.id);
  assert.equal(BigInt(agg.sum), 10n + 20n + 30n);
  assert.equal(agg.status, "aggregated");
});

test("recoverKeys reconstructs a dropped client's seed from surviving peers' shares", async () => {
  const s = await createSession(["a", "b", "c", "d"], 2);
  const shareSets = {};
  const seeds = {};
  for (const id of ["a", "b", "c", "d"]) {
    const r = await generateKeyShares(s.id, id);
    shareSets[id] = r.shares;
    seeds[id] = r.seed;
  }
  const values = { a: 1000n, b: 2000n, c: 3000n, d: 4000n };
  // Everybody submits their masked update.
  for (const id of ["a", "b", "c", "d"]) {
    const masked = maskValue(values[id], seeds[id]);
    await submitMaskedUpdate(s.id, id, masked);
  }
  // a, b, c reveal their seeds. d fails to reveal (dropped mid-round).
  for (const id of ["a", "b", "c"]) {
    await revealSeed(s.id, id, seeds[id]);
  }
  // Without recovery the aggregate is awaiting_recovery.
  const mid = await aggregateMaskedUpdates(s.id);
  assert.equal(mid.status, "awaiting_recovery");
  assert.deepEqual(mid.missing, ["d"]);

  // Surviving peers forward their shares of d to the server.
  const sharesOfD = ["a", "b", "c"].map((peerId) => {
    const share = shareSets["d"].find((x) => x.peerId === peerId);
    return { x: share.x, y: share.y };
  });
  const recovered = await recoverKeys(s.id, "d", sharesOfD);
  assert.ok(recovered.recovered);
  assert.equal(BigInt(recovered.seed), BigInt(seeds["d"]));

  // Now the aggregate should resolve to the full sum.
  const final = await aggregateMaskedUpdates(s.id);
  assert.equal(final.status, "aggregated");
  assert.equal(BigInt(final.sum), 1000n + 2000n + 3000n + 4000n);
  assert.ok(final.recoveredFor.includes("d"));
});

test("recoverKeys rejects share sets smaller than threshold", async () => {
  const s = await createSession(["a", "b", "c", "d"], 3);
  for (const id of ["a", "b", "c", "d"]) {
    await generateKeyShares(s.id, id);
  }
  const session = await getSession(s.id);
  // Only provide one share while threshold = 3.
  const oneShare = [session.shares["d"].byPeer["a"]];
  await assert.rejects(recoverKeys(s.id, "d", oneShare), /need at least 3 shares/);
});

test("maskValue + sum-of-masks roundtrip equals plain sum mod p", () => {
  const seeds = [111n, 222n, 333n, 444n];
  const values = [1n, 2n, 3n, 4n];
  let masked = 0n;
  let seedSum = 0n;
  for (let i = 0; i < 4; i++) {
    masked = (masked + maskValue(values[i], seeds[i])) % FIELD_PRIME;
    seedSum = (seedSum + seeds[i]) % FIELD_PRIME;
  }
  const unmasked = (masked + FIELD_PRIME - seedSum) % FIELD_PRIME;
  assert.equal(unmasked, 10n);
});

test("deleteSession removes the session", async () => {
  const s = await createSession(["a", "b"], 2);
  assert.equal(await deleteSession(s.id), true);
  assert.equal(await getSession(s.id), null);
  assert.equal(await deleteSession(s.id), false);
});

test("aggregateMaskedUpdates fails when no masked updates exist", async () => {
  const s = await createSession(["a", "b"], 2);
  await generateKeyShares(s.id, "a");
  await assert.rejects(aggregateMaskedUpdates(s.id), /no masked updates submitted/);
});

test("submitMaskedUpdate rejects clients not in the session", async () => {
  const s = await createSession(["a", "b"], 2);
  await generateKeyShares(s.id, "a");
  await assert.rejects(
    submitMaskedUpdate(s.id, "mallory", 1n),
    /not a session participant/,
  );
});

test("sessions with a single participant still roundtrip (trivial aggregation)", async () => {
  const s = await createSession(["solo"], 1);
  const { seed } = await generateKeyShares(s.id, "solo");
  await submitMaskedUpdate(s.id, "solo", maskValue(777n, seed));
  await revealSeed(s.id, "solo", seed);
  const agg = await aggregateMaskedUpdates(s.id);
  assert.equal(BigInt(agg.sum), 777n);
  assert.equal(agg.status, "aggregated");
});

test("internals expose MAX_PARTICIPANTS and store path helpers", () => {
  assert.equal(typeof _internals.MAX_PARTICIPANTS, "number");
  assert.equal(typeof _internals.storePath(), "string");
  assert.ok(_internals.storePath().endsWith("secure-aggregation.json"));
});
