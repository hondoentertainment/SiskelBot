/**
 * Phase 68.1: Web ingestion tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-web-ingest-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerSource,
  crawlSource,
  listSources,
  getLastCrawl,
  scheduleCrawl,
  listSchedules,
  normalizeUrl,
  sourceIdFromUrl,
} = await import("../lib/web-ingestion.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("normalizeUrl enforces http(s) schemes and strips trailing slash", () => {
  assert.equal(normalizeUrl("https://Example.com/"), "https://example.com");
  assert.equal(normalizeUrl("http://FOO.bar/path"), "http://foo.bar/path");
  assert.throws(() => normalizeUrl(""));
  assert.throws(() => normalizeUrl("ftp://example.com"));
  assert.throws(() => normalizeUrl("not a url"));
});

test("sourceIdFromUrl produces a stable id", () => {
  const a = sourceIdFromUrl("https://example.com/news");
  const b = sourceIdFromUrl("HTTPS://Example.com/news");
  assert.equal(a, b);
  assert.ok(a.length > 0);
});

test("registerSource stores and updates existing entries", async () => {
  const rec = await registerSource({ url: "https://example.com/feed", title: "Feed", tags: ["news"], intervalMs: 60000 });
  assert.equal(rec.url, "https://example.com/feed");
  assert.equal(rec.title, "Feed");
  assert.equal(rec.intervalMs, 60000);
  assert.ok(rec.createdAt);
  assert.ok(rec.updatedAt);

  const again = await registerSource({ url: "https://example.com/feed", title: "Feed v2" });
  assert.equal(again.id, rec.id);
  assert.equal(again.title, "Feed v2");
});

test("registerSource rejects invalid spec", async () => {
  await assert.rejects(() => registerSource(null));
  await assert.rejects(() => registerSource({ url: "" }));
});

test("crawlSource records a successful crawl using injected fetch", async () => {
  const rec = await registerSource({ url: "https://example.com/a" });
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    text: async () => `<html>fetched ${url}</html>`,
  });
  const crawl = await crawlSource(rec.id, { fetchImpl });
  assert.equal(crawl.ok, true);
  assert.equal(crawl.status, 200);
  assert.ok(crawl.bytes > 0);
  assert.ok(crawl.bodyPreview.includes("fetched"));
});

test("crawlSource records errors without throwing", async () => {
  const rec = await registerSource({ url: "https://example.com/b" });
  const fetchImpl = async () => {
    throw new Error("network boom");
  };
  const crawl = await crawlSource(rec.id, { fetchImpl });
  assert.equal(crawl.ok, false);
  assert.ok(crawl.error && crawl.error.includes("boom"));
});

test("crawlSource throws on unknown source or missing fetchImpl", async () => {
  await assert.rejects(() => crawlSource("nope", { fetchImpl: async () => ({ ok: true, status: 200, text: async () => "" }) }));
  const rec = await registerSource({ url: "https://example.com/c" });
  await assert.rejects(() => crawlSource(rec.id, {}));
});

test("listSources returns entries filtered by tag", async () => {
  await registerSource({ url: "https://example.com/tagged", tags: ["news", "daily"] });
  await registerSource({ url: "https://example.com/untagged" });
  const all = await listSources();
  assert.ok(all.length >= 2);
  const news = await listSources({ tag: "news" });
  assert.ok(news.some((s) => s.url === "https://example.com/tagged"));
  assert.ok(!news.some((s) => s.url === "https://example.com/untagged"));
});

test("getLastCrawl returns the most recent crawl record", async () => {
  const rec = await registerSource({ url: "https://example.com/last" });
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "one" });
  await crawlSource(rec.id, { fetchImpl });
  const fetchImpl2 = async () => ({ ok: true, status: 200, text: async () => "two" });
  await crawlSource(rec.id, { fetchImpl: fetchImpl2 });
  const last = await getLastCrawl(rec.id);
  assert.ok(last);
  assert.equal(last.bodyPreview, "two");
});

test("getLastCrawl returns null for unknown source", async () => {
  const r = await getLastCrawl("missing-source-id");
  assert.equal(r, null);
});

test("scheduleCrawl stores a schedule and listSchedules returns it", async () => {
  const rec = await registerSource({ url: "https://example.com/schedule" });
  const sched = await scheduleCrawl({ sourceId: rec.id, intervalMs: 60000 });
  assert.equal(sched.sourceId, rec.id);
  assert.ok(sched.nextRunAt);
  const all = await listSchedules();
  assert.ok(all.some((s) => s.sourceId === rec.id));
});

test("scheduleCrawl rejects invalid input", async () => {
  await assert.rejects(() => scheduleCrawl(null));
  await assert.rejects(() => scheduleCrawl({ sourceId: "", intervalMs: 1 }));
  await assert.rejects(() => scheduleCrawl({ sourceId: "missing", intervalMs: 1000 }));
  const rec = await registerSource({ url: "https://example.com/bad-sched" });
  await assert.rejects(() => scheduleCrawl({ sourceId: rec.id, intervalMs: -1 }));
});
