/**
 * Phase 46: Postgres KV module (optional DATABASE_URL integration test).
 */
import test from "node:test";
import assert from "node:assert/strict";

test("postgresKvEnabled is false without STORAGE_BACKEND=postgres", async () => {
  const prevB = process.env.STORAGE_BACKEND;
  const prevU = process.env.DATABASE_URL;
  delete process.env.STORAGE_BACKEND;
  delete process.env.DATABASE_URL;
  const mod = await import(`../lib/storage-postgres-kv.js?t=${Date.now()}`);
  assert.equal(mod.postgresKvEnabled(), false);
  process.env.STORAGE_BACKEND = prevB;
  process.env.DATABASE_URL = prevU;
});

test("postgres round-trip when DATABASE_URL set", async (t) => {
  const url = process.env.STORAGE_POSTGRES_TEST_URL;
  if (!url) {
    t.skip("Set STORAGE_POSTGRES_TEST_URL to run Postgres KV integration test");
    return;
  }
  const prevB = process.env.STORAGE_BACKEND;
  const prevU = process.env.DATABASE_URL;
  process.env.STORAGE_BACKEND = "postgres";
  process.env.DATABASE_URL = url;
  const mod = await import(`../lib/storage-postgres-kv.js?t=pg-${Date.now()}`);
  const key = "/tmp/test/users/u1/workspaces/ws1/context.json";
  const payload = { _version: 1, items: [{ id: "a", title: "t" }] };
  try {
    const saved = await mod.postgresKvSave(key, payload);
    assert.equal(saved, true);
    const loaded = await mod.postgresKvLoad(key);
    assert.deepEqual(loaded, payload);
    await mod.closePostgresPool();
  } finally {
    process.env.STORAGE_BACKEND = prevB;
    process.env.DATABASE_URL = prevU;
  }
});
