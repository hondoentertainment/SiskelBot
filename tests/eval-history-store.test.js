/**
 * Unit tests for lib/eval-history-store.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-eval-history-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const mod = await import("../lib/eval-history-store.js");
const { recordSample, listSamples, getSeries, latest, clearHistory } = mod;

test("recordSample: happy path assigns id and normalizes", async () => {
  const ws = `ws-happy-${Date.now()}`;
  const saved = await recordSample(ws, {
    ts: 1700_000_000_000,
    kind: "benchmark",
    suite: "mini",
    metrics: { passRate: 0.9, total: 10 },
    commit: "abc123",
    tags: { env: "ci" },
  });
  assert.ok(saved.id && typeof saved.id === "string");
  assert.equal(saved.kind, "benchmark");
  assert.equal(saved.suite, "mini");
  assert.equal(saved.metrics.passRate, 0.9);
  assert.equal(saved.metrics.total, 10);
  assert.equal(saved.commit, "abc123");
  assert.deepEqual(saved.tags, { env: "ci" });
});

test("recordSample: validation errors", async () => {
  const ws = `ws-invalid-${Date.now()}`;
  await assert.rejects(
    () => recordSample(ws, { kind: "benchmark", metrics: { passRate: 1 } }),
    /ts must be a finite number/,
  );
  await assert.rejects(
    () => recordSample(ws, { ts: 1, metrics: { passRate: 1 } }),
    /kind must be one of/,
  );
  await assert.rejects(
    () => recordSample(ws, { ts: 1, kind: "bogus", metrics: { passRate: 1 } }),
    /kind must be one of/,
  );
  await assert.rejects(
    () => recordSample(ws, { ts: 1, kind: "benchmark" }),
    /metrics must be an object/,
  );
  await assert.rejects(
    () => recordSample(ws, { ts: 1, kind: "benchmark", metrics: {} }),
    /metrics must be non-empty/,
  );
  await assert.rejects(
    () => recordSample(ws, { ts: 1, kind: "benchmark", metrics: { p: "no" } }),
    /metrics\.p must be a finite number/,
  );
});

test("listSamples: newest-first with filtering", async () => {
  const ws = `ws-list-${Date.now()}`;
  const base = 1_700_000_000_000;
  await recordSample(ws, { ts: base + 1000, kind: "benchmark", suite: "mini", metrics: { passRate: 0.5 } });
  await recordSample(ws, { ts: base + 3000, kind: "benchmark", suite: "mini", metrics: { passRate: 0.7 } });
  await recordSample(ws, { ts: base + 2000, kind: "benchmark", suite: "big", metrics: { passRate: 0.6 } });
  await recordSample(ws, { ts: base + 4000, kind: "safety", suite: "mini", metrics: { passRate: 0.9 } });

  const all = await listSamples(ws);
  assert.equal(all.length, 4);
  assert.ok(all[0].ts >= all[1].ts);
  assert.ok(all[1].ts >= all[2].ts);

  const bench = await listSamples(ws, { kind: "benchmark" });
  assert.equal(bench.length, 3);
  assert.ok(bench.every((s) => s.kind === "benchmark"));

  const benchMini = await listSamples(ws, { kind: "benchmark", suite: "mini" });
  assert.equal(benchMini.length, 2);

  const windowed = await listSamples(ws, {
    kind: "benchmark",
    sinceTs: base + 1500,
    untilTs: base + 2500,
  });
  assert.equal(windowed.length, 1);
  assert.equal(windowed[0].metrics.passRate, 0.6);

  const limited = await listSamples(ws, { limit: 2 });
  assert.equal(limited.length, 2);
});

test("recordSample: ring buffer caps at 10000", async () => {
  const ws = `ws-ring-${Date.now()}`;
  const N = 10_005;
  for (let i = 0; i < N; i++) {
    await recordSample(ws, {
      ts: 1_700_000_000_000 + i,
      kind: "custom",
      metrics: { v: i },
    });
  }
  const all = await listSamples(ws, { limit: 1000 });
  assert.equal(all.length, 1000);
  // The very newest (largest i) should still be present, in front.
  assert.equal(all[0].metrics.v, N - 1);

  // The raw blob holds 10000; the oldest 5 should have been dropped.
  // getSeries(raw) returns every matching metric, so use a wide sample:
  const series = await getSeries(ws, { kind: "custom", metric: "v", bucket: "raw" });
  assert.equal(series.length, 10_000);
  assert.equal(series[0].value, 5); // first surviving sample is i=5
  assert.equal(series[series.length - 1].value, N - 1);
});

test("getSeries: raw bucket returns each sample", async () => {
  const ws = `ws-raw-${Date.now()}`;
  await recordSample(ws, { ts: 100, kind: "benchmark", metrics: { passRate: 0.1 } });
  await recordSample(ws, { ts: 200, kind: "benchmark", metrics: { passRate: 0.2 } });
  const series = await getSeries(ws, { kind: "benchmark", metric: "passRate", bucket: "raw" });
  assert.deepEqual(
    series.map((p) => ({ ts: p.ts, value: p.value, count: p.count })),
    [
      { ts: 100, value: 0.1, count: 1 },
      { ts: 200, value: 0.2, count: 1 },
    ],
  );
});

test("getSeries: day/hour/week bucketing", async () => {
  const ws = `ws-bucket-${Date.now()}`;
  const MS_HOUR = 3_600_000;
  const MS_DAY = 86_400_000;
  // Two samples in same UTC hour, one the next hour, one a week later.
  const t0 = Date.UTC(2024, 0, 1, 0, 0, 0); // Mon 2024-01-01 00:00 UTC
  await recordSample(ws, { ts: t0 + 10_000, kind: "benchmark", suite: "mini", metrics: { passRate: 0.5 } });
  await recordSample(ws, { ts: t0 + 60_000, kind: "benchmark", suite: "mini", metrics: { passRate: 0.7 } });
  await recordSample(ws, { ts: t0 + MS_HOUR + 1000, kind: "benchmark", suite: "mini", metrics: { passRate: 0.9 } });
  await recordSample(ws, { ts: t0 + 7 * MS_DAY + 1000, kind: "benchmark", suite: "mini", metrics: { passRate: 1.0 } });

  const hour = await getSeries(ws, { kind: "benchmark", metric: "passRate", bucket: "hour" });
  // three distinct hour buckets
  assert.equal(hour.length, 3);
  assert.equal(hour[0].ts, t0);            // snaps to UTC hour start
  assert.equal(hour[0].count, 2);
  assert.ok(Math.abs(hour[0].value - 0.6) < 1e-9);

  const day = await getSeries(ws, { kind: "benchmark", metric: "passRate", bucket: "day" });
  // Two day buckets: 2024-01-01 and 2024-01-08
  assert.equal(day.length, 2);
  assert.equal(day[0].ts, t0);
  assert.equal(day[0].count, 3);
  assert.equal(day[1].ts, t0 + 7 * MS_DAY);
  assert.equal(day[1].count, 1);

  const week = await getSeries(ws, { kind: "benchmark", metric: "passRate", bucket: "week" });
  // 2024-01-01 is a Monday → both Monday-anchored weeks are distinct.
  assert.equal(week.length, 2);
  // First week bucket anchors on 2024-01-01 00:00 UTC exactly.
  assert.equal(week[0].ts, t0);
  assert.equal(week[1].ts, t0 + 7 * MS_DAY);
});

test("getSeries: filters by kind+metric+suite", async () => {
  const ws = `ws-filter-${Date.now()}`;
  await recordSample(ws, { ts: 100, kind: "benchmark", suite: "mini", metrics: { passRate: 0.9, total: 10 } });
  await recordSample(ws, { ts: 200, kind: "benchmark", suite: "big", metrics: { passRate: 0.4, total: 50 } });
  await recordSample(ws, { ts: 300, kind: "safety", suite: "mini", metrics: { passRate: 1.0 } });

  const mini = await getSeries(ws, { kind: "benchmark", metric: "passRate", suite: "mini", bucket: "raw" });
  assert.equal(mini.length, 1);
  assert.equal(mini[0].value, 0.9);

  const totalSeries = await getSeries(ws, { kind: "benchmark", metric: "total", bucket: "raw" });
  assert.equal(totalSeries.length, 2);

  const safety = await getSeries(ws, { kind: "safety", metric: "passRate", bucket: "raw" });
  assert.equal(safety.length, 1);
  assert.equal(safety[0].value, 1.0);

  // metric not present on any sample -> empty
  const nope = await getSeries(ws, { kind: "benchmark", metric: "nonesuch", bucket: "raw" });
  assert.equal(nope.length, 0);
});

test("latest: returns most recent matching sample", async () => {
  const ws = `ws-latest-${Date.now()}`;
  await recordSample(ws, { ts: 100, kind: "benchmark", suite: "mini", metrics: { passRate: 0.5 } });
  await recordSample(ws, { ts: 300, kind: "benchmark", suite: "mini", metrics: { passRate: 0.9 } });
  await recordSample(ws, { ts: 200, kind: "benchmark", suite: "big", metrics: { passRate: 0.7 } });

  const lmini = await latest(ws, { kind: "benchmark", suite: "mini" });
  assert.ok(lmini);
  assert.equal(lmini.ts, 300);

  const lany = await latest(ws, { kind: "benchmark" });
  assert.equal(lany.ts, 300);

  const lsafety = await latest(ws, { kind: "safety" });
  assert.equal(lsafety, null);
});

test("clearHistory + workspace isolation", async () => {
  const wsA = `ws-iso-A-${Date.now()}`;
  const wsB = `ws-iso-B-${Date.now()}`;
  await recordSample(wsA, { ts: 1, kind: "custom", metrics: { v: 1 } });
  await recordSample(wsB, { ts: 2, kind: "custom", metrics: { v: 2 } });

  const a = await listSamples(wsA);
  const b = await listSamples(wsB);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].metrics.v, 1);
  assert.equal(b[0].metrics.v, 2);

  await clearHistory(wsA);
  assert.equal((await listSamples(wsA)).length, 0);
  // B untouched
  assert.equal((await listSamples(wsB)).length, 1);
});
