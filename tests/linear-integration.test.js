import test from "node:test";
import assert from "node:assert/strict";
import { isLinearConfigured, createLinearIssue, searchLinearIssues } from "../lib/linear-integration.js";

test("isLinearConfigured returns false when env not set", () => {
  assert.equal(isLinearConfigured(), false);
});

test("createLinearIssue throws when Linear not configured", async () => {
  await assert.rejects(
    () => createLinearIssue("team-1", "Test issue", "description"),
    { message: "Linear not configured" },
  );
});

test("searchLinearIssues throws when Linear not configured", async () => {
  await assert.rejects(
    () => searchLinearIssues("bug fix"),
    { message: "Linear not configured" },
  );
});
