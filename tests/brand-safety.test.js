/**
 * Phase 67.4: Brand safety tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-brand-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createRuleSet,
  evaluateContent,
  listRuleSets,
  updateRuleSet,
  testContent,
  deleteRuleSet,
  applyRuleSet,
} = await import("../lib/brand-safety.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("createRuleSet stores a validated rule set", async () => {
  const rs = await createRuleSet({
    name: "default",
    brand: "Acme",
    bannedKeywords: ["weapons"],
    riskyKeywords: ["politics"],
    blockedTopics: ["violence"],
    requiredTopics: ["family"],
  });
  assert.ok(rs.id);
  assert.equal(rs.brand, "Acme");
  assert.deepEqual(rs.bannedKeywords, ["weapons"]);
});

test("createRuleSet validates required fields", async () => {
  await assert.rejects(() => createRuleSet(null));
  await assert.rejects(() => createRuleSet({ name: "only" }));
  await assert.rejects(() => createRuleSet({ brand: "only" }));
});

test("applyRuleSet blocks on banned keywords", () => {
  const result = applyRuleSet(
    { bannedKeywords: ["weapons"], riskyKeywords: [], blockedTopics: [], requiredTopics: [] },
    { text: "This ad promotes weapons to children" },
  );
  assert.equal(result.verdict, "block");
  assert.ok(result.reasons.some((r) => r.includes("weapons")));
});

test("applyRuleSet flags on risky keywords", () => {
  const result = applyRuleSet(
    { bannedKeywords: [], riskyKeywords: ["politics"], blockedTopics: [], requiredTopics: [] },
    { text: "discusses politics briefly" },
  );
  assert.equal(result.verdict, "flag");
  assert.ok(result.flaggedKeywords.includes("politics"));
});

test("applyRuleSet blocks on blocked topics", () => {
  const result = applyRuleSet(
    { bannedKeywords: [], riskyKeywords: [], blockedTopics: ["violence"], requiredTopics: [] },
    { text: "safe text", topics: ["violence"] },
  );
  assert.equal(result.verdict, "block");
  assert.ok(result.blockedTopics.includes("violence"));
});

test("applyRuleSet flags missing required topics", () => {
  const result = applyRuleSet(
    { bannedKeywords: [], riskyKeywords: [], blockedTopics: [], requiredTopics: ["family"] },
    { text: "safe text", topics: ["tech"] },
  );
  assert.equal(result.verdict, "flag");
  assert.ok(result.missingRequired.includes("family"));
});

test("applyRuleSet allow when clean content and required topics present", () => {
  const result = applyRuleSet(
    { bannedKeywords: ["weapons"], riskyKeywords: ["politics"], blockedTopics: ["violence"], requiredTopics: ["family"] },
    { text: "wholesome message", topics: ["family"] },
  );
  assert.equal(result.verdict, "allow");
});

test("applyRuleSet case insensitive by default", () => {
  const result = applyRuleSet(
    { bannedKeywords: ["weapons"], riskyKeywords: [], blockedTopics: [], requiredTopics: [], caseSensitive: false },
    { text: "Talks about WEAPONS" },
  );
  assert.equal(result.verdict, "block");
});

test("evaluateContent looks up persisted rule sets", async () => {
  const rs = await createRuleSet({
    name: "persisted",
    brand: "B",
    bannedKeywords: ["badword"],
  });
  const result = await evaluateContent(rs.id, { text: "includes badword somewhere" });
  assert.equal(result.verdict, "block");
});

test("evaluateContent returns allow when rule set disabled", async () => {
  const rs = await createRuleSet({ name: "disabled", brand: "B", bannedKeywords: ["x"], enabled: false });
  const result = await evaluateContent(rs.id, { text: "contains x explicitly" });
  assert.equal(result.verdict, "allow");
});

test("updateRuleSet changes keywords", async () => {
  const rs = await createRuleSet({ name: "upd", brand: "B", bannedKeywords: ["old"] });
  const updated = await updateRuleSet(rs.id, { bannedKeywords: ["new"] });
  assert.deepEqual(updated.bannedKeywords, ["new"]);
  await assert.rejects(() => updateRuleSet("missing", { bannedKeywords: [] }));
});

test("listRuleSets filters by brand and enabledOnly", async () => {
  await createRuleSet({ name: "brandX1", brand: "X" });
  const x = await listRuleSets({ brand: "X" });
  for (const r of x) assert.equal(r.brand, "X");
});

test("testContent evaluates inline without persisting", () => {
  const result = testContent({
    ruleSet: { name: "inline", brand: "i", bannedKeywords: ["forbidden"] },
    content: { text: "forbidden stuff here" },
  });
  assert.equal(result.verdict, "block");
});

test("deleteRuleSet removes and then returns false", async () => {
  const rs = await createRuleSet({ name: "to-delete", brand: "Z" });
  const ok = await deleteRuleSet(rs.id);
  assert.equal(ok, true);
  const again = await deleteRuleSet(rs.id);
  assert.equal(again, false);
});
