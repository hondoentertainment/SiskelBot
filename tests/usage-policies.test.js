/**
 * Phase 65.2: Usage policy tests.
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
  evaluatePolicy,
  evaluatePolicyObject,
  listPolicies,
  updatePolicy,
  testPolicy,
  deletePolicy,
  getPolicy,
  matchRule,
} = await import("../lib/usage-policies.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("createPolicy persists a new policy with rules", async () => {
  const p = await createPolicy({
    name: "engineering-policy",
    department: "engineering",
    defaultAction: "allow",
    rules: [
      { action: "deny", match: { model: "gpt-4-giant" }, reason: "too expensive" },
    ],
  });
  assert.ok(p.id);
  assert.equal(p.name, "engineering-policy");
  assert.equal(p.rules.length, 1);
  assert.ok(p.createdAt);
});

test("createPolicy rejects malformed payloads", async () => {
  await assert.rejects(() => createPolicy(null));
  await assert.rejects(() => createPolicy({ name: "a" }));
  await assert.rejects(() => createPolicy({ name: "a", department: "d", rules: [{ action: "bogus" }] }));
  await assert.rejects(() =>
    createPolicy({ name: "a", department: "d", defaultAction: "bogus" }),
  );
});

test("matchRule handles model, tags, tokens, users, workspaces", () => {
  assert.equal(matchRule({ model: "gpt-4" }, { model: "gpt-4" }), true);
  assert.equal(matchRule({ model: ["gpt-4", "gpt-4o"] }, { model: "gpt-4o" }), true);
  assert.equal(matchRule({ model: "gpt-4" }, { model: "llama" }), false);
  assert.equal(matchRule({ tags: ["prod"] }, { tags: ["prod", "core"] }), true);
  assert.equal(matchRule({ tags: ["prod"] }, { tags: ["dev"] }), false);
  assert.equal(matchRule({ maxTokens: 1000 }, { tokens: 500 }), true);
  assert.equal(matchRule({ maxTokens: 1000 }, { tokens: 5000 }), false);
  assert.equal(matchRule({ users: ["alice"] }, { user: "alice" }), true);
  assert.equal(matchRule({ users: ["alice"] }, { user: "bob" }), false);
  assert.equal(matchRule({ workspaces: ["ws1"] }, { workspace: "ws1" }), true);
});

test("matchRule hoursOfDay handles wrapping ranges", () => {
  // 9..17 weekday window
  assert.equal(matchRule({ hoursOfDay: [9, 17] }, { hour: 10 }), true);
  assert.equal(matchRule({ hoursOfDay: [9, 17] }, { hour: 8 }), false);
  // overnight window 22..6
  assert.equal(matchRule({ hoursOfDay: [22, 6] }, { hour: 23 }), true);
  assert.equal(matchRule({ hoursOfDay: [22, 6] }, { hour: 2 }), true);
  assert.equal(matchRule({ hoursOfDay: [22, 6] }, { hour: 10 }), false);
});

test("evaluatePolicy returns deny when a rule matches", async () => {
  const p = await createPolicy({
    name: "deny-expensive",
    department: "sales",
    defaultAction: "allow",
    rules: [
      { action: "deny", match: { model: "expensive-model" }, reason: "cost-control" },
    ],
  });
  const result = await evaluatePolicy(p.id, { model: "expensive-model" });
  assert.equal(result.action, "deny");
  assert.equal(result.reason, "cost-control");
  const allow = await evaluatePolicy(p.id, { model: "cheap-model" });
  assert.equal(allow.action, "allow");
});

test("evaluatePolicy throws on unknown id", async () => {
  await assert.rejects(() => evaluatePolicy("missing", {}));
});

test("listPolicies filters by department and enabledOnly", async () => {
  await createPolicy({ name: "p1", department: "eng", rules: [] });
  const p2 = await createPolicy({ name: "p2", department: "sales", rules: [] });
  await updatePolicy(p2.id, { enabled: false });
  const all = await listPolicies();
  assert.ok(all.length >= 2);
  const eng = await listPolicies({ department: "eng" });
  for (const p of eng) assert.ok(p.department === "eng" || p.department === "*");
  const enabled = await listPolicies({ enabledOnly: true });
  for (const p of enabled) assert.equal(p.enabled, true);
});

test("updatePolicy merges fields and rewrites rules", async () => {
  const p = await createPolicy({ name: "upd", department: "ops", rules: [] });
  const updated = await updatePolicy(p.id, {
    rules: [{ action: "deny", match: { tags: ["prod"] }, reason: "ops-deny-prod" }],
  });
  assert.equal(updated.rules.length, 1);
  assert.equal(updated.rules[0].action, "deny");
});

test("testPolicy evaluates an ad-hoc policy without persisting", () => {
  const result = testPolicy(
    {
      name: "tmp",
      department: "eng",
      defaultAction: "allow",
      rules: [{ action: "deny", match: { maxTokens: 100 }, reason: "small-only" }],
    },
    { tokens: 50 },
  );
  assert.equal(result.action, "deny");
  const result2 = testPolicy(
    {
      name: "tmp",
      department: "eng",
      defaultAction: "allow",
      rules: [{ action: "deny", match: { maxTokens: 100 } }],
    },
    { tokens: 500 },
  );
  assert.equal(result2.action, "allow");
});

test("deletePolicy removes the record", async () => {
  const p = await createPolicy({ name: "del", department: "x", rules: [] });
  const ok = await deletePolicy(p.id);
  assert.equal(ok, true);
  const after = await getPolicy(p.id);
  assert.equal(after, null);
  const okAgain = await deletePolicy(p.id);
  assert.equal(okAgain, false);
});

test("evaluatePolicyObject respects enabled flag", () => {
  const policy = {
    id: "x",
    name: "x",
    department: "eng",
    defaultAction: "deny",
    rules: [],
    enabled: false,
  };
  const result = evaluatePolicyObject(policy, {});
  assert.equal(result.action, "allow");
});
