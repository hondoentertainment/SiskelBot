/**
 * Phase 63.1: Repo-level RAG tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-repo-rag-"));
process.env.STORAGE_PATH = TMP;

const {
  indexRepository,
  searchRepo,
  getRepoStats,
  listRepos,
  removeRepo,
  _reset,
} = await import("../lib/repo-rag.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("indexRepository indexes files and returns summary", async () => {
  await _reset("ws-idx");
  const res = await indexRepository({
    workspaceId: "ws-idx",
    repoId: "repo-1",
    files: [
      { path: "src/foo.js", content: "function helloWorld() { return 42; }\nconsole.log(helloWorld());" },
      { path: "src/bar.py", content: "def greet(name):\n    return f'hi {name}'" },
    ],
  });
  assert.equal(res.repoId, "repo-1");
  assert.equal(res.fileCount, 2);
  assert.ok(res.tokenCount > 0);
});

test("searchRepo finds matching files scored by TF", async () => {
  await _reset("ws-search");
  await indexRepository({
    workspaceId: "ws-search",
    repoId: "r",
    files: [
      { path: "a.js", content: "alpha beta alpha beta alpha" },
      { path: "b.js", content: "beta gamma" },
      { path: "c.js", content: "delta epsilon" },
    ],
  });
  const hits = await searchRepo({ workspaceId: "ws-search", query: "alpha" });
  assert.equal(hits.hits.length, 1);
  assert.equal(hits.hits[0].path, "a.js");
  assert.ok(hits.hits[0].score >= 3);
  const both = await searchRepo({ workspaceId: "ws-search", query: "alpha beta" });
  // a.js should rank highest (3 alphas + 2 betas = 5), then b.js (1 beta).
  assert.equal(both.hits[0].path, "a.js");
  assert.equal(both.hits[1].path, "b.js");
});

test("searchRepo returns empty hits for empty query", async () => {
  await _reset("ws-empty");
  await indexRepository({
    workspaceId: "ws-empty",
    repoId: "r",
    files: [{ path: "a.js", content: "hello" }],
  });
  const res = await searchRepo({ workspaceId: "ws-empty", query: "" });
  assert.equal(res.hits.length, 0);
});

test("searchRepo includes line numbers for matches", async () => {
  await _reset("ws-lines");
  await indexRepository({
    workspaceId: "ws-lines",
    repoId: "r",
    files: [{ path: "m.js", content: "line one\nhas keyword here\nlast line keyword" }],
  });
  const res = await searchRepo({ workspaceId: "ws-lines", query: "keyword" });
  assert.equal(res.hits.length, 1);
  assert.deepEqual(res.hits[0].lines, [2, 3]);
});

test("getRepoStats and listRepos summarize the workspace", async () => {
  await _reset("ws-stats");
  await indexRepository({
    workspaceId: "ws-stats",
    repoId: "r1",
    files: [{ path: "x.js", content: "foo bar baz" }],
  });
  await indexRepository({
    workspaceId: "ws-stats",
    repoId: "r2",
    files: [
      { path: "y.js", content: "alpha" },
      { path: "z.js", content: "beta" },
    ],
  });
  const stats = await getRepoStats("ws-stats");
  assert.equal(stats.repos, 2);
  assert.equal(stats.totalFiles, 3);
  assert.ok(stats.totalTokens >= 5);
  const { repos } = await listRepos("ws-stats");
  assert.equal(repos.length, 2);
});

test("removeRepo deletes repo and drops its postings", async () => {
  await _reset("ws-remove");
  await indexRepository({
    workspaceId: "ws-remove",
    repoId: "keep",
    files: [{ path: "k.js", content: "shared token" }],
  });
  await indexRepository({
    workspaceId: "ws-remove",
    repoId: "drop",
    files: [{ path: "d.js", content: "shared token drop" }],
  });
  const { removed } = await removeRepo({ workspaceId: "ws-remove", repoId: "drop" });
  assert.equal(removed, true);
  const stats = await getRepoStats("ws-remove");
  assert.equal(stats.repos, 1);
  const hits = await searchRepo({ workspaceId: "ws-remove", query: "drop" });
  assert.equal(hits.hits.length, 0);
  const shared = await searchRepo({ workspaceId: "ws-remove", query: "shared" });
  assert.equal(shared.hits.length, 1);
  assert.equal(shared.hits[0].repoId, "keep");
});

test("re-indexing a repoId replaces its prior index", async () => {
  await _reset("ws-reindex");
  await indexRepository({
    workspaceId: "ws-reindex",
    repoId: "r",
    files: [{ path: "one.js", content: "alpha beta" }],
  });
  await indexRepository({
    workspaceId: "ws-reindex",
    repoId: "r",
    files: [{ path: "two.js", content: "gamma delta" }],
  });
  const alpha = await searchRepo({ workspaceId: "ws-reindex", query: "alpha" });
  assert.equal(alpha.hits.length, 0);
  const gamma = await searchRepo({ workspaceId: "ws-reindex", query: "gamma" });
  assert.equal(gamma.hits.length, 1);
  assert.equal(gamma.hits[0].path, "two.js");
});

test("removeRepo for unknown repo reports not removed", async () => {
  await _reset("ws-missing");
  const res = await removeRepo({ workspaceId: "ws-missing", repoId: "ghost" });
  assert.equal(res.removed, false);
});
