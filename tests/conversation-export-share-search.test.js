import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
// import { createServer } from "http";
// import express from "express";

// Set test storage path before importing modules
const TEST_DIR = `/tmp/siskelbot-test-export-${Date.now()}`;
process.env.STORAGE_PATH = TEST_DIR;
process.env.STORAGE_BACKEND = "json";

import * as storage from "../lib/storage.js";
import { exportConversation } from "../lib/conversation-export.js";
import { createShareLink, getSharedConversation, revokeShareLink, listShareLinks } from "../lib/conversation-sharing.js";
import { searchConversations } from "../lib/conversation-search.js";

const userId = "testuser";
const workspace = "default";

let convId;

before(async () => {
  const conv = {
    id: "test-conv-1",
    title: "Test Conversation",
    messages: [
      { role: "user", content: "Hello, how are you?" },
      { role: "assistant", content: "I am doing well, thank you for asking!" },
      { role: "user", content: "Tell me about JavaScript closures" },
      { role: "assistant", content: "A closure is a function that has access to variables in its outer scope." },
    ],
    meta: { model: "gpt-4" },
    createdAt: new Date().toISOString(),
  };
  await storage.add("conversations", conv, workspace, false, userId);
  convId = conv.id;

  const conv2 = {
    id: "test-conv-2",
    title: "Python Discussion",
    messages: [
      { role: "user", content: "What is Python used for?" },
      { role: "assistant", content: "Python is used for web development, data science, machine learning, and scripting." },
    ],
    meta: { model: "gpt-4" },
    createdAt: new Date("2025-01-15").toISOString(),
  };
  await storage.add("conversations", conv2, workspace, false, userId);
});

after(async () => {
  const { rmSync } = await import("fs");
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- Export tests ---

describe("conversation export", () => {
  it("exports as markdown", async () => {
    const result = await exportConversation(convId, "markdown", userId, workspace);
    assert.ok(result.content.includes("# Conversation: Test Conversation"));
    assert.ok(result.content.includes("## User"));
    assert.ok(result.content.includes("## Assistant"));
    assert.ok(result.content.includes("Hello, how are you?"));
    assert.ok(result.content.includes("Exported from SiskelBot"));
    assert.equal(result.contentType, "text/markdown; charset=utf-8");
    assert.ok(result.filename.endsWith(".md"));
  });

  it("exports as json", async () => {
    const result = await exportConversation(convId, "json", userId, workspace);
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.id, convId);
    assert.equal(parsed.messages.length, 4);
    assert.equal(result.contentType, "application/json; charset=utf-8");
    assert.ok(result.filename.endsWith(".json"));
  });

  it("exports as html", async () => {
    const result = await exportConversation(convId, "html", userId, workspace);
    assert.ok(result.content.includes("<!DOCTYPE html>"));
    assert.ok(result.content.includes("Test Conversation"));
    assert.ok(result.content.includes("Hello, how are you?"));
    assert.ok(result.content.includes("Exported from SiskelBot"));
    assert.equal(result.contentType, "text/html; charset=utf-8");
    assert.ok(result.filename.endsWith(".html"));
  });

  it("throws for unknown conversation", async () => {
    await assert.rejects(
      () => exportConversation("nonexistent", "json", userId, workspace),
      { message: "Conversation not found" }
    );
  });

  it("throws for unsupported format", async () => {
    await assert.rejects(
      () => exportConversation(convId, "pdf", userId, workspace),
      { message: /Unsupported export format/ }
    );
  });
});

// --- Sharing tests ---

describe("conversation sharing", () => {
  let shareId;

  it("creates a share link", async () => {
    const result = await createShareLink(convId, userId, workspace, {});
    assert.ok(result.shareId);
    assert.ok(result.url.includes(result.shareId));
    assert.equal(result.expiresAt, null);
    shareId = result.shareId;
  });

  it("retrieves shared conversation", async () => {
    const result = await getSharedConversation(shareId);
    assert.ok(result);
    assert.equal(result.needsPassword, false);
    assert.equal(result.conversation.id, convId);
    assert.equal(result.conversation.title, "Test Conversation");
  });

  it("lists share links", async () => {
    const links = await listShareLinks(userId, workspace);
    assert.ok(links.length >= 1);
    assert.ok(links.some((l) => l.shareId === shareId));
  });

  it("revokes a share link", async () => {
    const revoked = await revokeShareLink(shareId, userId);
    assert.equal(revoked, true);
    const result = await getSharedConversation(shareId);
    assert.equal(result, null);
  });

  it("creates a password-protected share", async () => {
    const result = await createShareLink(convId, userId, workspace, { password: "secret123" });
    const withoutPw = await getSharedConversation(result.shareId);
    assert.ok(withoutPw.needsPassword);

    const wrongPw = await getSharedConversation(result.shareId, "wrong");
    assert.equal(wrongPw, null);

    const correctPw = await getSharedConversation(result.shareId, "secret123");
    assert.ok(correctPw);
    assert.equal(correctPw.needsPassword, false);
    assert.equal(correctPw.conversation.id, convId);
  });

  it("creates an expiring share link", async () => {
    const result = await createShareLink(convId, userId, workspace, { expiresIn: 24 });
    assert.ok(result.expiresAt);
    const expires = new Date(result.expiresAt);
    const now = new Date();
    assert.ok(expires > now);
  });

  it("returns false when revoking non-existent share", async () => {
    const revoked = await revokeShareLink("nonexistent", userId);
    assert.equal(revoked, false);
  });
});

// --- Search tests ---

describe("conversation search", () => {
  it("finds conversations by message content", async () => {
    const result = await searchConversations("closures", userId, workspace);
    assert.ok(result.total >= 1);
    assert.ok(result.results.some((r) => r.conversationId === convId));
  });

  it("finds conversations by title content", async () => {
    const result = await searchConversations("Python Discussion", userId, workspace);
    assert.ok(result.total >= 1);
    assert.ok(result.results.some((r) => r.conversationId === "test-conv-2"));
  });

  it("returns snippets with context", async () => {
    const result = await searchConversations("JavaScript", userId, workspace);
    assert.ok(result.total >= 1);
    const match = result.results.find((r) => r.conversationId === convId);
    assert.ok(match);
    assert.ok(match.matchSnippet);
  });

  it("respects limit and offset", async () => {
    const result = await searchConversations("how", userId, workspace, { limit: 1 });
    assert.ok(result.results.length <= 1);
  });

  it("filters by date range", async () => {
    const result = await searchConversations("Python", userId, workspace, {
      dateFrom: "2025-01-01",
      dateTo: "2025-02-01",
    });
    assert.ok(result.total >= 1);
    assert.ok(result.results.some((r) => r.conversationId === "test-conv-2"));
  });

  it("returns empty for no matches", async () => {
    const result = await searchConversations("xyznonexistent123", userId, workspace);
    assert.equal(result.total, 0);
    assert.equal(result.results.length, 0);
  });

  it("returns empty for empty query", async () => {
    const result = await searchConversations("", userId, workspace);
    assert.equal(result.total, 0);
  });
});
