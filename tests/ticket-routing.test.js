/**
 * Phase 62.2: Ticket routing tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-ticket-routing-"));
process.env.STORAGE_PATH = TMP;

const {
  createQueue,
  listQueues,
  setAgentSkills,
  listAgents,
  routeTicket,
  getQueueStats,
  listTickets,
} = await import("../lib/ticket-routing.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("createQueue persists a queue", async () => {
  const q = await createQueue("billing", { skills: ["billing", "refunds"], slaMinutes: 30 });
  assert.equal(q.name, "billing");
  assert.deepEqual(q.skills, ["billing", "refunds"]);
  assert.equal(q.slaMinutes, 30);
  assert.ok(q.createdAt);
});

test("createQueue rejects empty name", async () => {
  await assert.rejects(() => createQueue(""));
});

test("listQueues returns created queues", async () => {
  await createQueue("tech", { skills: ["tech", "infra"], minPriority: "normal" });
  const queues = await listQueues();
  const names = queues.map((q) => q.name).sort();
  assert.ok(names.includes("billing"));
  assert.ok(names.includes("tech"));
});

test("setAgentSkills persists agent profile", async () => {
  const a = await setAgentSkills("alice", ["billing", "refunds"], { maxConcurrent: 3 });
  assert.equal(a.agentId, "alice");
  assert.deepEqual(a.skills, ["billing", "refunds"]);
  assert.equal(a.maxConcurrent, 3);
  assert.ok(a.available);
});

test("setAgentSkills rejects invalid skills", async () => {
  await assert.rejects(() => setAgentSkills("bob", "notarray"));
});

test("routeTicket assigns to matching queue and agent", async () => {
  await setAgentSkills("bob", ["tech", "infra"], { maxConcurrent: 5 });
  const result = await routeTicket({
    subject: "Server down",
    body: "Production is broken",
    priority: "urgent",
    requiredSkills: ["tech"],
  });
  assert.equal(result.queue, "tech");
  assert.equal(result.assignedAgent, "bob");
  assert.equal(result.status, "assigned");
  assert.equal(result.priority, "urgent");
  assert.ok(result.id);
});

test("routeTicket falls back to unassigned when no agent has the skills", async () => {
  await createQueue("exotic", { skills: ["quantum"] });
  const result = await routeTicket({
    subject: "Quantum issue",
    priority: "high",
    requiredSkills: ["quantum"],
  });
  assert.equal(result.queue, "exotic");
  assert.equal(result.assignedAgent, null);
  assert.equal(result.status, "unassigned");
});

test("routeTicket handles missing skills with priority fallback", async () => {
  const result = await routeTicket({
    subject: "general question",
    priority: "low",
  });
  assert.ok(result.id);
  assert.equal(result.priority, "low");
});

test("routeTicket rejects invalid input", async () => {
  await assert.rejects(() => routeTicket(null));
});

test("getQueueStats aggregates routed tickets", async () => {
  const stats = await getQueueStats();
  assert.ok(stats);
  assert.ok(stats.tech);
  assert.ok(stats.tech.total >= 1);
});

test("getQueueStats for a single queue", async () => {
  const stats = await getQueueStats("tech");
  assert.ok(stats.total >= 1);
  assert.ok(stats.byPriority.urgent >= 1);
});

test("listAgents reflects stored profiles", async () => {
  const agents = await listAgents();
  const ids = agents.map((a) => a.agentId);
  assert.ok(ids.includes("alice"));
  assert.ok(ids.includes("bob"));
});

test("listTickets returns recorded tickets", async () => {
  const all = await listTickets();
  assert.ok(Array.isArray(all));
  assert.ok(all.length >= 2);
});
