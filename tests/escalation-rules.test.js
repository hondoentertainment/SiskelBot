/**
 * Phase 62.4: Escalation rules tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-escalation-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createRule,
  getRule,
  listRules,
  deleteRule,
  evaluateRules,
  triggerHandoff,
  listHandoffs,
  _internals,
} = await import("../lib/escalation-rules.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("createRule requires name and conditions", async () => {
  await assert.rejects(() => createRule({}), /name is required/);
  await assert.rejects(() => createRule({ name: "x" }), /conditions are required/);
});

test("createRule persists and getRule retrieves", async () => {
  const rule = await createRule({
    name: "sla-breach",
    conditions: { slaBreachMinutes: 60 },
    action: { type: "handoff", target: "human-tier2" },
  });
  assert.ok(rule.id);
  const fetched = await getRule(rule.id);
  assert.equal(fetched.name, "sla-breach");
  assert.equal(fetched.action.target, "human-tier2");
});

test("evaluateRules matches SLA breach when elapsed exceeds threshold", async () => {
  const rule = await createRule({
    name: "fresh-sla",
    conditions: { slaBreachMinutes: 30 },
  });
  const recent = { id: "t1", subject: "x", body: "y", createdAt: new Date(Date.now() - 10 * 60_000).toISOString() };
  const stale = { id: "t2", subject: "x", body: "y", createdAt: new Date(Date.now() - 90 * 60_000).toISOString() };
  const mRecent = await evaluateRules(recent);
  const mStale = await evaluateRules(stale);
  assert.ok(!mRecent.some((m) => m.rule.id === rule.id));
  assert.ok(mStale.some((m) => m.rule.id === rule.id));
});

test("evaluateRules matches sentimentBelow", async () => {
  await createRule({
    name: "bad-vibes",
    conditions: { sentimentBelow: -0.2 },
  });
  const t = { subject: "h", body: "b", sentiment: -0.8, createdAt: new Date().toISOString() };
  const matches = await evaluateRules(t);
  assert.ok(matches.some((m) => m.rule.name === "bad-vibes"));
});

test("evaluateRules matches keywordAny and keywordAll", async () => {
  await createRule({
    name: "keywords-any",
    conditions: { keywordAny: ["urgent", "refund"] },
  });
  await createRule({
    name: "keywords-all",
    conditions: { keywordAll: ["payment", "failed"] },
  });
  const t1 = { subject: "Refund please", body: "", createdAt: new Date().toISOString() };
  const m1 = await evaluateRules(t1);
  assert.ok(m1.some((m) => m.rule.name === "keywords-any"));
  const t2 = { subject: "payment failed", body: "help", createdAt: new Date().toISOString() };
  const m2 = await evaluateRules(t2);
  assert.ok(m2.some((m) => m.rule.name === "keywords-all"));
});

test("evaluateRules matches loopCountAtLeast", async () => {
  await createRule({
    name: "looping",
    conditions: { loopCountAtLeast: 3 },
  });
  const t = { subject: "s", body: "b", loopCount: 5, createdAt: new Date().toISOString() };
  const matches = await evaluateRules(t);
  assert.ok(matches.some((m) => m.rule.name === "looping"));
});

test("evaluateRules matches priorityAtLeast", async () => {
  await createRule({
    name: "high-pri",
    conditions: { priorityAtLeast: "high" },
  });
  const low = { subject: "s", body: "b", priority: "low", createdAt: new Date().toISOString() };
  const urgent = { subject: "s", body: "b", priority: "urgent", createdAt: new Date().toISOString() };
  const mLow = await evaluateRules(low);
  const mUrgent = await evaluateRules(urgent);
  assert.ok(!mLow.some((m) => m.rule.name === "high-pri"));
  assert.ok(mUrgent.some((m) => m.rule.name === "high-pri"));
});

test("evaluateRules combines conditions with AND semantics", async () => {
  await createRule({
    name: "and-rule",
    conditions: { priorityAtLeast: "high", keywordAny: ["hack"] },
  });
  const partial = { subject: "urgent", body: "", priority: "urgent", createdAt: new Date().toISOString() };
  const full = { subject: "hack attempted", body: "", priority: "urgent", createdAt: new Date().toISOString() };
  const mPartial = await evaluateRules(partial);
  const mFull = await evaluateRules(full);
  assert.ok(!mPartial.some((m) => m.rule.name === "and-rule"));
  assert.ok(mFull.some((m) => m.rule.name === "and-rule"));
});

test("evaluateRules skips disabled rules", async () => {
  const rule = await createRule({
    name: "off-rule",
    enabled: false,
    conditions: { keywordAny: ["anything"] },
  });
  const t = { subject: "anything here", body: "", createdAt: new Date().toISOString() };
  const matches = await evaluateRules(t);
  assert.ok(!matches.some((m) => m.rule.id === rule.id));
});

test("listRules returns all and deleteRule removes", async () => {
  const rule = await createRule({
    name: "ephemeral",
    conditions: { keywordAny: ["x"] },
  });
  let all = await listRules();
  assert.ok(all.some((r) => r.id === rule.id));
  const res = await deleteRule(rule.id);
  assert.equal(res.ok, true);
  all = await listRules();
  assert.ok(!all.some((r) => r.id === rule.id));
});

test("triggerHandoff and listHandoffs round-trip", async () => {
  const entry = await triggerHandoff({ ticketId: "t-99", reason: "test" });
  const list = await listHandoffs();
  assert.ok(list.some((h) => h.id === entry.id));
  assert.equal(list[0].ticketId, "t-99");
});

test("triggerHandoff requires ticketId", async () => {
  await assert.rejects(() => triggerHandoff({}), /ticketId is required/);
});
