/**
 * Phase 63.2: PR review agent tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-pr-review-"));
process.env.STORAGE_PATH = TMP;

const {
  reviewDiff,
  getReview,
  listReviews,
  approveReview,
  isPrReviewHitlEnabled,
  BUILTIN_RULES,
  _reset,
  _internals,
} = await import("../lib/pr-review-agent.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const SIMPLE_DIFF = `diff --git a/src/foo.js b/src/foo.js
--- a/src/foo.js
+++ b/src/foo.js
@@ -1,2 +1,5 @@
 function foo() {
+  console.log("debug");
+  // TODO: refactor this
   return 1;
 }
`;

const DANGER_DIFF = `--- a/src/bad.js
+++ b/src/bad.js
@@ -1,1 +1,3 @@
 export const x = 1;
+const r = eval(input);
+const f = new Function("return 1");
`;

test("BUILTIN_RULES exposes the core rule ids", () => {
  const ids = BUILTIN_RULES.map((r) => r.id);
  assert.ok(ids.includes("no-console-log"));
  assert.ok(ids.includes("todo-fixme"));
  assert.ok(ids.includes("long-function"));
  assert.ok(ids.includes("missing-test"));
  assert.ok(ids.includes("dangerous-eval"));
});

test("parseDiff extracts added lines with correct line numbers", () => {
  const parsed = _internals.parseDiff(SIMPLE_DIFF);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].file, "src/foo.js");
  assert.equal(parsed[0].addedLines.length, 2);
  assert.equal(parsed[0].addedLines[0].line, 2);
  assert.ok(parsed[0].addedLines[0].content.includes("console.log"));
});

test("reviewDiff flags console.log and TODO as separate comments", async () => {
  await _reset("ws-simple");
  const review = await reviewDiff({ workspaceId: "ws-simple", diff: SIMPLE_DIFF });
  assert.ok(review.reviewId);
  const rules = review.comments.map((c) => c.rule);
  assert.ok(rules.includes("no-console-log"));
  assert.ok(rules.includes("todo-fixme"));
  // Also missing-test (src change, no test change).
  assert.ok(rules.includes("missing-test"));
});

test("reviewDiff flags eval and new Function as error severity", async () => {
  await _reset("ws-danger");
  const review = await reviewDiff({ workspaceId: "ws-danger", diff: DANGER_DIFF });
  const errs = review.comments.filter((c) => c.severity === "error");
  assert.ok(errs.length >= 2);
  for (const e of errs) {
    assert.equal(e.rule, "dangerous-eval");
  }
});

test("reviewDiff rules filter limits to allowed rules", async () => {
  await _reset("ws-filter");
  const review = await reviewDiff({
    workspaceId: "ws-filter",
    diff: SIMPLE_DIFF,
    rules: ["no-console-log"],
  });
  assert.ok(review.comments.every((c) => c.rule === "no-console-log"));
});

test("reviewDiff throws when diff is empty", async () => {
  await _reset("ws-empty");
  await assert.rejects(() => reviewDiff({ workspaceId: "ws-empty", diff: "" }));
});

test("getReview and listReviews round-trip", async () => {
  await _reset("ws-list");
  const r1 = await reviewDiff({ workspaceId: "ws-list", diff: SIMPLE_DIFF });
  const r2 = await reviewDiff({ workspaceId: "ws-list", diff: DANGER_DIFF });
  const fetched = await getReview(r1.reviewId, "ws-list");
  assert.equal(fetched.reviewId, r1.reviewId);
  const { reviews } = await listReviews("ws-list");
  assert.equal(reviews.length, 2);
  const ids = reviews.map((r) => r.reviewId);
  assert.ok(ids.includes(r1.reviewId));
  assert.ok(ids.includes(r2.reviewId));
});

test("missing-test rule does not fire when tests are also changed", async () => {
  await _reset("ws-testschanged");
  const diff = `--- a/src/foo.js
+++ b/src/foo.js
@@ -1,1 +1,2 @@
 existing
+added
--- a/tests/foo.test.js
+++ b/tests/foo.test.js
@@ -1,1 +1,2 @@
 existing
+added
`;
  const review = await reviewDiff({ workspaceId: "ws-testschanged", diff });
  const rules = review.comments.map((c) => c.rule);
  assert.ok(!rules.includes("missing-test"));
});

test("long-function rule triggers on large function bodies", async () => {
  await _reset("ws-long");
  let body = "";
  for (let i = 0; i < 60; i += 1) {
    body += `+  const x${i} = ${i};\n`;
  }
  const diff = `--- a/src/big.js
+++ b/src/big.js
@@ -1,1 +1,62 @@
 preexisting
+function huge() {
${body}+}
`;
  const review = await reviewDiff({ workspaceId: "ws-long", diff });
  const rules = review.comments.map((c) => c.rule);
  assert.ok(rules.includes("long-function"), `rules should include long-function, got ${rules.join(",")}`);
});

test("reviewDiff defaults to approved when HITL is disabled", async () => {
  const prev = process.env.PR_REVIEW_HITL;
  delete process.env.PR_REVIEW_HITL;
  try {
    await _reset("ws-approved");
    const review = await reviewDiff({ workspaceId: "ws-approved", diff: SIMPLE_DIFF });
    assert.equal(review.status, "approved");
    assert.equal(isPrReviewHitlEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PR_REVIEW_HITL;
    else process.env.PR_REVIEW_HITL = prev;
  }
});

test("reviewDiff creates draft when PR_REVIEW_HITL=1", async () => {
  const prev = process.env.PR_REVIEW_HITL;
  process.env.PR_REVIEW_HITL = "1";
  try {
    await _reset("ws-hitl");
    const review = await reviewDiff({ workspaceId: "ws-hitl", diff: SIMPLE_DIFF });
    assert.equal(review.status, "draft");
    assert.equal(isPrReviewHitlEnabled(), true);
    const fetched = await getReview(review.reviewId, "ws-hitl");
    assert.equal(fetched.status, "draft");
    const { reviews } = await listReviews("ws-hitl");
    assert.equal(reviews[0].status, "draft");
  } finally {
    if (prev === undefined) delete process.env.PR_REVIEW_HITL;
    else process.env.PR_REVIEW_HITL = prev;
  }
});

test("reviewDiff creates draft when requireApproval is true", async () => {
  const prev = process.env.PR_REVIEW_HITL;
  delete process.env.PR_REVIEW_HITL;
  try {
    await _reset("ws-req");
    const review = await reviewDiff({
      workspaceId: "ws-req",
      diff: SIMPLE_DIFF,
      requireApproval: true,
    });
    assert.equal(review.status, "draft");
  } finally {
    if (prev === undefined) delete process.env.PR_REVIEW_HITL;
    else process.env.PR_REVIEW_HITL = prev;
  }
});

test("approveReview approves draft and rejects duplicate approval", async () => {
  const prev = process.env.PR_REVIEW_HITL;
  process.env.PR_REVIEW_HITL = "1";
  try {
    await _reset("ws-approve");
    const draft = await reviewDiff({ workspaceId: "ws-approve", diff: SIMPLE_DIFF });
    assert.equal(draft.status, "draft");

    const approved = await approveReview(draft.reviewId, "ws-approve", { approvedBy: "reviewer-1" });
    assert.equal(approved.status, "approved");
    assert.ok(approved.approvedAt);
    assert.equal(approved.approvedBy, "reviewer-1");

    const fetched = await getReview(draft.reviewId, "ws-approve");
    assert.equal(fetched.status, "approved");
    assert.equal(fetched.approvedBy, "reviewer-1");

    await assert.rejects(
      () => approveReview(draft.reviewId, "ws-approve", { approvedBy: "reviewer-2" }),
      (err) => err.code === "ALREADY_APPROVED",
    );
  } finally {
    if (prev === undefined) delete process.env.PR_REVIEW_HITL;
    else process.env.PR_REVIEW_HITL = prev;
  }
});
