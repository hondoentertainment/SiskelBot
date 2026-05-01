import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import {
  generateWiki,
  getWiki,
  getWikiPage,
  listWikiPages,
  invalidateWiki,
} from "../lib/repo-wiki-generator.js";

const ws = () => `test-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function makeCtx() {
  const root = mkdtempSync(join(tmpdir(), "wiki-test-"));
  mkdirSync(join(root, "routes"), { recursive: true });
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Test Project\nA test project.");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-project", version: "1.0.0" }));
  writeFileSync(join(root, "routes", "index.js"), "// routes index");
  writeFileSync(join(root, "lib", "core.js"), "// core lib");
  return { workspaceFilesystemRoot: root };
}

test("generateWiki creates wiki without llmClient (placeholder pages)", async () => {
  const workspaceId = ws();
  const ctx = makeCtx();
  const wiki = await generateWiki(workspaceId, ctx, null, {});
  assert.ok(wiki.wikiId);
  assert.equal(wiki.workspaceId, workspaceId);
  assert.equal(wiki.status, "ready");
  assert.ok(Array.isArray(wiki.pages));
  assert.ok(wiki.pages.length > 0);
  // Placeholder pages should have content
  for (const page of wiki.pages) {
    assert.ok(page.slug);
    assert.ok(page.title);
    assert.ok(typeof page.content === "string");
  }
});

test("generateWiki with llmClient function creates pages with LLM content", async () => {
  const workspaceId = ws();
  const ctx = makeCtx();
  const llmClient = async () => ({ content: "# Generated\nThis is LLM generated content." });
  const wiki = await generateWiki(workspaceId, ctx, llmClient, {});
  assert.equal(wiki.status, "ready");
  assert.ok(wiki.pages.some((p) => p.content.includes("Generated") || p.content.includes("LLM")));
});

test("getWiki returns null before generation", async () => {
  const workspaceId = ws();
  const result = await getWiki(workspaceId);
  assert.equal(result, null);
});

test("getWiki returns wiki after generation", async () => {
  const workspaceId = ws();
  const ctx = makeCtx();
  await generateWiki(workspaceId, ctx, null, {});
  const wiki = await getWiki(workspaceId);
  assert.ok(wiki);
  assert.equal(wiki.workspaceId, workspaceId);
});

test("getWikiPage returns a specific page by slug", async () => {
  const workspaceId = ws();
  const ctx = makeCtx();
  const wiki = await generateWiki(workspaceId, ctx, null, {});
  const firstPage = wiki.pages[0];
  const page = await getWikiPage(workspaceId, firstPage.slug);
  assert.ok(page);
  assert.equal(page.slug, firstPage.slug);
});

test("getWikiPage returns null for unknown slug", async () => {
  const workspaceId = ws();
  const ctx = makeCtx();
  await generateWiki(workspaceId, ctx, null, {});
  const page = await getWikiPage(workspaceId, "nonexistent-slug");
  assert.equal(page, null);
});

test("getWikiPage returns null if no wiki generated", async () => {
  const workspaceId = ws();
  const page = await getWikiPage(workspaceId, "any-slug");
  assert.equal(page, null);
});

test("listWikiPages returns page summaries without full content", async () => {
  const workspaceId = ws();
  const ctx = makeCtx();
  await generateWiki(workspaceId, ctx, null, {});
  const pages = await listWikiPages(workspaceId);
  assert.ok(Array.isArray(pages));
  assert.ok(pages.length > 0);
  for (const p of pages) {
    assert.ok(p.slug);
    assert.ok(p.title);
    assert.ok(!p.content, "listWikiPages should not return full content");
  }
});

test("listWikiPages returns empty array if no wiki", async () => {
  const workspaceId = ws();
  const pages = await listWikiPages(workspaceId);
  assert.deepEqual(pages, []);
});

test("invalidateWiki sets status to pending", async () => {
  const workspaceId = ws();
  const ctx = makeCtx();
  await generateWiki(workspaceId, ctx, null, {});
  const result = await invalidateWiki(workspaceId);
  assert.equal(result.status, "pending");
});

test("invalidateWiki creates a pending wiki if none exists", async () => {
  const workspaceId = ws();
  const result = await invalidateWiki(workspaceId);
  assert.equal(result.status, "pending");
  assert.ok(result.wikiId);
});
