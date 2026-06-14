/**
 * Coverage tests for lib/agent-run-control.js
 * Covers the MAX_CONCURRENT=0 path (no-op) because that's the default env.
 * We spawn a child Node process to exercise the MAX_CONCURRENT>0 path without
 * leaking env state into the rest of the test suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const AGENT_RUN_CONTROL_URL = pathToFileURL(join(REPO, "lib", "agent-run-control.js")).href;

// Import the module under the default "unlimited" configuration (MAX_CONCURRENT=0).
// This covers the getMaxConcurrentRunsPerWorkspace / ok-path branches.
const mod = await import("../lib/agent-run-control.js");

test("getMaxConcurrentRunsPerWorkspace returns 0 by default", () => {
  assert.equal(mod.getMaxConcurrentRunsPerWorkspace(), 0);
});

test("tryBeginWorkspaceAgentRun is a no-op when MAX_CONCURRENT=0", () => {
  const r = mod.tryBeginWorkspaceAgentRun("ws-a");
  assert.deepEqual(r, { ok: true });
});

test("endWorkspaceAgentRun is a no-op when MAX_CONCURRENT=0", () => {
  // Should not throw when called without a matching begin
  mod.endWorkspaceAgentRun("ws-never-began");
  mod.endWorkspaceAgentRun(null);
  mod.endWorkspaceAgentRun(undefined);
  mod.endWorkspaceAgentRun("");
});

test("bindSessionAbortController returns null controller for empty sessionId", () => {
  const r = mod.bindSessionAbortController("");
  assert.equal(r.controller, null);
  assert.equal(typeof r.release, "function");
  // release is a safe no-op
  r.release();
});

test("bindSessionAbortController returns null controller for whitespace sessionId", () => {
  const r = mod.bindSessionAbortController("    ");
  assert.equal(r.controller, null);
  r.release();
});

test("bindSessionAbortController returns a fresh AbortController for a valid sessionId", () => {
  const { controller, release } = mod.bindSessionAbortController("sess-fresh-1");
  try {
    assert.ok(controller instanceof AbortController);
    assert.equal(controller.signal.aborted, false);
  } finally {
    release();
  }
});

test("binding a second controller for the same session aborts the prior one", () => {
  const first = mod.bindSessionAbortController("sess-supersede");
  const second = mod.bindSessionAbortController("sess-supersede");
  assert.equal(first.controller.signal.aborted, true, "first controller should be aborted by second bind");
  assert.equal(second.controller.signal.aborted, false, "second controller starts fresh");
  second.release();
});

test("release does not delete a newer controller from the map", () => {
  const first = mod.bindSessionAbortController("sess-release-old");
  const second = mod.bindSessionAbortController("sess-release-old");
  // The first release is a no-op for the current map entry
  first.release();
  // cancel should still work because `second` is still bound
  const r = mod.cancelAgentSessionRun("sess-release-old");
  assert.deepEqual(r, { ok: true });
  assert.equal(second.controller.signal.aborted, true);
});

test("cancelAgentSessionRun returns NO_ACTIVE_RUN for unknown session", () => {
  const r = mod.cancelAgentSessionRun("definitely-not-bound-" + Date.now());
  assert.deepEqual(r, { ok: false, code: "NO_ACTIVE_RUN" });
});

test("cancelAgentSessionRun trims whitespace before lookup", () => {
  const sid = "sess-trim-1";
  const { release } = mod.bindSessionAbortController(sid);
  try {
    const r = mod.cancelAgentSessionRun(`  ${sid}  `);
    assert.deepEqual(r, { ok: true });
  } finally {
    release();
  }
});

test("cancelAgentSessionRun with null sessionId returns NO_ACTIVE_RUN", () => {
  const r = mod.cancelAgentSessionRun(null);
  assert.deepEqual(r, { ok: false, code: "NO_ACTIVE_RUN" });
});

test("release of current controller removes entry so subsequent cancel is NO_ACTIVE_RUN", () => {
  const sid = "sess-release-current";
  const { release } = mod.bindSessionAbortController(sid);
  release();
  const r = mod.cancelAgentSessionRun(sid);
  assert.deepEqual(r, { ok: false, code: "NO_ACTIVE_RUN" });
});

// ---- Child-process path: exercise MAX_CONCURRENT > 0 branches ----
test("with AGENT_MAX_CONCURRENT_RUNS_PER_WORKSPACE=1 the second run is blocked and end decrements", () => {
  const script = `
    import assert from "node:assert/strict";
    const m = await import("${AGENT_RUN_CONTROL_URL}");
    assert.equal(m.getMaxConcurrentRunsPerWorkspace(), 1);
    const a = m.tryBeginWorkspaceAgentRun("ws1");
    assert.deepEqual(a, { ok: true });
    const b = m.tryBeginWorkspaceAgentRun("ws1");
    assert.equal(b.ok, false);
    assert.equal(b.code, "AGENT_RUN_CONCURRENCY");
    assert.equal(b.max, 1);
    // A different workspace has its own counter
    const c = m.tryBeginWorkspaceAgentRun("ws2");
    assert.deepEqual(c, { ok: true });
    // Ending ws1 frees capacity
    m.endWorkspaceAgentRun("ws1");
    const d = m.tryBeginWorkspaceAgentRun("ws1");
    assert.deepEqual(d, { ok: true });
    // endWorkspaceAgentRun floors at zero
    m.endWorkspaceAgentRun("ws1");
    m.endWorkspaceAgentRun("ws1");
    m.endWorkspaceAgentRun("ws1");
    // Begin with null/undefined workspace defaults to "default"
    const e = m.tryBeginWorkspaceAgentRun(null);
    assert.deepEqual(e, { ok: true });
    m.endWorkspaceAgentRun(undefined);
    console.log("CHILD_OK");
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, AGENT_MAX_CONCURRENT_RUNS_PER_WORKSPACE: "1" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `child process failed: ${r.stderr}`);
  assert.ok(r.stdout.includes("CHILD_OK"), `child stdout: ${r.stdout}`);
});
