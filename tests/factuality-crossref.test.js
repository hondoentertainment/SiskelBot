/**
 * Phase 67.3: Factuality cross-ref tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-factuality-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  configureSources,
  listSources,
  getSource,
  deleteSource,
  verifyClaim,
  extractTerms,
} = await import("../lib/factuality-crossref.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("extractTerms removes stopwords and short tokens", () => {
  const out = extractTerms("The cat is on the mat.");
  assert.ok(out.includes("cat"));
  assert.ok(out.includes("mat"));
  assert.ok(!out.includes("the"));
  assert.ok(!out.includes("is"));
});

test("configureSources validates inputs", async () => {
  await assert.rejects(() => configureSources([]), /sources array/);
  await assert.rejects(() => configureSources([{}]), /name/);
  await assert.rejects(() => configureSources([{ name: "x" }]), /text or url/);
});

test("configureSources persists and listSources returns them", async () => {
  const [s1, s2] = await configureSources([
    { name: "iana", text: "The Internet Assigned Numbers Authority maintains the DNS root zone registry." },
    { name: "wiki", url: "https://example.com/wiki", description: "wiki snapshot" },
  ]);
  assert.ok(s1.id && s2.id);
  const list = await listSources();
  assert.ok(list.some((s) => s.id === s1.id));
  assert.ok(list.some((s) => s.id === s2.id));
});

test("verifyClaim requires a claim", async () => {
  await assert.rejects(() => verifyClaim({}), /claim/);
});

test("verifyClaim supports claim with high term overlap against inline text", async () => {
  const sources = await configureSources([
    { name: "physics", text: "Water boils at 100 degrees Celsius at standard atmospheric pressure." },
  ]);
  const result = await verifyClaim({
    claim: "Water boils at 100 degrees Celsius at standard pressure",
    sourceIds: [sources[0].id],
  });
  assert.ok(result.confidence > 0.7);
  assert.equal(result.verdict, "supported");
  assert.equal(result.sourceResults.length, 1);
});

test("verifyClaim marks unsupported when overlap is low", async () => {
  const sources = await configureSources([
    { name: "history", text: "The French Revolution began in 1789 and ended in 1799." },
  ]);
  const result = await verifyClaim({
    claim: "Lunar eclipses happen during a full moon",
    sourceIds: [sources[0].id],
  });
  assert.equal(result.verdict, "unsupported");
  assert.ok(result.confidence < 0.4);
});

test("verifyClaim partial verdict at moderate overlap", async () => {
  const sources = await configureSources([
    { name: "geo", text: "Paris is the capital and most populous city of France, situated along the Seine River." },
  ]);
  const result = await verifyClaim({
    claim: "Paris sits along a river and has people",
    sourceIds: [sources[0].id],
  });
  assert.ok(["partial", "supported"].includes(result.verdict));
});

test("verifyClaim uses urlFetcher for URL-only sources", async () => {
  const sources = await configureSources([
    { name: "remote", url: "https://example.test/canonical" },
  ]);
  const fetcherCalls = [];
  const result = await verifyClaim({
    claim: "Cats are small domesticated carnivorous mammals",
    sourceIds: [sources[0].id],
    urlFetcher: async (url) => {
      fetcherCalls.push(url);
      return "Cats are small domesticated carnivorous mammals often kept as pets.";
    },
  });
  assert.equal(fetcherCalls.length, 1);
  assert.equal(result.sourceResults[0].fetched, true);
  assert.ok(result.confidence > 0);
});

test("verifyClaim applies requiredPatterns gate", async () => {
  const sources = await configureSources([
    { name: "num", text: "The tower stands 324 meters tall with three observation decks" },
  ]);
  const ok = await verifyClaim({
    claim: "The tower is 324 meters tall",
    sourceIds: [sources[0].id],
    requiredPatterns: [/324/],
  });
  assert.equal(ok.patternCheck.passed, true);
  const bad = await verifyClaim({
    claim: "The tower is 324 meters tall",
    sourceIds: [sources[0].id],
    requiredPatterns: [/999/],
  });
  assert.equal(bad.patternCheck.passed, false);
  assert.equal(bad.verdict, "unsupported");
});

test("deleteSource and getSource coordinate correctly", async () => {
  const [s] = await configureSources([
    { name: "temp", text: "ephemeral test source content for deletion" },
  ]);
  const del = await deleteSource(s.id);
  assert.equal(del.ok, true);
  assert.equal(await getSource(s.id), null);
});

test("verifyClaim reports no_sources when nothing configured matches", async () => {
  const result = await verifyClaim({
    claim: "anything goes",
    sourceIds: ["definitely-not-real"],
  });
  assert.equal(result.verdict, "no_sources");
});
