/**
 * Eval subject registry tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-eval-subjects-"));
process.env.STORAGE_PATH = TMP;

const {
  registerSubject,
  ensureSeededSubjects,
  listSubjects,
  getSubject,
  removeSubject,
  _reset,
  PHASE63_SUBJECTS,
} = await import("../lib/eval-subjects.js");

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

test("PHASE63_SUBJECTS lists all five Phase 63 features", () => {
  assert.equal(PHASE63_SUBJECTS.length, 5);
  for (const f of [
    "repo-rag",
    "pr-review-agent",
    "test-gen",
    "refactor-agent",
    "migration-assistant",
  ]) {
    assert.ok(
      PHASE63_SUBJECTS.some((s) => s.feature === f),
      `expected feature ${f}`
    );
  }
});

test("registerSubject persists a new subject", async () => {
  await _reset();
  const rec = await registerSubject({
    subjectId: "test.subject",
    feature: "test-feature",
    tags: ["custom"],
  });
  assert.equal(rec.subjectId, "test.subject");
  const listed = await listSubjects();
  assert.equal(listed.length, 1);
});

test("registerSubject is idempotent on subjectId", async () => {
  await _reset();
  await registerSubject({ subjectId: "x", feature: "foo" });
  await registerSubject({ subjectId: "x", feature: "bar" });
  const listed = await listSubjects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].feature, "bar");
});

test("registerSubject rejects missing fields", async () => {
  await assert.rejects(() => registerSubject({}), /subjectId required/);
  await assert.rejects(
    () => registerSubject({ subjectId: "x" }),
    /feature required/
  );
});

test("ensureSeededSubjects seeds Phase 63 subjects on a clean registry", async () => {
  await _reset();
  const out = await ensureSeededSubjects();
  assert.equal(out.added, 5);
  const tagged = await listSubjects({ tag: "phase63" });
  assert.equal(tagged.length, 5);
});

test("ensureSeededSubjects is idempotent", async () => {
  await _reset();
  await ensureSeededSubjects();
  const second = await ensureSeededSubjects();
  assert.equal(second.added, 0);
});

test("getSubject and removeSubject round-trip", async () => {
  await _reset();
  await registerSubject({ subjectId: "x", feature: "foo" });
  const found = await getSubject("x");
  assert.ok(found);
  const removed = await removeSubject("x");
  assert.equal(removed, true);
  assert.equal(await getSubject("x"), null);
});
