/**
 * Tests for lib/agent-profiles.js — built-in profiles, workspace CRUD, validation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getBuiltInProfiles,
  listProfiles,
  getProfile,
  upsertProfile,
  deleteProfile,
} from "../lib/agent-profiles.js";

const TEST_WS = "test-profiles-" + Date.now();

// ── Built-in profiles ───────────────────────────────────────────────────────

test("getBuiltInProfiles returns 5 built-in profiles", () => {
  const builtIns = getBuiltInProfiles();
  assert.equal(builtIns.length, 5);
  const ids = builtIns.map((p) => p.id).sort();
  assert.deepEqual(ids, ["code_writer", "executor", "researcher", "reviewer", "synthesizer"]);
  for (const p of builtIns) {
    assert.equal(p.builtIn, true);
    assert.ok(p.systemPrompt.length > 0);
    assert.ok(p.createdAt);
    assert.ok(p.updatedAt);
  }
});

// ── listProfiles ────────────────────────────────────────────────────────────

test("listProfiles returns 5 built-ins for a fresh workspace", async () => {
  const profiles = await listProfiles(TEST_WS);
  assert.equal(profiles.length, 5);
  const ids = profiles.map((p) => p.id).sort();
  assert.deepEqual(ids, ["code_writer", "executor", "researcher", "reviewer", "synthesizer"]);
});

// ── upsertProfile ───────────────────────────────────────────────────────────

test("upsert a custom profile and list returns 6", async () => {
  const saved = await upsertProfile(TEST_WS, {
    id: "my-custom-agent",
    name: "My Custom Agent",
    systemPrompt: "You are a custom agent.",
    toolAllowlist: ["search_context"],
    budgets: { maxIterations: 10 },
  });
  assert.equal(saved.id, "my-custom-agent");
  assert.equal(saved.name, "My Custom Agent");
  assert.equal(saved.builtIn, false);
  assert.ok(saved.createdAt);
  assert.ok(saved.updatedAt);

  const all = await listProfiles(TEST_WS);
  assert.equal(all.length, 6);
  assert.ok(all.find((p) => p.id === "my-custom-agent"));
});

test("upsert with same id as built-in overrides it", async () => {
  const overridden = await upsertProfile(TEST_WS, {
    id: "researcher",
    systemPrompt: "You are a custom researcher with extra powers.",
    toolAllowlist: ["search_context", "web_search"],
    budgets: { maxIterations: 50 },
  });
  assert.equal(overridden.id, "researcher");
  assert.equal(overridden.builtIn, true); // still marked as built-in id
  assert.ok(overridden.systemPrompt.includes("custom researcher"));

  const profile = await getProfile(TEST_WS, "researcher");
  assert.ok(profile.systemPrompt.includes("custom researcher"));
});

test("delete workspace override of built-in restores default", async () => {
  // The override was created in the previous test
  const deleted = await deleteProfile(TEST_WS, "researcher");
  assert.equal(deleted, true);

  const profile = await getProfile(TEST_WS, "researcher");
  assert.ok(profile);
  // Should be the original built-in again
  assert.ok(profile.systemPrompt.includes("research agent"));
  assert.equal(profile.builtIn, true);
});

// ── Validation ──────────────────────────────────────────────────────────────

test("validate: missing systemPrompt throws error", async () => {
  await assert.rejects(
    () => upsertProfile(TEST_WS, { id: "valid-id" }),
    (err) => {
      assert.equal(err.code, "VALIDATION_ERROR");
      assert.ok(err.message.includes("systemPrompt"));
      return true;
    }
  );
});

test("validate: invalid id format throws error", async () => {
  await assert.rejects(
    () =>
      upsertProfile(TEST_WS, {
        id: "INVALID ID!",
        systemPrompt: "Some prompt",
      }),
    (err) => {
      assert.equal(err.code, "VALIDATION_ERROR");
      assert.ok(err.message.includes("id"));
      return true;
    }
  );
});

test("validate: single char id throws error", async () => {
  await assert.rejects(
    () =>
      upsertProfile(TEST_WS, {
        id: "x",
        systemPrompt: "Some prompt",
      }),
    (err) => {
      assert.equal(err.code, "VALIDATION_ERROR");
      return true;
    }
  );
});

test("validate: empty systemPrompt throws error", async () => {
  await assert.rejects(
    () =>
      upsertProfile(TEST_WS, {
        id: "valid-id",
        systemPrompt: "   ",
      }),
    (err) => {
      assert.equal(err.code, "VALIDATION_ERROR");
      assert.ok(err.message.includes("systemPrompt"));
      return true;
    }
  );
});

test("validate: bad budgets field throws error", async () => {
  await assert.rejects(
    () =>
      upsertProfile(TEST_WS, {
        id: "valid-id",
        systemPrompt: "OK prompt",
        budgets: { maxIterations: -5 },
      }),
    (err) => {
      assert.equal(err.code, "VALIDATION_ERROR");
      assert.ok(err.message.includes("maxIterations"));
      return true;
    }
  );
});

// ── getProfile ──────────────────────────────────────────────────────────────

test("getProfile returns built-in by id", async () => {
  const profile = await getProfile(TEST_WS, "executor");
  assert.ok(profile);
  assert.equal(profile.id, "executor");
  assert.equal(profile.builtIn, true);
  assert.ok(profile.systemPrompt.includes("execution agent"));
});

test("getProfile returns custom profile by id", async () => {
  const profile = await getProfile(TEST_WS, "my-custom-agent");
  assert.ok(profile);
  assert.equal(profile.id, "my-custom-agent");
  assert.equal(profile.builtIn, false);
});

test("getProfile returns null for unknown id", async () => {
  const profile = await getProfile(TEST_WS, "does-not-exist");
  assert.equal(profile, null);
});

// ── deleteProfile ───────────────────────────────────────────────────────────

test("delete custom profile returns true", async () => {
  await upsertProfile(TEST_WS, {
    id: "temp-agent",
    systemPrompt: "Temporary agent.",
  });
  const deleted = await deleteProfile(TEST_WS, "temp-agent");
  assert.equal(deleted, true);

  const profile = await getProfile(TEST_WS, "temp-agent");
  assert.equal(profile, null);
});

test("delete non-existent profile returns false", async () => {
  const deleted = await deleteProfile(TEST_WS, "no-such-profile");
  assert.equal(deleted, false);
});

test("delete built-in without workspace override throws error", async () => {
  // Use a fresh workspace where no overrides exist
  const freshWs = "fresh-delete-test-" + Date.now();
  await assert.rejects(
    () => deleteProfile(freshWs, "executor"),
    (err) => {
      assert.equal(err.code, "BUILTIN_DELETE");
      return true;
    }
  );
});

// ── Profile schema shape ────────────────────────────────────────────────────

test("upserted profile has complete schema shape", async () => {
  const saved = await upsertProfile(TEST_WS, {
    id: "shape-test",
    name: "Shape Test",
    systemPrompt: "Testing shape.",
    model: "gpt-4",
    toolAllowlist: ["search_context"],
    toolDenylist: ["code_execute"],
    budgets: {
      maxIterations: 10,
      maxCostUsd: 1.5,
      maxWallTimeMs: 60000,
      maxToolCalls: 50,
    },
  });

  assert.equal(saved.id, "shape-test");
  assert.equal(saved.name, "Shape Test");
  assert.equal(saved.systemPrompt, "Testing shape.");
  assert.equal(saved.model, "gpt-4");
  assert.deepEqual(saved.toolAllowlist, ["search_context"]);
  assert.deepEqual(saved.toolDenylist, ["code_execute"]);
  assert.equal(saved.budgets.maxIterations, 10);
  assert.equal(saved.budgets.maxCostUsd, 1.5);
  assert.equal(saved.budgets.maxWallTimeMs, 60000);
  assert.equal(saved.budgets.maxToolCalls, 50);
  assert.equal(saved.builtIn, false);
  assert.ok(saved.createdAt);
  assert.ok(saved.updatedAt);
});

test("upsert defaults missing optional fields to null", async () => {
  const saved = await upsertProfile(TEST_WS, {
    id: "minimal-profile",
    systemPrompt: "Minimal.",
  });
  assert.equal(saved.model, null);
  assert.equal(saved.toolAllowlist, null);
  assert.equal(saved.toolDenylist, null);
  assert.equal(saved.budgets.maxIterations, null);
  assert.equal(saved.budgets.maxCostUsd, null);
  assert.equal(saved.budgets.maxWallTimeMs, null);
  assert.equal(saved.budgets.maxToolCalls, null);
});

// ── Workspace isolation ─────────────────────────────────────────────────────

test("profiles are isolated between workspaces", async () => {
  const ws1 = "isolation-ws1-" + Date.now();
  const ws2 = "isolation-ws2-" + Date.now();

  await upsertProfile(ws1, {
    id: "ws1-only",
    systemPrompt: "Only in ws1.",
  });

  const ws1Profiles = await listProfiles(ws1);
  const ws2Profiles = await listProfiles(ws2);

  assert.ok(ws1Profiles.find((p) => p.id === "ws1-only"));
  assert.ok(!ws2Profiles.find((p) => p.id === "ws1-only"));
});
