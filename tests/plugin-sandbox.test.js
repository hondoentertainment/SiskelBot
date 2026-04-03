/**
 * Phase 17.1: Plugin Sandbox Tests
 * Tests loading, executing, timeout enforcement, and error handling for JS plugins.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { writeFileSync, mkdirSync, unlinkSync, rmSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Dynamic import to get a fresh module each time (avoid cache across test files)
async function getSandbox() {
  const url = new URL(`../lib/plugin-sandbox.js?t=${Date.now()}${Math.random()}`, import.meta.url);
  return import(url.href);
}

const HELLO_PLUGIN = resolve(ROOT, "plugins/examples/hello-world.plugin.js");
const WORD_COUNT_PLUGIN = resolve(ROOT, "plugins/examples/word-count.plugin.js");

// Temp directory for test plugins
const TMP_DIR = resolve(ROOT, "tests/.tmp-plugins");

function setupTmpDir() {
  mkdirSync(TMP_DIR, { recursive: true });
}

function cleanTmpDir() {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (_) {
    // ignore
  }
}

// -- Loading tests --

test("loadPlugin: loads a valid plugin and returns metadata", async () => {
  const { loadPlugin, unloadPlugin } = await getSandbox();
  const meta = await loadPlugin(HELLO_PLUGIN);
  assert.equal(meta.id, "hello-world");
  assert.equal(meta.name, "hello-world");
  assert.equal(meta.version, "1.0.0");
  assert.ok(meta.description.length > 0);
  unloadPlugin(meta.id);
});

test("loadPlugin: throws for non-existent file", async () => {
  const { loadPlugin } = await getSandbox();
  await assert.rejects(
    () => loadPlugin("/nonexistent/path/plugin.js"),
    (err) => {
      assert.ok(err.message.includes("not found"));
      return true;
    }
  );
});

test("loadPlugin: throws for plugin missing name export", async () => {
  setupTmpDir();
  const badPlugin = resolve(TMP_DIR, "no-name.plugin.js");
  writeFileSync(
    badPlugin,
    `export const version = "1.0.0";\nexport async function execute() { return { output: "hi" }; }\n`
  );
  const { loadPlugin } = await getSandbox();
  await assert.rejects(
    () => loadPlugin(badPlugin),
    (err) => {
      assert.ok(err.message.includes("name"));
      return true;
    }
  );
  cleanTmpDir();
});

test("loadPlugin: throws for plugin missing execute export", async () => {
  setupTmpDir();
  const badPlugin = resolve(TMP_DIR, "no-execute.plugin.js");
  writeFileSync(
    badPlugin,
    `export const name = "bad";\nexport const version = "1.0.0";\n`
  );
  const { loadPlugin } = await getSandbox();
  await assert.rejects(
    () => loadPlugin(badPlugin),
    (err) => {
      assert.ok(err.message.includes("execute"));
      return true;
    }
  );
  cleanTmpDir();
});

// -- Execution tests --

test("executePlugin: hello-world plugin returns greeting with input", async () => {
  const { loadPlugin, executePlugin, unloadPlugin } = await getSandbox();
  await loadPlugin(HELLO_PLUGIN);
  const result = await executePlugin("hello-world", { input: "Alice" });
  assert.equal(result.output, "Hello, Alice!");
  assert.deepStrictEqual(result.metadata, { greeted: "Alice" });
  unloadPlugin("hello-world");
});

test("executePlugin: hello-world plugin defaults to World", async () => {
  const { loadPlugin, executePlugin, unloadPlugin } = await getSandbox();
  await loadPlugin(HELLO_PLUGIN);
  const result = await executePlugin("hello-world", { input: "" });
  assert.equal(result.output, "Hello, World!");
  unloadPlugin("hello-world");
});

test("executePlugin: word-count plugin counts correctly", async () => {
  const { loadPlugin, executePlugin, unloadPlugin } = await getSandbox();
  await loadPlugin(WORD_COUNT_PLUGIN);
  const result = await executePlugin("word-count", { input: "one two three" });
  assert.equal(result.output, "Words: 3, Characters: 13, Lines: 1");
  assert.deepStrictEqual(result.metadata, { words: 3, characters: 13, lines: 1 });
  unloadPlugin("word-count");
});

test("executePlugin: throws for unloaded plugin", async () => {
  const { executePlugin } = await getSandbox();
  await assert.rejects(
    () => executePlugin("nonexistent-plugin", { input: "test" }),
    (err) => {
      assert.ok(err.message.includes("not loaded"));
      return true;
    }
  );
});

// -- Timeout test --

test("executePlugin: enforces timeout on slow plugins", async () => {
  setupTmpDir();
  const slowPlugin = resolve(TMP_DIR, "slow.plugin.js");
  writeFileSync(
    slowPlugin,
    [
      'export const name = "slow";',
      'export const version = "1.0.0";',
      'export const description = "Deliberately slow plugin";',
      "export async function execute() {",
      "  await new Promise(r => setTimeout(r, 120000));",
      '  return { output: "done" };',
      "}",
    ].join("\n")
  );

  // Set a short timeout for testing
  const origTimeout = process.env.PLUGIN_TIMEOUT_MS;
  process.env.PLUGIN_TIMEOUT_MS = "1500";

  try {
    const { loadPlugin, executePlugin, unloadPlugin } = await getSandbox();
    await loadPlugin(slowPlugin);
    await assert.rejects(
      () => executePlugin("slow", { input: "" }),
      (err) => {
        assert.ok(err.message.includes("timed out") || err.message.includes("exited"));
        return true;
      }
    );
    unloadPlugin("slow");
  } finally {
    if (origTimeout === undefined) delete process.env.PLUGIN_TIMEOUT_MS;
    else process.env.PLUGIN_TIMEOUT_MS = origTimeout;
    cleanTmpDir();
  }
});

// -- List and unload tests --

test("listPlugins: returns loaded plugins", async () => {
  const { loadPlugin, listPlugins, unloadPlugin } = await getSandbox();
  await loadPlugin(HELLO_PLUGIN);
  await loadPlugin(WORD_COUNT_PLUGIN);
  const list = listPlugins();
  assert.ok(list.length >= 2);
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes("hello-world"));
  assert.ok(ids.includes("word-count"));
  unloadPlugin("hello-world");
  unloadPlugin("word-count");
});

test("unloadPlugin: removes a plugin", async () => {
  const { loadPlugin, listPlugins, unloadPlugin } = await getSandbox();
  await loadPlugin(HELLO_PLUGIN);
  assert.ok(listPlugins().some((p) => p.id === "hello-world"));
  const removed = unloadPlugin("hello-world");
  assert.equal(removed, true);
  assert.ok(!listPlugins().some((p) => p.id === "hello-world"));
});

test("unloadPlugin: returns false for unknown plugin", async () => {
  const { unloadPlugin } = await getSandbox();
  assert.equal(unloadPlugin("nonexistent"), false);
});

// -- Error handling: plugin that throws --

test("executePlugin: handles plugin that throws an error", async () => {
  setupTmpDir();
  const errPlugin = resolve(TMP_DIR, "throws.plugin.js");
  writeFileSync(
    errPlugin,
    [
      'export const name = "throws";',
      'export const version = "1.0.0";',
      "export async function execute() {",
      '  throw new Error("Intentional failure");',
      "}",
    ].join("\n")
  );

  const { loadPlugin, executePlugin, unloadPlugin } = await getSandbox();
  await loadPlugin(errPlugin);
  await assert.rejects(
    () => executePlugin("throws", { input: "" }),
    (err) => {
      assert.ok(err.message.includes("Intentional failure"));
      return true;
    }
  );
  unloadPlugin("throws");
  cleanTmpDir();
});

// -- Error handling: plugin returns invalid shape --

test("executePlugin: rejects plugin that returns invalid output", async () => {
  setupTmpDir();
  const badRetPlugin = resolve(TMP_DIR, "bad-return.plugin.js");
  writeFileSync(
    badRetPlugin,
    [
      'export const name = "bad-return";',
      'export const version = "1.0.0";',
      "export async function execute() {",
      "  return { notOutput: 42 };",
      "}",
    ].join("\n")
  );

  const { loadPlugin, executePlugin, unloadPlugin } = await getSandbox();
  await loadPlugin(badRetPlugin);
  await assert.rejects(
    () => executePlugin("bad-return", { input: "" }),
    (err) => {
      assert.ok(err.message.includes("output"));
      return true;
    }
  );
  unloadPlugin("bad-return");
  cleanTmpDir();
});
