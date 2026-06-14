/**
 * Workflow engine unit tests.
 * Uses temp directory via STORAGE_PATH to avoid polluting data/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-workflow-"));
process.env.STORAGE_PATH = tempDir;

import {
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listWorkflows,
  getWorkflow,
  executeWorkflow,
  getWorkflowRun,
  listWorkflowRuns,
} from "../lib/workflow-engine.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- CRUD tests ---

test("createWorkflow creates a workflow with defaults", async () => {
  const wf = await createWorkflow("test-ws", {
    name: "My Workflow",
    description: "A test workflow",
    steps: [
      { id: "s1", name: "Step 1", type: "transform", config: { expression: "hello" } },
    ],
  });

  assert.ok(wf.id, "should have an id");
  assert.equal(wf.name, "My Workflow");
  assert.equal(wf.description, "A test workflow");
  assert.equal(wf.workspaceId, "test-ws");
  assert.equal(wf.enabled, true);
  assert.equal(wf.steps.length, 1);
  assert.ok(wf.createdAt);
  assert.ok(wf.updatedAt);
});

test("listWorkflows returns workflows for a workspace", async () => {
  const items = await listWorkflows("test-ws");
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 1);
});

test("getWorkflow retrieves a workflow by id and workspace", async () => {
  const wf = await createWorkflow("test-ws", { name: "Get Test" });
  const found = await getWorkflow(wf.id, "test-ws");
  assert.ok(found);
  assert.equal(found.id, wf.id);
  assert.equal(found.name, "Get Test");
});

test("getWorkflow returns null for non-existent id", async () => {
  const found = await getWorkflow("non-existent", "test-ws");
  assert.equal(found, null);
});

test("updateWorkflow updates allowed fields", async () => {
  const wf = await createWorkflow("test-ws", { name: "Update Test" });
  const updated = await updateWorkflow(wf.id, { name: "Updated Name", enabled: false });
  assert.ok(updated);
  assert.equal(updated.name, "Updated Name");
  assert.equal(updated.enabled, false);
  assert.notEqual(updated.updatedAt, wf.updatedAt);
});

test("updateWorkflow returns null for non-existent id", async () => {
  const result = await updateWorkflow("non-existent-id", { name: "Nope" });
  assert.equal(result, null);
});

test("deleteWorkflow removes a workflow", async () => {
  const wf = await createWorkflow("test-ws", { name: "Delete Me" });
  const deleted = await deleteWorkflow(wf.id);
  assert.equal(deleted, true);

  const found = await getWorkflow(wf.id, "test-ws");
  assert.equal(found, null);
});

test("deleteWorkflow returns false for non-existent id", async () => {
  const result = await deleteWorkflow("non-existent-id");
  assert.equal(result, false);
});

// --- Execution tests ---

test("executeWorkflow runs a simple linear workflow", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Linear Workflow",
    steps: [
      { id: "s1", name: "Transform 1", type: "transform", config: { expression: "hello world" } },
      { id: "s2", name: "Transform 2", type: "transform", config: { expression: "step 2 done" } },
    ],
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "exec-ws" });
  assert.ok(run.runId);
  assert.equal(run.workflowId, wf.id);
  assert.equal(run.status, "completed");
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[0].status, "completed");
  assert.equal(run.steps[0].output.result, "hello world");
  assert.equal(run.steps[1].status, "completed");
  assert.ok(run.duration >= 0);
});

test("executeWorkflow handles variable interpolation", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Interpolation Workflow",
    variables: { greeting: "Hello" },
    steps: [
      { id: "s1", name: "Greet", type: "transform", config: { expression: "{{variables.greeting}} World" } },
      { id: "s2", name: "Use prev", type: "transform", config: { expression: "Result: {{steps.s1.result}}" } },
    ],
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "exec-ws" });
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].output.result, "Hello World");
  assert.equal(run.steps[1].output.result, "Result: Hello World");
});

test("executeWorkflow interpolates trigger input", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Trigger Input Workflow",
    steps: [
      { id: "s1", type: "transform", config: { expression: "Got: {{trigger.input.data}}" } },
    ],
  });

  const run = await executeWorkflow(wf.id, {
    workspaceId: "exec-ws",
    input: { data: "test-value" },
  });
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].output.result, "Got: test-value");
});

test("executeWorkflow overrides variables from context", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Override Vars",
    variables: { name: "default" },
    steps: [
      { id: "s1", type: "transform", config: { expression: "Name: {{variables.name}}" } },
    ],
  });

  const run = await executeWorkflow(wf.id, {
    workspaceId: "exec-ws",
    variables: { name: "overridden" },
  });
  assert.equal(run.steps[0].output.result, "Name: overridden");
});

// --- Condition branching tests ---

test("executeWorkflow handles condition branching (then)", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Condition Then",
    variables: { flag: "true" },
    steps: [
      {
        id: "cond1", type: "condition",
        config: { expression: "variables.flag == 'true'", thenStep: "yes-step", elseStep: "no-step" },
      },
      { id: "yes-step", type: "transform", config: { expression: "yes branch" } },
      { id: "no-step", type: "transform", config: { expression: "no branch" } },
    ],
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "exec-ws" });
  assert.equal(run.status, "completed");
  const condStep = run.steps.find((s) => s.stepId === "cond1");
  assert.ok(condStep);
  assert.equal(condStep.output.condition, true);
  assert.equal(condStep.output.branch, "then");
  assert.equal(condStep.output.branchOutput.result, "yes branch");
});

test("executeWorkflow handles condition branching (else)", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Condition Else",
    variables: { flag: "false" },
    steps: [
      {
        id: "cond2", type: "condition",
        config: { expression: "variables.flag == 'true'", thenStep: "yes-step2", elseStep: "no-step2" },
      },
      { id: "yes-step2", type: "transform", config: { expression: "yes" } },
      { id: "no-step2", type: "transform", config: { expression: "no" } },
    ],
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "exec-ws" });
  const condStep = run.steps.find((s) => s.stepId === "cond2");
  assert.equal(condStep.output.condition, false);
  assert.equal(condStep.output.branch, "else");
  assert.equal(condStep.output.branchOutput.result, "no");
});

// --- Error handling tests ---

test("executeWorkflow stops on error when onError is stop", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Error Stop",
    steps: [
      { id: "s1", type: "transform", config: { expression: "ok" } },
      { id: "s2", type: "http", config: { url: "http://invalid-host-that-does-not-exist.test/fail" }, onError: "stop" },
      { id: "s3", type: "transform", config: { expression: "should not run" } },
    ],
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "exec-ws" });
  assert.equal(run.status, "failed");
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[0].status, "completed");
  assert.equal(run.steps[1].status, "failed");
});

test("executeWorkflow continues on error when onError is continue", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Error Continue",
    steps: [
      { id: "s1", type: "transform", config: { expression: "ok" } },
      { id: "s2", type: "http", config: { url: "http://invalid-host-that-does-not-exist.test/fail" }, onError: "continue" },
      { id: "s3", type: "transform", config: { expression: "still running" } },
    ],
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "exec-ws" });
  assert.equal(run.status, "completed");
  assert.equal(run.steps.length, 3);
  assert.equal(run.steps[0].status, "completed");
  assert.equal(run.steps[1].status, "failed");
  assert.equal(run.steps[2].status, "completed");
  assert.equal(run.steps[2].output.result, "still running");
});

test("executeWorkflow throws for disabled workflow", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Disabled",
    enabled: false,
    steps: [{ id: "s1", type: "transform", config: { expression: "nope" } }],
  });

  await assert.rejects(
    () => executeWorkflow(wf.id, { workspaceId: "exec-ws" }),
    (err) => {
      assert.ok(err.message.includes("disabled"));
      return true;
    },
  );
});

test("executeWorkflow throws for non-existent workflow", async () => {
  await assert.rejects(
    () => executeWorkflow("does-not-exist", { workspaceId: "exec-ws" }),
    (err) => {
      assert.ok(err.message.includes("not found"));
      return true;
    },
  );
});

// --- Run history tests ---

test("getWorkflowRun retrieves a completed run", async () => {
  const wf = await createWorkflow("run-ws", {
    name: "Run History",
    steps: [{ id: "s1", type: "transform", config: { expression: "logged" } }],
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "run-ws" });
  const retrieved = await getWorkflowRun(run.runId, "run-ws");
  assert.ok(retrieved);
  assert.equal(retrieved.runId, run.runId);
  assert.equal(retrieved.workflowId, wf.id);
  assert.equal(retrieved.status, "completed");
});

test("listWorkflowRuns returns runs for a workflow", async () => {
  const wf = await createWorkflow("run-ws", {
    name: "Multiple Runs",
    steps: [{ id: "s1", type: "transform", config: { expression: "run" } }],
  });

  await executeWorkflow(wf.id, { workspaceId: "run-ws" });
  await executeWorkflow(wf.id, { workspaceId: "run-ws" });

  const runs = await listWorkflowRuns(wf.id, { workspaceId: "run-ws" });
  assert.ok(runs.length >= 2);
  for (const r of runs) {
    assert.equal(r.workflowId, wf.id);
  }
});

test("listWorkflowRuns supports limit and offset", async () => {
  const wf = await createWorkflow("run-ws", {
    name: "Paginated Runs",
    steps: [{ id: "s1", type: "transform", config: { expression: "page" } }],
  });

  await executeWorkflow(wf.id, { workspaceId: "run-ws" });
  await executeWorkflow(wf.id, { workspaceId: "run-ws" });
  await executeWorkflow(wf.id, { workspaceId: "run-ws" });

  const page1 = await listWorkflowRuns(wf.id, { workspaceId: "run-ws", limit: 2, offset: 0 });
  assert.ok(page1.length <= 2);

  const page2 = await listWorkflowRuns(wf.id, { workspaceId: "run-ws", limit: 2, offset: 2 });
  assert.ok(page2.length >= 1);
});

// --- Notify and chat step types ---

test("executeWorkflow runs notify step", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Notify Workflow",
    steps: [
      { id: "n1", type: "notify", config: { channel: "general", message: "Hello {{variables.who}}" } },
    ],
    variables: { who: "Team" },
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "exec-ws" });
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].output.notified, true);
  assert.equal(run.steps[0].output.channel, "general");
  assert.equal(run.steps[0].output.message, "Hello Team");
});

test("executeWorkflow runs chat step", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Chat Workflow",
    steps: [
      { id: "c1", type: "chat", config: { messages: [{ role: "user", content: "Hi" }], model: "gpt-4" } },
    ],
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "exec-ws" });
  assert.equal(run.status, "completed");
  assert.ok(run.steps[0].output.response.includes("chat"));
});

test("executeWorkflow runs recipe step", async () => {
  const wf = await createWorkflow("exec-ws", {
    name: "Recipe Workflow",
    steps: [
      { id: "r1", type: "recipe", config: { recipeName: "deploy-app" } },
    ],
  });

  const run = await executeWorkflow(wf.id, { workspaceId: "exec-ws" });
  assert.equal(run.status, "completed");
  assert.equal(run.steps[0].output.recipe, "deploy-app");
  assert.equal(run.steps[0].output.executed, true);
});
