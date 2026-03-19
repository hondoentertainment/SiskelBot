import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("storage-sqlite-kv (Phase 50)", () => {
  let prevBackend;
  let tmp;

  beforeEach(() => {
    prevBackend = process.env.STORAGE_BACKEND;
    tmp = mkdtempSync(join(tmpdir(), "siskel-sqlite-"));
  });

  afterEach(() => {
    process.env.STORAGE_BACKEND = prevBackend;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
  });

  it("skips when STORAGE_BACKEND is not sqlite", async () => {
    process.env.STORAGE_BACKEND = "json";
    const mod = await import("../lib/storage-sqlite-kv.js");
    assert.strictEqual(mod.sqliteKvEnabled(), false);
  });

  it("round-trips when sqlite is available", async () => {
    process.env.STORAGE_BACKEND = "sqlite";
    const mod = await import("../lib/storage-sqlite-kv.js");
    let Database;
    try {
      const { createRequire } = await import("module");
      const require = createRequire(import.meta.url);
      Database = require("better-sqlite3");
    } catch {
      console.log("skip: better-sqlite3 not installed");
      return;
    }
    assert.ok(Database);
    const key = join(tmp, "users", "u", "workspaces", "w", "context.json");
    const data = { _version: 1, items: [{ id: "a" }] };
    const saved = mod.sqliteKvSave(key, data, () => tmp);
    assert.strictEqual(saved, true);
    const loaded = mod.sqliteKvLoad(key, () => tmp);
    assert.deepStrictEqual(loaded, data);
  });
});
