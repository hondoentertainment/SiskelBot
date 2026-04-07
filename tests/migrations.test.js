import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { discoverMigrations, runMigrations, getMigrationStatus, rollbackMigration } from "../lib/migrations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// -- Discovery tests (no database needed) --

test("migrations: discoverMigrations finds migration files in order", async () => {
  const migrationsDir = join(__dirname, "..", "migrations");
  const migrations = await discoverMigrations(migrationsDir);
  assert.ok(Array.isArray(migrations), "should return an array");
  assert.ok(migrations.length >= 6, `expected at least 6 migrations, got ${migrations.length}`);

  // Verify ordering
  assert.equal(migrations[0].id, "001_init_storage_kv");
  assert.equal(migrations[1].id, "002_add_api_keys");
  assert.equal(migrations[2].id, "003_add_audit_log");
  assert.equal(migrations[3].id, "004_add_agent_sessions");
  assert.equal(migrations[4].id, "005_add_workflows");
  assert.equal(migrations[5].id, "006_add_agent_memory");
});

test("migrations: each migration has required exports", async () => {
  const migrationsDir = join(__dirname, "..", "migrations");
  const migrations = await discoverMigrations(migrationsDir);

  for (const m of migrations) {
    assert.ok(typeof m.id === "string" && m.id.length > 0, `${m.filename}: id should be a non-empty string`);
    assert.ok(typeof m.up === "function", `${m.filename}: up should be a function`);
    assert.ok(typeof m.description === "string", `${m.filename}: description should be a string`);
    // down is optional but all ours have it
    assert.ok(typeof m.down === "function", `${m.filename}: down should be a function`);
  }
});

test("migrations: discoverMigrations returns empty for nonexistent dir", async () => {
  const migrations = await discoverMigrations("/tmp/nonexistent-migrations-dir-xyz");
  assert.ok(Array.isArray(migrations));
  assert.equal(migrations.length, 0);
});

test("migrations: discoverMigrations skips non-migration files", async () => {
  const tmpDir = join(__dirname, ".tmp-migrations-test-" + Date.now());
  mkdirSync(tmpDir, { recursive: true });

  // Create a valid migration
  writeFileSync(
    join(tmpDir, "001_test.js"),
    `export const id = "001_test";\nexport const description = "test";\nexport async function up() {}\nexport async function down() {}\n`
  );

  // Create a non-migration file (no number prefix)
  writeFileSync(join(tmpDir, "readme.txt"), "not a migration");

  // Create a JS file without required exports
  writeFileSync(join(tmpDir, "002_bad.js"), `export const name = "bad";\n`);

  try {
    const migrations = await discoverMigrations(tmpDir);
    assert.equal(migrations.length, 1, "should only find the valid migration");
    assert.equal(migrations[0].id, "001_test");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// -- Mock pool tests for status tracking and idempotent re-run --

function createMockPool() {
  const tables = {};
  const mockClient = {
    query: async (sql, params) => mockQuery(sql, params),
    release: () => {},
  };

  function mockQuery(sql, params) {
    const trimmed = sql.replace(/\s+/g, " ").trim();

    // CREATE TABLE _migrations
    if (trimmed.includes("CREATE TABLE IF NOT EXISTS _migrations")) {
      tables._migrations = tables._migrations || [];
      return { rows: [] };
    }

    // SELECT from _migrations
    if (trimmed.includes("SELECT id FROM _migrations")) {
      return { rows: (tables._migrations || []).map((r) => ({ id: r.id })) };
    }

    if (trimmed.includes("SELECT id, description, applied_at FROM _migrations")) {
      return { rows: tables._migrations || [] };
    }

    // INSERT into _migrations
    if (trimmed.includes("INSERT INTO _migrations")) {
      tables._migrations = tables._migrations || [];
      tables._migrations.push({
        id: params[0],
        description: params[1],
        applied_at: new Date().toISOString(),
      });
      return { rows: [] };
    }

    // DELETE from _migrations
    if (trimmed.includes("DELETE FROM _migrations")) {
      tables._migrations = (tables._migrations || []).filter((r) => r.id !== params[0]);
      return { rows: [] };
    }

    // BEGIN / COMMIT / ROLLBACK
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(trimmed)) {
      return { rows: [] };
    }

    // Catch-all for DDL from migrations (CREATE TABLE, CREATE INDEX, ALTER TABLE, DROP TABLE)
    return { rows: [] };
  }

  return {
    query: async (sql, params) => mockQuery(sql, params),
    connect: async () => mockClient,
    _tables: tables,
  };
}

test("migrations: runMigrations applies pending and skips applied", async () => {
  const pool = createMockPool();
  const migrationsDir = join(__dirname, "..", "migrations");

  // First run: should apply all
  const result1 = await runMigrations(pool, { migrationsDir });
  assert.ok(result1.applied.length >= 6, "first run should apply all migrations");
  assert.equal(result1.skipped.length, 0, "first run should skip none");
  assert.equal(result1.errors.length, 0, "first run should have no errors");

  // Second run: should skip all (idempotent)
  const result2 = await runMigrations(pool, { migrationsDir });
  assert.equal(result2.applied.length, 0, "second run should apply none");
  assert.ok(result2.skipped.length >= 6, "second run should skip all");
  assert.equal(result2.errors.length, 0, "second run should have no errors");
});

test("migrations: getMigrationStatus reflects current state", async () => {
  const pool = createMockPool();
  const migrationsDir = join(__dirname, "..", "migrations");

  // Before running: all pending
  const before = await getMigrationStatus(pool, { migrationsDir });
  assert.equal(before.applied.length, 0);
  assert.ok(before.pending.length >= 6);

  // Run migrations
  await runMigrations(pool, { migrationsDir });

  // After running: all applied
  const after = await getMigrationStatus(pool, { migrationsDir });
  assert.ok(after.applied.length >= 6);
  assert.equal(after.pending.length, 0);
});

test("migrations: rollbackMigration removes applied migration", async () => {
  const pool = createMockPool();
  const migrationsDir = join(__dirname, "..", "migrations");

  await runMigrations(pool, { migrationsDir });

  const result = await rollbackMigration(pool, "006_add_agent_memory", { migrationsDir });
  assert.equal(result.success, true);

  const status = await getMigrationStatus(pool, { migrationsDir });
  assert.ok(status.pending.includes("006_add_agent_memory"), "rolled-back migration should be pending");
});

test("migrations: rollbackMigration fails for unapplied migration", async () => {
  const pool = createMockPool();
  const migrationsDir = join(__dirname, "..", "migrations");

  const result = await rollbackMigration(pool, "006_add_agent_memory", { migrationsDir });
  assert.equal(result.success, false);
  assert.ok(result.error.includes("has not been applied"));
});
