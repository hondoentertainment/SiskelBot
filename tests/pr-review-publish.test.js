/**
 * Phase 63.2 publish-gate tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-pr-review-publish-"));
process.env.STORAGE_PATH = TMP;

const { reviewDiff, _reset } = await import("../lib/pr-review-agent.js");
const {
  requestPublication,
  inspectPublication,
  consumePublication,
  SUPPORTED_TARGETS,
} = await import("../lib/pr-review-publish.js");

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

const SAMPLE_DIFF = `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -0,0 +1,2 @@
+console.log("hello");
+// TODO: handle
`;

async function stageReview(workspaceId = "ws-pub") {
  await _reset(workspaceId);
  return reviewDiff({ workspaceId, diff: SAMPLE_DIFF });
}

test("SUPPORTED_TARGETS advertises github-pr-comments and draft-only", () => {
  assert.ok(SUPPORTED_TARGETS.includes("draft-only"));
  assert.ok(SUPPORTED_TARGETS.includes("github-pr-comments"));
});

test("requestPublication rejects missing identifiers", async () => {
  await assert.rejects(
    () => requestPublication({}),
    /reviewId required/
  );
  await assert.rejects(
    () => requestPublication({ reviewId: "r1" }),
    /workspaceId required/
  );
});

test("requestPublication rejects unknown target", async () => {
  const review = await stageReview();
  await assert.rejects(
    () =>
      requestPublication({
        reviewId: review.reviewId,
        workspaceId: "ws-pub",
        target: "slack",
      }),
    /unsupported target/
  );
});

test("requestPublication returns a token and inspect shows pending state", async () => {
  const review = await stageReview();
  const out = await requestPublication({
    reviewId: review.reviewId,
    workspaceId: "ws-pub",
    target: "github-pr-comments",
    requestedBy: "alice",
  });
  assert.ok(out.token);
  assert.equal(out.target, "github-pr-comments");
  const pending = inspectPublication(out.token);
  assert.ok(pending);
  assert.equal(pending.requestedBy, "alice");
  assert.equal(pending.target, "github-pr-comments");
});

test("consumePublication with approve returns comments and invalidates token", async () => {
  const review = await stageReview();
  const { token } = await requestPublication({
    reviewId: review.reviewId,
    workspaceId: "ws-pub",
    target: "github-pr-comments",
  });
  const result = consumePublication(token, { decision: "approve" });
  assert.ok(result);
  assert.equal(result.decision, "approve");
  assert.equal(Array.isArray(result.comments), true);
  assert.equal(inspectPublication(token), null);
  assert.equal(consumePublication(token, { decision: "approve" }), null);
});

test("consumePublication with deny returns empty comments", async () => {
  const review = await stageReview();
  const { token } = await requestPublication({
    reviewId: review.reviewId,
    workspaceId: "ws-pub",
    target: "github-pr-comments",
  });
  const result = consumePublication(token, { decision: "deny" });
  assert.equal(result.decision, "deny");
  assert.deepEqual(result.comments, []);
});
