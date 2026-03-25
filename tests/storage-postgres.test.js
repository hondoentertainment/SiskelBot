/**
 * Phase 68: Storage abstraction tests for migrated paths (eval sets, knowledge,
 * admin data). Verifies that the json-path-store layer correctly handles
 * read/write round-trips and that migrated modules work through the abstraction.
 *
 * Runs against the file backend by default. When STORAGE_POSTGRES_TEST_URL is set,
 * an additional integration test validates the Postgres KV path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-storage-pg-"));
process.env.STORAGE_PATH = tempDir;
// Ensure no Postgres or SQLite backend for unit tests
delete process.env.STORAGE_BACKEND;
delete process.env.DATABASE_URL;

// Dynamic import after env is configured
const { readJsonPath, writeJsonPath, withPathLock, getDataDir } = await import(
  "../lib/json-path-store.js"
);

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- json-path-store round-trip ---
test("readJsonPath / writeJsonPath round-trip (file backend)", async () => {
  const path = join(tempDir, "test-roundtrip.json");
  const payload = { _version: 1, items: [{ id: "a", title: "hello" }] };
  await writeJsonPath(path, payload);
  const loaded = await readJsonPath(path);
  assert.deepEqual(loaded, payload);
});

test("readJsonPath returns default when file missing", async () => {
  const path = join(tempDir, "nonexistent.json");
  const loaded = await readJsonPath(path, { empty: true });
  assert.deepEqual(loaded, { empty: true });
});

test("withPathLock serializes concurrent writes", async () => {
  const path = join(tempDir, "lock-test.json");
  await writeJsonPath(path, { counter: 0 });
  const increments = Array.from({ length: 10 }, (_, i) =>
    withPathLock(path, async () => {
      const data = await readJsonPath(path, { counter: 0 });
      data.counter += 1;
      await writeJsonPath(path, data);
    })
  );
  await Promise.all(increments);
  const final = await readJsonPath(path);
  assert.equal(final.counter, 10, "All 10 increments applied without race");
});

// --- storage-eval: eval sets through abstraction ---
test("storage-eval listEvalSets returns empty when no sets exist", async () => {
  const { listEvalSets } = await import(`../lib/storage-eval.js?t=${Date.now()}`);
  const sets = await listEvalSets();
  assert.ok(Array.isArray(sets));
});

test("storage-eval saveEvalSet + loadEvalSet round-trip", async () => {
  const { saveEvalSet, loadEvalSet, listEvalSets } = await import(
    `../lib/storage-eval.js?t=save-${Date.now()}`
  );
  const evalSet = {
    id: "test-set-1",
    name: "Test Eval Set",
    cases: [{ input: "hello", expected: "world" }],
  };
  const saved = await saveEvalSet(evalSet);
  assert.equal(saved.id, "test-set-1");
  assert.equal(saved.name, "Test Eval Set");
  assert.ok(saved.updatedAt);

  const loaded = await loadEvalSet("test-set-1");
  assert.ok(loaded);
  assert.equal(loaded.name, "Test Eval Set");
  assert.equal(loaded.cases.length, 1);

  const list = await listEvalSets();
  assert.ok(list.some((s) => s.id === "test-set-1"));
});

test("storage-eval removeEvalSet deletes set", async () => {
  const { saveEvalSet, removeEvalSet, loadEvalSet } = await import(
    `../lib/storage-eval.js?t=rm-${Date.now()}`
  );
  await saveEvalSet({ id: "rm-target", name: "To Remove", cases: [] });
  const removed = await removeEvalSet("rm-target");
  assert.equal(removed, true);
  const loaded = await loadEvalSet("rm-target");
  assert.equal(loaded, null);
});

test("storage-eval migrates legacy on-disk eval-sets", async () => {
  // Seed a legacy eval-sets directory
  const legacyDir = join(tempDir, "eval-sets");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(legacyDir, "legacy-set.json"),
    JSON.stringify({ id: "legacy-set", name: "Legacy Set", cases: [{ input: "a" }] })
  );

  // Clear the store file so migration triggers
  const storePath = join(tempDir, "eval-sets-store.json");
  try {
    rmSync(storePath);
  } catch (_) {}

  const { listEvalSets, loadEvalSet } = await import(
    `../lib/storage-eval.js?t=migrate-${Date.now()}`
  );
  const sets = await listEvalSets();
  assert.ok(sets.some((s) => s.id === "legacy-set"), "Legacy eval set migrated to durable store");

  const loaded = await loadEvalSet("legacy-set");
  assert.ok(loaded);
  assert.equal(loaded.name, "Legacy Set");
});

// --- knowledge-store through abstraction ---
test("knowledge-store indexDocument + search round-trip via json-path-store", async () => {
  const knowledgeDir = mkdtempSync(join(tmpdir(), "siskel-knowledge-pg-"));
  process.env.KNOWLEDGE_DATA_DIR = knowledgeDir;

  try {
    const { indexDocument, search, list, getDocumentById } = await import(
      `../lib/knowledge-store.js?t=pg-${Date.now()}`
    );

    const result = await indexDocument({
      text: "Phase 68 durable storage migration for SiskelBot.",
      workspace: "default",
      title: "Migration Doc",
      dataDir: knowledgeDir,
    });
    assert.ok(result.id, "indexDocument returns an id");

    const searchResult = await search({
      query: "durable storage",
      workspace: "default",
      dataDir: knowledgeDir,
    });
    assert.ok(searchResult.snippets.length > 0, "search finds indexed document");
    assert.equal(searchResult.snippets[0].id, result.id);

    const listResult = await list({ workspace: "default", dataDir: knowledgeDir });
    assert.ok(listResult.items.length > 0, "list returns indexed documents");

    const doc = await getDocumentById({
      id: result.id,
      workspace: "default",
      dataDir: knowledgeDir,
    });
    assert.equal(doc.title, "Migration Doc");
    assert.ok(doc.content.includes("Phase 68"));
  } finally {
    delete process.env.KNOWLEDGE_DATA_DIR;
    try {
      rmSync(knowledgeDir, { recursive: true });
    } catch (_) {}
  }
});

// --- admin-data through abstraction ---
test("admin-data getRecentAuditLog reads through json-path-store", async () => {
  // Write audit log via json-path-store
  const auditPath = join(tempDir, "execution-audit.json");
  await writeJsonPath(auditPath, [
    { action: "test-action", timestamp: "2025-01-01T00:00:00Z" },
    { action: "test-action-2", timestamp: "2025-01-02T00:00:00Z" },
  ]);

  const { getRecentAuditLog } = await import(`../lib/admin-data.js?t=audit-${Date.now()}`);
  const log = await getRecentAuditLog(10);
  assert.ok(Array.isArray(log));
  assert.equal(log.length, 2);
  // Most recent first
  assert.equal(log[0].action, "test-action-2");
});

// --- Postgres integration (skipped unless STORAGE_POSTGRES_TEST_URL set) ---
test("json-path-store round-trip with Postgres backend", async (t) => {
  const url = process.env.STORAGE_POSTGRES_TEST_URL;
  if (!url) {
    t.skip("Set STORAGE_POSTGRES_TEST_URL to run Postgres integration test");
    return;
  }
  const prevB = process.env.STORAGE_BACKEND;
  const prevU = process.env.DATABASE_URL;
  process.env.STORAGE_BACKEND = "postgres";
  process.env.DATABASE_URL = url;

  try {
    const store = await import(`../lib/json-path-store.js?t=pg-integ-${Date.now()}`);
    const key = `/tmp/test/phase68/eval-sets-store.json`;
    const payload = { _version: 1, sets: [{ id: "pg-test", name: "PG Test" }] };
    await store.writeJsonPath(key, payload);
    const loaded = await store.readJsonPath(key);
    assert.deepEqual(loaded, payload);
  } finally {
    process.env.STORAGE_BACKEND = prevB;
    process.env.DATABASE_URL = prevU;
  }
});
