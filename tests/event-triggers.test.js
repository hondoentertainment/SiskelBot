/**
 * Event triggers unit tests.
 * Register, fire, filter, transform, and remove triggers.
 * Uses temp directory via STORAGE_PATH to avoid polluting data/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-triggers-"));
process.env.STORAGE_PATH = tempDir;

import {
  registerTrigger,
  removeTrigger,
  listTriggers,
  getTrigger,
  fireTrigger,
  getAllowedEvents,
} from "../lib/event-triggers.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- Registration tests ---

test("registerTrigger creates a trigger with defaults", async () => {
  const trigger = await registerTrigger({
    workspaceId: "test-ws",
    event: "webhook.received",
    workflowId: "wf-123",
    name: "On Webhook",
  });

  assert.ok(trigger.id);
  assert.equal(trigger.workspaceId, "test-ws");
  assert.equal(trigger.event, "webhook.received");
  assert.equal(trigger.workflowId, "wf-123");
  assert.equal(trigger.name, "On Webhook");
  assert.equal(trigger.enabled, true);
  assert.equal(trigger.fireCount, 0);
  assert.equal(trigger.lastFiredAt, null);
  assert.ok(trigger.createdAt);
});

test("registerTrigger rejects invalid event", async () => {
  await assert.rejects(
    () => registerTrigger({ workspaceId: "test-ws", event: "invalid.event", workflowId: "wf-1" }),
    { message: /Invalid event/ }
  );
});

test("registerTrigger rejects missing workflowId", async () => {
  await assert.rejects(
    () => registerTrigger({ workspaceId: "test-ws", event: "webhook.received", workflowId: "" }),
    { message: /workflowId is required/ }
  );
});

test("getAllowedEvents returns valid event list", () => {
  const events = getAllowedEvents();
  assert.ok(Array.isArray(events));
  assert.ok(events.includes("webhook.received"));
  assert.ok(events.includes("agent.finished"));
  assert.ok(events.includes("document.created"));
  assert.ok(events.includes("recipe.completed"));
  assert.ok(events.includes("conversation.created"));
  assert.ok(events.includes("schedule.fired"));
});

// --- List / Get tests ---

test("listTriggers returns triggers for a workspace", async () => {
  const triggers = await listTriggers("test-ws");
  assert.ok(Array.isArray(triggers));
  assert.ok(triggers.length >= 1);
});

test("listTriggers returns empty for unknown workspace", async () => {
  const triggers = await listTriggers("no-such-ws");
  assert.ok(Array.isArray(triggers));
  assert.equal(triggers.length, 0);
});

test("getTrigger retrieves by id", async () => {
  const created = await registerTrigger({
    workspaceId: "test-ws",
    event: "recipe.completed",
    workflowId: "wf-abc",
    name: "Recipe Done",
  });

  const found = await getTrigger("test-ws", created.id);
  assert.ok(found);
  assert.equal(found.id, created.id);
  assert.equal(found.name, "Recipe Done");
});

test("getTrigger returns null for non-existent", async () => {
  const found = await getTrigger("test-ws", "non-existent");
  assert.equal(found, null);
});

// --- Remove tests ---

test("removeTrigger removes a trigger", async () => {
  const trigger = await registerTrigger({
    workspaceId: "test-ws",
    event: "agent.finished",
    workflowId: "wf-del",
    name: "To Delete",
  });

  const removed = await removeTrigger("test-ws", trigger.id);
  assert.equal(removed, true);

  const found = await getTrigger("test-ws", trigger.id);
  assert.equal(found, null);
});

test("removeTrigger returns false for non-existent", async () => {
  const removed = await removeTrigger("test-ws", "non-existent");
  assert.equal(removed, false);
});

// --- Fire tests ---

test("fireTrigger matches and executes triggers", async () => {
  await registerTrigger({
    workspaceId: "fire-ws",
    event: "document.created",
    workflowId: "wf-fire-1",
    name: "Doc Trigger",
  });

  const executed = [];
  const result = await fireTrigger("document.created", { docId: "d1", title: "Test" }, {
    workspaceId: "fire-ws",
    executeWorkflow: async (workflowId, opts) => {
      executed.push({ workflowId, opts });
      return { runId: "run-1" };
    },
  });

  assert.equal(result.matched, 1);
  assert.equal(result.executed, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, "executed");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].workflowId, "wf-fire-1");
});

test("fireTrigger with no matching event returns 0 matches", async () => {
  const result = await fireTrigger("conversation.created", {}, {
    workspaceId: "fire-ws",
  });

  assert.equal(result.matched, 0);
  assert.equal(result.executed, 0);
});

test("fireTrigger dry-run when no executeWorkflow provided", async () => {
  await registerTrigger({
    workspaceId: "fire-ws",
    event: "schedule.fired",
    workflowId: "wf-dry",
  });

  const result = await fireTrigger("schedule.fired", { task: "run-report" }, {
    workspaceId: "fire-ws",
  });

  assert.equal(result.matched, 1);
  assert.equal(result.executed, 1);
  assert.equal(result.results[0].status, "dry-run");
});

// --- Filter tests ---

test("fireTrigger applies filter and skips non-matching events", async () => {
  await registerTrigger({
    workspaceId: "filter-ws",
    event: "webhook.received",
    workflowId: "wf-filtered",
    filter: { source: "github" },
  });

  // Non-matching: source is "gitlab"
  const result1 = await fireTrigger("webhook.received", { source: "gitlab" }, {
    workspaceId: "filter-ws",
    executeWorkflow: async () => ({}),
  });
  assert.equal(result1.matched, 1);
  assert.equal(result1.executed, 0);

  // Matching: source is "github"
  const result2 = await fireTrigger("webhook.received", { source: "github" }, {
    workspaceId: "filter-ws",
    executeWorkflow: async () => ({}),
  });
  assert.equal(result2.matched, 1);
  assert.equal(result2.executed, 1);
});

// --- Conditional / temporal filter tests ---

test("evaluateFilter supports operator conditions and dotted paths", async () => {
  const { _internal } = await import("../lib/event-triggers.js");
  const { evaluateFilter } = _internal;

  // numeric comparisons
  assert.equal(evaluateFilter({ count: { op: "gt", value: 5 } }, { count: 10 }), true);
  assert.equal(evaluateFilter({ count: { op: "gt", value: 5 } }, { count: 2 }), false);
  assert.equal(evaluateFilter({ count: { op: "lte", value: 5 } }, { count: 5 }), true);

  // contains / in / ne
  assert.equal(evaluateFilter({ title: { op: "contains", value: "urgent" } }, { title: "urgent fix" }), true);
  assert.equal(evaluateFilter({ env: { op: "in", value: ["prod", "stage"] } }, { env: "prod" }), true);
  assert.equal(evaluateFilter({ env: { op: "in", value: ["prod"] } }, { env: "dev" }), false);
  assert.equal(evaluateFilter({ state: { op: "ne", value: "closed" } }, { state: "open" }), true);

  // exists
  assert.equal(evaluateFilter({ author: { op: "exists" } }, { author: "x" }), true);
  assert.equal(evaluateFilter({ author: { op: "exists", value: false } }, {}), true);

  // dotted path
  assert.equal(evaluateFilter({ "pr.labels": { op: "contains", value: "bug" } }, { pr: { labels: "bug,ci" } }), true);

  // backward compatible equality still works
  assert.equal(evaluateFilter({ source: "github" }, { source: "github" }), true);
  assert.equal(evaluateFilter({ source: "github" }, { source: "gitlab" }), false);
});

test("evaluateFilter supports temporal older_than / newer_than", async () => {
  const { _internal } = await import("../lib/event-triggers.js");
  const { evaluateFilter } = _internal;
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const justNow = new Date().toISOString();

  assert.equal(evaluateFilter({ updatedAt: { op: "older_than", value: 3600 } }, { updatedAt: twoHoursAgo }), true);
  assert.equal(evaluateFilter({ updatedAt: { op: "older_than", value: 3600 } }, { updatedAt: justNow }), false);
  assert.equal(evaluateFilter({ updatedAt: { op: "newer_than", value: 3600 } }, { updatedAt: justNow }), true);
  assert.equal(evaluateFilter({ updatedAt: { op: "older_than", value: 3600 } }, { updatedAt: "not-a-date" }), false);
});

test("fireTrigger honors an operator condition end-to-end", async () => {
  await registerTrigger({
    workspaceId: "cond-ws",
    event: "webhook.received",
    workflowId: "wf-cond",
    filter: { stars: { op: "gte", value: 100 } },
  });

  const low = await fireTrigger("webhook.received", { stars: 10 }, {
    workspaceId: "cond-ws",
    executeWorkflow: async () => ({}),
  });
  assert.equal(low.executed, 0);

  const high = await fireTrigger("webhook.received", { stars: 250 }, {
    workspaceId: "cond-ws",
    executeWorkflow: async () => ({}),
  });
  assert.equal(high.executed, 1);
});

// --- Transform tests ---

test("fireTrigger applies transform to data", async () => {
  await registerTrigger({
    workspaceId: "transform-ws",
    event: "agent.finished",
    workflowId: "wf-transform",
    transform: {
      agentName: "agent.name",
      resultSummary: "result.summary",
    },
  });

  let receivedVars = null;
  await fireTrigger(
    "agent.finished",
    { agent: { name: "researcher" }, result: { summary: "Found 3 docs" } },
    {
      workspaceId: "transform-ws",
      executeWorkflow: async (_wfId, opts) => {
        receivedVars = opts.variables;
        return {};
      },
    },
  );

  assert.ok(receivedVars);
  assert.equal(receivedVars.agentName, "researcher");
  assert.equal(receivedVars.resultSummary, "Found 3 docs");
});

test("fireTrigger updates fireCount after firing", async () => {
  const trigger = await registerTrigger({
    workspaceId: "count-ws",
    event: "recipe.completed",
    workflowId: "wf-count",
  });

  await fireTrigger("recipe.completed", { recipeId: "r1" }, {
    workspaceId: "count-ws",
    executeWorkflow: async () => ({}),
  });

  const updated = await getTrigger("count-ws", trigger.id);
  assert.equal(updated.fireCount, 1);
  assert.ok(updated.lastFiredAt);
});

test("fireTrigger handles workflow execution errors gracefully", async () => {
  await registerTrigger({
    workspaceId: "error-ws",
    event: "document.created",
    workflowId: "wf-error",
  });

  const result = await fireTrigger("document.created", {}, {
    workspaceId: "error-ws",
    executeWorkflow: async () => { throw new Error("Workflow failed"); },
  });

  assert.equal(result.matched, 1);
  assert.equal(result.executed, 0);
  assert.equal(result.results[0].status, "error");
  assert.ok(result.results[0].error.includes("Workflow failed"));
});
