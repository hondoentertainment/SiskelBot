/**
 * Phase 62.2: Ticket router tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-ticket-router-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createTicket,
  assignTicket,
  listQueues,
  configureSkills,
  getTicket,
  listTickets,
  PRIORITIES,
  _internals,
} = await import("../lib/ticket-router.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("createTicket requires a subject", async () => {
  await assert.rejects(() => createTicket({}), /subject is required/);
});

test("createTicket normalizes priority to one of the allowed values", async () => {
  const t1 = await createTicket({ subject: "one", priority: "Urgent" });
  assert.equal(t1.priority, "urgent");
  const t2 = await createTicket({ subject: "two", priority: "bogus" });
  assert.equal(t2.priority, "normal");
  assert.ok(PRIORITIES.includes("urgent"));
});

test("configureSkills creates queues and registers agents", async () => {
  const cfg = await configureSkills({
    alice: { skills: ["billing", "refunds"], queue: "billing" },
    bob: { skills: ["networking"], queue: "ops" },
    cara: { skills: ["general"], queue: "default" },
  });
  assert.ok(cfg.queues.billing);
  assert.ok(cfg.queues.ops);
  assert.ok(cfg.queues.default);
  const queues = await listQueues();
  assert.ok(queues.some((q) => q.name === "billing" && q.agents.some((a) => a.id === "alice")));
});

test("assignTicket routes skill-matching tickets to matching queue", async () => {
  await configureSkills({
    alice: { skills: ["billing", "refunds"], queue: "billing" },
    bob: { skills: ["networking"], queue: "ops" },
  });
  const ticket = await createTicket({
    subject: "refund please",
    requiredSkills: ["billing"],
  });
  const assigned = await assignTicket(ticket.id);
  assert.equal(assigned.queue, "billing");
  assert.equal(assigned.assignedTo, "alice");
  assert.equal(assigned.status, "assigned");
});

test("assignTicket falls back to default queue when no skill match", async () => {
  await configureSkills({
    deb: { skills: ["general"], queue: "default" },
  });
  const ticket = await createTicket({
    subject: "weird",
    requiredSkills: ["quantum-cryptography"],
  });
  const assigned = await assignTicket(ticket.id);
  assert.equal(assigned.queue, "default");
  // Fallback landed somewhere in the default pool (pool depends on prior
  // configureSkills calls sharing this tmpdir). Just assert we got *an* agent.
  assert.ok(assigned.assignedTo, `expected some assignee in default queue, got ${assigned.assignedTo}`);
});

test("assignTicket with no requiredSkills routes to default queue round-robin", async () => {
  await configureSkills({
    ray: { skills: [], queue: "default" },
    sue: { skills: [], queue: "default" },
  });
  const t1 = await createTicket({ subject: "a" });
  const t2 = await createTicket({ subject: "b" });
  const t3 = await createTicket({ subject: "c" });
  const a1 = await assignTicket(t1.id);
  const a2 = await assignTicket(t2.id);
  const a3 = await assignTicket(t3.id);
  const assigns = [a1.assignedTo, a2.assignedTo, a3.assignedTo];
  // Must cover both agents (round-robin).
  assert.ok(assigns.includes("ray"));
  assert.ok(assigns.includes("sue"));
});

test("assignTicket on unknown ticket throws NOT_FOUND", async () => {
  await assert.rejects(
    () => assignTicket("no-such-ticket"),
    (err) => err.code === "NOT_FOUND",
  );
});

test("listTickets filters by status", async () => {
  const t = await createTicket({ subject: "filter-me" });
  await configureSkills({ eve: { skills: [], queue: "default" } });
  await assignTicket(t.id);
  const open = await listTickets({ status: "open" });
  const assigned = await listTickets({ status: "assigned" });
  assert.ok(!open.some((x) => x.id === t.id));
  assert.ok(assigned.some((x) => x.id === t.id));
});

test("listTickets filters by queue", async () => {
  await configureSkills({ ian: { skills: ["vip"], queue: "vip" } });
  const t = await createTicket({ subject: "vip please", requiredSkills: ["vip"] });
  await assignTicket(t.id);
  const vipList = await listTickets({ queue: "vip" });
  assert.ok(vipList.some((x) => x.id === t.id));
});

test("pickQueue picks skill-match queue over default", () => {
  const cfg = {
    queues: {
      default: { agents: ["gen"], roundRobinIndex: 0 },
      billing: { agents: ["alice"], roundRobinIndex: 0 },
    },
    agents: {
      gen: { id: "gen", skills: [], queue: "default" },
      alice: { id: "alice", skills: ["billing"], queue: "billing" },
    },
  };
  const { queueName } = _internals.pickQueue(cfg, ["billing"]);
  assert.equal(queueName, "billing");
});

test("round-robin index wraps around within a queue", async () => {
  await configureSkills({
    x1: { skills: ["wrap"], queue: "wrap-q" },
    x2: { skills: ["wrap"], queue: "wrap-q" },
  });
  const assignees = [];
  for (let i = 0; i < 4; i++) {
    const t = await createTicket({ subject: `t${i}`, requiredSkills: ["wrap"] });
    const a = await assignTicket(t.id);
    assignees.push(a.assignedTo);
  }
  // With two agents we expect each to appear twice.
  const x1c = assignees.filter((a) => a === "x1").length;
  const x2c = assignees.filter((a) => a === "x2").length;
  assert.equal(x1c, 2);
  assert.equal(x2c, 2);
});

test("getTicket returns null for unknown id", async () => {
  assert.equal(await getTicket("nope"), null);
});
