/**
 * Phase 67.3: Misinformation checks tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-misinfo-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  addClaim,
  checkClaim,
  listClaims,
  addSource,
  rankSourceCredibility,
  listSources,
} = await import("../lib/misinfo-checks.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("addSource persists with clamped credibility", async () => {
  const s1 = await addSource({ name: "Source A", credibility: 0.8 });
  assert.equal(s1.credibility, 0.8);
  const s2 = await addSource({ name: "Source B", credibility: 2 });
  assert.equal(s2.credibility, 1);
  const s3 = await addSource({ name: "Source C", credibility: -1 });
  assert.equal(s3.credibility, 0);
  await assert.rejects(() => addSource({}));
});

test("addClaim requires source references to exist", async () => {
  const src = await addSource({ name: "Reference", credibility: 0.9 });
  const claim = await addClaim({
    statement: "The sky appears blue during the day due to rayleigh scattering",
    verdict: "supports",
    sources: [{ sourceId: src.id, stance: "supports" }],
  });
  assert.ok(claim.id);
  assert.equal(claim.verdict, "supports");
  assert.equal(claim.sources.length, 1);
  await assert.rejects(() =>
    addClaim({ statement: "x", sources: [{ sourceId: "missing" }] }),
  );
});

test("addClaim validates statement and verdict", async () => {
  await assert.rejects(() => addClaim(null));
  await assert.rejects(() => addClaim({ statement: "" }));
  await assert.rejects(() => addClaim({ statement: "hi", verdict: "nuclear" }));
});

test("checkClaim returns supported when a matching claim has credible supports", async () => {
  const src = await addSource({ name: "credible", credibility: 0.95 });
  await addClaim({
    statement: "Water boils at 100 degrees Celsius at sea level",
    verdict: "supports",
    sources: [{ sourceId: src.id, stance: "supports" }],
  });
  const result = await checkClaim({
    statement: "Does water boil at 100 degrees Celsius at sea level",
    minOverlap: 0.3,
  });
  assert.equal(result.verdict, "supported");
  assert.ok(result.matches.length >= 1);
  assert.ok(result.sourceScore > 0);
});

test("checkClaim returns refuted when top source refutes", async () => {
  const src = await addSource({ name: "refute-src", credibility: 0.9 });
  await addClaim({
    statement: "Vaccines cause autism according to peer reviewed studies",
    verdict: "refutes",
    sources: [{ sourceId: src.id, stance: "refutes" }],
  });
  const result = await checkClaim({
    statement: "Vaccines cause autism according to peer reviewed studies",
    minOverlap: 0.3,
  });
  assert.equal(result.verdict, "refuted");
});

test("checkClaim returns disputed when sources disagree", async () => {
  const srcA = await addSource({ name: "pro", credibility: 0.7 });
  const srcB = await addSource({ name: "con", credibility: 0.7 });
  await addClaim({
    statement: "Coffee significantly improves long-term memory in healthy adults",
    sources: [
      { sourceId: srcA.id, stance: "supports" },
      { sourceId: srcB.id, stance: "refutes" },
    ],
  });
  const result = await checkClaim({
    statement: "Coffee significantly improves long-term memory in healthy adults",
    minOverlap: 0.3,
  });
  assert.equal(result.verdict, "disputed");
});

test("checkClaim returns unsupported with no matching claim", async () => {
  const result = await checkClaim({
    statement: "Purple flying unicorns powered by solar panels invaded Venus",
    minOverlap: 0.9,
  });
  assert.equal(result.verdict, "unsupported");
  assert.deepEqual(result.matches, []);
});

test("checkClaim validates input", async () => {
  await assert.rejects(() => checkClaim(null));
  await assert.rejects(() => checkClaim({}));
});

test("listClaims filters by verdict and limits", async () => {
  await addClaim({ statement: "red apples taste sweet delicious", verdict: "supports" });
  await addClaim({ statement: "green kiwis taste sour juicy", verdict: "refutes" });
  const supports = await listClaims({ verdict: "supports" });
  for (const c of supports) assert.equal(c.verdict, "supports");
  const limited = await listClaims({ limit: 1 });
  assert.ok(limited.length <= 1);
});

test("rankSourceCredibility orders descending", async () => {
  const ranked = await rankSourceCredibility();
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].credibility >= ranked[i].credibility);
    assert.equal(ranked[i].rank, i + 1);
  }
});

test("listSources filters by minCredibility and category", async () => {
  await addSource({ name: "cat-news", credibility: 0.6, category: "news" });
  const news = await listSources({ category: "news", minCredibility: 0.5 });
  for (const s of news) {
    assert.equal(s.category, "news");
    assert.ok(s.credibility >= 0.5);
  }
});
