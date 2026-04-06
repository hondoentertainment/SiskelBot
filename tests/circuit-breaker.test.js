import test from "node:test";
import assert from "node:assert/strict";
import { recordSuccess, recordFailure, isOpen, execute } from "../lib/circuit-breaker.js";

// Helper: reset circuit state by recording success
function resetBackend(backend) {
  recordSuccess(backend);
}

test("circuit-breaker: successful calls keep circuit closed", () => {
  const backend = "test-success-" + Date.now();
  resetBackend(backend);
  recordSuccess(backend);
  const status = isOpen(backend);
  assert.equal(status.open, false);
});

test("circuit-breaker: circuit stays closed below failure threshold", () => {
  const backend = "test-below-threshold-" + Date.now();
  resetBackend(backend);
  // Default threshold is 5; record 4 failures
  for (let i = 0; i < 4; i++) {
    recordFailure(backend);
  }
  const status = isOpen(backend);
  assert.equal(status.open, false);
});

test("circuit-breaker: circuit opens after N consecutive failures", () => {
  const backend = "test-open-" + Date.now();
  resetBackend(backend);
  // Default threshold is 5
  for (let i = 0; i < 5; i++) {
    recordFailure(backend);
  }
  const status = isOpen(backend);
  assert.equal(status.open, true);
  assert.ok(typeof status.retryAfterMs === "number");
  assert.ok(status.retryAfterMs > 0);
});

test("circuit-breaker: success resets failure count", () => {
  const backend = "test-reset-" + Date.now();
  resetBackend(backend);
  for (let i = 0; i < 4; i++) {
    recordFailure(backend);
  }
  recordSuccess(backend);
  // After reset, need full threshold again
  recordFailure(backend);
  const status = isOpen(backend);
  assert.equal(status.open, false);
});

test("circuit-breaker: different backends have independent circuits", () => {
  const backendA = "test-indep-a-" + Date.now();
  const backendB = "test-indep-b-" + Date.now();
  resetBackend(backendA);
  resetBackend(backendB);

  for (let i = 0; i < 5; i++) {
    recordFailure(backendA);
  }
  assert.equal(isOpen(backendA).open, true);
  assert.equal(isOpen(backendB).open, false);
});

test("circuit-breaker: execute passes through on success", async () => {
  const backend = "test-exec-ok-" + Date.now();
  resetBackend(backend);
  const mockRes = { ok: true, status: 200 };
  const result = await execute(backend, async () => mockRes);
  assert.equal(result, mockRes);
  assert.equal(isOpen(backend).open, false);
});

test("circuit-breaker: execute records failure on non-ok response", async () => {
  const backend = "test-exec-fail-" + Date.now();
  resetBackend(backend);
  const mockRes = { ok: false, status: 500 };
  for (let i = 0; i < 5; i++) {
    await execute(backend, async () => mockRes);
  }
  assert.equal(isOpen(backend).open, true);
});

test("circuit-breaker: execute throws CIRCUIT_OPEN when open", async () => {
  const backend = "test-exec-open-" + Date.now();
  resetBackend(backend);
  for (let i = 0; i < 5; i++) {
    recordFailure(backend);
  }
  await assert.rejects(
    () => execute(backend, async () => ({ ok: true })),
    (err) => {
      assert.equal(err.code, "CIRCUIT_OPEN");
      assert.ok(err.retryAfterMs > 0);
      return true;
    }
  );
});

test("circuit-breaker: execute rethrows backend errors and records failure", async () => {
  const backend = "test-exec-throw-" + Date.now();
  resetBackend(backend);
  await assert.rejects(
    () => execute(backend, async () => { throw new Error("connection refused"); }),
    { message: "connection refused" }
  );
});
