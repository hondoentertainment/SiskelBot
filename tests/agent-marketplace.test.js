/**
 * Tests for lib/agent-marketplace.js — publish, update, delete, list, search,
 * install (increments count), rating with duplicate prevention, reputation score,
 * featured agents, report submission.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate the marketplace data directory before importing the lib.
process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "agent-mp-test-"));

const {
  publishAgent,
  listMarketplaceAgents,
  searchMarketplaceAgents,
  getMarketplaceAgent,
  updateMarketplaceAgent,
  deleteMarketplaceAgent,
  rateAgent,
  getAgentRatings,
  installAgent,
  getAgentStats,
  reportAgent,
  listReports,
  featureAgent,
  listFeaturedAgents,
  AGENT_CATEGORIES,
  _resetAgentMarketplaceForTests,
} = await import("../lib/agent-marketplace.js");

const { calculateReputationScore, getReputationBadge } = await import("../lib/agent-reputation.js");

const ALICE = { userId: "alice", name: "Alice" };
const BOB = { userId: "bob", name: "Bob", verified: true };

const VALID_CONFIG = {
  name: "Code Reviewer",
  description: "Reviews pull requests for style and correctness.",
  category: "coding",
  tags: ["review", "code"],
  systemPrompt: "You are a meticulous code reviewer.",
  tools: ["search_context", "get_context_document"],
  hyperparameters: { temperature: 0.2, max_tokens: 1000 },
  model: "gpt-4o-mini",
  examples: [{ input: "Review this", output: "LGTM", description: "approval" }],
  license: "MIT",
};

await _resetAgentMarketplaceForTests();

// ─── publish ─────────────────────────────────────────────────────────────────

test("publishAgent stores a new agent and returns marketplaceId/slug", async () => {
  const result = await publishAgent(VALID_CONFIG, ALICE);
  assert.ok(result.marketplaceId);
  assert.ok(result.slug);
  assert.ok(result.publishedAt);

  const fetched = await getMarketplaceAgent(result.marketplaceId);
  assert.equal(fetched.name, "Code Reviewer");
  assert.equal(fetched.systemPrompt, "You are a meticulous code reviewer.");
  assert.equal(fetched.category, "coding");
  assert.deepEqual(fetched.tools, ["search_context", "get_context_document"]);
});

test("publishAgent rejects missing name", async () => {
  await assert.rejects(
    () => publishAgent({ systemPrompt: "x" }, ALICE),
    /name is required/
  );
});

test("publishAgent rejects missing systemPrompt", async () => {
  await assert.rejects(
    () => publishAgent({ name: "Foo" }, ALICE),
    /systemPrompt is required/
  );
});

test("publishAgent coerces invalid category to 'other'", async () => {
  const result = await publishAgent(
    { name: "Misc", systemPrompt: "you are misc", category: "not-real" },
    ALICE
  );
  const fetched = await getMarketplaceAgent(result.marketplaceId);
  assert.equal(fetched.category, "other");
});

test("publishAgent sanitizes tags", async () => {
  const result = await publishAgent(
    {
      name: "Tag Test",
      systemPrompt: "x",
      tags: ["  Hello  ", "WORLD", "", null, "x".repeat(50)],
    },
    ALICE
  );
  const fetched = await getMarketplaceAgent(result.marketplaceId);
  assert.deepEqual(fetched.tags.slice(0, 3), ["hello", "world", "x".repeat(32)]);
});

test("publishAgent does not include systemPrompt in list view", async () => {
  await _resetAgentMarketplaceForTests();
  await publishAgent(VALID_CONFIG, ALICE);
  const result = await listMarketplaceAgents({});
  assert.ok(result.items.length >= 1);
  assert.equal(result.items[0].systemPrompt, undefined);
});

// ─── update / delete ─────────────────────────────────────────────────────────

test("updateMarketplaceAgent updates fields when called by publisher", async () => {
  await _resetAgentMarketplaceForTests();
  const published = await publishAgent(VALID_CONFIG, ALICE);
  const updated = await updateMarketplaceAgent(
    published.marketplaceId,
    { description: "Improved reviewer", tags: ["new-tag"] },
    ALICE.userId
  );
  assert.equal(updated.description, "Improved reviewer");
  assert.deepEqual(updated.tags, ["new-tag"]);
});

test("updateMarketplaceAgent rejects non-publisher", async () => {
  const published = await publishAgent(VALID_CONFIG, ALICE);
  await assert.rejects(
    () => updateMarketplaceAgent(published.marketplaceId, { description: "hacked" }, "mallory"),
    /only the publisher/
  );
});

test("updateMarketplaceAgent throws for missing agent", async () => {
  await assert.rejects(
    () => updateMarketplaceAgent("nonexistent", { description: "x" }, ALICE.userId),
    /agent not found/
  );
});

test("deleteMarketplaceAgent removes agent when called by publisher", async () => {
  const published = await publishAgent(VALID_CONFIG, ALICE);
  const result = await deleteMarketplaceAgent(published.marketplaceId, ALICE.userId);
  assert.equal(result.deleted, true);
  const fetched = await getMarketplaceAgent(published.marketplaceId);
  assert.equal(fetched, null);
});

test("deleteMarketplaceAgent rejects non-publisher", async () => {
  const published = await publishAgent(VALID_CONFIG, ALICE);
  await assert.rejects(
    () => deleteMarketplaceAgent(published.marketplaceId, "mallory"),
    /only the publisher/
  );
});

// ─── list / search ───────────────────────────────────────────────────────────

test("listMarketplaceAgents filters by category", async () => {
  await _resetAgentMarketplaceForTests();
  await publishAgent({ ...VALID_CONFIG, category: "coding", name: "Coder A" }, ALICE);
  await publishAgent({ ...VALID_CONFIG, category: "coding", name: "Coder B" }, ALICE);
  await publishAgent({ ...VALID_CONFIG, category: "writing", name: "Writer A" }, ALICE);

  const coders = await listMarketplaceAgents({ category: "coding" });
  assert.equal(coders.total, 2);
  for (const a of coders.items) assert.equal(a.category, "coding");

  const writers = await listMarketplaceAgents({ category: "writing" });
  assert.equal(writers.total, 1);
});

test("listMarketplaceAgents pagination respects offset and limit", async () => {
  const all = await listMarketplaceAgents({ limit: 100 });
  const page1 = await listMarketplaceAgents({ limit: 1, offset: 0 });
  const page2 = await listMarketplaceAgents({ limit: 1, offset: 1 });
  assert.equal(page1.items.length, 1);
  if (all.total > 1) {
    assert.notEqual(page1.items[0].marketplaceId, page2.items[0].marketplaceId);
  }
});

test("searchMarketplaceAgents finds by name", async () => {
  const matches = await searchMarketplaceAgents("coder a");
  assert.ok(matches.some((m) => m.name === "Coder A"));
});

test("searchMarketplaceAgents returns empty for blank query", async () => {
  const matches = await searchMarketplaceAgents("");
  assert.deepEqual(matches, []);
});

// ─── install ────────────────────────────────────────────────────────────────

test("installAgent increments install count and returns installedAgentId", async () => {
  await _resetAgentMarketplaceForTests();
  const published = await publishAgent(VALID_CONFIG, ALICE);
  const before = await getMarketplaceAgent(published.marketplaceId);
  assert.equal(before.installs, 0);

  const result = await installAgent(published.marketplaceId, "ws-1", "user-1");
  assert.ok(result.installedAgentId);

  const after = await getMarketplaceAgent(published.marketplaceId);
  assert.equal(after.installs, 1);

  // Multiple installs accumulate.
  await installAgent(published.marketplaceId, "ws-2", "user-2");
  const after2 = await getMarketplaceAgent(published.marketplaceId);
  assert.equal(after2.installs, 2);
});

test("installAgent throws for missing agent", async () => {
  await assert.rejects(
    () => installAgent("nonexistent", "ws", "user"),
    /agent not found/
  );
});

// ─── ratings (with duplicate prevention) ────────────────────────────────────

test("rateAgent stores rating and recalculates aggregate", async () => {
  await _resetAgentMarketplaceForTests();
  const published = await publishAgent(VALID_CONFIG, ALICE);

  const r1 = await rateAgent(published.marketplaceId, "user-1", 5, "Excellent");
  assert.equal(r1.rated, true);
  assert.equal(r1.updated, false);
  assert.equal(r1.avgRating, 5);
  assert.equal(r1.ratingCount, 1);

  const r2 = await rateAgent(published.marketplaceId, "user-2", 3, "Okay");
  assert.equal(r2.avgRating, 4);
  assert.equal(r2.ratingCount, 2);
});

test("rateAgent prevents duplicate ratings — same user updates instead of inserting", async () => {
  await _resetAgentMarketplaceForTests();
  const published = await publishAgent(VALID_CONFIG, ALICE);
  await rateAgent(published.marketplaceId, "user-1", 5, "first");
  const second = await rateAgent(published.marketplaceId, "user-1", 2, "second");
  assert.equal(second.updated, true);
  assert.equal(second.ratingCount, 1);
  assert.equal(second.avgRating, 2);

  const ratings = await getAgentRatings(published.marketplaceId);
  assert.equal(ratings.count, 1);
  assert.equal(ratings.average, 2);
  assert.equal(ratings.reviews[0].review, "second");
});

test("rateAgent rejects out-of-range rating", async () => {
  const published = await publishAgent(VALID_CONFIG, ALICE);
  await assert.rejects(
    () => rateAgent(published.marketplaceId, "u", 0),
    /rating must be/
  );
  await assert.rejects(
    () => rateAgent(published.marketplaceId, "u", 6),
    /rating must be/
  );
});

test("getAgentRatings returns distribution and reviews", async () => {
  await _resetAgentMarketplaceForTests();
  const published = await publishAgent(VALID_CONFIG, ALICE);
  await rateAgent(published.marketplaceId, "u1", 5, "great");
  await rateAgent(published.marketplaceId, "u2", 5, "love it");
  await rateAgent(published.marketplaceId, "u3", 3, "ok");

  const ratings = await getAgentRatings(published.marketplaceId);
  assert.equal(ratings.count, 3);
  assert.ok(ratings.average > 4 && ratings.average < 5);
  assert.equal(ratings.distribution["5"], 2);
  assert.equal(ratings.distribution["3"], 1);
  assert.equal(ratings.reviews.length, 3);
});

// ─── reputation scoring ─────────────────────────────────────────────────────

test("calculateReputationScore returns 0 for empty stats", () => {
  assert.equal(calculateReputationScore({}), 0);
  assert.equal(calculateReputationScore(null), 0);
});

test("calculateReputationScore weighted score increases with rating + installs", () => {
  const low = calculateReputationScore({
    avgRating: 2,
    ratingCount: 5,
    installs: 1,
    publishedAt: new Date().toISOString(),
  });
  const high = calculateReputationScore({
    avgRating: 5,
    ratingCount: 100,
    installs: 5_000,
    publishedAt: new Date().toISOString(),
    verifiedPublisher: true,
  });
  assert.ok(high > low);
  assert.ok(high <= 100);
  assert.ok(low >= 0);
});

test("calculateReputationScore reaches verified tier with strong stats", () => {
  const score = calculateReputationScore({
    avgRating: 5,
    ratingCount: 200,
    installs: 10_000,
    publishedAt: new Date().toISOString(),
    verifiedPublisher: true,
  });
  assert.ok(score >= 80, `expected >= 80 got ${score}`);
});

test("calculateReputationScore penalizes reports", () => {
  const baseStats = {
    avgRating: 5,
    ratingCount: 50,
    installs: 1_000,
    publishedAt: new Date().toISOString(),
    verifiedPublisher: true,
  };
  const clean = calculateReputationScore(baseStats);
  const reported = calculateReputationScore({ ...baseStats, reports: 5 });
  assert.ok(reported < clean);
});

test("getReputationBadge maps score ranges correctly", () => {
  assert.equal(getReputationBadge(0), "new");
  assert.equal(getReputationBadge(29), "new");
  assert.equal(getReputationBadge(30), "emerging");
  assert.equal(getReputationBadge(59), "emerging");
  assert.equal(getReputationBadge(60), "trusted");
  assert.equal(getReputationBadge(79), "trusted");
  assert.equal(getReputationBadge(80), "verified");
  assert.equal(getReputationBadge(100), "verified");
});

// ─── featured agents ────────────────────────────────────────────────────────

test("featureAgent marks an agent as featured", async () => {
  await _resetAgentMarketplaceForTests();
  const published = await publishAgent(VALID_CONFIG, ALICE);
  const result = await featureAgent(published.marketplaceId, "admin-1");
  assert.equal(result.featured, true);

  const fetched = await getMarketplaceAgent(published.marketplaceId);
  assert.equal(fetched.featured, true);
});

test("listFeaturedAgents returns only featured agents", async () => {
  await _resetAgentMarketplaceForTests();
  const a = await publishAgent({ ...VALID_CONFIG, name: "Featured A" }, ALICE);
  const b = await publishAgent({ ...VALID_CONFIG, name: "Featured B" }, ALICE);
  await publishAgent({ ...VALID_CONFIG, name: "Not Featured" }, ALICE);

  await featureAgent(a.marketplaceId, "admin");
  await featureAgent(b.marketplaceId, "admin");

  const featured = await listFeaturedAgents();
  assert.equal(featured.length, 2);
  for (const f of featured) {
    assert.equal(f.featured, true);
  }
});

test("featureAgent throws for missing agent", async () => {
  await assert.rejects(
    () => featureAgent("nonexistent", "admin"),
    /agent not found/
  );
});

// ─── reports ────────────────────────────────────────────────────────────────

test("reportAgent submits a report and increments counter", async () => {
  await _resetAgentMarketplaceForTests();
  const published = await publishAgent(VALID_CONFIG, ALICE);

  const result = await reportAgent(published.marketplaceId, "user-1", "spam");
  assert.ok(result.reportId);
  assert.equal(result.reason, "spam");
  assert.equal(result.status, "open");

  const fetched = await getMarketplaceAgent(published.marketplaceId);
  assert.equal(fetched.reports, 1);
});

test("reportAgent coerces unknown reason to 'other'", async () => {
  const published = await publishAgent(VALID_CONFIG, ALICE);
  const result = await reportAgent(published.marketplaceId, "user-1", "totally-bogus");
  assert.equal(result.reason, "other");
});

test("listReports returns reports filtered by status", async () => {
  await _resetAgentMarketplaceForTests();
  const published = await publishAgent(VALID_CONFIG, ALICE);
  await reportAgent(published.marketplaceId, "u1", "spam");
  await reportAgent(published.marketplaceId, "u2", "broken");

  const all = await listReports();
  assert.ok(all.length >= 2);

  const open = await listReports("open");
  assert.ok(open.every((r) => r.status === "open"));
});

// ─── stats ──────────────────────────────────────────────────────────────────

test("getAgentStats aggregates everything", async () => {
  await _resetAgentMarketplaceForTests();
  const published = await publishAgent(VALID_CONFIG, BOB);
  await rateAgent(published.marketplaceId, "u1", 5);
  await rateAgent(published.marketplaceId, "u2", 4);
  await installAgent(published.marketplaceId, "ws-1", "u3");

  const stats = await getAgentStats(published.marketplaceId);
  assert.equal(stats.installs, 1);
  assert.equal(stats.ratingCount, 2);
  assert.equal(stats.avgRating, 4.5);
  assert.ok(stats.weeklyActivity >= 1);
  assert.ok(stats.reputationScore >= 0 && stats.reputationScore <= 100);
  assert.ok(["new", "emerging", "trusted", "verified"].includes(stats.reputationBadge));
});

test("getAgentStats returns zeros for missing agent", async () => {
  const stats = await getAgentStats("nonexistent");
  assert.equal(stats.installs, 0);
  assert.equal(stats.avgRating, 0);
});

// ─── categories ─────────────────────────────────────────────────────────────

test("AGENT_CATEGORIES includes expected categories", () => {
  assert.ok(AGENT_CATEGORIES.includes("coding"));
  assert.ok(AGENT_CATEGORIES.includes("research"));
  assert.ok(AGENT_CATEGORIES.includes("other"));
  assert.equal(AGENT_CATEGORIES.length, 10);
});
