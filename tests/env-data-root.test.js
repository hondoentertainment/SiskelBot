import test from "node:test";
import assert from "node:assert/strict";

test("hasDurableStorage is false on Vercel without STORAGE_PATH or postgres", async () => {
  const prev = { ...process.env };
  process.env.VERCEL = "1";
  delete process.env.STORAGE_PATH;
  delete process.env.STORAGE_BACKEND;
  delete process.env.DATABASE_URL;
  const mod = await import(`../lib/env-data-root.js?t=${Date.now()}`);
  assert.equal(mod.hasDurableStorage(), false);
  process.env = prev;
});

test("hasDurableStorage is true with STORAGE_PATH on Vercel", async () => {
  const prev = { ...process.env };
  process.env.VERCEL = "1";
  process.env.STORAGE_PATH = "/data";
  const mod = await import(`../lib/env-data-root.js?t=${Date.now()}-sp`);
  assert.equal(mod.hasDurableStorage(), true);
  process.env = prev;
});

test("hasDurableStorage is true locally without explicit config", async () => {
  const prev = { ...process.env };
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.STORAGE_PATH;
  delete process.env.STORAGE_BACKEND;
  const mod = await import(`../lib/env-data-root.js?t=${Date.now()}-local`);
  assert.equal(mod.hasDurableStorage(), true);
  process.env = prev;
});
