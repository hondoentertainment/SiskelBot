import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
  createWorkspaceFromTemplate,
} from "../lib/workspace-templates.js";

function setupTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "ws-templates-"));
  // Create defaults dir with a sample default template
  const defaultsDir = join(dir, "workspace-templates", "defaults");
  mkdirSync(defaultsDir, { recursive: true });
  writeFileSync(
    join(defaultsDir, "coding-assistant.json"),
    JSON.stringify({
      id: "coding-assistant",
      name: "Coding Assistant",
      description: "Coding-focused template",
      defaultSystemPrompt: "You are a coding assistant.",
      memorySnippets: ["Write clean code."],
      toolAllowlist: ["knowledge_search"],
      tags: ["coding"],
    }),
    "utf8"
  );
  writeFileSync(
    join(defaultsDir, "research-analyst.json"),
    JSON.stringify({
      id: "research-analyst",
      name: "Research Analyst",
      description: "Research-focused template",
      defaultSystemPrompt: "You are a research analyst.",
      memorySnippets: [],
      toolAllowlist: ["knowledge_search"],
      tags: ["research"],
    }),
    "utf8"
  );
  writeFileSync(
    join(defaultsDir, "team-default.json"),
    JSON.stringify({
      id: "team-default",
      name: "Team Default",
      description: "General team template",
      defaultSystemPrompt: "You are a team assistant.",
      memorySnippets: [],
      toolAllowlist: [],
      tags: ["team"],
    }),
    "utf8"
  );
  return dir;
}

test("createTemplate creates a custom template", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const t = await createTemplate({
      name: "My Template",
      description: "A custom template",
      defaultSystemPrompt: "Be helpful.",
      memorySnippets: ["Remember this."],
      toolAllowlist: ["web_search"],
      tags: ["custom"],
    });
    assert.ok(t.id, "template must have an id");
    assert.equal(t.name, "My Template");
    assert.equal(t.description, "A custom template");
    assert.equal(t.defaultSystemPrompt, "Be helpful.");
    assert.deepEqual(t.memorySnippets, ["Remember this."]);
    assert.deepEqual(t.toolAllowlist, ["web_search"]);
    assert.deepEqual(t.tags, ["custom"]);
    assert.equal(t.isDefault, false);
    assert.ok(t.createdAt);
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTemplate requires a name", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    await assert.rejects(() => createTemplate({}), { message: "Template name is required" });
    await assert.rejects(() => createTemplate({ name: "  " }), { message: "Template name is required" });
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTemplates returns defaults and custom templates", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    await createTemplate({ name: "Custom One", tags: ["custom"] });
    const all = await listTemplates();
    assert.ok(all.length >= 4, "should have 3 defaults + 1 custom");
    const defaultNames = all.filter((t) => t.isDefault).map((t) => t.name);
    assert.ok(defaultNames.includes("Coding Assistant"));
    assert.ok(defaultNames.includes("Research Analyst"));
    assert.ok(defaultNames.includes("Team Default"));
    const custom = all.find((t) => t.name === "Custom One");
    assert.ok(custom);
    assert.equal(custom.isDefault, false);
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getTemplate retrieves a default template", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const t = await getTemplate("coding-assistant");
    assert.ok(t);
    assert.equal(t.name, "Coding Assistant");
    assert.equal(t.isDefault, true);
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getTemplate retrieves a custom template", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const created = await createTemplate({ name: "Findme" });
    const found = await getTemplate(created.id);
    assert.ok(found);
    assert.equal(found.name, "Findme");
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getTemplate returns null for unknown id", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const t = await getTemplate("nonexistent-id");
    assert.equal(t, null);
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTemplate updates a custom template", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const created = await createTemplate({ name: "Updatable", description: "v1" });
    const updated = await updateTemplate(created.id, { description: "v2", tags: ["updated"] });
    assert.ok(updated);
    assert.equal(updated.description, "v2");
    assert.deepEqual(updated.tags, ["updated"]);
    assert.equal(updated.name, "Updatable"); // name preserved
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTemplate returns null for unknown id", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const result = await updateTemplate("no-such-id", { name: "X" });
    assert.equal(result, null);
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteTemplate removes a custom template", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const created = await createTemplate({ name: "Deletable" });
    const deleted = await deleteTemplate(created.id);
    assert.equal(deleted, true);
    const found = await getTemplate(created.id);
    assert.equal(found, null);
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteTemplate returns false for unknown id", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const result = await deleteTemplate("no-such-id");
    assert.equal(result, false);
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyTemplate applies settings to a workspace", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const result = await applyTemplate("coding-assistant", "test-ws", "testuser");
    assert.equal(result.template, "coding-assistant");
    assert.equal(result.workspace, "test-ws");
    assert.ok(result.appliedSettings);
    assert.equal(result.appliedSettings.defaultSystemPrompt, "You are a coding assistant.");
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyTemplate throws for unknown template", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    await assert.rejects(() => applyTemplate("nonexistent", "ws", "user"), {
      message: "Template not found",
    });
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWorkspaceFromTemplate creates workspace with template settings", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    const ws = await createWorkspaceFromTemplate("coding-assistant", "My Coding WS", "testuser2");
    assert.ok(ws.id, "workspace must have an id");
    assert.equal(ws.name, "My Coding WS");
    assert.equal(ws.templateId, "coding-assistant");
    assert.equal(ws.templateName, "Coding Assistant");
    assert.ok(ws.appliedSettings);
    assert.equal(ws.appliedSettings.defaultSystemPrompt, "You are a coding assistant.");
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWorkspaceFromTemplate throws for unknown template", async () => {
  const dir = setupTmpDir();
  const prev = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = dir;
  try {
    await assert.rejects(() => createWorkspaceFromTemplate("nonexistent", "WS", "user"), {
      message: "Template not found",
    });
  } finally {
    process.env.STORAGE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
