/**
 * Phase 64.5: Reproducibility checks tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-reproducibility-checks-"));
process.env.STORAGE_PATH = TMP;

const {
  createCheck,
  runCheck,
  getCheckReport,
  listChecks,
  getDefaultChecklist,
  _reset,
} = await import("../lib/reproducibility-checks.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("getDefaultChecklist returns the expected items", () => {
  const list = getDefaultChecklist();
  const ids = list.map((i) => i.id);
  for (const expected of [
    "code-version-pinned",
    "seed-recorded",
    "data-hash-recorded",
    "dependency-lockfile-present",
    "hardware-documented",
    "env-captured",
    "metrics-recorded",
    "artifacts-stored",
  ]) {
    assert.ok(ids.includes(expected), `missing item ${expected}`);
  }
  for (const item of list) {
    assert.ok(typeof item.label === "string");
    assert.ok(typeof item.weight === "number" && item.weight > 0);
    assert.equal(typeof item.required, "boolean");
  }
});

test("createCheck uses the default checklist when items omitted", async () => {
  await _reset("ws-def");
  const check = await createCheck({ workspaceId: "ws-def", experimentId: "exp-1" });
  assert.ok(check.id);
  assert.equal(check.experimentId, "exp-1");
  assert.equal(check.status, "pending");
  assert.equal(check.items.length, getDefaultChecklist().length);
});

test("createCheck accepts custom items and filters malformed ones", async () => {
  await _reset("ws-cust");
  const check = await createCheck({
    workspaceId: "ws-cust",
    items: [
      { id: "custom-one", label: "Custom 1", weight: 5, required: true },
      { id: "custom-two", weight: -1 }, // invalid weight → normalized to 1
      { label: "no id" }, // filtered out
      "bogus",
    ],
  });
  assert.equal(check.items.length, 2);
  assert.equal(check.items[0].id, "custom-one");
  assert.equal(check.items[1].weight, 1);
});

test("runCheck computes score and letter grade (all pass)", async () => {
  await _reset("ws-run");
  const check = await createCheck({ workspaceId: "ws-run" });
  const results = {};
  for (const item of getDefaultChecklist()) results[item.id] = true;
  const report = await runCheck({ checkId: check.id, results });
  assert.equal(report.passed, getDefaultChecklist().length);
  assert.equal(report.failed, 0);
  assert.equal(report.skipped, 0);
  assert.equal(report.score, 100);
  assert.equal(report.grade, "A");
  assert.equal(report.requiredSatisfied, true);
});

test("runCheck tracks failed and skipped items", async () => {
  await _reset();
  const check = await createCheck({ workspaceId: "ws-part" });
  const results = {
    "code-version-pinned": true,
    "seed-recorded": false,
    "data-hash-recorded": true,
    // others omitted → skipped
  };
  const report = await runCheck({ checkId: check.id, results });
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 1);
  assert.ok(report.skipped >= 5);
  assert.ok(report.failedItems.includes("seed-recorded"));
  assert.equal(report.requiredSatisfied, false);
  assert.ok(report.missingRequired.length > 0);
});

test("runCheck produces B/C/D/F by score thresholds", async () => {
  await _reset();
  const items = [
    { id: "a", weight: 10, required: false },
    { id: "b", weight: 10, required: false },
  ];

  const ck1 = await createCheck({ workspaceId: "ws-grade", items });
  const r1 = await runCheck({ checkId: ck1.id, results: { a: true, b: true } });
  assert.equal(r1.grade, "A");

  const ck2 = await createCheck({ workspaceId: "ws-grade", items });
  const r2 = await runCheck({ checkId: ck2.id, results: { a: true, b: false } });
  assert.equal(r2.score, 50);
  assert.equal(r2.grade, "F");

  const ck3 = await createCheck({
    workspaceId: "ws-grade",
    items: [
      { id: "big", weight: 8, required: false },
      { id: "small", weight: 2, required: false },
    ],
  });
  const r3 = await runCheck({ checkId: ck3.id, results: { big: true, small: false } });
  assert.equal(r3.score, 80);
  assert.equal(r3.grade, "B");
});

test("runCheck rejects bad inputs", async () => {
  await assert.rejects(() => runCheck({ checkId: "", results: {} }), /checkId is required/);
  await assert.rejects(() => runCheck({ checkId: "x", results: null }), /results must be an object/);
  await assert.rejects(() => runCheck({ checkId: "nope", results: {} }), /not found/);
});

test("getCheckReport returns persisted check with report", async () => {
  await _reset();
  const check = await createCheck({ workspaceId: "ws-get" });
  await runCheck({ checkId: check.id, results: { "seed-recorded": true } });
  const got = await getCheckReport(check.id);
  assert.ok(got);
  assert.equal(got.status, "complete");
  assert.ok(got.report);
  assert.equal(got.report.passed, 1);
  const none = await getCheckReport("does-not-exist");
  assert.equal(none, null);
});

test("listChecks filters by workspace and optional experimentId", async () => {
  await _reset("ws-l");
  const c1 = await createCheck({ workspaceId: "ws-l", experimentId: "e1" });
  const c2 = await createCheck({ workspaceId: "ws-l", experimentId: "e2" });
  await createCheck({ workspaceId: "ws-l", experimentId: "e1" });

  const all = await listChecks({ workspaceId: "ws-l" });
  assert.equal(all.length, 3);

  const e1Only = await listChecks({ workspaceId: "ws-l", experimentId: "e1" });
  assert.equal(e1Only.length, 2);
  for (const ch of e1Only) assert.equal(ch.experimentId, "e1");

  const e2Only = await listChecks({ workspaceId: "ws-l", experimentId: "e2" });
  assert.equal(e2Only.length, 1);
  assert.equal(e2Only[0].id, c2.id);
  // touch c1 to avoid unused-var lint
  assert.ok(c1.id);
});
