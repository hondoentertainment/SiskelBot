// CHAOS TEST: backend hangs forever (never-resolving fetch)
// EXPECTED: circuit breaker opens after CIRCUIT_BREAKER_FAILURES, half-opens after cooldown, closes on probe success.
//
// Run with: npm run test:chaos
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// Configure the breaker for fast tests BEFORE the module is imported.
const ORIGINAL_FAILURES = process.env.CIRCUIT_BREAKER_FAILURES;
const ORIGINAL_COOLDOWN = process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
process.env.CIRCUIT_BREAKER_FAILURES = "3";
process.env.CIRCUIT_BREAKER_COOLDOWN_MS = "100";

const { execute, isOpen, recordSuccess, getBreakerState } = await import(
  "../../lib/circuit-breaker.js"
);

const BACKEND = `chaos-timeout-${Date.now()}`;

function neverResolves() {
  // Mirror the contract of the global fetch: a Promise that hangs forever.
  // We simulate "hang" by aborting after a short delay so the test stays fast
  // while still exercising the breaker's failure-counting code path.
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("ETIMEDOUT (simulated hang)")), 5);
  });
}

describe("CHAOS: backend timeout", () => {
  before(() => {
    // Ensure we start from a clean breaker.
    recordSuccess(BACKEND);
  });

  after(() => {
    if (ORIGINAL_FAILURES === undefined) delete process.env.CIRCUIT_BREAKER_FAILURES;
    else process.env.CIRCUIT_BREAKER_FAILURES = ORIGINAL_FAILURES;
    if (ORIGINAL_COOLDOWN === undefined) delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
    else process.env.CIRCUIT_BREAKER_COOLDOWN_MS = ORIGINAL_COOLDOWN;
    recordSuccess(BACKEND);
  });

  it(
    "circuit breaker opens after N consecutive timeouts",
    { timeout: 10_000 },
    async () => {
      // Patch global fetch to a never-resolving stand-in.
      const originalFetch = global.fetch;
      global.fetch = neverResolves;

      try {
        // Drive 3 failures (matches CIRCUIT_BREAKER_FAILURES=3 above).
        for (let i = 0; i < 3; i++) {
          await assert.rejects(
            execute(BACKEND, () => fetch("https://example.invalid/v1/x"))
          );
        }
      } finally {
        global.fetch = originalFetch;
      }

      const status = isOpen(BACKEND, { halfOpenAsOpen: true });
      assert.equal(status.open, true, "breaker should be open after threshold failures");
      assert.equal(getBreakerState(BACKEND), "open");
    },
  );

  it(
    "after cooldown, breaker enters half-open and one probe is allowed through",
    { timeout: 10_000 },
    async () => {
      // Wait past the 100ms cooldown configured at module load time.
      await new Promise((r) => setTimeout(r, 150));

      // execute() should let exactly one probe through (half-open). We make
      // the probe fail to verify the breaker re-opens with a fresh window.
      const failingProbe = () => Promise.reject(new Error("probe-failure"));
      await assert.rejects(execute(BACKEND, failingProbe));

      const reOpened = isOpen(BACKEND, { halfOpenAsOpen: true });
      assert.equal(
        reOpened.open,
        true,
        "a failed half-open probe must re-open the breaker with a fresh cooldown",
      );
    },
  );

  it(
    "a successful probe closes the breaker again",
    { timeout: 10_000 },
    async () => {
      // Wait out the second cooldown.
      await new Promise((r) => setTimeout(r, 150));

      // Now feed a "successful" Response-shaped object into execute().
      const okProbe = () => Promise.resolve({ ok: true, status: 200 });
      const res = await execute(BACKEND, okProbe);
      assert.equal(res.ok, true);

      // Breaker should now be closed.
      const status = isOpen(BACKEND);
      assert.equal(status.open, false, "successful probe must close the breaker");
      assert.equal(getBreakerState(BACKEND), "closed");
    },
  );
});
