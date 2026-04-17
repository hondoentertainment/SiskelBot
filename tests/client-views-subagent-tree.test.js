/**
 * Unit tests for client/src/views/subagent-tree.js pure functions.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { buildTree, renderTreeHtml, updateNodeInTree } = await import(
  "../client/src/views/subagent-tree.js"
);

// ── buildTree ──────────────────────────────────────────────────────────────

test("buildTree: empty events produces root-only tree", () => {
  const tree = buildTree([], { sessionId: "s1", title: "root session" });
  assert.equal(tree.id, "s1");
  assert.equal(tree.title, "root session");
  assert.equal(tree.profile, "root");
  assert.equal(tree.status, "running");
  assert.deepEqual(tree.children, []);
});

test("buildTree: spawned events create correct children", () => {
  const events = [
    { type: "subagent.spawned", payload: { childSessionId: "c1", profile: "researcher", goal: "Find docs" } },
    { type: "subagent.spawned", payload: { childSessionId: "c2", profile: "executor", goal: "Run build" } },
  ];
  const tree = buildTree(events, { sessionId: "root" });
  assert.equal(tree.children.length, 2);
  assert.equal(tree.children[0].id, "c1");
  assert.equal(tree.children[0].profile, "researcher");
  assert.equal(tree.children[0].title, "Find docs");
  assert.equal(tree.children[0].status, "pending");
  assert.equal(tree.children[1].id, "c2");
  assert.equal(tree.children[1].profile, "executor");
});

test("buildTree: subagent.done updates child status and iterations", () => {
  const events = [
    { type: "subagent.spawned", payload: { childSessionId: "c1", profile: "reviewer", goal: "Review" } },
    { type: "subagent.done", payload: { childSessionId: "c1", iterations: 3 } },
  ];
  const tree = buildTree(events);
  assert.equal(tree.children[0].status, "complete");
  assert.equal(tree.children[0].iterations, 3);
});

test("buildTree: subagent.done with error sets failed status", () => {
  const events = [
    { type: "subagent.spawned", payload: { childSessionId: "c1", goal: "Task" } },
    { type: "subagent.done", payload: { childSessionId: "c1", error: "timeout" } },
  ];
  const tree = buildTree(events);
  assert.equal(tree.children[0].status, "failed");
});

test("buildTree: cost.update updates child cost", () => {
  const events = [
    { type: "subagent.spawned", payload: { childSessionId: "c1", goal: "Task" } },
    { type: "cost.update", payload: { childSessionId: "c1", childCostUsd: 0.005 } },
  ];
  const tree = buildTree(events);
  assert.equal(tree.children[0].costUsd, 0.005);
});

test("buildTree: handles null/undefined events gracefully", () => {
  const tree = buildTree(null);
  assert.equal(tree.id, "root");
  assert.deepEqual(tree.children, []);
});

test("buildTree: duplicate childSessionId ignored", () => {
  const events = [
    { type: "subagent.spawned", payload: { childSessionId: "c1", goal: "X" } },
    { type: "subagent.spawned", payload: { childSessionId: "c1", goal: "Y" } },
  ];
  const tree = buildTree(events);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].title, "X");
});

// ── renderTreeHtml ─────────────────────────────────────────────────────────

test("renderTreeHtml: renders correct depth classes", () => {
  const tree = { id: "r", title: "root", profile: "root", status: "running", costUsd: 0.04, iterations: 7, children: [
    { id: "c1", title: "child", profile: "researcher", status: "complete", costUsd: 0.01, iterations: 3, children: [] },
  ] };
  const html = renderTreeHtml(tree);
  assert.ok(html.includes("sat-depth-0"));
  assert.ok(html.includes("sat-depth-1"));
});

test("renderTreeHtml: includes status class", () => {
  const tree = { id: "r", title: "root", profile: "root", status: "failed", costUsd: 0, iterations: 0, children: [] };
  const html = renderTreeHtml(tree);
  assert.ok(html.includes("sat-status-failed"));
  assert.ok(html.includes("sat-badge-failed"));
});

test("renderTreeHtml: collapsed node omits children", () => {
  const tree = { id: "r", title: "root", profile: "root", status: "running", costUsd: 0, iterations: 0, children: [
    { id: "c1", title: "child", profile: "executor", status: "pending", costUsd: 0, iterations: 0, children: [] },
  ] };
  const collapsed = new Set(["r"]);
  const html = renderTreeHtml(tree, 0, collapsed);
  assert.ok(!html.includes("sat-depth-1"), "collapsed root should not render children");
  assert.ok(html.includes("\u25B6"), "collapsed toggle should show right arrow");
});

test("renderTreeHtml: handles null tree", () => {
  assert.equal(renderTreeHtml(null), "");
});

// ── updateNodeInTree ───────────────────────────────────────────────────────

test("updateNodeInTree: updates correct node by childSessionId", () => {
  const tree = { id: "r", children: [
    { id: "c1", status: "pending", costUsd: 0, children: [] },
  ] };
  const updated = updateNodeInTree(tree, "c1", { status: "complete", costUsd: 0.01 });
  assert.equal(updated.children[0].status, "complete");
  assert.equal(updated.children[0].costUsd, 0.01);
});

test("updateNodeInTree: does not mutate input", () => {
  const tree = { id: "r", children: [
    { id: "c1", status: "pending", children: [] },
  ] };
  const updated = updateNodeInTree(tree, "c1", { status: "complete" });
  assert.equal(tree.children[0].status, "pending");
  assert.notEqual(updated, tree);
});

test("updateNodeInTree: handles missing node gracefully", () => {
  const tree = { id: "r", children: [] };
  const result = updateNodeInTree(tree, "nonexistent", { status: "done" });
  assert.equal(result, tree, "should return same reference when node not found");
});

test("updateNodeInTree: handles null tree", () => {
  assert.equal(updateNodeInTree(null, "c1", { status: "done" }), null);
});
