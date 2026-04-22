import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "eval-run-hist-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  recordEvalRun,
  listEvalRuns,
  detectRegression,
  getPassRateTrend,
} = await import("../lib/eval-run-history.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("recordEvalRun: rejects missing fields", async () => {
  assert.equal(await recordEvalRun(null), false);
  assert.equal(await recordEvalRun({ suiteId: "x" }), false);
  assert.equal(await recordEvalRun({ suiteId: "", passed: 1, total: 1 }), false);
});

test("recordEvalRun: persists a run", async () => {
  const ok = await recordEvalRun({
    suiteId: "golden-test",
    passed: 8,
    total: 10,
    results: [{ id: "c1", pass: true }, { id: "c2", pass: false, reason: "mismatch" }],
  });
  assert.equal(ok, true);
  const list = await listEvalRuns({ suiteId: "golden-test" });
  assert.equal(list.length, 1);
  assert.equal(list[0].passed, 8);
  assert.equal(list[0].passRate, 0.8);
});

test("detectRegression: returns null with fewer than 2 runs", async () => {
  const r = await detectRegression("regression-suite");
  assert.equal(r, null);
});

test("detectRegression: null when pass rate improves", async () => {
  await recordEvalRun({ suiteId: "improves", passed: 5, total: 10 });
  await recordEvalRun({ suiteId: "improves", passed: 9, total: 10 });
  const r = await detectRegression("improves");
  assert.equal(r, null);
});

test("detectRegression: detects drop", async () => {
  await recordEvalRun({ suiteId: "drops", passed: 10, total: 10 });
  await recordEvalRun({ suiteId: "drops", passed: 5, total: 10 });
  const r = await detectRegression("drops");
  assert.ok(r);
  assert.equal(r.current, 0.5);
  assert.equal(r.previous, 1);
  assert.ok(r.delta < 0);
});

test("getPassRateTrend: returns oldest-first points", async () => {
  await recordEvalRun({ suiteId: "trend", passed: 1, total: 10 });
  await recordEvalRun({ suiteId: "trend", passed: 5, total: 10 });
  await recordEvalRun({ suiteId: "trend", passed: 9, total: 10 });
  const trend = await getPassRateTrend("trend");
  assert.equal(trend.length, 3);
  assert.ok(trend[0].t <= trend[1].t);
  assert.equal(trend[2].passRate, 0.9);
});
