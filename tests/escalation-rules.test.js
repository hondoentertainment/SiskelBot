/**
 * Phase 62.4: Escalation rules tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-escalation-"));
process.env.STORAGE_PATH = TMP;

const {
  matchCondition,
  addRule,
  listRules,
  removeRule,
  evaluateRules,
  triggerEscalation,
  listEscalations,
  getEscalationHistory,
} = await import("../lib/escalation-rules.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("matchCondition equals/not_equals", () => {
  assert.ok(matchCondition({ field: "priority", op: "equals", value: "urgent" }, { priority: "urgent" }));
  assert.ok(!matchCondition({ field: "priority", op: "equals", value: "urgent" }, { priority: "low" }));
  assert.ok(matchCondition({ field: "priority", op: "not_equals", value: "low" }, { priority: "high" }));
});

test("matchCondition contains/regex", () => {
  assert.ok(matchCondition({ field: "subject", op: "contains", value: "error" }, { subject: "500 ERROR on prod" }));
  assert.ok(matchCondition({ field: "subject", op: "regex", value: "^\\d{3}" }, { subject: "500 bad" }));
  assert.ok(!matchCondition({ field: "subject", op: "regex", value: "[unclosed" }, { subject: "anything" }));
});

test("matchCondition gt/gte/lt/lte/in", () => {
  assert.ok(matchCondition({ field: "waitMinutes", op: "gt", value: 30 }, { waitMinutes: 60 }));
  assert.ok(matchCondition({ field: "waitMinutes", op: "gte", value: 60 }, { waitMinutes: 60 }));
  assert.ok(matchCondition({ field: "waitMinutes", op: "lt", value: 10 }, { waitMinutes: 5 }));
  assert.ok(matchCondition({ field: "waitMinutes", op: "lte", value: 10 }, { waitMinutes: 10 }));
  assert.ok(matchCondition({ field: "tier", op: "in", value: ["gold", "platinum"] }, { tier: "gold" }));
});

test("matchCondition handles nested fields", () => {
  assert.ok(matchCondition({ field: "customer.tier", op: "equals", value: "gold" }, { customer: { tier: "gold" } }));
});

test("matchCondition returns false for invalid input", () => {
  assert.ok(!matchCondition(null, {}));
  assert.ok(!matchCondition({ field: "x", op: "unknown", value: 1 }, { x: 1 }));
});

test("addRule persists a rule", async () => {
  const rule = await addRule({
    name: "VIP urgent",
    conditions: [
      { field: "customer.tier", op: "equals", value: "platinum" },
      { field: "priority", op: "equals", value: "urgent" },
    ],
    action: { type: "escalate", target: "tier3", priority: "urgent" },
  });
  assert.ok(rule.id);
  assert.equal(rule.name, "VIP urgent");
  assert.ok(rule.enabled);
});

test("addRule rejects invalid input", async () => {
  await assert.rejects(() => addRule(null));
  await assert.rejects(() => addRule({ name: "bad" }));
  await assert.rejects(() => addRule({ name: "bad", conditions: [] }));
});

test("listRules returns persisted rules", async () => {
  const rules = await listRules();
  assert.ok(rules.length >= 1);
});

test("evaluateRules matches a ticket", async () => {
  await addRule({
    name: "long wait",
    conditions: [{ field: "waitMinutes", op: "gt", value: 30 }],
    action: { type: "escalate", target: "tier2" },
  });
  const matches = await evaluateRules({
    priority: "urgent",
    customer: { tier: "platinum" },
    waitMinutes: 45,
  });
  assert.ok(matches.length >= 2);
  const names = matches.map((m) => m.name);
  assert.ok(names.includes("VIP urgent"));
  assert.ok(names.includes("long wait"));
});

test("evaluateRules returns [] for null ticket", async () => {
  const matches = await evaluateRules(null);
  assert.deepEqual(matches, []);
});

test("triggerEscalation records history", async () => {
  const rec = await triggerEscalation({
    id: "t1",
    subject: "Site down",
    priority: "urgent",
    customer: { tier: "platinum" },
    waitMinutes: 60,
  });
  assert.ok(rec.id);
  assert.ok(rec.rule);
  assert.equal(rec.ticketId, "t1");
  assert.equal(rec.manual, false);
});

test("triggerEscalation handles manual (no match)", async () => {
  const rec = await triggerEscalation({
    id: "t2",
    subject: "something",
    priority: "low",
    customer: { tier: "bronze" },
    waitMinutes: 1,
  });
  assert.equal(rec.manual, true);
});

test("listEscalations returns recent entries", async () => {
  const list = await listEscalations(10);
  assert.ok(list.length >= 2);
});

test("getEscalationHistory can filter by ticketId", async () => {
  const history = await getEscalationHistory("t1");
  assert.ok(history.length >= 1);
  assert.ok(history.every((h) => h.ticketId === "t1"));
});

test("removeRule deletes a rule", async () => {
  const rule = await addRule({
    name: "temporary",
    conditions: [{ field: "priority", op: "equals", value: "urgent" }],
  });
  const removed = await removeRule(rule.id);
  assert.ok(removed);
  const rules = await listRules();
  assert.ok(!rules.find((r) => r.id === rule.id));
});
