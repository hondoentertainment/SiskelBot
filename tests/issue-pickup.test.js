import test from "node:test";
import assert from "node:assert/strict";
import {
  createIssuePickupRecord,
  listPickedUpIssues,
  updateIssuePickupRecord,
  handleGithubIssueWebhook,
} from "../lib/issue-pickup.js";

const ws = () => `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("createIssuePickupRecord creates a record", async () => {
  const workspaceId = ws();
  const record = await createIssuePickupRecord(workspaceId, {
    source: "github",
    issueId: "42",
    title: "Fix the bug",
    body: "It crashes on startup",
    repoFullName: "org/repo",
  });
  assert.ok(record.pickupId);
  assert.equal(record.workspaceId, workspaceId);
  assert.equal(record.source, "github");
  assert.equal(record.issueId, "42");
  assert.equal(record.title, "Fix the bug");
  assert.equal(record.status, "pending");
  assert.equal(record.sessionId, null);
});

test("listPickedUpIssues returns all records", async () => {
  const workspaceId = ws();
  await createIssuePickupRecord(workspaceId, { source: "github", issueId: "1", title: "Issue 1" });
  await createIssuePickupRecord(workspaceId, { source: "linear", issueId: "2", title: "Issue 2" });
  const list = await listPickedUpIssues(workspaceId);
  assert.equal(list.length, 2);
});

test("listPickedUpIssues returns empty array for fresh workspace", async () => {
  const workspaceId = ws();
  const list = await listPickedUpIssues(workspaceId);
  assert.deepEqual(list, []);
});

test("updateIssuePickupRecord updates status and sessionId", async () => {
  const workspaceId = ws();
  const record = await createIssuePickupRecord(workspaceId, { source: "github", issueId: "10", title: "Update me" });
  const updated = await updateIssuePickupRecord(workspaceId, record.pickupId, { status: "in_progress", sessionId: "sess-abc" });
  assert.equal(updated.status, "in_progress");
  assert.equal(updated.sessionId, "sess-abc");
  assert.equal(updated.pickupId, record.pickupId);
});

test("updateIssuePickupRecord returns null for nonexistent record", async () => {
  const workspaceId = ws();
  const result = await updateIssuePickupRecord(workspaceId, "nonexistent-id", { status: "done" });
  assert.equal(result, null);
});

test("handleGithubIssueWebhook creates record on labeled event with trigger label", async () => {
  const workspaceId = ws();
  const payload = {
    action: "labeled",
    label: { name: "devin" },
    issue: { number: 99, title: "Automate this", body: "Please fix", html_url: "https://github.com/org/repo/issues/99" },
    repository: { full_name: "org/repo" },
  };
  const result = await handleGithubIssueWebhook(payload, workspaceId);
  assert.ok(result);
  assert.equal(result.triggered, true);
  assert.equal(result.title, "Automate this");
  assert.equal(result.repoFullName, "org/repo");
});

test("handleGithubIssueWebhook ignores event with wrong label", async () => {
  const workspaceId = ws();
  const payload = {
    action: "labeled",
    label: { name: "bug" },
    issue: { number: 1, title: "Bug report", body: "" },
    repository: { full_name: "org/repo" },
  };
  const result = await handleGithubIssueWebhook(payload, workspaceId);
  assert.equal(result.triggered, false);
});

test("handleGithubIssueWebhook ignores non-labeled action", async () => {
  const workspaceId = ws();
  const payload = {
    action: "opened",
    issue: { number: 5, title: "New issue", body: "" },
    repository: { full_name: "org/repo" },
  };
  const result = await handleGithubIssueWebhook(payload, workspaceId);
  assert.equal(result.triggered, false);
});

test("handleGithubIssueWebhook supports custom triggerLabel", async () => {
  const workspaceId = ws();
  const payload = {
    action: "labeled",
    label: { name: "agent" },
    issue: { number: 7, title: "Custom label", body: "body", html_url: "" },
    repository: { full_name: "myorg/myrepo" },
  };
  const result = await handleGithubIssueWebhook(payload, workspaceId, { triggerLabel: "agent" });
  assert.ok(result);
  assert.equal(result.triggered, true);
  assert.equal(result.title, "Custom label");
});
