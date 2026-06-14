import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "replay-tokens-"));
const prevStorage = process.env.STORAGE_PATH;
const prevReplaySecret = process.env.REPLAY_TOKEN_SECRET;
const prevSessionSecret = process.env.SESSION_SECRET;
process.env.STORAGE_PATH = dir;
process.env.REPLAY_TOKEN_SECRET = "unit-test-secret-value-please-change";

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  if (prevReplaySecret === undefined) delete process.env.REPLAY_TOKEN_SECRET;
  else process.env.REPLAY_TOKEN_SECRET = prevReplaySecret;
  if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = prevSessionSecret;
  rmSync(dir, { recursive: true, force: true });
});

const {
  mintReplayToken,
  verifyReplayToken,
  revokeReplayToken,
  decodeReplayTokenPayload,
  isReplayJtiRevoked,
} = await import("../lib/replay-tokens.js");

test("mint/verify roundtrip returns valid token with expected claims", async () => {
  const token = mintReplayToken({
    runId: "run-1",
    workspaceId: "default",
    userId: "user-42",
    ttlMs: 60_000,
  });
  assert.equal(typeof token, "string");
  assert.equal(token.split(".").length, 3);

  const verdict = await verifyReplayToken(token);
  assert.equal(verdict.valid, true, `expected valid, got reason=${verdict.reason}`);
  assert.equal(verdict.reason, null);
  assert.ok(verdict.claims);
  assert.equal(verdict.claims.runId, "run-1");
  assert.equal(verdict.claims.workspaceId, "default");
  assert.equal(verdict.claims.userId, "user-42");
  assert.equal(verdict.claims.scope, "replay:read");
  assert.ok(typeof verdict.claims.jti === "string" && verdict.claims.jti.length > 0);
  assert.ok(typeof verdict.claims.iat === "number");
  assert.ok(typeof verdict.claims.exp === "number");
  assert.ok(verdict.claims.exp > verdict.claims.iat);
});

test("decodeReplayTokenPayload works without secret check", () => {
  const token = mintReplayToken({
    runId: "run-2",
    workspaceId: "ws",
    userId: "u",
    ttlMs: 60_000,
  });
  const payload = decodeReplayTokenPayload(token);
  assert.ok(payload);
  assert.equal(payload.runId, "run-2");
});

test("expired token is rejected", async () => {
  // Craft a token with very short TTL then wait past expiry.
  const token = mintReplayToken({
    runId: "run-expired",
    workspaceId: "ws",
    userId: "u",
    ttlMs: 60_000,
  });
  // Tamper claims.exp to 1970 by recomputing and re-signing would defeat the point.
  // Instead, manipulate the payload directly through the crypto API to simulate expiry.
  const [h, p] = token.split(".");
  const payloadJson = Buffer.from(
    p.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (p.length % 4)) % 4),
    "base64",
  ).toString("utf8");
  const payload = JSON.parse(payloadJson);
  payload.exp = 1; // Jan 1 1970
  const newPayload64 = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const { createHmac } = await import("crypto");
  const sig = createHmac("sha256", process.env.REPLAY_TOKEN_SECRET)
    .update(`${h}.${newPayload64}`)
    .digest();
  const newSig64 = sig
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const expiredToken = `${h}.${newPayload64}.${newSig64}`;

  const verdict = await verifyReplayToken(expiredToken);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "EXPIRED");
});

test("tampered signature is rejected", async () => {
  const token = mintReplayToken({
    runId: "run-tamper",
    workspaceId: "ws",
    userId: "u",
    ttlMs: 60_000,
  });
  const parts = token.split(".");
  // Flip the first character of the signature (within the base64url alphabet).
  const sigOriginal = parts[2];
  const flipped = sigOriginal.startsWith("A") ? "B" + sigOriginal.slice(1) : "A" + sigOriginal.slice(1);
  const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
  const verdict = await verifyReplayToken(tampered);
  assert.equal(verdict.valid, false);
  assert.ok(
    verdict.reason === "BAD_SIGNATURE" || verdict.reason === "MALFORMED_SIGNATURE",
    `unexpected reason ${verdict.reason}`,
  );
});

test("tampered payload (claims) is rejected because signature no longer matches", async () => {
  const token = mintReplayToken({
    runId: "run-alter",
    workspaceId: "ws",
    userId: "u",
    ttlMs: 60_000,
  });
  const parts = token.split(".");
  // Re-encode a different payload without re-signing.
  const alteredPayload64 = Buffer.from(
    JSON.stringify({ runId: "different", scope: "replay:read" }),
    "utf8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const altered = `${parts[0]}.${alteredPayload64}.${parts[2]}`;
  const verdict = await verifyReplayToken(altered);
  assert.equal(verdict.valid, false);
  assert.ok(
    verdict.reason === "BAD_SIGNATURE" || verdict.reason === "MALFORMED_SIGNATURE",
    `unexpected reason ${verdict.reason}`,
  );
});

test("revoked jti is rejected after revokeReplayToken", async () => {
  const token = mintReplayToken({
    runId: "run-revoke",
    workspaceId: "ws",
    userId: "u",
    ttlMs: 60_000,
  });
  const ok1 = await verifyReplayToken(token);
  assert.equal(ok1.valid, true);
  const jti = ok1.claims.jti;

  const revokeResult = await revokeReplayToken(token);
  assert.equal(revokeResult.ok, true);
  assert.equal(revokeResult.jti, jti);
  assert.equal(await isReplayJtiRevoked(jti), true);

  const after = await verifyReplayToken(token);
  assert.equal(after.valid, false);
  assert.equal(after.reason, "REVOKED");
});

test("malformed tokens are rejected without throwing", async () => {
  const cases = ["", "not-a-token", "a.b", "a.b.c.d"];
  for (const token of cases) {
    const verdict = await verifyReplayToken(token);
    assert.equal(verdict.valid, false);
  }
});

test("missing secret throws when neither REPLAY_TOKEN_SECRET nor SESSION_SECRET set", async () => {
  const savedReplay = process.env.REPLAY_TOKEN_SECRET;
  const savedSession = process.env.SESSION_SECRET;
  delete process.env.REPLAY_TOKEN_SECRET;
  delete process.env.SESSION_SECRET;
  try {
    assert.throws(
      () =>
        mintReplayToken({
          runId: "r",
          workspaceId: "w",
          userId: "u",
          ttlMs: 1000,
        }),
      (err) => err && err.code === "REPLAY_SECRET_MISSING",
    );

    await assert.rejects(
      async () => {
        // Construct a structurally valid 3-part token so that the verifier
        // reaches the secret-resolution code path.
        await verifyReplayToken("aa.bb.cc");
      },
      (err) => err && err.code === "REPLAY_SECRET_MISSING",
    );
  } finally {
    if (savedReplay !== undefined) process.env.REPLAY_TOKEN_SECRET = savedReplay;
    if (savedSession !== undefined) process.env.SESSION_SECRET = savedSession;
  }
});

test("SESSION_SECRET is used as fallback when REPLAY_TOKEN_SECRET is missing", async () => {
  const savedReplay = process.env.REPLAY_TOKEN_SECRET;
  delete process.env.REPLAY_TOKEN_SECRET;
  process.env.SESSION_SECRET = "fallback-session-secret-value";
  try {
    const token = mintReplayToken({
      runId: "fb-run",
      workspaceId: "ws",
      userId: "u",
      ttlMs: 60_000,
    });
    const verdict = await verifyReplayToken(token);
    assert.equal(verdict.valid, true);
  } finally {
    if (savedReplay !== undefined) process.env.REPLAY_TOKEN_SECRET = savedReplay;
    else process.env.REPLAY_TOKEN_SECRET = "unit-test-secret-value-please-change";
  }
});
