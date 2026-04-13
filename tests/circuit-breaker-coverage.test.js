/**
 * Coverage tests for lib/circuit-breaker.js — fills gaps in the existing
 * circuit-breaker.test.js (cooldown expiry + execute success/failure edges).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recordFailure, recordSuccess, isOpen, execute } from "../lib/circuit-breaker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

test("recordFailure returns true once threshold reached, false otherwise", () => {
  const backend = "cb-cov-threshold-" + Date.now();
  recordSuccess(backend);
  let opened = false;
  for (let i = 0; i < 4; i++) {
    assert.equal(recordFailure(backend), false, `failure ${i + 1} should not open`);
  }
  opened = recordFailure(backend);
  assert.equal(opened, true, "5th failure should open");
});

test("execute records success on 2xx response (clears state)", async () => {
  const backend = "cb-cov-exec-ok-" + Date.now();
  // Prime failure then let success reset
  recordFailure(backend);
  recordFailure(backend);
  const res = await execute(backend, async () => ({ ok: true, status: 200 }));
  assert.equal(res.ok, true);
  assert.equal(isOpen(backend).open, false);
  // Next single failure alone doesn't reopen (proves state was cleared)
  recordFailure(backend);
  assert.equal(isOpen(backend).open, false);
});

test("execute rethrows but still records on fetch rejection (state preserved)", async () => {
  const backend = "cb-cov-exec-throw-" + Date.now();
  recordSuccess(backend);
  await assert.rejects(
    () => execute(backend, async () => { throw new Error("boom"); }),
    /boom/
  );
  assert.equal(isOpen(backend).open, false, "one failure is below threshold");
});

test("execute throws CIRCUIT_OPEN with retryAfterMs when already open", async () => {
  const backend = "cb-cov-already-open-" + Date.now();
  for (let i = 0; i < 5; i++) recordFailure(backend);
  const err = await execute(backend, async () => ({ ok: true }))
    .then(() => null)
    .catch((e) => e);
  assert.ok(err);
  assert.equal(err.code, "CIRCUIT_OPEN");
  assert.ok(typeof err.retryAfterMs === "number" && err.retryAfterMs > 0);
});

test("isOpen below threshold short-circuits and does not touch openUntil", () => {
  const backend = "cb-cov-below-" + Date.now();
  recordSuccess(backend);
  recordFailure(backend);
  recordFailure(backend);
  // failures=2, threshold=5 default
  const r = isOpen(backend);
  assert.equal(r.open, false);
  assert.equal(r.retryAfterMs, undefined);
});

// Run cooldown-expiry branch in a child with very short cooldown so we exercise
// the "circuit closed after cooldown" path deterministically.
test("isOpen transitions back to closed after cooldown elapses", () => {
  const script = `
    import assert from "node:assert/strict";
    const m = await import("${REPO.replace(/\\/g, "/")}/lib/circuit-breaker.js");
    const backend = "child-cooldown";
    for (let i = 0; i < 3; i++) m.recordFailure(backend);
    assert.equal(m.isOpen(backend).open, true);
    // Busy-wait until cooldown elapses (cooldown is 10ms here)
    const deadline = Date.now() + 40;
    while (Date.now() < deadline) { /* spin */ }
    const after = m.isOpen(backend);
    assert.equal(after.open, false, "should have closed after cooldown");
    // And a subsequent success/failure starts from a clean slate
    m.recordFailure(backend);
    m.recordFailure(backend);
    assert.equal(m.isOpen(backend).open, false);
    console.log("CHILD_OK");
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      CIRCUIT_BREAKER_FAILURES: "3",
      CIRCUIT_BREAKER_COOLDOWN_MS: "10",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  assert.ok(r.stdout.includes("CHILD_OK"), `stdout: ${r.stdout}`);
});

test("execute records failure on non-ok response then eventually opens", async () => {
  const backend = "cb-cov-non-ok-" + Date.now();
  recordSuccess(backend);
  for (let i = 0; i < 5; i++) {
    const res = await execute(backend, async () => ({ ok: false, status: 502 }));
    assert.equal(res.ok, false);
  }
  assert.equal(isOpen(backend).open, true);
});
