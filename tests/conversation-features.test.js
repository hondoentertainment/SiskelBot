import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// Set up a temporary storage path for tests
const TEST_STORAGE = join(process.cwd(), "data", "_test_conv_features_" + Date.now());
process.env.STORAGE_PATH = TEST_STORAGE;

if (!existsSync(TEST_STORAGE)) mkdirSync(TEST_STORAGE, { recursive: true });

import * as storage from "../lib/storage.js";
import { exportConversation } from "../lib/conversation-export.js";
import { createShareLink, getSharedConversation, revokeShareLink, listShareLinks } from "../lib/conversation-sharing.js";
import { searchConversations } from "../lib/conversation-search.js";

const TEST_USER = "testuser";
const TEST_WORKSPACE = "default";

const testConversation = {
  id: "conv-test-001",
  title: "Test Conversation",
  createdAt: new Date().toISOString(),
  model: "test-model",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "What is the meaning of life?" },
    { role: "assistant", content: "The meaning of life is a deep philosophical question." },
  ],
};

test("setup: seed test conversation", async () => {
  await storage.add("conversations", testConversation, TEST_WORKSPACE, false, TEST_USER);
  const loaded = await storage.get("conversations", "conv-test-001", TEST_WORKSPACE, TEST_USER);
  assert.ok(loaded);
  assert.equal(loaded.title, "Test Conversation");
});

// --- Export tests ---

test("exportConversation generates markdown format", async () => {
  const result = await exportConversation("conv-test-001", "markdown", TEST_USER, TEST_WORKSPACE);
  assert.equal(result.contentType, "text/markdown; charset=utf-8");
  assert.ok(result.filename.endsWith(".md"));
  assert.ok(result.content.includes("# Conversation: Test Conversation"));
  assert.ok(result.content.includes("## User"));
  assert.ok(result.content.includes("meaning of life"));
  assert.ok(result.content.includes("## Assistant"));
});

test("exportConversation generates JSON format", async () => {
  const result = await exportConversation("conv-test-001", "json", TEST_USER, TEST_WORKSPACE);
  assert.equal(result.contentType, "application/json; charset=utf-8");
  assert.ok(result.filename.endsWith(".json"));
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.title, "Test Conversation");
  assert.ok(Array.isArray(parsed.messages));
  assert.equal(parsed.messages.length, 3);
});

test("exportConversation generates HTML format", async () => {
  const result = await exportConversation("conv-test-001", "html", TEST_USER, TEST_WORKSPACE);
  assert.ok(result.contentType.includes("text/html"));
  assert.ok(result.filename.endsWith(".html"));
  assert.ok(result.content.includes("<!DOCTYPE html>"));
  assert.ok(result.content.includes("Test Conversation"));
});

test("exportConversation throws for nonexistent conversation", async () => {
  await assert.rejects(
    () => exportConversation("nonexistent-id", "json", TEST_USER, TEST_WORKSPACE),
    { message: "Conversation not found" },
  );
});

// --- Sharing tests ---

test("createShareLink creates a share link", async () => {
  const link = await createShareLink("conv-test-001", TEST_USER, TEST_WORKSPACE);
  assert.ok(link.shareId);
  assert.ok(link.url.includes(link.shareId));
  assert.equal(link.expiresAt, null);
});

test("createShareLink with expiration sets expiresAt", async () => {
  const link = await createShareLink("conv-test-001", TEST_USER, TEST_WORKSPACE, { expiresIn: 1 });
  assert.ok(link.expiresAt);
  const expiresAt = new Date(link.expiresAt);
  assert.ok(expiresAt > new Date());
});

test("getSharedConversation retrieves a shared conversation", async () => {
  const link = await createShareLink("conv-test-001", TEST_USER, TEST_WORKSPACE);
  const result = await getSharedConversation(link.shareId);
  assert.ok(result);
  assert.equal(result.needsPassword, false);
  assert.ok(result.conversation);
  assert.equal(result.conversation.title, "Test Conversation");
});

test("getSharedConversation returns null for nonexistent share", async () => {
  const result = await getSharedConversation("nonexistent-share-id");
  assert.equal(result, null);
});

test("createShareLink with password requires password to access", async () => {
  const link = await createShareLink("conv-test-001", TEST_USER, TEST_WORKSPACE, { password: "secret123" });

  // Without password
  const result1 = await getSharedConversation(link.shareId);
  assert.ok(result1);
  assert.equal(result1.needsPassword, true);
  assert.ok(!result1.conversation);

  // With wrong password
  const result2 = await getSharedConversation(link.shareId, "wrong");
  assert.equal(result2, null);

  // With correct password
  const result3 = await getSharedConversation(link.shareId, "secret123");
  assert.ok(result3);
  assert.equal(result3.needsPassword, false);
  assert.ok(result3.conversation);
});

test("share link expiration prevents access", async () => {
  // Create a link with a very short expiration (0.0001 hours ~ 0.36 seconds)
  const link = await createShareLink("conv-test-001", TEST_USER, TEST_WORKSPACE, { expiresIn: 0.0001 });
  assert.ok(link.expiresAt);
  // Wait just long enough for it to expire
  await new Promise((r) => setTimeout(r, 500));
  const result = await getSharedConversation(link.shareId);
  assert.equal(result, null);
});

test("revokeShareLink prevents access", async () => {
  const link = await createShareLink("conv-test-001", TEST_USER, TEST_WORKSPACE);
  const revoked = await revokeShareLink(link.shareId, TEST_USER);
  assert.equal(revoked, true);
  const result = await getSharedConversation(link.shareId);
  assert.equal(result, null);
});

test("listShareLinks returns active links", async () => {
  const link = await createShareLink("conv-test-001", TEST_USER, TEST_WORKSPACE);
  const links = await listShareLinks(TEST_USER, TEST_WORKSPACE);
  assert.ok(Array.isArray(links));
  assert.ok(links.some((l) => l.shareId === link.shareId));
});

// --- Search tests ---

test("searchConversations returns matching results", async () => {
  const result = await searchConversations("meaning of life", TEST_USER, TEST_WORKSPACE);
  assert.ok(result.total > 0);
  assert.ok(result.results.length > 0);
  assert.equal(result.results[0].conversationId, "conv-test-001");
  assert.ok(result.results[0].matchSnippet);
});

test("searchConversations returns empty for no match", async () => {
  const result = await searchConversations("xyznonexistent999", TEST_USER, TEST_WORKSPACE);
  assert.equal(result.total, 0);
  assert.equal(result.results.length, 0);
});

test("searchConversations returns empty for empty query", async () => {
  const result = await searchConversations("", TEST_USER, TEST_WORKSPACE);
  assert.equal(result.total, 0);
});

test("searchConversations respects limit and offset", async () => {
  const result = await searchConversations("meaning", TEST_USER, TEST_WORKSPACE, { limit: 1, offset: 0 });
  assert.ok(result.results.length <= 1);
});

// Cleanup
test("cleanup: remove test storage", () => {
  try {
    rmSync(TEST_STORAGE, { recursive: true, force: true });
  } catch { /* ignore */ }
});
