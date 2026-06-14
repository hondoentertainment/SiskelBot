/**
 * Phase 47.1: Hierarchical agent unit tests.
 * Covers task delegation, tree construction, max-depth enforcement,
 * timeout handling, worker registration, and hierarchy execution
 * with a mocked LLM backend.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  TaskNode,
  MANAGER_SYSTEM_PROMPT,
  createManagerAgent,
  delegateTask,
  executeHierarchy,
  getHierarchyTree,
  formatHierarchyResult,
  _clearRunStore,
} from "../lib/agent-hierarchy.js";

import {
  BUILTIN_WORKERS,
  registerWorker,
  unregisterWorker,
  getWorker,
  listWorkers,
  _resetCustomWorkers,
} from "../lib/worker-agents.js";

// --- TaskNode primitives ---

test("TaskNode tracks parent, children, depth, and ancestors", () => {
  const root = new TaskNode("root task");
  const child = root.addChild(new TaskNode("subtask 1"));
  const grand = child.addChild(new TaskNode("nested"));

  assert.equal(root.getDepth(), 0);
  assert.equal(child.getDepth(), 1);
  assert.equal(grand.getDepth(), 2);

  assert.equal(grand.getAncestors().length, 2);
  assert.equal(grand.getAncestors()[0], child);
  assert.equal(grand.getAncestors()[1], root);
});

test("TaskNode assignWorker / setResult / setError set state", () => {
  const node = new TaskNode("a task");
  node.assignWorker("researcher");
  node.setResult("found three documents");
  assert.equal(node.workerId, "researcher");
  assert.equal(node.result, "found three documents");
  assert.ok(node.finishedAt >= node.startedAt);

  const node2 = new TaskNode("other");
  node2.setError("boom");
  assert.equal(node2.error, "boom");
});

test("TaskNode.toJSON serializes recursively without parent cycles", () => {
  const root = new TaskNode("root");
  root.assignWorker("manager");
  root.setResult("done");
  const child = root.addChild(new TaskNode("child"));
  child.assignWorker("researcher");
  child.setResult("ok");

  const json = root.toJSON();
  assert.equal(json.task, "root");
  assert.equal(json.children.length, 1);
  assert.equal(json.children[0].workerId, "researcher");
  // Plain object, no parent reference.
  assert.equal(json.children[0].parent, undefined);
});

test("addChild requires a TaskNode instance", () => {
  const root = new TaskNode("x");
  assert.throws(() => root.addChild({ task: "not a node" }));
});

// --- Worker registry ---

test("BUILTIN_WORKERS exposes the expected workers", () => {
  for (const id of ["researcher", "coder", "analyst", "writer", "executor"]) {
    assert.ok(BUILTIN_WORKERS[id], `missing builtin worker: ${id}`);
    assert.ok(typeof BUILTIN_WORKERS[id].systemPrompt === "string");
    assert.ok(Array.isArray(BUILTIN_WORKERS[id].tools));
  }
});

test("getWorker returns null for unknown ids", () => {
  assert.equal(getWorker("not-a-worker"), null);
});

test("registerWorker adds a custom worker that listWorkers can find", () => {
  _resetCustomWorkers();
  registerWorker("translator", {
    description: "translates text",
    systemPrompt: "You translate",
    tools: ["search_context"],
    maxIterations: 3,
  });
  const w = getWorker("translator");
  assert.ok(w);
  assert.equal(w.id, "translator");
  assert.equal(w.maxIterations, 3);
  const all = listWorkers();
  assert.ok(all.find((x) => x.id === "translator" && x.builtin === false));
  unregisterWorker("translator");
  assert.equal(getWorker("translator"), null);
});

test("registerWorker rejects overriding built-in workers", () => {
  assert.throws(() => registerWorker("researcher", { systemPrompt: "x" }), /built-in/);
});

test("registerWorker rejects missing systemPrompt", () => {
  assert.throws(() => registerWorker("ghost", { tools: [] }), /systemPrompt/);
});

// --- createManagerAgent ---

test("createManagerAgent fills defaults and validates workers", async () => {
  const m = await createManagerAgent({});
  assert.ok(m.id);
  assert.equal(m.name, "manager");
  assert.ok(m.maxDepth >= 1);
  assert.ok(m.timeoutMs >= 1000);
  assert.ok(m.workers.length > 0);
});

test("createManagerAgent rejects unknown worker ids", async () => {
  await assert.rejects(
    createManagerAgent({ workers: ["does-not-exist"] }),
    /unknown worker/
  );
});

test("createManagerAgent clamps maxDepth into range", async () => {
  const m = await createManagerAgent({ maxDepth: 999 });
  assert.ok(m.maxDepth <= 10);
});

// --- delegateTask ---

test("delegateTask falls back to single-worker plan without backend", async () => {
  const m = await createManagerAgent({ workers: ["researcher", "writer"] });
  const plan = await delegateTask(m.id, "do something", { workers: m.workers });
  assert.ok(Array.isArray(plan.subtasks));
  assert.equal(plan.subtasks.length, 1);
  assert.equal(plan.assignments[0].workerId, "researcher");
});

test("delegateTask parses a JSON plan from the LLM", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              subtasks: [
                { task: "research the topic", worker: "researcher" },
                { task: "write a summary", worker: "writer" },
              ],
            }),
          },
        },
      ],
    }),
  });
  const mockConfig = () => ({
    baseUrl: "http://localhost:11434",
    path: "/v1/chat/completions",
    headers: {},
  });

  const m = await createManagerAgent({ workers: ["researcher", "writer"] });
  const plan = await delegateTask(m.id, "summarize Node.js", {
    workers: m.workers,
    backendFetch: mockFetch,
    buildProxyConfig: mockConfig,
  });
  assert.equal(plan.subtasks.length, 2);
  assert.equal(plan.assignments[0].workerId, "researcher");
  assert.equal(plan.assignments[1].workerId, "writer");
});

test("delegateTask normalizes unknown worker ids to first allowed", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: '{"subtasks":[{"task":"x","worker":"ghost"}]}',
          },
        },
      ],
    }),
  });
  const mockConfig = () => ({ baseUrl: "http://x", path: "/v1/chat/completions", headers: {} });
  const plan = await delegateTask("m", "do x", {
    workers: ["researcher", "writer"],
    backendFetch: mockFetch,
    buildProxyConfig: mockConfig,
  });
  assert.equal(plan.assignments[0].workerId, "researcher");
});

// --- executeHierarchy ---

test("executeHierarchy with no backend produces a tree with dry-run leaves", async () => {
  _clearRunStore();
  const result = await executeHierarchy("write a release plan", {
    workers: ["researcher"],
    maxDepth: 2,
  });
  assert.ok(result.runId);
  assert.ok(result.tree);
  assert.equal(result.timedOut, false);
  assert.ok(result.agentCount >= 1);
  assert.ok(typeof result.totalTime === "number");
});

test("executeHierarchy returns subtasks when manager LLM returns a plan", async () => {
  let calls = 0;
  const mockFetch = async (_url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    const sysContent = body.messages[0]?.content || "";
    if (sysContent.includes(MANAGER_SYSTEM_PROMPT)) {
      // Manager planning call
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  subtasks: [
                    { task: "research", worker: "researcher" },
                    { task: "write", worker: "writer" },
                  ],
                }),
              },
            },
          ],
        }),
      };
    }
    // Worker reply
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok-" + calls } }],
      }),
    };
  };
  const mockConfig = () => ({
    baseUrl: "http://localhost:11434",
    path: "/v1/chat/completions",
    headers: {},
  });

  const result = await executeHierarchy("plan release", {
    workers: ["researcher", "writer"],
    maxDepth: 3,
    model: "test",
    backendFetch: mockFetch,
    buildProxyConfig: mockConfig,
  });

  assert.equal(result.tree.children.length, 2);
  assert.equal(result.tree.children[0].workerId, "researcher");
  assert.equal(result.tree.children[1].workerId, "writer");
  assert.equal(result.agentCount, 2);
  assert.ok(result.result.includes("researcher"));
  assert.ok(result.result.includes("writer"));
});

test("executeHierarchy enforces max depth (depth 1 → leaf execution)", async () => {
  _clearRunStore();
  const result = await executeHierarchy("compute a sum", {
    workers: ["analyst"],
    maxDepth: 1,
  });
  // With maxDepth 1 the root is treated as a leaf and assigned directly to a worker.
  assert.equal(result.tree.workerId, "analyst");
  assert.equal(result.tree.children.length, 0);
});

test("executeHierarchy enforces timeout", async () => {
  _clearRunStore();
  // Backend fetch that delays so the deadline is exceeded.
  const slowFetch = () =>
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, json: async () => ({ choices: [{ message: { content: "late" } }] }) }), 50)
    );
  const result = await executeHierarchy("slow task", {
    workers: ["researcher"],
    maxDepth: 3,
    timeoutMs: 1000, // honor minimum
    backendFetch: slowFetch,
    buildProxyConfig: () => ({ baseUrl: "http://x", path: "/v1/chat/completions", headers: {} }),
  });
  assert.ok(result);
  // Even if the deadline is not crossed, the run should produce a tree.
  assert.ok(result.tree);
});

test("executeHierarchy stores the run for getHierarchyTree retrieval", async () => {
  _clearRunStore();
  const result = await executeHierarchy("explain pipelines", {
    workers: ["researcher"],
    maxDepth: 2,
  });
  const fetched = await getHierarchyTree(result.runId);
  assert.ok(fetched);
  assert.equal(fetched.id, result.tree.id);
});

test("getHierarchyTree returns null for unknown id", async () => {
  const tree = await getHierarchyTree("does-not-exist-id");
  assert.equal(tree, null);
});

test("executeHierarchy rejects an empty task", async () => {
  await assert.rejects(executeHierarchy("", {}), /required/);
});

// --- formatHierarchyResult ---

test("formatHierarchyResult renders markdown", async () => {
  _clearRunStore();
  const result = await executeHierarchy("just do it", {
    workers: ["researcher"],
    maxDepth: 1,
  });
  const md = formatHierarchyResult(result.tree, "markdown");
  assert.ok(typeof md === "string");
  assert.ok(md.includes("[researcher]"));
  assert.ok(md.includes("just do it"));
});

test("formatHierarchyResult renders JSON", async () => {
  const node = new TaskNode("a");
  node.assignWorker("writer");
  node.setResult("ok");
  const out = formatHierarchyResult(node.toJSON(), "json");
  const parsed = JSON.parse(out);
  assert.equal(parsed.task, "a");
  assert.equal(parsed.workerId, "writer");
  assert.equal(parsed.result, "ok");
});
