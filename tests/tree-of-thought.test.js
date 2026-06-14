/**
 * Phase 52.1: Tree-of-Thought reasoning tests.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  ThoughtNode,
  expandThought,
  scoreThought,
  beamSearch,
  dfsSearch,
  bfsSearch,
  pruneLowScoring,
  defaultGoalCheck,
  extractAnswer,
  treeToDot,
  treeToJson,
} = await import("../lib/tree-of-thought.js");

// ---- ThoughtNode ----

test("ThoughtNode creation and children", () => {
  const root = new ThoughtNode({ thought: "root task" });
  assert.equal(root.thought, "root task");
  assert.equal(root.depth, 0);
  assert.equal(root.children.length, 0);
  assert.ok(root.id);

  const child = new ThoughtNode({ thought: "child" });
  root.addChild(child);
  assert.equal(root.children.length, 1);
  assert.equal(child.depth, 1);
  assert.equal(child.parent, root);
});

test("getPath returns root to node inclusive", () => {
  const root = new ThoughtNode({ thought: "root" });
  const a = new ThoughtNode({ thought: "a" });
  const b = new ThoughtNode({ thought: "b" });
  root.addChild(a);
  a.addChild(b);

  const path = b.getPath();
  assert.equal(path.length, 3);
  assert.equal(path[0].thought, "root");
  assert.equal(path[1].thought, "a");
  assert.equal(path[2].thought, "b");
});

test("addChild rejects non-ThoughtNode", () => {
  const root = new ThoughtNode({ thought: "r" });
  assert.throws(() => root.addChild({ thought: "x" }), TypeError);
});

// ---- expandThought ----

test("expandThought produces children with scores", async () => {
  const root = new ThoughtNode({ thought: "Solve: 2+2" });
  const gen = async () => ["therefore we add 2 and 2", "possibly 4", "the answer is 4"];
  const kids = await expandThought(root, { generator: gen, k: 3 });
  assert.equal(kids.length, 3);
  assert.equal(root.children.length, 3);
  for (const k of kids) {
    assert.equal(k.depth, 1);
    assert.equal(k.parent, root);
    assert.ok(k.score >= 0 && k.score <= 1);
  }
});

test("expandThought respects k", async () => {
  const root = new ThoughtNode({ thought: "r" });
  const gen = async () => ["a", "b", "c", "d", "e"];
  const kids = await expandThought(root, { generator: gen, k: 2 });
  assert.equal(kids.length, 2);
});

test("expandThought errors on bad generator output", async () => {
  const root = new ThoughtNode({ thought: "r" });
  await assert.rejects(
    () => expandThought(root, { generator: async () => "not-an-array", k: 2 }),
    /must return an array/
  );
});

// ---- scoreThought ----

test("scoreThought is deterministic for identical input", () => {
  const a = new ThoughtNode({
    thought: "Therefore the answer must be 42 because of reasoning steps.",
  });
  const b = new ThoughtNode({
    thought: "Therefore the answer must be 42 because of reasoning steps.",
  });
  assert.equal(scoreThought(a), scoreThought(b));
});

test("scoreThought rewards confidence markers and penalizes hedges", () => {
  const confident = new ThoughtNode({
    thought: "Therefore the final answer is clearly 7 based on the proof.",
  });
  const hedged = new ThoughtNode({
    thought: "Maybe the answer is perhaps 7, I think, though I'm unsure.",
  });
  assert.ok(scoreThought(confident) > scoreThought(hedged));
});

test("scoreThought returns 0 for empty thoughts", () => {
  const empty = new ThoughtNode({ thought: "" });
  assert.equal(scoreThought(empty), 0);
});

// ---- beamSearch ----

test("beamSearch with mock generator returns best path", async () => {
  let call = 0;
  // Deterministic generator: one branch leads to a final answer.
  const generator = async (ctx) => {
    call++;
    const d = ctx.node.depth;
    if (d === 0) return ["branch A considered", "branch B considered", "branch C considered"];
    if (d === 1) {
      if (ctx.node.thought.startsWith("branch A")) {
        return ["therefore step A1", "A2 maybe", "A3 clearly valid"];
      }
      return ["some other step", "another step", "yet another"];
    }
    if (d === 2) {
      if (ctx.node.thought.includes("A3")) {
        return ["final answer: 42"];
      }
      return ["inconclusive", "still searching"];
    }
    return [];
  };
  const result = await beamSearch("what is the meaning of life?", {
    depth: 3,
    beamWidth: 2,
    k: 3,
    generator,
  });
  assert.ok(result.bestPath.length >= 1);
  assert.ok(result.tree instanceof ThoughtNode);
  assert.ok(result.stats.nodesExpanded > 0);
  assert.ok(call > 0);
  // Should have found a goal
  assert.ok(result.stats.goalsFound >= 1);
  const last = result.bestPath[result.bestPath.length - 1];
  assert.match(last.thought.toLowerCase(), /final answer/);
});

test("beamSearch respects beamWidth", async () => {
  const gen = async () => ["a long and confident thought 1", "maybe 2", "clearly 3", "hedged 4", "certainly 5"];
  const result = await beamSearch("task", {
    depth: 1,
    beamWidth: 2,
    k: 5,
    generator: gen,
  });
  // At depth 1, at most 2 children should survive pruning.
  const surviving = result.tree.children.filter((c) => !c.pruned);
  assert.ok(surviving.length <= 2);
});

test("beamSearch respects max depth", async () => {
  const gen = async () => ["a", "b", "c"];
  const result = await beamSearch("task", {
    depth: 2,
    beamWidth: 2,
    k: 3,
    generator: gen,
  });
  // Deepest node should be at depth 2 (root=0, then 2 expansions).
  assert.ok(result.stats.maxDepthReached <= 2);
});

// ---- dfsSearch / bfsSearch ----

test("dfsSearch traverses depth-first", async () => {
  const gen = async () => ["thought one", "thought two"];
  const result = await dfsSearch("root", { depth: 2, k: 2, generator: gen });
  assert.ok(result.tree instanceof ThoughtNode);
  assert.ok(result.stats.nodesExpanded >= 1);
  assert.ok(result.stats.maxDepthReached >= 1);
});

test("bfsSearch traverses breadth-first", async () => {
  const gen = async () => ["thought one", "thought two"];
  const result = await bfsSearch("root", { depth: 2, k: 2, generator: gen });
  assert.ok(result.visitOrder, "bfsSearch should expose visitOrder");
  // Level order: root (depth 0), then all depth-1 nodes, then all depth-2.
  let prevDepth = -1;
  for (const node of result.visitOrder) {
    assert.ok(node.depth >= prevDepth);
    prevDepth = node.depth;
  }
});

// ---- pruneLowScoring ----

test("pruneLowScoring removes below threshold", () => {
  const a = new ThoughtNode({ thought: "a" });
  a.score = 0.1;
  const b = new ThoughtNode({ thought: "b" });
  b.score = 0.5;
  const c = new ThoughtNode({ thought: "c" });
  c.score = 0.9;
  const kept = pruneLowScoring([a, b, c], 0.4);
  assert.equal(kept.length, 2);
  assert.ok(a.pruned);
  assert.ok(!b.pruned);
  assert.ok(!c.pruned);
});

test("pruneLowScoring handles non-array input", () => {
  assert.deepEqual(pruneLowScoring(null, 0.5), []);
});

// ---- custom scorer / goalCheck ----

test("custom scorer is used when provided", async () => {
  const custom = () => 0.999;
  const gen = async () => ["a", "b"];
  const result = await beamSearch("root", {
    depth: 1,
    beamWidth: 2,
    k: 2,
    generator: gen,
    scorer: custom,
  });
  for (const child of result.tree.children) {
    assert.equal(child.score, 0.999);
  }
});

test("custom goalCheck terminates search early", async () => {
  const gen = async () => ["any thought", "another"];
  const goal = (node) => node.depth >= 1; // stop immediately
  const result = await beamSearch("root", {
    depth: 5,
    beamWidth: 3,
    k: 2,
    generator: gen,
    goalCheck: goal,
  });
  // maxDepthReached should not exceed 1 because all depth-1 nodes are terminals.
  assert.ok(result.stats.maxDepthReached <= 1);
  assert.ok(result.stats.goalsFound >= 1);
});

// ---- defaultGoalCheck ----

test("defaultGoalCheck detects conclusion markers", () => {
  assert.ok(defaultGoalCheck(new ThoughtNode({ thought: "Final answer: 42" })));
  assert.ok(defaultGoalCheck(new ThoughtNode({ thought: "The answer is 7" })));
  assert.ok(defaultGoalCheck(new ThoughtNode({ thought: "Conclusion: done." })));
  assert.ok(!defaultGoalCheck(new ThoughtNode({ thought: "still reasoning" })));
  assert.ok(defaultGoalCheck(new ThoughtNode({ thought: "x", state: { goal: true } })));
});

// ---- extractAnswer ----

test("extractAnswer pulls from marker", () => {
  const root = new ThoughtNode({ thought: "start" });
  const mid = new ThoughtNode({ thought: "work" });
  const end = new ThoughtNode({ thought: "Final answer: 42" });
  root.addChild(mid);
  mid.addChild(end);
  assert.equal(extractAnswer(end.getPath()), "42");
});

test("extractAnswer returns last thought when no marker", () => {
  const n = new ThoughtNode({ thought: "just some text" });
  assert.equal(extractAnswer([n]), "just some text");
});

test("extractAnswer handles empty path", () => {
  assert.equal(extractAnswer([]), "");
  assert.equal(extractAnswer(null), "");
});

// ---- serialization ----

test("treeToJson serializes tree", () => {
  const root = new ThoughtNode({ thought: "r" });
  root.addChild(new ThoughtNode({ thought: "a" }));
  const j = treeToJson(root);
  assert.equal(j.thought, "r");
  assert.equal(j.children.length, 1);
  assert.equal(j.children[0].thought, "a");
  assert.ok(j.id);
});

test("treeToDot produces valid DOT string", () => {
  const root = new ThoughtNode({ thought: "root" });
  const a = new ThoughtNode({ thought: "child with \"quotes\"" });
  root.addChild(a);
  const dot = treeToDot(root);
  assert.ok(dot.startsWith("digraph ToT {"));
  assert.ok(dot.trimEnd().endsWith("}"));
  assert.match(dot, /root/);
  // Edge present
  assert.match(dot, /->/);
});

test("treeToDot handles non-node input", () => {
  assert.equal(treeToDot(null), "digraph ToT {}");
});

// ---- edge cases ----

test("empty tree handled", async () => {
  const result = await beamSearch("", {
    depth: 0,
    beamWidth: 1,
    k: 1,
    generator: async () => [],
  });
  assert.ok(result.tree instanceof ThoughtNode);
  assert.equal(result.tree.thought, "");
  assert.equal(result.stats.nodesExpanded, 0);
});

test("single node handled", async () => {
  // depth=0 means we only score the root; no expansion.
  const result = await beamSearch("just the root", {
    depth: 0,
    beamWidth: 1,
    k: 1,
    generator: async () => ["unused"],
  });
  assert.equal(result.bestPath.length, 1);
  assert.equal(result.bestPath[0].thought, "just the root");
});

test("beamSearch with default generator runs", async () => {
  const result = await beamSearch("task", { depth: 2, beamWidth: 2, k: 2 });
  assert.ok(result.bestPath.length >= 1);
  assert.ok(result.tree instanceof ThoughtNode);
  assert.ok(result.stats.nodesCreated > 1);
});
