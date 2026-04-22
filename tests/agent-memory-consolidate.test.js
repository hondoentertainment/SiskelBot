import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "memory-consolidate-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  consolidationEnabled,
  jaccard,
  clusterMemories,
  summarizeCluster,
  consolidateIfNeeded,
} = await import("../lib/agent-memory-consolidate.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("consolidationEnabled: false by default", () => {
  const prev = process.env.AGENT_MEMORY_CONSOLIDATE;
  delete process.env.AGENT_MEMORY_CONSOLIDATE;
  try {
    assert.equal(consolidationEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.AGENT_MEMORY_CONSOLIDATE = prev;
  }
});

test("jaccard: empty sets -> 0", () => {
  assert.equal(jaccard(new Set(), new Set(["a"])), 0);
  assert.equal(jaccard(new Set(["a"]), new Set()), 0);
});

test("jaccard: identical sets -> 1", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
});

test("jaccard: partial overlap", () => {
  const j = jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]));
  // |intersect|=2, |union|=4 -> 0.5
  assert.equal(j, 0.5);
});

test("clusterMemories: groups near-duplicates", () => {
  const memories = [
    { id: "1", content: "deploy the application to production" },
    { id: "2", content: "deploy application to production environment" },
    { id: "3", content: "totally unrelated cat picture" },
  ];
  const clusters = clusterMemories(memories, 0.4);
  assert.ok(clusters.length >= 2);
  const deployCluster = clusters.find((c) => c.some((m) => m.id === "1"));
  assert.ok(deployCluster);
  assert.ok(deployCluster.some((m) => m.id === "2"));
});

test("clusterMemories: respects category boundaries", () => {
  const memories = [
    { id: "1", content: "same words here", category: "fact" },
    { id: "2", content: "same words here", category: "observation" },
  ];
  const clusters = clusterMemories(memories, 0.5);
  assert.equal(clusters.length, 2);
});

test("summarizeCluster: returns representative with count annotation", () => {
  const summary = summarizeCluster([
    { content: "a simple fact" },
    { content: "a simple fact again" },
    { content: "yet another simple fact repeated" },
  ]);
  assert.match(summary, /simple fact/);
  assert.match(summary, /×3/);
});

test("summarizeCluster: empty cluster -> empty string", () => {
  assert.equal(summarizeCluster([]), "");
  assert.equal(summarizeCluster(null), "");
});

test("consolidateIfNeeded: skipped when flag disabled", async () => {
  const prev = process.env.AGENT_MEMORY_CONSOLIDATE;
  delete process.env.AGENT_MEMORY_CONSOLIDATE;
  try {
    const r = await consolidateIfNeeded("u", "w");
    assert.equal(r.skipped, true);
  } finally {
    if (prev !== undefined) process.env.AGENT_MEMORY_CONSOLIDATE = prev;
  }
});

test("consolidateIfNeeded: skipped under trigger threshold", async () => {
  const prev = process.env.AGENT_MEMORY_CONSOLIDATE;
  process.env.AGENT_MEMORY_CONSOLIDATE = "1";
  try {
    const r = await consolidateIfNeeded("u-empty", "w-empty");
    assert.equal(r.skipped, true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MEMORY_CONSOLIDATE;
    else process.env.AGENT_MEMORY_CONSOLIDATE = prev;
  }
});
