/**
 * Coverage tests for lib/circuit-breaker.js — fills gaps in the existing
 * circuit-breaker.test.js (cooldown expiry + execute success/failure edges).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  recordFailure,
  recordSuccess,
  isOpen,
  execute,
  getBreakerState,
  getBreakerSnapshot,
} from "../lib/circuit-breaker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const CIRCUIT_BREAKER_URL = pathToFileURL(join(REPO, "lib", "circuit-breaker.js")).href;

test("recordFailure returns true once threshold reached, false otherwise", () => {
  const backend = "cb-cov-threshold-" + Date.now();
  recordSuccess(backend);
  for (let i = 0; i < 4; i++) {
    assert.equal(recordFailure(backend), false, `failure ${i + 1} should not open`);
  }
  const opened = recordFailure(backend);
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
    const m = await import("${CIRCUIT_BREAKER_URL}");
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

// ---- Tri-state half_open tests -----------------------------------------

test("getBreakerState: initial state is 'closed' for unknown backends", () => {
  const backend = "cb-cov-state-initial-" + Date.now();
  assert.equal(getBreakerState(backend), "closed");
});

test("getBreakerState: transitions closed -> open after N failures", () => {
  const backend = "cb-cov-state-open-" + Date.now();
  recordSuccess(backend);
  for (let i = 0; i < 5; i++) recordFailure(backend);
  assert.equal(getBreakerState(backend), "open");
});

// Drive the full closed -> open -> half_open -> closed cycle in a child
// process so we can set a very short cooldown and avoid flaky waits.
test("tri-state: open -> half_open after cooldown; success -> closed", () => {
  const script = `
    import assert from "node:assert/strict";
    const m = await import("${CIRCUIT_BREAKER_URL}");
    const backend = "child-tri-success";
    // Drive to open
    for (let i = 0; i < 3; i++) m.recordFailure(backend);
    assert.equal(m.getBreakerState(backend), "open");
    assert.equal(m.isOpen(backend, { halfOpenAsOpen: true }).open, true);
    // Wait past cooldown (10ms)
    const deadline = Date.now() + 40;
    while (Date.now() < deadline) { /* spin */ }
    // Observing state promotes to half_open via execute() path; check via
    // strict halfOpenAsOpen flag so we can see the half_open label.
    assert.equal(m.getBreakerState(backend), "half_open");
    const strict = m.isOpen(backend, { halfOpenAsOpen: true });
    assert.equal(strict.open, true);
    assert.equal(strict.state, "half_open");
    // execute() promotes + lets the probe through; success closes.
    const res = await m.execute(backend, async () => ({ ok: true, status: 200 }));
    assert.equal(res.ok, true);
    assert.equal(m.getBreakerState(backend), "closed");
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

test("tri-state: half_open failure -> open with fresh cooldown", () => {
  const script = `
    import assert from "node:assert/strict";
    const m = await import("${CIRCUIT_BREAKER_URL}");
    const backend = "child-tri-fail";
    for (let i = 0; i < 3; i++) m.recordFailure(backend);
    assert.equal(m.getBreakerState(backend), "open");
    const snapOpen1 = m.getBreakerSnapshot(backend);
    const cooldown1 = snapOpen1.cooldownRemainingMs;
    assert.ok(cooldown1 > 0, "first cooldown should be positive");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(m.getBreakerState(backend), "half_open");
    // A failure in half_open re-opens with fresh cooldown.
    const reopened = m.recordFailure(backend);
    assert.equal(reopened, true, "half_open failure should re-open");
    assert.equal(m.getBreakerState(backend), "open");
    const snapOpen2 = m.getBreakerSnapshot(backend);
    assert.ok(snapOpen2.cooldownRemainingMs > 0, "fresh cooldown expected");
    // Fresh cooldown window should be close to the configured 10ms, not
    // a leftover slice of the previous window.
    assert.ok(snapOpen2.cooldownRemainingMs <= 10, "fresh cooldown should be ~full window");
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

test("isOpen: halfOpenAsOpen:true reports half_open as open:true", () => {
  const script = `
    import assert from "node:assert/strict";
    const m = await import("${CIRCUIT_BREAKER_URL}");
    const backend = "child-halfopen-flag";
    for (let i = 0; i < 3; i++) m.recordFailure(backend);
    // Wait past cooldown.
    const deadline = Date.now() + 40;
    while (Date.now() < deadline) { /* spin */ }
    // Default: legacy behavior — open:false, state cleared.
    const legacy = m.isOpen(backend);
    assert.equal(legacy.open, false, "default mode treats cooldown-elapsed as recovered");
    // Re-drive to open for the strict-mode check.
    for (let i = 0; i < 3; i++) m.recordFailure(backend);
    const d2 = Date.now() + 40;
    while (Date.now() < d2) { /* spin */ }
    const strict = m.isOpen(backend, { halfOpenAsOpen: true });
    assert.equal(strict.open, true);
    assert.equal(strict.state, "half_open");
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

test("getBreakerSnapshot(name): returns full row with all fields", () => {
  const backend = "cb-cov-snapshot-name-" + Date.now();
  recordSuccess(backend);
  recordFailure(backend);
  recordFailure(backend);
  const row = getBreakerSnapshot(backend);
  assert.equal(row.name, backend);
  assert.equal(row.state, "closed"); // below threshold
  assert.equal(row.failures, 2);
  assert.equal(typeof row.lastFailureAt, "string");
  assert.ok(!Number.isNaN(Date.parse(row.lastFailureAt)));
  assert.equal(typeof row.cooldownRemainingMs, "number");
  assert.ok(row.cooldownRemainingMs >= 0);
});

test("getBreakerSnapshot(name): unknown backend returns closed/zeroed row", () => {
  const backend = "cb-cov-snapshot-unknown-" + Date.now();
  const row = getBreakerSnapshot(backend);
  assert.equal(row.name, backend);
  assert.equal(row.state, "closed");
  assert.equal(row.failures, 0);
  assert.equal(row.lastFailureAt, null);
  assert.equal(row.cooldownRemainingMs, 0);
});

test("getBreakerSnapshot(): returns array of all known breakers", () => {
  const tag = "cb-cov-snapshot-all-" + Date.now();
  const a = tag + "-a";
  const b = tag + "-b";
  recordSuccess(a);
  recordSuccess(b);
  recordFailure(a);
  recordFailure(b);
  recordFailure(b);
  const rows = getBreakerSnapshot();
  assert.ok(Array.isArray(rows));
  const rowA = rows.find((r) => r.name === a);
  const rowB = rows.find((r) => r.name === b);
  assert.ok(rowA, "row for backend a expected");
  assert.ok(rowB, "row for backend b expected");
  assert.equal(rowA.failures, 1);
  assert.equal(rowB.failures, 2);
  for (const r of [rowA, rowB]) {
    assert.ok(["closed", "open", "half_open"].includes(r.state));
    assert.ok(typeof r.cooldownRemainingMs === "number");
    assert.ok(r.lastFailureAt === null || typeof r.lastFailureAt === "string");
  }
});
