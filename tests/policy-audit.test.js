/**
 * Phase 51.4: Policy audit trail tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-policy-audit-"));
process.env.STORAGE_PATH = TMP;

const {
  recordDecision,
  queryDecisions,
  exportDecisions,
  getDecisionStats,
  DECISION_ACTIONS,
  _reset,
} = await import("../lib/policy-audit.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("DECISION_ACTIONS includes standard actions", () => {
  for (const a of ["allow", "warn", "block", "revise"]) {
    assert.ok(DECISION_ACTIONS.includes(a), `missing ${a}`);
  }
});

test("recordDecision stores a record and returns an id", async () => {
  await _reset();
  const rec = await recordDecision({
    workspaceId: "ws-1",
    policyId: "policy-a",
    source: "jailbreak-detector",
    action: "block",
    reason: "contains jailbreak pattern",
    severity: 90,
  });
  assert.ok(rec.decisionId);
  assert.equal(rec.workspaceId, "ws-1");
  assert.equal(rec.action, "block");
  assert.ok(typeof rec.timestamp === "number");
});

test("queryDecisions returns records filtered by workspace", async () => {
  await _reset();
  await recordDecision({ workspaceId: "alpha", action: "allow", source: "s1" });
  await recordDecision({ workspaceId: "beta", action: "block", source: "s2" });
  await recordDecision({ workspaceId: "alpha", action: "warn", source: "s1" });

  const alpha = await queryDecisions({ workspaceId: "alpha" });
  assert.equal(alpha.total, 2);
  assert.equal(alpha.decisions.length, 2);
  const beta = await queryDecisions({ workspaceId: "beta" });
  assert.equal(beta.total, 1);
});

test("queryDecisions filters by action and source", async () => {
  await _reset();
  await recordDecision({ workspaceId: "ws", action: "allow", source: "s1" });
  await recordDecision({ workspaceId: "ws", action: "block", source: "s2" });
  await recordDecision({ workspaceId: "ws", action: "block", source: "s1" });

  const blocks = await queryDecisions({ action: "block" });
  assert.equal(blocks.total, 2);
  const s1 = await queryDecisions({ source: "s1" });
  assert.equal(s1.total, 2);
  const s1Block = await queryDecisions({ action: "block", source: "s1" });
  assert.equal(s1Block.total, 1);
});

test("queryDecisions supports time window filters", async () => {
  await _reset();
  await recordDecision({ workspaceId: "ws", action: "allow", timestamp: 1000 });
  await recordDecision({ workspaceId: "ws", action: "allow", timestamp: 2000 });
  await recordDecision({ workspaceId: "ws", action: "allow", timestamp: 3000 });

  const middle = await queryDecisions({ since: 1500, until: 2500 });
  assert.equal(middle.total, 1);
  const later = await queryDecisions({ since: 2000 });
  assert.equal(later.total, 2);
});

test("queryDecisions supports pagination", async () => {
  await _reset();
  for (let i = 0; i < 10; i += 1) {
    await recordDecision({ workspaceId: "ws", action: "allow", timestamp: i });
  }
  const page = await queryDecisions({ limit: 4, offset: 2 });
  assert.equal(page.decisions.length, 4);
  assert.equal(page.total, 10);
  assert.equal(page.offset, 2);
});

test("recordDecision normalizes unknown action to 'allow'", async () => {
  await _reset();
  const rec = await recordDecision({ workspaceId: "ws", action: "chaos" });
  assert.equal(rec.action, "allow");
});

test("exportDecisions returns JSON and CSV bodies", async () => {
  await _reset();
  await recordDecision({ workspaceId: "ws", action: "block", reason: "bad, comma", source: "s" });
  await recordDecision({ workspaceId: "ws", action: "allow", source: "s" });
  const js = await exportDecisions({ workspaceId: "ws" }, "json");
  assert.equal(js.format, "json");
  const parsed = JSON.parse(js.body);
  assert.equal(parsed.length, 2);
  const csv = await exportDecisions({ workspaceId: "ws" }, "csv");
  assert.equal(csv.format, "csv");
  assert.ok(csv.body.split("\n")[0].includes("decisionId"));
  // Reason with a comma should be quoted.
  assert.ok(csv.body.includes('"bad, comma"'));
});

test("getDecisionStats aggregates counts by action/source", async () => {
  await _reset();
  await recordDecision({ workspaceId: "ws", action: "allow", source: "s1" });
  await recordDecision({ workspaceId: "ws", action: "block", source: "s1" });
  await recordDecision({ workspaceId: "ws", action: "block", source: "s2" });
  const stats = await getDecisionStats({ workspaceId: "ws" });
  assert.equal(stats.total, 3);
  assert.equal(stats.byAction.allow, 1);
  assert.equal(stats.byAction.block, 2);
  assert.equal(stats.bySource.s1, 2);
  assert.equal(stats.bySource.s2, 1);
});

test("recordDecision does not throw on invalid input", async () => {
  // It should tolerate any nonsense.
  const rec = await recordDecision({ workspaceId: null, action: undefined });
  assert.ok(rec);
  assert.equal(rec.workspaceId, "default");
  assert.equal(rec.action, "allow");
});

test("ring buffer bound trims old entries", async () => {
  await _reset();
  process.env.POLICY_AUDIT_MAX_ENTRIES = "5";
  for (let i = 0; i < 10; i += 1) {
    await recordDecision({ workspaceId: "buf", action: "allow", metadata: { i } });
  }
  delete process.env.POLICY_AUDIT_MAX_ENTRIES;
  const q = await queryDecisions({ workspaceId: "buf" });
  assert.equal(q.total, 5);
});
