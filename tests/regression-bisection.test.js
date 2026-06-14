/**
 * Phase 75.4: Regression bisection tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-regression-bisection-"));
process.env.STORAGE_PATH = TMP;

const {
  createBisectSession,
  advanceBisect,
  getBisectSession,
  listSessions,
  _reset,
} = await import("../lib/regression-bisection.js");

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

test("createBisectSession validates inputs", async () => {
  await _reset();
  await assert.rejects(
    () => createBisectSession({ workspaceId: "ws", goodCommit: "a", failingCommit: "b", commits: ["a"] }),
    /at least 2/,
  );
  await assert.rejects(
    () => createBisectSession({ workspaceId: "ws", failingCommit: "b", commits: ["a", "b"] }),
    /goodCommit/,
  );
  await assert.rejects(
    () => createBisectSession({ workspaceId: "ws", goodCommit: "a", commits: ["a", "b"] }),
    /failingCommit/,
  );
});

test("createBisectSession initializes lo/hi/current correctly", async () => {
  await _reset();
  const commits = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const s = await createBisectSession({
    workspaceId: "bws",
    goodCommit: "c0",
    failingCommit: "c5",
    testCommand: "npm test",
    commits,
  });
  assert.equal(s.lo, 0);
  assert.equal(s.hi, 5);
  // midpoint((0+5)/2) = 2
  assert.equal(s.current, 2);
  assert.equal(s.status, "in-progress");
  assert.equal(s.breakerCommit, null);
});

test("advanceBisect with fail narrows hi; with pass narrows lo", async () => {
  await _reset();
  const commits = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const s = await createBisectSession({
    workspaceId: "ws", goodCommit: "c0", failingCommit: "c5", commits,
  });
  // current=2. Say it fails → hi=2, next current = midpoint(0,2)=1
  const s2 = await advanceBisect({ sessionId: s.sessionId, result: "fail" });
  assert.equal(s2.hi, 2);
  assert.equal(s2.current, 1);
  assert.equal(s2.status, "in-progress");
  // Now at c1 say it passes → lo=1, lo+1=2, hi=2 → found with breakerCommit = commits[2]
  const s3 = await advanceBisect({ sessionId: s.sessionId, result: "pass" });
  assert.equal(s3.status, "found");
  assert.equal(s3.breakerCommit, "c2");
});

test("tiny 2-commit range is immediately found", async () => {
  await _reset();
  const s = await createBisectSession({
    workspaceId: "ws", goodCommit: "a", failingCommit: "b", commits: ["a", "b"],
  });
  assert.equal(s.status, "found");
  assert.equal(s.breakerCommit, "b");
});

test("advanceBisect rejects invalid result values", async () => {
  await _reset();
  const s = await createBisectSession({
    workspaceId: "ws", goodCommit: "c0", failingCommit: "c5",
    commits: ["c0", "c1", "c2", "c3", "c4", "c5"],
  });
  await assert.rejects(
    () => advanceBisect({ sessionId: s.sessionId, result: "maybe" }),
    /result must be/,
  );
  await assert.rejects(
    () => advanceBisect({ sessionId: "nope", result: "pass" }),
    /unknown sessionId/,
  );
});

test("getBisectSession + listSessions", async () => {
  await _reset();
  const s1 = await createBisectSession({
    workspaceId: "lws", goodCommit: "a", failingCommit: "c", commits: ["a", "b", "c"],
  });
  const s2 = await createBisectSession({
    workspaceId: "lws", goodCommit: "a", failingCommit: "d", commits: ["a", "b", "c", "d"],
  });
  const g = await getBisectSession(s1.sessionId);
  assert.equal(g.sessionId, s1.sessionId);
  const list = await listSessions("lws");
  assert.equal(list.length, 2);
  const ids = list.map((x) => x.sessionId).sort();
  assert.deepEqual(ids.sort(), [s1.sessionId, s2.sessionId].sort());
});

test("skip result advances past the commit", async () => {
  await _reset();
  const s = await createBisectSession({
    workspaceId: "sk", goodCommit: "c0", failingCommit: "c5",
    commits: ["c0", "c1", "c2", "c3", "c4", "c5"],
  });
  const prevCurrent = s.current; // 2
  const s2 = await advanceBisect({ sessionId: s.sessionId, result: "skip" });
  assert.ok(s2.current !== prevCurrent || s2.status === "aborted");
  assert.equal(s2.history[0].result, "skip");
});
