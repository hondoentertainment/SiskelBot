/**
 * Phase 67.4: Brand safety tests — rules engine with keyword/regex/negated.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-brand-safety-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createRule,
  getRule,
  listRules,
  updateRule,
  deleteRule,
  evaluateContent,
  RULE_KIND_KEYWORD,
  RULE_KIND_REGEX,
  RULE_KIND_NEGATED,
  SEVERITY_BLOCK,
  SEVERITY_WARN,
  SEVERITY_INFO,
} = await import("../lib/brand-safety.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("createRule validates kind and severity", async () => {
  await assert.rejects(() => createRule({}), /name/);
  await assert.rejects(() => createRule({ name: "x" }), /kind/);
  await assert.rejects(() => createRule({ name: "x", kind: "bogus" }), /kind must be/);
  await assert.rejects(() => createRule({ name: "x", kind: RULE_KIND_KEYWORD, severity: "critical" }), /severity/);
  await assert.rejects(() => createRule({ name: "x", kind: RULE_KIND_KEYWORD, keywords: [] }), /keywords/);
  await assert.rejects(() => createRule({ name: "x", kind: RULE_KIND_REGEX, patterns: [] }), /patterns/);
});

test("createRule persists and listRules returns", async () => {
  const r = await createRule({
    name: "alcohol",
    kind: RULE_KIND_KEYWORD,
    keywords: ["beer", "wine"],
    severity: SEVERITY_WARN,
    tags: ["beverages"],
  });
  assert.ok(r.id);
  const list = await listRules({ tag: "beverages" });
  assert.ok(list.some((x) => x.id === r.id));
});

test("evaluateContent detects keyword matches with position", async () => {
  const rule = await createRule({
    name: "kw-detect",
    kind: RULE_KIND_KEYWORD,
    keywords: ["contraband"],
    severity: SEVERITY_BLOCK,
  });
  const result = await evaluateContent("please avoid the contraband in this text", { ruleIds: [rule.id] });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].match.toLowerCase(), "contraband");
  assert.equal(result.hits[0].severity, SEVERITY_BLOCK);
  assert.equal(result.blocked, true);
});

test("evaluateContent regex rule matches case-insensitively", async () => {
  const rule = await createRule({
    name: "phone",
    kind: RULE_KIND_REGEX,
    patterns: ["\\b\\d{3}-\\d{3}-\\d{4}\\b"],
    severity: SEVERITY_WARN,
  });
  const result = await evaluateContent("call me at 555-123-4567 please", { ruleIds: [rule.id] });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].match, "555-123-4567");
});

test("evaluateContent negated rule suppresses when negator in window", async () => {
  const rule = await createRule({
    name: "bomb-negated",
    kind: RULE_KIND_NEGATED,
    keywords: ["bomb"],
    negators: ["not", "bath", "the"],
    windowChars: 20,
    severity: SEVERITY_BLOCK,
  });
  // Negator "not" is in the 20-char window → should be suppressed.
  const suppressed = await evaluateContent("this is not a bomb", { ruleIds: [rule.id] });
  assert.equal(suppressed.hits.length, 0);
  // Negator "bath" is also suppressive here (bath bomb).
  const bathBomb = await evaluateContent("I enjoyed my bath bomb yesterday", { ruleIds: [rule.id] });
  assert.equal(bathBomb.hits.length, 0);
});

test("evaluateContent negated rule fires when no negator nearby", async () => {
  const rule = await createRule({
    name: "bomb-hit",
    kind: RULE_KIND_NEGATED,
    keywords: ["bomb"],
    negators: ["bath"],
    windowChars: 15,
    severity: SEVERITY_BLOCK,
  });
  const hit = await evaluateContent("they detonated the bomb at dawn", { ruleIds: [rule.id] });
  assert.equal(hit.hits.length, 1);
  assert.equal(hit.blocked, true);
});

test("evaluateContent sorts hits by severity desc and flags block", async () => {
  const info = await createRule({ name: "i", kind: RULE_KIND_KEYWORD, keywords: ["foo"], severity: SEVERITY_INFO });
  const block = await createRule({ name: "b", kind: RULE_KIND_KEYWORD, keywords: ["baz"], severity: SEVERITY_BLOCK });
  const result = await evaluateContent("foo and baz appear here", { ruleIds: [info.id, block.id] });
  assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0].severity, SEVERITY_BLOCK);
  assert.equal(result.highestSeverity, SEVERITY_BLOCK);
  assert.equal(result.blocked, true);
});

test("evaluateContent skips disabled rules", async () => {
  const rule = await createRule({ name: "off", kind: RULE_KIND_KEYWORD, keywords: ["trigger"] });
  await updateRule(rule.id, { enabled: false });
  const result = await evaluateContent("this should trigger nothing", { ruleIds: [rule.id] });
  assert.equal(result.hits.length, 0);
});

test("updateRule and deleteRule round-trip", async () => {
  const rule = await createRule({ name: "u", kind: RULE_KIND_KEYWORD, keywords: ["a"] });
  const updated = await updateRule(rule.id, { keywords: ["b", "c"], severity: SEVERITY_BLOCK });
  assert.deepEqual(updated.keywords.sort(), ["b", "c"]);
  assert.equal(updated.severity, SEVERITY_BLOCK);
  const del = await deleteRule(rule.id);
  assert.equal(del.ok, true);
  assert.equal(await getRule(rule.id), null);
});

test("evaluateContent validates content type", async () => {
  await assert.rejects(() => evaluateContent(42), /content must/);
});

test("evaluateContent returns empty hits when no rules match", async () => {
  const rule = await createRule({ name: "m", kind: RULE_KIND_KEYWORD, keywords: ["xyzqrs"] });
  const result = await evaluateContent("nothing to see here", { ruleIds: [rule.id] });
  assert.equal(result.hits.length, 0);
  assert.equal(result.highestSeverity, null);
  assert.equal(result.blocked, false);
});
