/**
 * Phase 68.3: Fact verification tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-fact-verify-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  verifyClaim,
  addAuthoritativeSource,
  listSources,
  getClaimStatus,
  listClaims,
} = await import("../lib/fact-verification.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("addAuthoritativeSource persists a source", async () => {
  const rec = await addAuthoritativeSource({
    name: "Encyclopedia Galactica",
    corpus: "Earth is the third planet from the Sun and the only astronomical object known to harbor life.",
    trust: 0.95,
  });
  assert.equal(rec.name, "Encyclopedia Galactica");
  assert.equal(rec.trust, 0.95);
  assert.ok(!rec.corpus);
});

test("addAuthoritativeSource rejects invalid input", async () => {
  await assert.rejects(() => addAuthoritativeSource(null));
  await assert.rejects(() => addAuthoritativeSource({ name: "", corpus: "x" }));
  await assert.rejects(() => addAuthoritativeSource({ name: "n", corpus: 42 }));
});

test("listSources returns entries without the corpus text", async () => {
  await addAuthoritativeSource({ name: "Corpus One", corpus: "secret content" });
  const all = await listSources();
  assert.ok(all.length >= 1);
  for (const s of all) {
    assert.ok(!s.corpus);
    assert.ok(!s.corpusTokens);
  }
});

test("verifyClaim returns 'verified' when the claim overlaps with a trusted source", async () => {
  await addAuthoritativeSource({
    name: "Astro Source",
    corpus: "Jupiter is the largest planet in the Solar System and is composed mainly of hydrogen and helium.",
    trust: 0.9,
  });
  const r = await verifyClaim("Jupiter is the largest planet in the Solar System");
  assert.equal(r.verdict, "verified");
  assert.ok(r.confidence > 0.4);
  assert.ok(r.perSource.length > 0);
});

test("verifyClaim returns 'unverified' when there is no supporting source", async () => {
  const r = await verifyClaim("xyzqq blarb squabble never before heard nonsense word");
  assert.equal(r.verdict, "unverified");
});

test("verifyClaim detects contradiction with negator tokens", async () => {
  await addAuthoritativeSource({
    name: "Historical Facts",
    corpus: "The moon landing happened in 1969 with Apollo 11.",
    trust: 0.9,
  });
  const r = await verifyClaim("The moon landing never happened in 1969 and was false");
  assert.ok(["disputed", "verified", "partial"].includes(r.verdict));
  const contradicted = r.perSource.some((p) => p.contradicted);
  assert.ok(contradicted);
});

test("verifyClaim rejects empty input", async () => {
  await assert.rejects(() => verifyClaim(""));
  await assert.rejects(() => verifyClaim(null));
});

test("getClaimStatus returns the most recent verdict", async () => {
  await addAuthoritativeSource({
    name: "Geo",
    corpus: "Mount Everest is the tallest mountain above sea level at 8,848 meters.",
    trust: 0.9,
  });
  await verifyClaim("Mount Everest is the tallest mountain");
  const status = await getClaimStatus("Mount Everest is the tallest mountain");
  assert.ok(status);
  assert.equal(status.verdict, "verified");
});

test("getClaimStatus returns null for unknown claims", async () => {
  const r = await getClaimStatus("completely unknown utterance 1234567");
  assert.equal(r, null);
});

test("listClaims returns all persisted verdicts", async () => {
  await verifyClaim("Something to record");
  const all = await listClaims();
  assert.ok(Array.isArray(all));
  assert.ok(all.length >= 1);
});
