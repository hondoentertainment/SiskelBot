/**
 * Phase 63: end-to-end "golden path" test for the code-generation vertical.
 *
 * Exercises the full Phase 63 chain in sequence as a single user journey so a
 * regression in any link is caught automatically:
 *
 *   a. repo-rag          — index a synthetic repo, search it, assert a hit.
 *   b. pr-review-agent   — review a unified diff, assert BUILTIN_RULE comments.
 *   c. pr-review-publish — stage the review behind the HITL gate, approve it,
 *                          assert the comments are released and the token dies.
 *   d. test-gen          — identify coverage gaps from LCOV, generate a stub.
 *   e. phase63-cost      — record Phase 63 usage, confirm it was recorded.
 *
 * One temp STORAGE_PATH and one workspaceId are shared across the scenario so
 * it reads as a single real user journey. Fully deterministic — no live LLM,
 * no network, no running server. Every module here is pure/local.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-phase63-golden-"));
process.env.STORAGE_PATH = TMP;

const { indexRepository, searchRepo, getRepoStats } = await import(
  "../lib/repo-rag.js"
);
const { reviewDiff, BUILTIN_RULES } = await import(
  "../lib/pr-review-agent.js"
);
const { requestPublication, inspectPublication, consumePublication } =
  await import("../lib/pr-review-publish.js");
const { identifyGaps, generateTestStub, listGaps, listHistory } =
  await import("../lib/test-gen.js");
const { recordPhase63Usage, PHASE63_FEATURES } = await import(
  "../lib/phase63-cost.js"
);

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
});

// A single workspace id shared across the whole scenario — reads as one journey.
const WS = "phase63-golden-ws";

// Synthetic repo source: one module under review, with a recognizable token.
const MODULE_SOURCE = `export function computeWidget(input) {
  const total = input.price * input.quantity;
  return total;
}

export function discountedWidget(input, rate) {
  return computeWidget(input) * (1 - rate);
}
`;

// A unified diff against that module that adds a console.log (no-console-log
// BUILTIN_RULE) and a TODO comment (todo-fixme BUILTIN_RULE).
const DIFF = `diff --git a/src/widget.js b/src/widget.js
--- a/src/widget.js
+++ b/src/widget.js
@@ -1,3 +1,5 @@
 export function computeWidget(input) {
   const total = input.price * input.quantity;
+  console.log("computeWidget total", total);
+  // TODO: validate input shape
   return total;
 }
`;

// Synthetic LCOV: src/widget.js has two uncovered lines (3 and 4).
const LCOV = `TN:
SF:src/widget.js
DA:1,3
DA:2,3
DA:3,0
DA:4,0
DA:5,3
LF:5
LH:3
end_of_record
`;

test("Phase 63 golden path: full code-generation vertical end-to-end", async (t) => {
  // ---------------------------------------------------------------
  // Step (a): repo-rag — index a small synthetic repo, then search it.
  // ---------------------------------------------------------------
  await t.test(
    "a. repo-rag indexes the synthetic repo and search returns a hit",
    async () => {
      const summary = await indexRepository({
        workspaceId: WS,
        repoId: "widget-service",
        files: [
          { path: "src/widget.js", content: MODULE_SOURCE },
          {
            path: "src/readme.md",
            content: "Widget service computes widget totals.",
          },
        ],
      });
      assert.equal(summary.repoId, "widget-service");
      assert.equal(summary.fileCount, 2);
      assert.ok(summary.tokenCount > 0, "indexed repo should have tokens");

      // The token "computeWidget" appears in src/widget.js — must be searchable.
      const { hits } = await searchRepo({
        workspaceId: WS,
        query: "computeWidget",
        limit: 5,
      });
      assert.ok(
        Array.isArray(hits) && hits.length >= 1,
        "search should return at least one hit"
      );
      const hit = hits.find((h) => h.path === "src/widget.js");
      assert.ok(hit, "src/widget.js should be among the search hits");
      assert.ok(hit.score > 0, "hit should have a positive TF score");

      const stats = await getRepoStats(WS);
      assert.equal(stats.repos, 1, "workspace should have exactly one repo");
      assert.equal(stats.totalFiles, 2);
    }
  );

  // ---------------------------------------------------------------
  // Step (b): pr-review-agent — review a diff that trips BUILTIN_RULEs.
  // ---------------------------------------------------------------
  let reviewId;
  await t.test(
    "b. pr-review-agent flags BUILTIN_RULE violations in the diff",
    async () => {
      // Sanity-check the rule we expect to fire is a real builtin.
      const builtinIds = BUILTIN_RULES.map((r) => r.id);
      assert.ok(
        builtinIds.includes("no-console-log"),
        "no-console-log is a builtin rule"
      );

      const review = await reviewDiff({ workspaceId: WS, diff: DIFF });
      assert.ok(review.reviewId, "review should have an id");
      assert.ok(
        Array.isArray(review.comments),
        "review should carry a comments array"
      );
      assert.ok(
        review.comments.length > 0,
        "review should produce at least one comment"
      );

      const firedRules = review.comments.map((c) => c.rule);
      assert.ok(
        firedRules.includes("no-console-log"),
        `expected no-console-log, got ${firedRules.join(",")}`
      );

      // Every comment must reference a file, a line and a severity.
      for (const c of review.comments) {
        assert.equal(typeof c.file, "string");
        assert.ok(Number.isFinite(c.line));
        assert.ok(
          typeof c.severity === "string" && c.severity.length > 0
        );
      }

      reviewId = review.reviewId;
    }
  );

  // ---------------------------------------------------------------
  // Step (c): pr-review-publish — HITL gate. The review must be staged,
  // then approved, before its comments are released. After approval the
  // single-use token must be invalid.
  // ---------------------------------------------------------------
  await t.test(
    "c. pr-review-publish gates the review behind a HITL approval token",
    async () => {
      assert.ok(reviewId, "step (b) must have produced a reviewId");

      // Stage the review for publication — returns a HITL token.
      const staged = await requestPublication({
        reviewId,
        workspaceId: WS,
        target: "github-pr-comments",
        requestedBy: "golden-path-user",
      });
      assert.ok(staged.token, "requestPublication should return a token");
      assert.equal(staged.target, "github-pr-comments");
      assert.ok(
        staged.commentCount >= 1,
        "staged publication should carry the review comments"
      );
      const token = staged.token;

      // Before approval: the publication is inspectable but not released.
      const pending = inspectPublication(token);
      assert.ok(pending, "pending publication should be inspectable");
      assert.equal(pending.reviewId, reviewId);
      assert.equal(pending.target, "github-pr-comments");

      // Operator approves — comments are released to the caller.
      const released = consumePublication(token, { decision: "approve" });
      assert.ok(released, "approved consumePublication should return a payload");
      assert.equal(released.decision, "approve");
      assert.equal(released.target, "github-pr-comments");
      assert.ok(
        Array.isArray(released.comments) && released.comments.length >= 1,
        "approved publication must return the review comments"
      );
      assert.ok(
        released.comments.some((c) => c.rule === "no-console-log"),
        "released comments must include the no-console-log finding from (b)"
      );

      // The token is single-use: it must be invalid after consumption.
      assert.equal(
        inspectPublication(token),
        null,
        "token should be invalid after it is consumed"
      );
      assert.equal(
        consumePublication(token, { decision: "approve" }),
        null,
        "a consumed token cannot be consumed again"
      );
    }
  );

  // ---------------------------------------------------------------
  // Step (d): test-gen — identify coverage gaps from LCOV, generate a stub.
  // ---------------------------------------------------------------
  await t.test(
    "d. test-gen identifies gaps and generates a test stub",
    async () => {
      const { files, gaps } = await identifyGaps({
        workspaceId: WS,
        lcov: LCOV,
      });
      assert.equal(files.length, 1, "LCOV describes one file");
      assert.equal(gaps.length, 1, "one file has uncovered lines");
      assert.equal(gaps[0].path, "src/widget.js");
      assert.deepEqual(
        gaps[0].uncoveredLines,
        [3, 4],
        "lines 3 and 4 are uncovered"
      );

      const stored = await listGaps(WS);
      assert.equal(
        stored.gaps.length,
        1,
        "gaps should be persisted for the workspace"
      );

      const { stub, record } = await generateTestStub({
        workspaceId: WS,
        modulePath: gaps[0].path,
        uncoveredLines: gaps[0].uncoveredLines,
        moduleSource: MODULE_SOURCE,
      });
      assert.equal(typeof stub, "string");
      assert.ok(stub.length > 0, "a non-empty stub string should be produced");
      assert.ok(stub.includes("node:test"), "stub should be a node:test file");
      assert.ok(stub.includes("src/widget.js"), "stub should target the module");
      // moduleSource exposes computeWidget — the stub should import it by name.
      assert.ok(
        stub.includes("computeWidget"),
        "stub should reference an exported symbol"
      );
      assert.deepEqual(record.uncoveredLines, [3, 4]);

      const { history } = await listHistory(WS);
      assert.ok(
        history.some((h) => h.id === record.id),
        "stub generation should be recorded in history"
      );
    }
  );

  // ---------------------------------------------------------------
  // Step (e): phase63-cost — record usage for one Phase 63 feature.
  // ---------------------------------------------------------------
  await t.test("e. phase63-cost records usage for the journey", async () => {
    const feature = PHASE63_FEATURES.includes("pr-review-agent")
      ? "pr-review-agent"
      : PHASE63_FEATURES[0];
    const result = await recordPhase63Usage({
      feature,
      workspaceId: WS,
      userId: "golden-path-user",
      model: "gpt-4o-mini",
      inputTokens: 1200,
      outputTokens: 340,
      calls: 1,
    });
    assert.equal(result.recorded, true, "Phase 63 usage should be recorded");
  });
});
