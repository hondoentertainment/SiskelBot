/**
 * Phase 56.1: Agent sandbox tests.
 *
 * Covers image policy, limit normalization, injectable executor,
 * lifecycle (create/run/destroy), resource-limit mutation, listing,
 * and timeout handling.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-agent-sandbox-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createSandbox,
  runInSandbox,
  destroySandbox,
  listSandboxes,
  getSandbox,
  setResourceLimits,
  setExecutor,
  isImageAllowed,
  normalizeLimits,
  setAllowedImages,
  getAllowedImages,
  HARD_LIMITS,
  DEFAULT_ALLOWED_IMAGES,
} = await import("../lib/agent-sandbox.js");

test.after(() => {
  setExecutor(null);
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */

test("isImageAllowed enforces the default allowlist", () => {
  assert.equal(isImageAllowed("python:3.11-slim"), true);
  assert.equal(isImageAllowed("evil:latest"), false);
  assert.equal(isImageAllowed(""), false);
  assert.equal(isImageAllowed(null), false);
  assert.equal(isImageAllowed("python:3.11-slim", []), false);
});

test("normalizeLimits clamps to HARD_LIMITS and fills defaults", () => {
  const l = normalizeLimits({ cpus: 9999, memoryMb: 99999999, timeoutMs: 9999999999 });
  assert.equal(l.cpus, HARD_LIMITS.cpus);
  assert.equal(l.memoryMb, HARD_LIMITS.memoryMb);
  assert.equal(l.timeoutMs, HARD_LIMITS.timeoutMs);
  const d = normalizeLimits();
  assert.ok(d.cpus > 0 && d.memoryMb > 0 && d.timeoutMs > 0);
  // Below the floor gets raised.
  const tiny = normalizeLimits({ cpus: -5, memoryMb: 1, timeoutMs: 1 });
  assert.ok(tiny.cpus >= 0.1);
  assert.ok(tiny.memoryMb >= 32);
  assert.ok(tiny.timeoutMs >= 100);
});

test("createSandbox persists a record with normalized limits", async () => {
  const rec = await createSandbox({
    image: "python:3.11-slim",
    name: "test-box",
    limits: { cpus: 2, memoryMb: 256, timeoutMs: 1000 },
  });
  assert.ok(rec.id.startsWith("sbx_"));
  assert.equal(rec.image, "python:3.11-slim");
  assert.equal(rec.state, "created");
  assert.equal(rec.limits.memoryMb, 256);
  assert.ok(rec.createdAt);
  const fetched = await getSandbox(rec.id);
  assert.equal(fetched.name, "test-box");
});

test("createSandbox rejects disallowed image", async () => {
  await assert.rejects(() => createSandbox({ image: "evil:latest" }), /not in the allowed/);
  await assert.rejects(() => createSandbox({}), /image is required/);
});

test("runInSandbox invokes the injected executor and records the run", async () => {
  const calls = [];
  setExecutor(async (spec) => {
    calls.push(spec);
    return { exitCode: 0, stdout: "hello", stderr: "", durationMs: 5 };
  });
  const rec = await createSandbox({ image: "alpine:3.19" });
  const res = await runInSandbox(rec.id, ["echo", "hello"]);
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, "hello");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].image, "alpine:3.19");
  assert.deepEqual(calls[0].command, ["echo", "hello"]);
  const after = await getSandbox(rec.id);
  assert.equal(after.state, "idle");
  assert.equal(after.runs.length, 1);
});

test("runInSandbox surfaces executor failures without crashing", async () => {
  setExecutor(async () => {
    throw new Error("docker exploded");
  });
  const rec = await createSandbox({ image: "alpine:3.19" });
  const res = await runInSandbox(rec.id, ["fail"]);
  assert.equal(res.exitCode, -1);
  assert.match(res.stderr, /docker exploded/);
  const after = await getSandbox(rec.id);
  assert.equal(after.state, "error");
});

test("runInSandbox enforces the sandbox timeout", async () => {
  setExecutor(() => new Promise((resolve) => {
    setTimeout(() => resolve({ exitCode: 0, stdout: "late", stderr: "", durationMs: 1000 }), 500);
  }));
  const rec = await createSandbox({ image: "alpine:3.19", limits: { timeoutMs: 150 } });
  const res = await runInSandbox(rec.id, ["sleep"]);
  assert.equal(res.exitCode, -1);
  assert.equal(res.timedOut, true);
});

test("setResourceLimits clamps and persists updates", async () => {
  setExecutor(null);
  const rec = await createSandbox({ image: "node:20-alpine" });
  const updated = await setResourceLimits(rec.id, { memoryMb: 128, cpus: 99999 });
  assert.equal(updated.limits.memoryMb, 128);
  assert.equal(updated.limits.cpus, HARD_LIMITS.cpus);
  const fetched = await getSandbox(rec.id);
  assert.equal(fetched.limits.memoryMb, 128);
});

test("destroySandbox marks the sandbox destroyed and blocks further runs", async () => {
  setExecutor(null);
  const rec = await createSandbox({ image: "debian:bookworm-slim" });
  const dead = await destroySandbox(rec.id);
  assert.equal(dead.state, "destroyed");
  assert.ok(dead.destroyedAt);
  await assert.rejects(() => runInSandbox(rec.id, ["ls"]), /destroyed/);
  // destroying twice is idempotent
  const again = await destroySandbox(rec.id);
  assert.equal(again.state, "destroyed");
});

test("listSandboxes returns all records and supports state filtering", async () => {
  const all = await listSandboxes();
  assert.ok(all.length >= 2);
  const destroyed = await listSandboxes({ state: "destroyed" });
  assert.ok(destroyed.every((s) => s.state === "destroyed"));
});

test("setAllowedImages / getAllowedImages persist policy changes", async () => {
  await setAllowedImages(["python:3.11-slim", "custom:latest"]);
  const allowed = await getAllowedImages();
  assert.deepEqual(allowed, ["python:3.11-slim", "custom:latest"]);
  // restore defaults for subsequent tests
  await setAllowedImages(DEFAULT_ALLOWED_IMAGES.slice());
});
