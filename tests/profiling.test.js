/**
 * Phase 60.1: Continuous profiling tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-profiling-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  startProfiler,
  stopProfiler,
  abortProfiler,
  getProfile,
  listProfiles,
  getActiveProfileStatus,
  buildCallTree,
} = await import("../lib/profiling.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test.afterEach(async () => {
  // Clean up any leftover profile between tests.
  try { await abortProfiler(); } catch (_) {}
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

test("startProfiler returns a running profile with id and label", () => {
  const profile = startProfiler({ intervalMs: 20, durationMs: 200, label: "test" });
  assert.ok(profile.id);
  assert.equal(profile.label, "test");
  assert.equal(profile.status, "running");
  assert.equal(profile.intervalMs, 20);
});

test("startProfiler rejects when another profile is already running", () => {
  startProfiler({ intervalMs: 20, durationMs: 500 });
  assert.throws(() => startProfiler({ intervalMs: 20, durationMs: 500 }), /already running/);
});

test("stopProfiler returns completed record with samples and tree", async () => {
  startProfiler({ intervalMs: 20, durationMs: 500 });
  await new Promise((r) => setTimeout(r, 80));
  const record = await stopProfiler();
  assert.equal(record.status, "completed");
  assert.ok(record.sampleCount >= 1);
  assert.ok(Array.isArray(record.samples));
  assert.ok(record.tree);
  assert.equal(record.tree.name, "root");
  assert.ok(Array.isArray(record.tree.children));
});

test("stopProfiler throws when no profiler is running", async () => {
  await assert.rejects(() => stopProfiler(), /no active/);
});

test("getActiveProfileStatus reflects current profile", async () => {
  assert.equal(getActiveProfileStatus(), null);
  startProfiler({ intervalMs: 20, durationMs: 500 });
  const status = getActiveProfileStatus();
  assert.ok(status);
  assert.equal(status.status, "running");
  await stopProfiler();
});

// ─── Retrieval ────────────────────────────────────────────────────────────

test("getProfile loads the saved profile by id", async () => {
  startProfiler({ intervalMs: 20, durationMs: 500, label: "get-test" });
  await new Promise((r) => setTimeout(r, 60));
  const rec = await stopProfiler();
  const loaded = await getProfile(rec.id);
  assert.equal(loaded.id, rec.id);
  assert.equal(loaded.label, "get-test");
});

test("listProfiles returns saved profiles newest-first", async () => {
  startProfiler({ intervalMs: 20, durationMs: 500, label: "list-a" });
  await new Promise((r) => setTimeout(r, 60));
  await stopProfiler();
  startProfiler({ intervalMs: 20, durationMs: 500, label: "list-b" });
  await new Promise((r) => setTimeout(r, 60));
  await stopProfiler();
  const profiles = await listProfiles();
  assert.ok(profiles.length >= 2);
  // newest first — list-b should come before list-a
  const labels = profiles.map((p) => p.label);
  const idxA = labels.indexOf("list-a");
  const idxB = labels.indexOf("list-b");
  assert.ok(idxB < idxA, `expected list-b before list-a, got ${labels}`);
});

// ─── Abort ────────────────────────────────────────────────────────────────

test("abortProfiler marks the profile aborted without the full tree", async () => {
  startProfiler({ intervalMs: 20, durationMs: 5000 });
  await new Promise((r) => setTimeout(r, 30));
  const record = await abortProfiler();
  assert.equal(record.status, "aborted");
  assert.ok(record.abortedAt);
});

test("abortProfiler returns null when nothing is running", async () => {
  const record = await abortProfiler();
  assert.equal(record, null);
});

// ─── Call tree ────────────────────────────────────────────────────────────

test("buildCallTree returns a root with cpu and memory children", () => {
  const samples = [
    { cpuDeltaUs: 5000, heap: { used: 1_000_000 }, rss: 10_000_000 },
    { cpuDeltaUs: 7000, heap: { used: 2_000_000 }, rss: 12_000_000 },
  ];
  const tree = buildCallTree(samples);
  assert.equal(tree.name, "root");
  assert.equal(tree.value, 2);
  const cpu = tree.children.find((c) => c.name === "cpu");
  const mem = tree.children.find((c) => c.name === "memory");
  assert.ok(cpu);
  assert.ok(mem);
  assert.ok(cpu.value >= 0);
  assert.ok(mem.value >= 0);
});

test("buildCallTree handles empty sample arrays", () => {
  const tree = buildCallTree([]);
  assert.equal(tree.name, "root");
  assert.equal(tree.value, 0);
  assert.deepEqual(tree.children, []);
});

// ─── Validation ──────────────────────────────────────────────────────────

test("startProfiler clamps intervalMs to a minimum", () => {
  const profile = startProfiler({ intervalMs: 1, durationMs: 200 });
  assert.ok(profile.intervalMs >= 10);
});
