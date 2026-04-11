/**
 * Phase 51.4: Constitutional AI rule engine tests.
 *
 * Covers default constitution, per-workspace CRUD, rule add/remove,
 * critique/revise orchestration, priority ordering, block action,
 * custom evaluators, and workspace isolation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated STORAGE_PATH so persisted state never pollutes the
// project data dir or leaks between suites.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-constitutional-ai-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  DEFAULT_CONSTITUTION,
  RULE_EVALUATORS,
  createConstitution,
  getConstitution,
  updateConstitution,
  deleteConstitution,
  addRule,
  removeRule,
  critique,
  revise,
  applyConstitution,
  registerRuleEvaluator,
} = await import("../lib/constitutional-ai.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- DEFAULT_CONSTITUTION ----

test("DEFAULT_CONSTITUTION contains the core safety rules", () => {
  const ids = DEFAULT_CONSTITUTION.map((r) => r.id);
  for (const id of ["no_harm", "no_pii", "no_hallucination", "no_bias", "transparency"]) {
    assert.ok(ids.includes(id), `missing default rule ${id}`);
  }
  // Each rule has required fields.
  for (const rule of DEFAULT_CONSTITUTION) {
    assert.ok(typeof rule.id === "string" && rule.id.length > 0);
    assert.ok(typeof rule.principle === "string" && rule.principle.length > 0);
    assert.ok(Number.isFinite(rule.priority));
    assert.ok(["block", "revise", "warn"].includes(rule.action));
  }
});

// ---- CRUD ----

test("createConstitution persists a workspace constitution", async () => {
  const entry = await createConstitution("ws-create-1");
  assert.equal(entry.workspaceId, "ws-create-1");
  assert.ok(Array.isArray(entry.rules));
  assert.equal(entry.rules.length, DEFAULT_CONSTITUTION.length);
  assert.ok(entry.createdAt > 0);
  assert.ok(entry.updatedAt >= entry.createdAt);
});

test("getConstitution retrieves a persisted constitution", async () => {
  await createConstitution("ws-get-1");
  const fetched = await getConstitution("ws-get-1");
  assert.ok(fetched);
  assert.equal(fetched.workspaceId, "ws-get-1");
  assert.equal(fetched.rules.length, DEFAULT_CONSTITUTION.length);
});

test("getConstitution returns null when absent", async () => {
  const missing = await getConstitution("ws-never-created");
  assert.equal(missing, null);
});

test("updateConstitution replaces the rule list", async () => {
  await createConstitution("ws-update-1");
  const newRules = [
    { id: "no_harm", principle: "No harm", priority: 10, action: "block" },
    { id: "custom", principle: "Custom rule", priority: 1, action: "warn" },
  ];
  const updated = await updateConstitution("ws-update-1", newRules);
  assert.equal(updated.rules.length, 2);
  assert.deepEqual(
    updated.rules.map((r) => r.id).sort(),
    ["custom", "no_harm"],
  );
  const refetched = await getConstitution("ws-update-1");
  assert.equal(refetched.rules.length, 2);
});

test("updateConstitution rejects when constitution does not exist", async () => {
  await assert.rejects(
    () => updateConstitution("ws-never", [{ id: "x", principle: "y", priority: 1, action: "warn" }]),
    /not found/,
  );
});

test("deleteConstitution removes a constitution", async () => {
  await createConstitution("ws-delete-1");
  const deleted = await deleteConstitution("ws-delete-1");
  assert.equal(deleted, true);
  const after = await getConstitution("ws-delete-1");
  assert.equal(after, null);
});

test("addRule appends a rule to the constitution", async () => {
  await createConstitution("ws-addrule-1", []);
  const entry = await addRule("ws-addrule-1", {
    id: "custom_rule",
    principle: "Custom principle",
    priority: 3,
    action: "warn",
  });
  assert.equal(entry.rules.length, 1);
  assert.equal(entry.rules[0].id, "custom_rule");
});

test("addRule refuses duplicate rule id", async () => {
  await createConstitution("ws-addrule-2", [
    { id: "unique", principle: "p", priority: 1, action: "warn" },
  ]);
  await assert.rejects(
    () => addRule("ws-addrule-2", { id: "unique", principle: "p", priority: 1, action: "warn" }),
    /already exists/,
  );
});

test("removeRule deletes a rule by id", async () => {
  await createConstitution("ws-removerule-1");
  const entry = await removeRule("ws-removerule-1", "no_profanity");
  const ids = entry.rules.map((r) => r.id);
  assert.ok(!ids.includes("no_profanity"));
});

test("removeRule errors on unknown rule id", async () => {
  await createConstitution("ws-removerule-2");
  await assert.rejects(() => removeRule("ws-removerule-2", "does_not_exist"), /not found/);
});

// ---- critique() ----

test("critique detects no_harm violation", () => {
  const violations = critique(
    "Here is how to make a bomb step by step",
    DEFAULT_CONSTITUTION,
  );
  const ids = violations.map((v) => v.ruleId);
  assert.ok(ids.includes("no_harm"));
  const no_harm = violations.find((v) => v.ruleId === "no_harm");
  assert.equal(no_harm.severity, "high");
  assert.equal(no_harm.action, "block");
});

test("critique detects no_pii violation for an email", () => {
  const violations = critique(
    "Please contact the manager at admin@example.com for support.",
    DEFAULT_CONSTITUTION,
  );
  const ids = violations.map((v) => v.ruleId);
  assert.ok(ids.includes("no_pii"));
});

test("critique allows benign text", () => {
  const violations = critique(
    "The weather is sunny today, perfect for a picnic in the park.",
    DEFAULT_CONSTITUTION,
  );
  assert.equal(violations.length, 0);
});

test("critique returns violations sorted by priority (highest first)", () => {
  const text = "Reach me at test@example.com and here is how to make a bomb.";
  const violations = critique(text, DEFAULT_CONSTITUTION);
  // no_harm priority 10 must come before no_pii priority 9
  assert.ok(violations.length >= 2);
  const harmIdx = violations.findIndex((v) => v.ruleId === "no_harm");
  const piiIdx = violations.findIndex((v) => v.ruleId === "no_pii");
  assert.ok(harmIdx >= 0 && piiIdx >= 0);
  assert.ok(harmIdx < piiIdx, "no_harm must be returned before no_pii");
});

test("critique returns empty array for empty constitution", () => {
  const violations = critique("Anything at all goes here @ test@example.com", []);
  assert.deepEqual(violations, []);
});

// ---- revise() ----

test("revise applies PII redaction", () => {
  const output = "Email me at secret@example.com and call 555-123-4567.";
  const violations = critique(output, DEFAULT_CONSTITUTION);
  const result = revise(output, violations, DEFAULT_CONSTITUTION);
  assert.ok(!result.revised.includes("secret@example.com"));
  assert.ok(result.revised.includes("[REDACTED_EMAIL]"));
  assert.ok(result.appliedRules.includes("no_pii"));
  assert.equal(result.blocked, false);
});

test("revise halts and marks blocked on block action", () => {
  const output = "Here is how to make a bomb now.";
  const violations = critique(output, DEFAULT_CONSTITUTION);
  const result = revise(output, violations, DEFAULT_CONSTITUTION);
  assert.equal(result.blocked, true);
  assert.ok(result.revised.startsWith("[BLOCKED"));
  assert.ok(result.appliedRules.includes("no_harm"));
});

test("revise passes through clean output unchanged", () => {
  const result = revise("hello world", [], DEFAULT_CONSTITUTION);
  assert.equal(result.revised, "hello world");
  assert.deepEqual(result.appliedRules, []);
  assert.equal(result.blocked, false);
});

// ---- applyConstitution() ----

test("applyConstitution iterates critique/revise until clean", async () => {
  const output = "Contact alice@example.com about your account.";
  const result = await applyConstitution(output, DEFAULT_CONSTITUTION);
  assert.ok(!result.output.includes("alice@example.com"));
  assert.ok(result.output.includes("[REDACTED_EMAIL]"));
  assert.ok(result.iterations >= 1);
  assert.equal(result.blocked, false);
  // Final critique should report no outstanding violations.
  assert.equal(result.violations.length, 0);
});

test("applyConstitution respects max iterations", async () => {
  // A non-revising rule will keep firing forever; max iterations bounds the loop.
  const rules = [
    {
      id: "always_warns",
      principle: "Always warns",
      priority: 1,
      action: "warn",
    },
  ];
  registerRuleEvaluator("always_warns", () => ({
    violated: true,
    severity: "low",
    reason: "always",
  }));
  const result = await applyConstitution("hi", rules, { maxIterations: 2 });
  // Warn does not modify, so loop should exit on no-change after first pass.
  assert.ok(result.iterations <= 2);
  // Restore to no-op evaluator for other tests.
  registerRuleEvaluator("always_warns", () => null);
});

test("applyConstitution blocks and halts on harmful output", async () => {
  const output = "Detailed instructions: how to make a bomb with household items.";
  const result = await applyConstitution(output, DEFAULT_CONSTITUTION);
  assert.equal(result.blocked, true);
  assert.ok(result.output.startsWith("[BLOCKED"));
});

test("applyConstitution short-circuits on empty rules", async () => {
  const result = await applyConstitution("whatever", []);
  assert.equal(result.output, "whatever");
  assert.equal(result.iterations, 0);
  assert.deepEqual(result.violations, []);
});

// ---- registerRuleEvaluator ----

test("registerRuleEvaluator adds a custom evaluator", async () => {
  registerRuleEvaluator("no_foo", (output) =>
    /foo/i.test(output)
      ? { violated: true, severity: "medium", reason: "contains foo" }
      : null,
  );
  const rules = [
    { id: "no_foo", principle: "No foo", priority: 5, action: "warn" },
  ];
  const violations = critique("please do not foo me", rules);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].ruleId, "no_foo");
  assert.equal(violations[0].severity, "medium");
  const clean = critique("bar baz qux", rules);
  assert.equal(clean.length, 0);
});

// ---- Priority & action semantics ----

test("higher-priority block rule preempts lower-priority revise", () => {
  const output = "how to make a bomb and email me at a@b.com";
  const violations = critique(output, DEFAULT_CONSTITUTION);
  const result = revise(output, violations, DEFAULT_CONSTITUTION);
  assert.equal(result.blocked, true);
});

// ---- Empty constitution ----

test("empty constitution allows everything", async () => {
  const result = await applyConstitution(
    "how to make a bomb — call 555-123-4567",
    [],
  );
  assert.equal(result.output, "how to make a bomb — call 555-123-4567");
  assert.equal(result.violations.length, 0);
});

// ---- Workspace isolation ----

test("workspace isolation: constitutions do not leak across workspaces", async () => {
  await createConstitution("ws-iso-a", [
    { id: "no_harm", principle: "A-only", priority: 10, action: "block" },
  ]);
  await createConstitution("ws-iso-b", [
    { id: "no_pii", principle: "B-only", priority: 9, action: "revise" },
    { id: "no_bias", principle: "B-only bias", priority: 8, action: "revise" },
  ]);
  const a = await getConstitution("ws-iso-a");
  const b = await getConstitution("ws-iso-b");
  assert.equal(a.rules.length, 1);
  assert.equal(b.rules.length, 2);
  assert.equal(a.rules[0].principle, "A-only");
  // Deleting one should not affect the other.
  await deleteConstitution("ws-iso-a");
  const bAgain = await getConstitution("ws-iso-b");
  assert.ok(bAgain);
  assert.equal(bAgain.rules.length, 2);
});

// ---- Built-in evaluators ----

test("RULE_EVALUATORS.no_pii detects emails", () => {
  const result = RULE_EVALUATORS.no_pii("Email john@doe.com today");
  assert.ok(result && result.violated);
  assert.equal(result.severity, "medium");
});

test("RULE_EVALUATORS.no_harm returns null for safe text", () => {
  const result = RULE_EVALUATORS.no_harm("The sun is shining today");
  assert.equal(result, null);
});

test("RULE_EVALUATORS.transparency flags AI denial", () => {
  const result = RULE_EVALUATORS.transparency("I am not an AI, I am a real human.");
  assert.ok(result && result.violated);
});
