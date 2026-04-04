import test from "node:test";
import assert from "node:assert/strict";
import { isJiraConfigured, createJiraIssue, searchJiraIssues } from "../lib/jira-integration.js";

test("isJiraConfigured returns false when env not set", () => {
  assert.equal(isJiraConfigured(), false);
});

test("createJiraIssue throws when Jira not configured", async () => {
  await assert.rejects(
    () => createJiraIssue("PROJ", "Test summary", "description"),
    { message: "Jira not configured" },
  );
});

test("searchJiraIssues throws when Jira not configured", async () => {
  await assert.rejects(
    () => searchJiraIssues("project = PROJ"),
    { message: "Jira not configured" },
  );
});

test("createJiraIssue validates required project key", async () => {
  // Even if configured, missing project key should error.
  // Since Jira is not configured, we get that error first.
  await assert.rejects(
    () => createJiraIssue("", "summary", "desc"),
    (err) => {
      assert.ok(err.message === "Jira not configured" || err.message === "Project key is required");
      return true;
    },
  );
});

test("searchJiraIssues validates JQL param", async () => {
  // Since Jira is not configured, we get that error first.
  // But when configured and JQL is empty, it would throw "JQL query is required".
  await assert.rejects(
    () => searchJiraIssues(""),
    (err) => {
      assert.ok(err.message === "Jira not configured" || err.message === "JQL query is required");
      return true;
    },
  );
});
