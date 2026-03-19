import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const defaultsPath = join(__dirname, "../client/templates.defaults.json");

test("default templates structure", () => {
  const raw = readFileSync(defaultsPath, "utf8");
  const data = JSON.parse(raw);

  assert.ok(Array.isArray(data.templates), "templates must be an array");
  assert.ok(data.templates.length >= 5, "must have at least 5 default templates (Coding, Deployment, Research, Content, Ops)");

  const ids = ["coding", "deployment", "research", "content", "ops"];
  for (const id of ids) {
    const t = data.templates.find((x) => x.id === id);
    assert.ok(t, `template "${id}" must exist`);
    assert.ok(typeof t.name === "string" && t.name.length > 0, `template "${id}" must have name`);
    assert.ok(typeof t.systemPrompt === "string", `template "${id}" must have systemPrompt`);
  }

  for (const t of data.templates) {
    assert.ok(t.id && typeof t.id === "string", "every template must have id");
    assert.ok(t.name && typeof t.name === "string", "every template must have name");
    assert.ok(typeof t.systemPrompt === "string", "every template must have systemPrompt");
  }
});

test("default profiles structure", () => {
  const raw = readFileSync(defaultsPath, "utf8");
  const data = JSON.parse(raw);

  assert.ok(Array.isArray(data.profiles), "profiles must be an array");
  assert.ok(data.profiles.length >= 3, "must have at least 3 default profiles (Coding, Quick ops, Detailed research)");

  const names = ["Coding", "Quick ops", "Detailed research"];
  for (const name of names) {
    const p = data.profiles.find((x) => x.name === name);
    assert.ok(p, `profile "${name}" must exist`);
    assert.ok(typeof p.id === "string" && p.id.length > 0, `profile "${name}" must have id`);
    assert.ok(typeof p.templateId === "string", `profile "${name}" must have templateId`);
    assert.ok(typeof p.systemPrompt === "string", `profile "${name}" must have systemPrompt`);
  }

  for (const p of data.profiles) {
    assert.ok(p.id && typeof p.id === "string", "every profile must have id");
    assert.ok(p.name && typeof p.name === "string", "every profile must have name");
    assert.ok(typeof p.templateId === "string", "every profile must have templateId");
  }
});
