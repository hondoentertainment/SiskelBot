/**
 * Phase 56.1: Agent sandbox tests.
 *
 * Exercises the pluggable runtime abstraction, mock runtime behavior,
 * sandbox lifecycle, resource limits, volume mounts, logs, and garbage
 * collection. Uses an isolated STORAGE_PATH so persisted state does not
 * leak between suites.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-agent-sandbox-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  SANDBOX_IMAGES,
  DEFAULT_LIMITS,
  registerRuntime,
  getRuntime,
  mockRuntime,
  createSandbox,
  execInSandbox,
  stopSandbox,
  removeSandbox,
  getSandbox,
  listSandboxes,
  getSandboxLogs,
  enforceLimits,
  mountVolume,
  gcStoppedSandboxes,
  _internals,
} = await import("../lib/agent-sandbox.js");

test.beforeEach(async () => {
  await _internals.resetForTests();
});

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- SANDBOX_IMAGES ----

test("SANDBOX_IMAGES exposes node, python, and shell profiles", () => {
  assert.ok(SANDBOX_IMAGES["node-alpine"]);
  assert.equal(SANDBOX_IMAGES["node-alpine"].base, "node:20-alpine");
  assert.deepEqual(SANDBOX_IMAGES["node-alpine"].tools, ["node", "npm"]);
  assert.ok(SANDBOX_IMAGES["python-slim"]);
  assert.equal(SANDBOX_IMAGES["python-slim"].base, "python:3.12-slim");
  assert.ok(SANDBOX_IMAGES["shell"]);
  assert.equal(SANDBOX_IMAGES["shell"].base, "ubuntu:22.04");
});

// ---- registerRuntime / getRuntime ----

test("registerRuntime stores a custom runtime and getRuntime resolves it", () => {
  const calls = [];
  const custom = {
    async pull(img) { calls.push(["pull", img]); return { image: img }; },
    async run(cfg) { calls.push(["run", cfg.image]); return { id: "c1", image: cfg.image, state: "running", startedAt: Date.now() }; },
    async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
    async stop() { return { id: "c1", state: "stopped" }; },
    async remove() { return { removed: true }; },
    async logs() { return []; },
    async list() { return []; },
  };
  registerRuntime("custom", custom);
  assert.equal(getRuntime("custom"), custom);
});

test("registerRuntime rejects incomplete runtimes", () => {
  assert.throws(() => registerRuntime("bad", {}), /must be a function/);
  assert.throws(() => registerRuntime("", mockRuntime), /name is required/);
  assert.throws(() => registerRuntime("null", null), /must be an object/);
});

test("getRuntime throws for unknown runtimes", () => {
  assert.throws(() => getRuntime("does-not-exist"), /not registered/);
});

// ---- mockRuntime exec ----

test("mockRuntime.exec returns deterministic stdout for common commands", async () => {
  const container = await mockRuntime.run({ image: "node:20-alpine" });
  const echoed = await mockRuntime.exec(container.id, "echo hello");
  assert.equal(echoed.exitCode, 0);
  assert.equal(echoed.stdout, "hello\n");
  const pwd = await mockRuntime.exec(container.id, "pwd");
  assert.equal(pwd.stdout, "/workspace\n");
  const fallback = await mockRuntime.exec(container.id, "ls /");
  assert.match(fallback.stdout, /\[mock\] ls \//);
});

// ---- createSandbox ----

test("createSandbox returns a sandbox id and running state", async () => {
  const sandbox = await createSandbox("node-alpine");
  assert.ok(sandbox.sandboxId);
  assert.equal(sandbox.state, "running");
  assert.equal(sandbox.imageKey, "node-alpine");
  assert.equal(sandbox.image, "node:20-alpine");
  assert.ok(sandbox.createdAt > 0);
  assert.deepEqual(sandbox.limits.cpuShares, DEFAULT_LIMITS.cpuShares);
});

test("createSandbox rejects invalid imageKey", async () => {
  await assert.rejects(() => createSandbox("nonexistent"), /invalid imageKey/);
  await assert.rejects(() => createSandbox(""), /invalid imageKey/);
});

test("createSandbox accepts metadata and mounts", async () => {
  const sandbox = await createSandbox("shell", {
    metadata: { agentRun: "run-1" },
    mounts: [{ hostPath: "/tmp/data", containerPath: "/data" }],
  });
  assert.equal(sandbox.metadata.agentRun, "run-1");
  assert.equal(sandbox.mounts.length, 1);
  assert.equal(sandbox.mounts[0].readOnly, true);
});

// ---- execInSandbox ----

test("execInSandbox runs a command and returns stdout", async () => {
  const sandbox = await createSandbox("shell");
  const result = await execInSandbox(sandbox.sandboxId, "echo sandbox");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "sandbox\n");
  assert.equal(result.timedOut, false);
});

test("execInSandbox rejects unknown sandbox ids", async () => {
  await assert.rejects(() => execInSandbox("missing", "echo x"), /not found/);
});

test("execInSandbox rejects when sandbox is stopped", async () => {
  const sandbox = await createSandbox("shell");
  await stopSandbox(sandbox.sandboxId);
  await assert.rejects(() => execInSandbox(sandbox.sandboxId, "echo x"), /not running/);
});

test("execInSandbox honors timeoutSec limit", async () => {
  const sandbox = await createSandbox("shell", { limits: { timeoutSec: 2 } });
  const result = await execInSandbox(sandbox.sandboxId, "sleep 10");
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
});

// ---- stop / remove ----

test("stopSandbox transitions state to stopped", async () => {
  const sandbox = await createSandbox("node-alpine");
  const stopped = await stopSandbox(sandbox.sandboxId);
  assert.equal(stopped.state, "stopped");
  assert.ok(stopped.stoppedAt > 0);
});

test("stopSandbox is idempotent on already-stopped sandboxes", async () => {
  const sandbox = await createSandbox("node-alpine");
  const first = await stopSandbox(sandbox.sandboxId);
  const second = await stopSandbox(sandbox.sandboxId);
  assert.equal(second.state, "stopped");
  assert.equal(first.stoppedAt, second.stoppedAt);
});

test("removeSandbox deletes metadata and reports removed=true", async () => {
  const sandbox = await createSandbox("python-slim");
  await stopSandbox(sandbox.sandboxId);
  const result = await removeSandbox(sandbox.sandboxId);
  assert.equal(result.removed, true);
  assert.equal(await getSandbox(sandbox.sandboxId), null);
});

test("removeSandbox stops a running sandbox before removing", async () => {
  const sandbox = await createSandbox("shell");
  const result = await removeSandbox(sandbox.sandboxId);
  assert.equal(result.removed, true);
  assert.equal(await getSandbox(sandbox.sandboxId), null);
});

test("removeSandbox returns removed=false when the sandbox does not exist", async () => {
  const result = await removeSandbox("nope");
  assert.equal(result.removed, false);
});

// ---- getSandbox / listSandboxes ----

test("getSandbox returns metadata; listSandboxes supports filters", async () => {
  const a = await createSandbox("node-alpine");
  const b = await createSandbox("python-slim");
  await stopSandbox(b.sandboxId);

  const fetched = await getSandbox(a.sandboxId);
  assert.equal(fetched.sandboxId, a.sandboxId);
  assert.equal(fetched.imageKey, "node-alpine");

  const all = await listSandboxes();
  assert.equal(all.length, 2);

  const running = await listSandboxes({ state: "running" });
  assert.equal(running.length, 1);
  assert.equal(running[0].sandboxId, a.sandboxId);

  const byImage = await listSandboxes({ imageKey: "python-slim" });
  assert.equal(byImage.length, 1);
  assert.equal(byImage[0].sandboxId, b.sandboxId);
});

// ---- getSandboxLogs ----

test("getSandboxLogs returns an ordered log of executed commands", async () => {
  const sandbox = await createSandbox("shell");
  await execInSandbox(sandbox.sandboxId, "echo one");
  await execInSandbox(sandbox.sandboxId, "echo two");
  const logs = await getSandboxLogs(sandbox.sandboxId);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].command, "echo one");
  assert.equal(logs[1].command, "echo two");
  const tail = await getSandboxLogs(sandbox.sandboxId, { tail: 1 });
  assert.equal(tail.length, 1);
  assert.equal(tail[0].command, "echo two");
});

// ---- enforceLimits ----

test("enforceLimits caps values at the configured maxima", () => {
  const huge = enforceLimits({ cpuShares: 99999, memoryMB: 999999, timeoutSec: 999999 });
  assert.equal(huge.cpuShares, 4096);
  assert.equal(huge.memoryMB, 8192);
  assert.equal(huge.timeoutSec, 600);
});

test("enforceLimits floors values at the configured minima and applies defaults", () => {
  const tiny = enforceLimits({ cpuShares: 0, memoryMB: 1, timeoutSec: 0 });
  assert.equal(tiny.cpuShares, 2);
  assert.equal(tiny.memoryMB, 16);
  assert.equal(tiny.timeoutSec, 1);
  const defaults = enforceLimits({});
  assert.deepEqual(defaults, DEFAULT_LIMITS);
});

test("enforceLimits rejects unsupported network modes and falls back", () => {
  const normalized = enforceLimits({ network: "internet" });
  assert.equal(normalized.network, "none");
  const host = enforceLimits({ network: "host" });
  assert.equal(host.network, "host");
});

// ---- mountVolume ----

test("mountVolume defaults to read-only and replaces existing mounts", async () => {
  const sandbox = await createSandbox("shell");
  const mount = await mountVolume(sandbox.sandboxId, "/tmp/data", "/data");
  assert.equal(mount.readOnly, true);
  const updated = await mountVolume(sandbox.sandboxId, "/tmp/other", "/data", false);
  assert.equal(updated.readOnly, false);
  const record = await getSandbox(sandbox.sandboxId);
  assert.equal(record.mounts.length, 1);
  assert.equal(record.mounts[0].hostPath, "/tmp/other");
});

test("mountVolume rejects unknown sandbox ids", async () => {
  await assert.rejects(
    () => mountVolume("missing", "/tmp/data", "/data"),
    /not found/,
  );
});

// ---- gcStoppedSandboxes ----

test("gcStoppedSandboxes removes stopped sandboxes older than cutoff", async () => {
  const a = await createSandbox("node-alpine");
  const b = await createSandbox("python-slim");
  await stopSandbox(a.sandboxId);
  // Don't stop b — it should survive GC.
  // Backdate the stop time so it is older than the cutoff.
  const store = await _internals.loadStore();
  store.sandboxes[a.sandboxId].stoppedAt = Date.now() - 120_000;
  await _internals.saveStore(store);

  const result = await gcStoppedSandboxes(60_000);
  assert.deepEqual(result.removed, [a.sandboxId]);
  assert.equal(await getSandbox(a.sandboxId), null);
  assert.ok(await getSandbox(b.sandboxId));
});

test("gcStoppedSandboxes leaves recently-stopped sandboxes intact", async () => {
  const sandbox = await createSandbox("shell");
  await stopSandbox(sandbox.sandboxId);
  const result = await gcStoppedSandboxes(60_000);
  assert.deepEqual(result.removed, []);
  assert.ok(await getSandbox(sandbox.sandboxId));
});
