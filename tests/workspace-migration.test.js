/**
 * Tests for lib/workspace-migration.js — export, import, validation, merge strategies, diff.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  exportWorkspace,
  importWorkspace,
  validateBundle,
  diffWorkspaces,
} from "../lib/workspace-migration.js";
import * as storage from "../lib/storage.js";
import { storeMemory } from "../lib/agent-memory.js";

const TEST_WS = "test-migrate-" + Date.now();
const TEST_USER = "test-user-migrate";

// Seed some test data
async function seedData() {
  await storage.add("conversations", {
    id: "conv-1",
    title: "Test conversation",
    messages: [{ role: "user", content: "hello" }],
  }, TEST_WS, false, TEST_USER);

  await storage.add("recipes", {
    id: "recipe-1",
    name: "Test recipe",
    steps: ["step1"],
  }, TEST_WS, false, TEST_USER);

  await storage.add("context", {
    id: "knowledge-1",
    title: "Test doc",
    content: "Some knowledge",
  }, TEST_WS, false, TEST_USER);

  await storeMemory(TEST_WS, TEST_USER, {
    content: "User prefers tabs",
    category: "preference",
    consent: true,
  });
}

test("exportWorkspace produces valid bundle", async () => {
  await seedData();
  const bundle = await exportWorkspace(TEST_WS, { userId: TEST_USER });
  assert.equal(bundle.version, "2.0");
  assert.ok(bundle.exportedAt);
  assert.ok(bundle.workspace);
  assert.ok(Array.isArray(bundle.conversations));
  assert.ok(Array.isArray(bundle.recipes));
  assert.ok(Array.isArray(bundle.knowledge));
  assert.ok(Array.isArray(bundle.memories));
  assert.ok(bundle.settings);
  assert.ok(bundle.conversations.length >= 1);
  assert.ok(bundle.recipes.length >= 1);
});

test("exportWorkspace selective export excludes conversations", async () => {
  const bundle = await exportWorkspace(TEST_WS, {
    userId: TEST_USER,
    includeConversations: false,
  });
  assert.equal(bundle.conversations.length, 0);
  assert.ok(bundle.recipes.length >= 1);
});

test("exportWorkspace selective export excludes knowledge", async () => {
  const bundle = await exportWorkspace(TEST_WS, {
    userId: TEST_USER,
    includeKnowledge: false,
  });
  assert.equal(bundle.knowledge.length, 0);
});

test("exportWorkspace selective export excludes memories", async () => {
  const bundle = await exportWorkspace(TEST_WS, {
    userId: TEST_USER,
    includeMemories: false,
  });
  assert.equal(bundle.memories.length, 0);
});

test("validateBundle accepts valid bundle", () => {
  const bundle = {
    version: "2.0",
    exportedAt: new Date().toISOString(),
    workspace: { id: "ws-1", name: "Test" },
    conversations: [{ id: "c1" }],
    recipes: [{ id: "r1" }],
    knowledge: [{ id: "k1" }],
    memories: [{ id: "m1" }],
    settings: { defaultSystemPrompt: "" },
  };
  const result = validateBundle(bundle);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateBundle rejects null", () => {
  const result = validateBundle(null);
  assert.equal(result.valid, false);
});

test("validateBundle reports missing fields", () => {
  const result = validateBundle({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 2);
});

test("validateBundle reports items missing ids", () => {
  const result = validateBundle({
    version: "2.0",
    exportedAt: new Date().toISOString(),
    workspace: { id: "ws" },
    conversations: [{ title: "no id" }],
    recipes: [],
    knowledge: [],
    memories: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("conversations")));
});

test("importWorkspace with overwrite strategy", async () => {
  const targetWs = "test-import-overwrite-" + Date.now();
  const bundle = await exportWorkspace(TEST_WS, { userId: TEST_USER });

  const result = await importWorkspace(bundle, TEST_USER, {
    targetWorkspaceId: targetWs,
    strategy: "overwrite",
  });
  assert.equal(result.ok, true);
  assert.ok(result.stats.conversations >= 1);
  assert.ok(result.stats.recipes >= 1);

  // Verify data was imported
  const convs = await storage.list("conversations", targetWs, TEST_USER);
  assert.ok(convs.length >= 1);
});

test("importWorkspace with merge strategy", async () => {
  const targetWs = "test-import-merge-" + Date.now();
  // Pre-seed target with one item
  await storage.add("conversations", {
    id: "existing-conv",
    title: "Existing",
  }, targetWs, false, TEST_USER);

  const bundle = await exportWorkspace(TEST_WS, { userId: TEST_USER });
  const result = await importWorkspace(bundle, TEST_USER, {
    targetWorkspaceId: targetWs,
    strategy: "merge",
  });
  assert.equal(result.ok, true);

  const convs = await storage.list("conversations", targetWs, TEST_USER);
  // Should have both existing and imported
  assert.ok(convs.length >= 2);
});

test("importWorkspace with skip strategy", async () => {
  const targetWs = "test-import-skip-" + Date.now();
  // Pre-seed with item that has same id as source
  const bundle = await exportWorkspace(TEST_WS, { userId: TEST_USER });
  const firstConvId = bundle.conversations[0]?.id;

  if (firstConvId) {
    await storage.add("conversations", {
      id: firstConvId,
      title: "Already here",
    }, targetWs, false, TEST_USER);

    const result = await importWorkspace(bundle, TEST_USER, {
      targetWorkspaceId: targetWs,
      strategy: "skip",
    });
    assert.equal(result.ok, true);

    // The existing item should still be there with original title
    const item = await storage.get("conversations", firstConvId, targetWs, TEST_USER);
    assert.equal(item.title, "Already here");
  }
});

test("importWorkspace rejects invalid bundle", async () => {
  const result = await importWorkspace({ invalid: true }, TEST_USER);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Invalid bundle"));
});

test("diffWorkspaces detects added items", () => {
  const bundleA = {
    conversations: [{ id: "c1", createdAt: "2025-01-01" }],
    recipes: [],
    knowledge: [],
    memories: [],
    webhooks: [],
    settings: {},
  };
  const bundleB = {
    conversations: [{ id: "c1", createdAt: "2025-01-01" }, { id: "c2", createdAt: "2025-01-02" }],
    recipes: [],
    knowledge: [],
    memories: [],
    webhooks: [],
    settings: {},
  };
  const { diffs } = diffWorkspaces(bundleA, bundleB);
  const convDiff = diffs.find((d) => d.collection === "conversations");
  assert.ok(convDiff);
  assert.equal(convDiff.onlyInB, 1);
  assert.ok(convDiff.details.addedIds.includes("c2"));
});

test("diffWorkspaces detects removed items", () => {
  const bundleA = {
    conversations: [{ id: "c1" }, { id: "c2" }],
    recipes: [],
    knowledge: [],
    memories: [],
    webhooks: [],
    settings: {},
  };
  const bundleB = {
    conversations: [{ id: "c1" }],
    recipes: [],
    knowledge: [],
    memories: [],
    webhooks: [],
    settings: {},
  };
  const { diffs } = diffWorkspaces(bundleA, bundleB);
  const convDiff = diffs.find((d) => d.collection === "conversations");
  assert.ok(convDiff);
  assert.equal(convDiff.onlyInA, 1);
  assert.ok(convDiff.details.removedIds.includes("c2"));
});

test("diffWorkspaces detects modified items", () => {
  const bundleA = {
    conversations: [{ id: "c1", updatedAt: "2025-01-01" }],
    recipes: [],
    knowledge: [],
    memories: [],
    webhooks: [],
    settings: {},
  };
  const bundleB = {
    conversations: [{ id: "c1", updatedAt: "2025-02-01" }],
    recipes: [],
    knowledge: [],
    memories: [],
    webhooks: [],
    settings: {},
  };
  const { diffs } = diffWorkspaces(bundleA, bundleB);
  const convDiff = diffs.find((d) => d.collection === "conversations");
  assert.ok(convDiff);
  assert.equal(convDiff.modified, 1);
});

test("diffWorkspaces detects settings changes", () => {
  const bundleA = {
    conversations: [],
    recipes: [],
    knowledge: [],
    memories: [],
    webhooks: [],
    settings: { defaultSystemPrompt: "old" },
  };
  const bundleB = {
    conversations: [],
    recipes: [],
    knowledge: [],
    memories: [],
    webhooks: [],
    settings: { defaultSystemPrompt: "new" },
  };
  const { diffs } = diffWorkspaces(bundleA, bundleB);
  assert.ok(diffs.some((d) => d.collection === "settings" && d.field === "defaultSystemPrompt"));
});

test("diffWorkspaces returns empty for identical bundles", () => {
  const bundle = {
    conversations: [{ id: "c1", createdAt: "2025-01-01" }],
    recipes: [],
    knowledge: [],
    memories: [],
    webhooks: [],
    settings: { defaultSystemPrompt: "hello" },
  };
  const { diffs } = diffWorkspaces(bundle, bundle);
  assert.equal(diffs.length, 0);
});
