/**
 * Scheduled agents unit tests.
 * CRUD, run execution, and run history.
 * Uses temp directory via STORAGE_PATH to avoid polluting data/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-sched-agents-"));
process.env.STORAGE_PATH = tempDir;

import {
  createScheduledAgent,
  listScheduledAgents,
  getScheduledAgent,
  updateScheduledAgent,
  deleteScheduledAgent,
  runScheduledAgent,
  getScheduledAgentRuns,
} from "../lib/scheduled-agents.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- CRUD tests ---

test("createScheduledAgent creates an agent with defaults", async () => {
  const agent = await createScheduledAgent({
    workspaceId: "test-ws",
    cron: "0 9 * * *",
    prompt: "Summarize the latest news",
    name: "Daily Summary",
  });

  assert.ok(agent.id, "should have an id");
  assert.equal(agent.workspaceId, "test-ws");
  assert.equal(agent.name, "Daily Summary");
  assert.equal(agent.cron, "0 9 * * *");
  assert.equal(agent.prompt, "Summarize the latest news");
  assert.equal(agent.agentMode, "single");
  assert.equal(agent.enabled, true);
  assert.ok(agent.createdAt);
  assert.ok(agent.updatedAt);
});

test("createScheduledAgent rejects missing prompt", async () => {
  await assert.rejects(
    () => createScheduledAgent({ workspaceId: "test-ws", cron: "0 9 * * *", prompt: "" }),
    { message: /prompt is required/ }
  );
});

test("createScheduledAgent rejects invalid cron", async () => {
  await assert.rejects(
    () => createScheduledAgent({ workspaceId: "test-ws", cron: "bad", prompt: "do something" }),
    { message: /valid cron/ }
  );
});

test("listScheduledAgents returns agents for a workspace", async () => {
  const agents = await listScheduledAgents("test-ws");
  assert.ok(Array.isArray(agents));
  assert.ok(agents.length >= 1);
});

test("listScheduledAgents returns empty array for unknown workspace", async () => {
  const agents = await listScheduledAgents("no-such-ws");
  assert.ok(Array.isArray(agents));
  assert.equal(agents.length, 0);
});

test("getScheduledAgent retrieves agent by id", async () => {
  const created = await createScheduledAgent({
    workspaceId: "test-ws",
    cron: "*/5 * * * *",
    prompt: "Check health",
    name: "Health Check",
  });
  const found = await getScheduledAgent("test-ws", created.id);
  assert.ok(found);
  assert.equal(found.id, created.id);
  assert.equal(found.name, "Health Check");
});

test("getScheduledAgent returns null for non-existent id", async () => {
  const found = await getScheduledAgent("test-ws", "non-existent");
  assert.equal(found, null);
});

test("updateScheduledAgent updates allowed fields", async () => {
  const agent = await createScheduledAgent({
    workspaceId: "test-ws",
    cron: "0 9 * * *",
    prompt: "Original prompt",
    name: "Update Test",
  });

  const updated = await updateScheduledAgent("test-ws", agent.id, {
    name: "Updated Name",
    prompt: "Updated prompt",
    enabled: false,
  });

  assert.ok(updated);
  assert.equal(updated.name, "Updated Name");
  assert.equal(updated.prompt, "Updated prompt");
  assert.equal(updated.enabled, false);
  assert.notEqual(updated.updatedAt, agent.updatedAt);
});

test("updateScheduledAgent returns null for non-existent id", async () => {
  const updated = await updateScheduledAgent("test-ws", "non-existent", { name: "Nope" });
  assert.equal(updated, null);
});

test("deleteScheduledAgent removes agent", async () => {
  const agent = await createScheduledAgent({
    workspaceId: "test-ws",
    cron: "0 9 * * *",
    prompt: "To be deleted",
    name: "Delete Test",
  });

  const deleted = await deleteScheduledAgent("test-ws", agent.id);
  assert.equal(deleted, true);

  const found = await getScheduledAgent("test-ws", agent.id);
  assert.equal(found, null);
});

test("deleteScheduledAgent returns false for non-existent id", async () => {
  const deleted = await deleteScheduledAgent("test-ws", "non-existent");
  assert.equal(deleted, false);
});

// --- Run execution tests ---

test("runScheduledAgent executes dry-run when no backend provided", async () => {
  const agent = await createScheduledAgent({
    workspaceId: "run-ws",
    cron: "0 9 * * *",
    prompt: "Generate a report",
    name: "Report Agent",
  });

  const result = await runScheduledAgent("run-ws", agent.id);
  assert.ok(result.runId);
  assert.ok(result.response.includes("dry-run"));
  assert.equal(typeof result.duration, "number");
  assert.equal(result.status, "completed");
});

test("runScheduledAgent throws for non-existent agent", async () => {
  await assert.rejects(
    () => runScheduledAgent("run-ws", "non-existent"),
    { message: /not found/ }
  );
});

test("runScheduledAgent records run in history", async () => {
  const agent = await createScheduledAgent({
    workspaceId: "run-ws",
    cron: "0 12 * * *",
    prompt: "Check metrics",
    name: "Metrics Agent",
  });

  await runScheduledAgent("run-ws", agent.id);
  await runScheduledAgent("run-ws", agent.id);

  const runs = await getScheduledAgentRuns("run-ws", agent.id);
  assert.ok(Array.isArray(runs));
  assert.ok(runs.length >= 2);
  assert.equal(runs[0].agentId, agent.id);
  assert.ok(runs[0].createdAt);
});

test("runScheduledAgent with mock backend", async () => {
  const agent = await createScheduledAgent({
    workspaceId: "run-ws",
    cron: "0 9 * * *",
    prompt: "Hello world",
    name: "Mock Agent",
  });

  const mockFetch = async (_url, _opts) => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "Hello from the model!" } }],
      usage: { total_tokens: 42 },
    }),
  });

  const mockConfig = (_model) => ({
    baseUrl: "http://localhost:11434",
    path: "/v1/chat/completions",
    headers: { "Content-Type": "application/json" },
  });

  const result = await runScheduledAgent("run-ws", agent.id, {
    backendFetch: mockFetch,
    buildProxyConfig: mockConfig,
    model: "test-model",
  });

  assert.equal(result.response, "Hello from the model!");
  assert.equal(result.tokens, 42);
  assert.equal(result.status, "completed");
  assert.equal(result.error, null);
});

// --- Run history tests ---

test("getScheduledAgentRuns returns empty for no runs", async () => {
  const runs = await getScheduledAgentRuns("run-ws", "never-ran");
  assert.ok(Array.isArray(runs));
  assert.equal(runs.length, 0);
});

test("getScheduledAgentRuns respects limit", async () => {
  const agent = await createScheduledAgent({
    workspaceId: "run-ws",
    cron: "0 9 * * *",
    prompt: "Limit test",
    name: "Limit Agent",
  });

  for (let i = 0; i < 5; i++) {
    await runScheduledAgent("run-ws", agent.id);
  }

  const runs = await getScheduledAgentRuns("run-ws", agent.id, 3);
  assert.equal(runs.length, 3);
});

test("runScheduledAgent updates lastRunAt on the agent", async () => {
  const agent = await createScheduledAgent({
    workspaceId: "run-ws",
    cron: "0 9 * * *",
    prompt: "Last run test",
    name: "LastRun Agent",
  });

  assert.equal(agent.lastRunAt, undefined);

  await runScheduledAgent("run-ws", agent.id);

  const updated = await getScheduledAgent("run-ws", agent.id);
  assert.ok(updated.lastRunAt);
});
