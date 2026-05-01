import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkflowRun,
  updateWorkflowStep,
  getWorkflowRun,
  listWorkflowRuns,
  handlePrReviewWebhook,
} from "../lib/github-dev-workflow.js";

const ws = () => `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("createWorkflowRun creates a run record", async () => {
  const workspaceId = ws();
  const run = await createWorkflowRun({
    workspaceId,
    owner: "testorg",
    repo: "testrepo",
    issueNumber: 42,
    branch: "fix/issue-42",
  });
  assert.ok(run.runId);
  assert.equal(run.workspaceId, workspaceId);
  assert.equal(run.owner, "testorg");
  assert.equal(run.repo, "testrepo");
  assert.equal(run.issueNumber, 42);
  assert.equal(run.branch, "fix/issue-42");
  assert.equal(run.status, "started");
  assert.deepEqual(run.steps, []);
});

test("listWorkflowRuns returns runs sorted by createdAt desc", async () => {
  const workspaceId = ws();
  const run1 = await createWorkflowRun({ workspaceId, owner: "org", repo: "r", issueNumber: 1 });
  const run2 = await createWorkflowRun({ workspaceId, owner: "org", repo: "r", issueNumber: 2 });
  const list = await listWorkflowRuns(workspaceId);
  assert.equal(list.length, 2);
  assert.ok(list[0].createdAt >= list[1].createdAt);
  assert.ok(list.some((r) => r.runId === run1.runId));
  assert.ok(list.some((r) => r.runId === run2.runId));
});

test("getWorkflowRun retrieves a specific run", async () => {
  const workspaceId = ws();
  const created = await createWorkflowRun({ workspaceId, owner: "org", repo: "r", issueNumber: 5 });
  const fetched = await getWorkflowRun(workspaceId, created.runId);
  assert.ok(fetched);
  assert.equal(fetched.runId, created.runId);
});

test("getWorkflowRun returns null for unknown runId", async () => {
  const workspaceId = ws();
  const result = await getWorkflowRun(workspaceId, "no-such-run-id");
  assert.equal(result, null);
});

test("updateWorkflowStep adds step to run", async () => {
  const workspaceId = ws();
  const run = await createWorkflowRun({ workspaceId, owner: "org", repo: "r", issueNumber: 10 });
  const updated = await updateWorkflowStep(workspaceId, run.runId, {
    name: "clone_repo",
    status: "done",
    at: Date.now(),
  });
  assert.ok(updated);
  assert.equal(updated.steps.length, 1);
  assert.equal(updated.steps[0].name, "clone_repo");
});

test("updateWorkflowStep sets run status to failed on failed step", async () => {
  const workspaceId = ws();
  const run = await createWorkflowRun({ workspaceId, owner: "org", repo: "r", issueNumber: 11 });
  const updated = await updateWorkflowStep(workspaceId, run.runId, { name: "build", status: "failed" });
  assert.equal(updated.status, "failed");
});

test("updateWorkflowStep sets run status to pr_open on push_pr done", async () => {
  const workspaceId = ws();
  const run = await createWorkflowRun({ workspaceId, owner: "org", repo: "r", issueNumber: 12 });
  const updated = await updateWorkflowStep(workspaceId, run.runId, { name: "push_pr", status: "done" });
  assert.equal(updated.status, "pr_open");
});

test("updateWorkflowStep returns null for unknown runId", async () => {
  const workspaceId = ws();
  const result = await updateWorkflowStep(workspaceId, "nonexistent-run", { name: "step", status: "done" });
  assert.equal(result, null);
});

test("handlePrReviewWebhook returns null runId when no matching run", async () => {
  const workspaceId = ws();
  const payload = {
    action: "review_requested",
    pull_request: { number: 999 },
    review: { body: "Looks good!" },
  };
  const result = await handlePrReviewWebhook(payload, workspaceId);
  assert.equal(result.runId, null);
  assert.ok(Array.isArray(result.comments));
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].body, "Looks good!");
});

test("handlePrReviewWebhook extracts pr number from issue with pull_request link", async () => {
  const workspaceId = ws();
  const payload = {
    action: "created",
    issue: { number: 77, pull_request: {} },
    comment: { body: "LGTM" },
  };
  const result = await handlePrReviewWebhook(payload, workspaceId);
  assert.ok(Array.isArray(result.comments));
  assert.equal(result.comments[0].body, "LGTM");
});

test("handlePrReviewWebhook returns null runId when no pull_request in payload", async () => {
  const workspaceId = ws();
  const payload = { action: "opened" };
  const result = await handlePrReviewWebhook(payload, workspaceId);
  assert.equal(result.runId, null);
  assert.deepEqual(result.comments, []);
});

test("handlePrReviewWebhook handles array comments in payload", async () => {
  const workspaceId = ws();
  const payload = {
    action: "review_submitted",
    pull_request: { number: 5 },
    comments: [
      { body: "Comment 1", path: "src/index.js", line: 10 },
      { body: "Comment 2", path: "src/app.js", line: 20 },
    ],
  };
  const result = await handlePrReviewWebhook(payload, workspaceId);
  assert.equal(result.comments.length, 2);
  assert.equal(result.comments[0].body, "Comment 1");
  assert.equal(result.comments[1].body, "Comment 2");
});
