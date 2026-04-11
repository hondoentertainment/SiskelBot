/**
 * Phase 60.1: continuous-profiling tests.
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
  getSamples,
  getFlameData,
  clearProfile,
  listProfiles,
  pushSample,
  captureSample,
  syntheticStack,
  summarizeSamples,
} = await import("../lib/continuous-profiling.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("captureSample returns a normalized sample", () => {
  const s = captureSample();
  assert.ok(typeof s.t === "number");
  assert.ok(typeof s.heapUsed === "number");
  assert.ok(typeof s.rss === "number");
  assert.ok(Array.isArray(s.stack));
});

test("captureSample accepts injected clock and memory usage", () => {
  const s = captureSample({
    hrtime: () => 42,
    memoryUsage: () => /** @type {any} */ ({ rss: 100, heapUsed: 50, heapTotal: 75, external: 5 }),
    stack: () => ["frame:a", "frame:b"],
  });
  assert.equal(s.t, 42);
  assert.equal(s.rss, 100);
  assert.equal(s.heapUsed, 50);
  assert.deepEqual(s.stack, ["frame:a", "frame:b"]);
});

test("syntheticStack returns a non-empty frame list", () => {
  const frames = syntheticStack();
  assert.ok(Array.isArray(frames));
  // Always at least one frame (the caller of syntheticStack itself).
  assert.ok(frames.length > 0);
});

test("startProfiler without autoStart records no samples", async () => {
  const prof = await startProfiler({ autoStart: false, name: "no-auto", durationMs: 1000 });
  assert.ok(prof.id);
  assert.equal(prof.name, "no-auto");
  const samples = await getSamples(prof.id);
  assert.ok(samples);
  assert.equal(samples.samples.length, 0);
  await stopProfiler(prof.id);
});

test("pushSample appends samples and stopProfiler persists them", async () => {
  const prof = await startProfiler({ autoStart: false, name: "pushed" });
  pushSample(prof.id, { t: 1, cpuMs: 5, heapUsed: 1000, stack: ["a", "b"] });
  pushSample(prof.id, { t: 2, cpuMs: 7, heapUsed: 2000, stack: ["a", "b"] });
  pushSample(prof.id, { t: 3, cpuMs: 4, heapUsed: 1500, stack: ["c"] });
  const stopped = await stopProfiler(prof.id);
  assert.ok(stopped);
  assert.equal(stopped.sampleCount, 3);
  assert.ok(stopped.summary);
  assert.equal(stopped.summary.count, 3);
  assert.equal(stopped.summary.cpuTotalMs, 16);
  assert.equal(stopped.summary.peakHeapUsed, 2000);
});

test("getSamples returns persisted samples after stop", async () => {
  const prof = await startProfiler({ autoStart: false, name: "persisted" });
  pushSample(prof.id, { t: 1, cpuMs: 2, heapUsed: 500, stack: ["f1"] });
  await stopProfiler(prof.id);
  const res = await getSamples(prof.id);
  assert.ok(res);
  assert.equal(res.running, false);
  assert.equal(res.samples.length, 1);
});

test("getFlameData folds stacks and counts them", async () => {
  const prof = await startProfiler({ autoStart: false, name: "flame" });
  pushSample(prof.id, { t: 1, cpuMs: 1, stack: ["root", "child"] });
  pushSample(prof.id, { t: 2, cpuMs: 2, stack: ["root", "child"] });
  pushSample(prof.id, { t: 3, cpuMs: 3, stack: ["root", "other"] });
  pushSample(prof.id, { t: 4, cpuMs: 0, stack: [] });
  const flame = await getFlameData(prof.id);
  assert.ok(flame);
  const byStack = Object.fromEntries(flame.folded.map((f) => [f.stack, f]));
  assert.equal(byStack["child;root"].count, 2);
  assert.equal(byStack["other;root"].count, 1);
  assert.equal(byStack["(root)"].count, 1);
  await stopProfiler(prof.id);
});

test("summarizeSamples handles empty input", () => {
  const s = summarizeSamples([]);
  assert.equal(s.count, 0);
  assert.equal(s.cpuTotalMs, 0);
  assert.equal(s.peakHeapUsed, 0);
});

test("listProfiles includes persisted profiles", async () => {
  const prof = await startProfiler({ autoStart: false, name: "listed" });
  pushSample(prof.id, { t: 1, cpuMs: 1, stack: ["f"] });
  await stopProfiler(prof.id);
  const list = await listProfiles();
  assert.ok(Array.isArray(list));
  assert.ok(list.some((p) => p.id === prof.id));
});

test("clearProfile removes one profile and all profiles", async () => {
  const a = await startProfiler({ autoStart: false, name: "a" });
  const b = await startProfiler({ autoStart: false, name: "b" });
  pushSample(a.id, { t: 1, cpuMs: 1 });
  pushSample(b.id, { t: 1, cpuMs: 1 });
  await stopProfiler(a.id);
  await stopProfiler(b.id);
  await clearProfile(a.id);
  const listed = await listProfiles();
  assert.ok(!listed.some((p) => p.id === a.id));
  await clearProfile();
  const after = await listProfiles();
  assert.equal(after.length, 0);
});

test("getSamples returns null for unknown id", async () => {
  const res = await getSamples("does-not-exist");
  assert.equal(res, null);
});

test("stopProfiler on unknown id returns null", async () => {
  const res = await stopProfiler("nope");
  assert.equal(res, null);
});
