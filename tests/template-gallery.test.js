/**
 * Tests for lib/template-gallery.js — publish, unpublish, list, search,
 * install, rate, ratings, stats, publisher templates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-gallery-"));
process.env.STORAGE_PATH = tempDir;

const {
  publishTemplate,
  unpublishTemplate,
  getGalleryTemplate,
  listGalleryTemplates,
  searchGalleryTemplates,
  installFromGallery,
  rateTemplate,
  getRatings,
  getPublisherTemplates,
  getGalleryStats,
} = await import("../lib/template-gallery.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

const PUBLISHER = { userId: "alice", displayName: "Alice Example" };
const PUBLISHER_BOB = { userId: "bob", displayName: "Bob Smith" };

// --- publishTemplate ---

test("publishTemplate creates a gallery entry and returns galleryId", async () => {
  const result = await publishTemplate("ws-1", {
    name: "Coding Assistant",
    description: "Helpful coding companion",
    category: "coding",
    tags: ["javascript", "ai"],
    content: { defaultSystemPrompt: "You are a coding assistant." },
  }, PUBLISHER);
  assert.ok(result.galleryId);
  assert.ok(result.publishedAt);
  const entry = await getGalleryTemplate(result.galleryId);
  assert.equal(entry.name, "Coding Assistant");
  assert.equal(entry.category, "coding");
  assert.deepEqual(entry.tags, ["javascript", "ai"]);
  assert.equal(entry.publisherUserId, "alice");
  assert.equal(entry.downloads, 0);
  assert.equal(entry.ratingAverage, 0);
});

test("publishTemplate throws when name is missing", async () => {
  await assert.rejects(
    () => publishTemplate("ws-1", { description: "no name" }, PUBLISHER),
    /name is required/
  );
});

test("publishTemplate throws when publisher.userId is missing", async () => {
  await assert.rejects(
    () => publishTemplate("ws-1", { name: "x" }, {}),
    /publisher.userId is required/
  );
});

test("publishTemplate normalizes category and tags", async () => {
  const result = await publishTemplate("ws-1", {
    name: "Tag normalize",
    tags: ["  Foo  ", "BAR", "", "baz"],
  }, PUBLISHER);
  const entry = await getGalleryTemplate(result.galleryId);
  assert.equal(entry.category, "general");
  assert.deepEqual(entry.tags, ["foo", "bar", "baz"]);
});

// --- unpublishTemplate ---

test("unpublishTemplate removes the entry when caller is publisher", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "Removable" }, PUBLISHER);
  const r = await unpublishTemplate(galleryId, PUBLISHER.userId);
  assert.equal(r.ok, true);
  const after = await getGalleryTemplate(galleryId);
  assert.equal(after, null);
});

test("unpublishTemplate forbids non-publisher", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "Mine" }, PUBLISHER);
  const r = await unpublishTemplate(galleryId, "intruder");
  assert.equal(r.ok, false);
  assert.equal(r.error, "forbidden");
});

test("unpublishTemplate returns not found for unknown id", async () => {
  const r = await unpublishTemplate("does-not-exist", PUBLISHER.userId);
  assert.equal(r.ok, false);
  assert.equal(r.error, "not found");
});

// --- listGalleryTemplates ---

test("listGalleryTemplates returns published templates with total", async () => {
  const result = await listGalleryTemplates();
  assert.ok(Array.isArray(result.items));
  assert.ok(result.total >= 1);
});

test("listGalleryTemplates filters by category", async () => {
  await publishTemplate("ws-1", { name: "Research X", category: "research" }, PUBLISHER);
  const result = await listGalleryTemplates({ category: "research" });
  assert.ok(result.items.length >= 1);
  assert.ok(result.items.every((t) => t.category === "research"));
});

test("listGalleryTemplates filters by tag", async () => {
  await publishTemplate("ws-1", { name: "Tagged", tags: ["urgent"] }, PUBLISHER);
  const result = await listGalleryTemplates({ tag: "urgent" });
  assert.ok(result.items.length >= 1);
  assert.ok(result.items.every((t) => t.tags.includes("urgent")));
});

test("listGalleryTemplates sortBy=recent orders by publishedAt desc", async () => {
  await publishTemplate("ws-1", { name: "Older sort entry" }, PUBLISHER);
  await new Promise((r) => setTimeout(r, 5));
  const newer = await publishTemplate("ws-1", { name: "Newer sort entry" }, PUBLISHER);
  const result = await listGalleryTemplates({ sortBy: "recent", limit: 50 });
  const idx = result.items.findIndex((t) => t.galleryId === newer.galleryId);
  assert.ok(idx >= 0 && idx < 5);
});

test("listGalleryTemplates sortBy=popular orders by downloads desc", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "Popular One" }, PUBLISHER);
  await installFromGallery(galleryId, "ws-target", "alice");
  await installFromGallery(galleryId, "ws-target", "alice");
  const result = await listGalleryTemplates({ sortBy: "popular", limit: 5 });
  assert.ok(result.items.length > 0);
  assert.equal(result.items[0].galleryId, galleryId);
});

test("listGalleryTemplates honors limit + offset", async () => {
  const result = await listGalleryTemplates({ limit: 1, offset: 0 });
  assert.equal(result.items.length, 1);
});

// --- searchGalleryTemplates ---

test("searchGalleryTemplates matches by name token", async () => {
  await publishTemplate("ws-1", { name: "Unique Search Token Foobar" }, PUBLISHER);
  const result = await searchGalleryTemplates("foobar");
  assert.ok(result.items.length >= 1);
  assert.ok(result.items.some((t) => t.name.toLowerCase().includes("foobar")));
});

test("searchGalleryTemplates matches by tag", async () => {
  await publishTemplate("ws-1", { name: "Has Searchtag", tags: ["searchtag"] }, PUBLISHER);
  const result = await searchGalleryTemplates("searchtag");
  assert.ok(result.items.length >= 1);
});

test("searchGalleryTemplates with empty query falls back to listGalleryTemplates", async () => {
  const result = await searchGalleryTemplates("");
  assert.ok(result.items.length >= 1);
});

// --- installFromGallery ---

test("installFromGallery increments download count and applies template", async () => {
  const { galleryId } = await publishTemplate("ws-1", {
    name: "Install Me",
    content: {
      defaultSystemPrompt: "Hello world",
      memorySnippets: ["fact-1"],
      toolAllowlist: ["search_context"],
    },
  }, PUBLISHER);
  const before = await getGalleryTemplate(galleryId);
  assert.equal(before.downloads, 0);
  const r = await installFromGallery(galleryId, "target-ws", "user-x");
  assert.equal(r.installed, true);
  assert.equal(r.workspaceId, "target-ws");
  const after = await getGalleryTemplate(galleryId);
  assert.equal(after.downloads, 1);
});

test("installFromGallery throws when template not found", async () => {
  await assert.rejects(
    () => installFromGallery("missing-id", "ws-x", "user"),
    /template not found/
  );
});

test("installFromGallery throws when targetWorkspaceId is missing", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "X" }, PUBLISHER);
  await assert.rejects(
    () => installFromGallery(galleryId, "", "user"),
    /targetWorkspaceId is required/
  );
});

// --- rateTemplate ---

test("rateTemplate accepts valid rating 1-5 and computes average", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "Rate Me" }, PUBLISHER);
  const r1 = await rateTemplate(galleryId, "u1", 5, "great");
  assert.equal(r1.ok, true);
  assert.equal(r1.average, 5);
  assert.equal(r1.count, 1);
  const r2 = await rateTemplate(galleryId, "u2", 3, "okay");
  assert.equal(r2.count, 2);
  assert.equal(r2.average, 4);
});

test("rateTemplate replaces an existing user rating", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "Replace Rate" }, PUBLISHER);
  await rateTemplate(galleryId, "u1", 1);
  const r = await rateTemplate(galleryId, "u1", 5);
  assert.equal(r.count, 1);
  assert.equal(r.average, 5);
});

test("rateTemplate rejects rating outside 1-5", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "Bad Rate" }, PUBLISHER);
  await assert.rejects(
    () => rateTemplate(galleryId, "u1", 0),
    /rating must be an integer between 1 and 5/
  );
  await assert.rejects(
    () => rateTemplate(galleryId, "u1", 6),
    /rating must be an integer between 1 and 5/
  );
});

test("rateTemplate rejects non-integer rating", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "Bad Rate Frac" }, PUBLISHER);
  await assert.rejects(
    () => rateTemplate(galleryId, "u1", 3.5),
    /rating must be an integer between 1 and 5/
  );
});

test("rateTemplate throws on missing template", async () => {
  await assert.rejects(
    () => rateTemplate("nope", "u1", 5),
    /template not found/
  );
});

// --- getRatings ---

test("getRatings returns average, count, distribution, reviews", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "Ratings Aggregate" }, PUBLISHER);
  await rateTemplate(galleryId, "u1", 5, "loved it");
  await rateTemplate(galleryId, "u2", 4, "pretty good");
  await rateTemplate(galleryId, "u3", 5, "");
  const r = await getRatings(galleryId);
  assert.equal(r.count, 3);
  assert.ok(r.average > 4 && r.average <= 5);
  assert.equal(r.distribution[5], 2);
  assert.equal(r.distribution[4], 1);
  assert.equal(r.distribution[1], 0);
  // Only entries with review text appear in reviews list.
  assert.equal(r.reviews.length, 2);
});

test("getRatings returns zero state for empty template", async () => {
  const { galleryId } = await publishTemplate("ws-1", { name: "No Ratings" }, PUBLISHER);
  const r = await getRatings(galleryId);
  assert.equal(r.count, 0);
  assert.equal(r.average, 0);
  assert.deepEqual(r.distribution, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  assert.deepEqual(r.reviews, []);
});

// --- getPublisherTemplates ---

test("getPublisherTemplates returns only the given publisher's templates", async () => {
  await publishTemplate("ws-1", { name: "Bob Template 1" }, PUBLISHER_BOB);
  await publishTemplate("ws-1", { name: "Bob Template 2" }, PUBLISHER_BOB);
  const list = await getPublisherTemplates("bob");
  assert.ok(list.length >= 2);
  assert.ok(list.every((t) => t.publisherUserId === "bob"));
});

test("getPublisherTemplates returns empty array for unknown publisher", async () => {
  const list = await getPublisherTemplates("nobody-xyz");
  assert.deepEqual(list, []);
});

// --- getGalleryStats ---

test("getGalleryStats aggregates totals and topCategories", async () => {
  const stats = await getGalleryStats();
  assert.ok(stats.totalTemplates >= 1);
  assert.ok(typeof stats.totalDownloads === "number");
  assert.ok(stats.totalPublishers >= 1);
  assert.ok(Array.isArray(stats.topCategories));
  if (stats.topCategories.length > 0) {
    assert.ok(stats.topCategories[0].category);
    assert.ok(stats.topCategories[0].count > 0);
  }
});
