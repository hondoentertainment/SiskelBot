/**
 * Phase 57.2: Data quality tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-dq-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  computeDrift,
  ksStatistic,
  psi,
  addRule,
  evaluateRules,
  getDriftReport,
  recordDriftReport,
  listRules,
} = await import("../lib/data-quality.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */

test("ksStatistic is 0 for identical samples", () => {
  const a = [1, 2, 3, 4, 5];
  assert.equal(ksStatistic(a, a), 0);
});

test("ksStatistic detects large shifts", () => {
  const a = [1, 2, 3, 4, 5];
  const b = [100, 101, 102, 103, 104];
  const k = ksStatistic(a, b);
  assert.ok(k > 0.9);
});

test("psi returns 0 for identical distributions", () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(psi(a, a), 0);
});

test("psi is larger for more divergent distributions", () => {
  const base = Array.from({ length: 100 }, (_, i) => i);
  const small = Array.from({ length: 100 }, (_, i) => i + 1);
  const big = Array.from({ length: 100 }, (_, i) => i + 200);
  assert.ok(psi(base, big) > psi(base, small));
});

test("computeDrift marks no-drift when samples match", () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const out = computeDrift(a, a);
  assert.equal(out.drifted, false);
  assert.equal(out.ks, 0);
});

test("computeDrift flags drift when samples diverge", () => {
  const a = Array.from({ length: 50 }, (_, i) => i);
  const b = Array.from({ length: 50 }, (_, i) => i + 100);
  const out = computeDrift(a, b);
  assert.equal(out.drifted, true);
  assert.ok(out.ks >= 0.15);
});

test("addRule persists a rule and listRules returns it", async () => {
  await addRule("min_latency", { op: "gte", value: 0, metric: "latency" });
  await addRule("bounded", { op: "in_range", min: 0, max: 100, metric: "score" });
  const rules = await listRules();
  const names = rules.map((r) => r.name);
  assert.ok(names.includes("min_latency"));
  assert.ok(names.includes("bounded"));
});

test("addRule rejects invalid op", async () => {
  await assert.rejects(() => addRule("bad", { op: "nope", value: 1 }), /unknown op/);
  await assert.rejects(() => addRule("", { op: "gt", value: 1 }), /required/);
});

test("evaluateRules reports pass/fail per rule", async () => {
  await addRule("min_count_rule", { op: "min_count", value: 3, metric: "score" });
  await addRule("max_val_rule", { op: "lte", value: 100, metric: "score" });
  const ok = await evaluateRules("score", [50, 60, 70, 80]);
  assert.equal(ok.passed, true);
  const fail = await evaluateRules("score", [150, 200]);
  assert.equal(fail.passed, false);
  const mcResult = fail.rules.find((r) => r.name === "min_count_rule");
  assert.equal(mcResult.passed, false);
});

test("evaluateRules supports in_range, not_null, unique_pct", async () => {
  await addRule("range_rule", { op: "in_range", min: 0, max: 10, metric: "t" });
  await addRule("null_rule", { op: "not_null", metric: "t" });
  await addRule("uniq_rule", { op: "unique_pct", value: 0.5, metric: "t" });
  const good = await evaluateRules("t", [1, 2, 3, 4, 5]);
  assert.equal(good.passed, true);
  const badRange = await evaluateRules("t", [1, 20]);
  const r = badRange.rules.find((x) => x.name === "range_rule");
  assert.equal(r.passed, false);
});

test("recordDriftReport and getDriftReport persist history", async () => {
  const a = [1, 2, 3];
  const b = [4, 5, 6];
  const report = computeDrift(a, b);
  await recordDriftReport("feature.x", report);
  await recordDriftReport("feature.x", report);
  const fetched = await getDriftReport("feature.x");
  assert.ok(fetched);
  assert.equal(fetched.history.length, 2);
  assert.ok(fetched.latest.ks >= 0);
});

test("getDriftReport returns null for unknown feature", async () => {
  assert.equal(await getDriftReport("missing"), null);
});
