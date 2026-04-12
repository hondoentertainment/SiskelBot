/**
 * Phase 65.2: Usage policy tests — scope-based allow/deny evaluation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-usage-policies-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createPolicy,
  getPolicy,
  listPolicies,
  deletePolicy,
  updatePolicy,
  evaluatePolicy,
  matchesRule,
} = await import("../lib/usage-policies.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("matchesRule handles exact, wildcard, and regex patterns", () => {
  assert.equal(matchesRule("gpt-4", "gpt-4"), true);
  assert.equal(matchesRule("gpt-4", "gpt-3"), false);
  assert.equal(matchesRule("*", "anything"), true);
  assert.equal(matchesRule("gpt-*", "gpt-4-turbo"), true);
  assert.equal(matchesRule("gpt-*", "claude-3"), false);
  assert.equal(matchesRule("*-preview", "gpt-4-preview"), true);
  assert.equal(matchesRule("re:^(gpt|claude)-.*$", "claude-opus"), true);
  assert.equal(matchesRule("re:^(gpt|claude)-.*$", "llama3"), false);
});

test("createPolicy validates required fields", async () => {
  await assert.rejects(() => createPolicy({}), /name/);
  await assert.rejects(() => createPolicy({ name: "p" }), /scope/);
  await assert.rejects(() => createPolicy({ name: "p", scope: { kind: "bogus", id: "x" } }), /scope.kind/);
  await assert.rejects(() => createPolicy({ name: "p", scope: { kind: "team" } }), /scope.id/);
});

test("createPolicy persists and listPolicies returns by priority desc", async () => {
  const low = await createPolicy({
    name: "low",
    scope: { kind: "department", id: "eng" },
    allow: ["*"],
    priority: 1,
  });
  const high = await createPolicy({
    name: "high",
    scope: { kind: "department", id: "eng" },
    deny: ["gpt-4"],
    priority: 10,
  });
  const list = await listPolicies({ scopeKind: "department", scopeId: "eng" });
  assert.ok(list.length >= 2);
  assert.equal(list[0].id, high.id);
  assert.ok(list.findIndex((p) => p.id === low.id) > 0);
});

test("evaluatePolicy returns allowed=true by default when no policy matches", async () => {
  const decision = await evaluatePolicy({
    subject: { department: "nonexistent" },
    resource: "gpt-4",
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "no_matching_policy");
});

test("evaluatePolicy enforces deny over allow in the same policy", async () => {
  const policy = await createPolicy({
    name: "eng-mix",
    scope: { kind: "department", id: "sales" },
    allow: ["gpt-*"],
    deny: ["gpt-4"],
    priority: 5,
  });
  const allowGpt3 = await evaluatePolicy({
    subject: { department: "sales" },
    resource: "gpt-3.5",
  });
  assert.equal(allowGpt3.allowed, true);
  assert.equal(allowGpt3.policyId, policy.id);
  const denyGpt4 = await evaluatePolicy({
    subject: { department: "sales" },
    resource: "gpt-4",
  });
  assert.equal(denyGpt4.allowed, false);
  assert.equal(denyGpt4.policyId, policy.id);
  assert.equal(denyGpt4.matchedRule, "gpt-4");
});

test("evaluatePolicy respects priority ordering across policies", async () => {
  await createPolicy({
    name: "deptwide-deny",
    scope: { kind: "department", id: "ops" },
    deny: ["claude-*"],
    priority: 100,
  });
  await createPolicy({
    name: "deptwide-allow",
    scope: { kind: "department", id: "ops" },
    allow: ["*"],
    priority: 1,
  });
  const decision = await evaluatePolicy({
    subject: { department: "ops" },
    resource: "claude-opus",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "denied_by_policy");
});

test("evaluatePolicy only applies policies whose scope matches the subject", async () => {
  await createPolicy({
    name: "user-only",
    scope: { kind: "user", id: "alice-unique-scope" },
    deny: ["*"],
    priority: 50,
  });
  const bob = await evaluatePolicy({
    subject: { user: "bob-unique-scope", department: "isolated-dept-xyz" },
    resource: "gpt-4",
  });
  assert.equal(bob.allowed, true);
  const alice = await evaluatePolicy({
    subject: { user: "alice-unique-scope" },
    resource: "gpt-4",
  });
  assert.equal(alice.allowed, false);
});

test("updatePolicy and deletePolicy modify the registry", async () => {
  const p = await createPolicy({
    name: "tmp",
    scope: { kind: "team", id: "red" },
    allow: ["a"],
    priority: 0,
  });
  const updated = await updatePolicy(p.id, { allow: ["a", "b"], priority: 5 });
  assert.deepEqual(updated.allow, ["a", "b"]);
  assert.equal(updated.priority, 5);
  const del = await deletePolicy(p.id);
  assert.equal(del.ok, true);
  assert.equal(await getPolicy(p.id), null);
});

test("evaluatePolicy requires a resource string", async () => {
  await assert.rejects(() => evaluatePolicy({ subject: { department: "eng" } }), /resource/);
});

test("evaluatePolicy uses caller-supplied policies list when provided", async () => {
  const decision = await evaluatePolicy({
    subject: { department: "eng" },
    resource: "gpt-4",
    policies: [
      {
        id: "p1",
        name: "ephemeral",
        scope: { kind: "department", id: "eng" },
        deny: ["gpt-4"],
        allow: [],
        priority: 10,
      },
    ],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.policyId, "p1");
});
