/**
 * Phase 63.3: Test generation tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-test-gen-"));
process.env.STORAGE_PATH = TMP;

const {
  parseLcov,
  identifyGaps,
  generateTestStub,
  listGaps,
  listHistory,
  _reset,
} = await import("../lib/test-gen.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const SAMPLE_LCOV = `TN:
SF:lib/alpha.js
DA:1,1
DA:2,0
DA:3,1
DA:4,0
DA:5,1
LF:5
LH:3
end_of_record
SF:lib/beta.js
DA:1,5
DA:2,5
LF:2
LH:2
end_of_record
SF:lib/gamma.js
DA:1,0
DA:2,0
LF:2
LH:0
end_of_record
`;

test("parseLcov extracts per-file uncovered lines", () => {
  const parsed = parseLcov(SAMPLE_LCOV);
  assert.equal(parsed.files.length, 3);
  const alpha = parsed.files.find((f) => f.path === "lib/alpha.js");
  assert.deepEqual(alpha.uncoveredLines, [2, 4]);
  assert.equal(alpha.linesFound, 5);
  assert.equal(alpha.linesHit, 3);
  const beta = parsed.files.find((f) => f.path === "lib/beta.js");
  assert.deepEqual(beta.uncoveredLines, []);
  const gamma = parsed.files.find((f) => f.path === "lib/gamma.js");
  assert.deepEqual(gamma.uncoveredLines, [1, 2]);
});

test("parseLcov handles empty input", () => {
  assert.deepEqual(parseLcov("").files, []);
  assert.deepEqual(parseLcov(null).files, []);
});

test("identifyGaps stores only files with uncovered lines", async () => {
  await _reset("ws-gaps");
  const out = await identifyGaps({ workspaceId: "ws-gaps", lcov: SAMPLE_LCOV });
  assert.equal(out.files.length, 3);
  assert.equal(out.gaps.length, 2);
  const stored = await listGaps("ws-gaps");
  assert.equal(stored.gaps.length, 2);
  const paths = stored.gaps.map((g) => g.path).sort();
  assert.deepEqual(paths, ["lib/alpha.js", "lib/gamma.js"]);
});

test("generateTestStub produces a parseable node:test stub", async () => {
  await _reset("ws-stub");
  const { stub } = await generateTestStub({
    workspaceId: "ws-stub",
    modulePath: "lib/alpha.js",
    uncoveredLines: [2, 4],
  });
  assert.ok(stub.includes("import test from \"node:test\""));
  assert.ok(stub.includes("import assert from \"node:assert/strict\""));
  assert.ok(stub.includes("lib/alpha.js"));
  assert.ok(stub.includes("2, 4"));
  assert.ok(stub.includes("alpha:"));
});

test("generateTestStub uses exported names when moduleSource provided", async () => {
  await _reset("ws-src");
  const moduleSource = `
export function doThing(x) { return x; }
export const helper = () => {};
export async function run() {}
`;
  const { stub } = await generateTestStub({
    workspaceId: "ws-src",
    modulePath: "lib/things.js",
    uncoveredLines: [1, 2],
    moduleSource,
  });
  assert.ok(stub.includes("{ doThing, helper, run }"), `stub: ${stub}`);
  assert.ok(stub.includes("assert.ok(doThing)"));
});

test("generateTestStub records history and rejects missing modulePath", async () => {
  await _reset("ws-hist");
  await generateTestStub({
    workspaceId: "ws-hist",
    modulePath: "lib/one.js",
    uncoveredLines: [1, 2],
  });
  await generateTestStub({
    workspaceId: "ws-hist",
    modulePath: "lib/two.js",
    uncoveredLines: [5],
  });
  const { history } = await listHistory("ws-hist");
  assert.equal(history.length, 2);
  assert.ok(history[0].createdAt >= history[1].createdAt);
  await assert.rejects(() => generateTestStub({ workspaceId: "ws-hist", modulePath: "" }));
});

test("identifyGaps with empty lcov produces zero gaps", async () => {
  await _reset("ws-empty");
  const out = await identifyGaps({ workspaceId: "ws-empty", lcov: "" });
  assert.equal(out.gaps.length, 0);
});
