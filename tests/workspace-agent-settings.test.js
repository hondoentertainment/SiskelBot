import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  normalizeWorkspaceAgentSettings,
  buildWorkspaceAgentAugmentation,
  augmentMessagesWithWorkspaceAgent,
  saveWorkspaceAgentSettings,
  canEditWorkspaceAgentSettings,
} from "../lib/workspace-agent-settings.js";

test("normalizeWorkspaceAgentSettings trims and filters snippets", () => {
  const n = normalizeWorkspaceAgentSettings({
    defaultSystemPrompt: "  hi  ",
    memorySnippets: ["", "  x  ", 99, "y"],
  });
  assert.equal(n.defaultSystemPrompt, "hi");
  assert.deepEqual(n.memorySnippets, ["x", "y"]);
});

test("buildWorkspaceAgentAugmentation includes approved memory heading", () => {
  const text = buildWorkspaceAgentAugmentation({
    defaultSystemPrompt: "P",
    memorySnippets: ["one", "two"],
  });
  assert.ok(text.startsWith("P"));
  assert.ok(text.includes("Approved workspace memory"));
  assert.ok(text.includes("- one"));
  assert.ok(text.includes("- two"));
});

test("canEditWorkspaceAgentSettings allows admin and member only", () => {
  assert.equal(canEditWorkspaceAgentSettings("admin"), true);
  assert.equal(canEditWorkspaceAgentSettings("member"), true);
  assert.equal(canEditWorkspaceAgentSettings("viewer"), false);
});

test("augmentMessagesWithWorkspaceAgent merges into first system message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-agent-"));
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    await saveWorkspaceAgentSettings("anonymous", "ws-augment", {
      defaultSystemPrompt: "Extra",
      memorySnippets: ["mem"],
    });
    const out = await augmentMessagesWithWorkspaceAgent(
      [{ role: "system", content: "Core" }],
      "anonymous",
      "ws-augment"
    );
    assert.equal(out[0].role, "system");
    assert.ok(out[0].content.includes("Core"));
    assert.ok(out[0].content.includes("Extra"));
    assert.ok(out[0].content.includes("- mem"));
  } finally {
    if (prev === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
