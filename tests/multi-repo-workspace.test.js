import test from "node:test";
import assert from "node:assert/strict";
import {
  addRepository,
  removeRepository,
  listRepositories,
  getMultiRepoConfig,
  resolvePathInWorkspace,
} from "../lib/multi-repo-workspace.js";

const ws = () => `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("addRepository adds a repo to workspace config", async () => {
  const workspaceId = ws();
  const repo = await addRepository(workspaceId, { name: "myrepo", root: "/workspace/myrepo" });
  assert.equal(repo.name, "myrepo");
  assert.equal(repo.root, "/workspace/myrepo");
  assert.equal(repo.remoteUrl, null);
  assert.equal(repo.branch, null);
});

test("addRepository with remoteUrl and branch", async () => {
  const workspaceId = ws();
  const repo = await addRepository(workspaceId, {
    name: "repo2",
    root: "/workspace/repo2",
    remoteUrl: "https://github.com/org/repo2",
    branch: "main",
  });
  assert.equal(repo.remoteUrl, "https://github.com/org/repo2");
  assert.equal(repo.branch, "main");
});

test("addRepository throws on invalid name", async () => {
  const workspaceId = ws();
  await assert.rejects(
    () => addRepository(workspaceId, { name: "invalid name!", root: "/ws/x" }),
    /alphanumeric/i
  );
});

test("addRepository throws on duplicate name", async () => {
  const workspaceId = ws();
  await addRepository(workspaceId, { name: "dup", root: "/ws/dup" });
  await assert.rejects(() => addRepository(workspaceId, { name: "dup", root: "/ws/dup2" }), /already exists/i);
});

test("listRepositories returns all repos", async () => {
  const workspaceId = ws();
  await addRepository(workspaceId, { name: "r1", root: "/ws/r1" });
  await addRepository(workspaceId, { name: "r2", root: "/ws/r2" });
  const repos = await listRepositories(workspaceId);
  assert.equal(repos.length, 2);
  assert.ok(repos.some((r) => r.name === "r1"));
  assert.ok(repos.some((r) => r.name === "r2"));
});

test("listRepositories returns empty for fresh workspace", async () => {
  const workspaceId = ws();
  const repos = await listRepositories(workspaceId);
  assert.deepEqual(repos, []);
});

test("removeRepository removes an existing repo", async () => {
  const workspaceId = ws();
  await addRepository(workspaceId, { name: "to-remove", root: "/ws/remove" });
  const removed = await removeRepository(workspaceId, "to-remove");
  assert.equal(removed, true);
  const repos = await listRepositories(workspaceId);
  assert.ok(repos.every((r) => r.name !== "to-remove"));
});

test("removeRepository returns false for nonexistent repo", async () => {
  const workspaceId = ws();
  const result = await removeRepository(workspaceId, "doesnt-exist");
  assert.equal(result, false);
});

test("getMultiRepoConfig returns normalized config", async () => {
  const workspaceId = ws();
  const config = await getMultiRepoConfig(workspaceId);
  assert.ok(Array.isArray(config.repositories));
  assert.equal(config.repositories.length, 0);
});

test("resolvePathInWorkspace finds a path in configured repos", async () => {
  const workspaceId = ws();
  await addRepository(workspaceId, { name: "main", root: "/workspace/main" });
  const resolved = await resolvePathInWorkspace(workspaceId, "main/src/index.js");
  assert.ok(resolved !== null);
});
