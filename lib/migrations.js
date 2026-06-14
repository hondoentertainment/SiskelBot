/**
 * Versioned database migration system.
 * Migrations live in migrations/ directory as numbered JS files.
 * Tracks applied migrations in a `_migrations` table.
 */
import { readdir } from "fs/promises";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

const MIGRATIONS_TABLE = "_migrations";

/**
 * Ensure the _migrations tracking table exists.
 */
async function ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      description TEXT,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

/**
 * Discover migration files in the migrations/ directory.
 * Returns sorted array of { filename, id, module }.
 */
export async function discoverMigrations(migrationsDir) {
  const dir = migrationsDir || MIGRATIONS_DIR;
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const migrationFiles = files
    .filter((f) => /^\d+.*\.js$/.test(f))
    .sort();

  const migrations = [];
  for (const file of migrationFiles) {
    const modulePath = join(dir, file);
    const mod = await import(pathToFileURL(modulePath).href);
    if (!mod.id || typeof mod.up !== "function") {
      console.warn(`[migrations] Skipping ${file}: missing id or up function`);
      continue;
    }
    migrations.push({
      filename: file,
      id: mod.id,
      description: mod.description || "",
      up: mod.up,
      down: typeof mod.down === "function" ? mod.down : null,
    });
  }
  return migrations;
}

/**
 * Get list of already-applied migration IDs from the database.
 */
async function getAppliedMigrationIds(pool) {
  const result = await pool.query(
    `SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY applied_at`
  );
  return result.rows.map((r) => r.id);
}

/**
 * Run all pending migrations in order.
 * @param {import('pg').Pool} pgPool
 * @param {{ migrationsDir?: string }} [opts]
 * @returns {Promise<{ applied: string[], skipped: string[], errors: Array<{ id: string, error: string }> }>}
 */
export async function runMigrations(pgPool, opts = {}) {
  await ensureMigrationsTable(pgPool);
  const appliedIds = await getAppliedMigrationIds(pgPool);
  const appliedSet = new Set(appliedIds);
  const migrations = await discoverMigrations(opts.migrationsDir);

  const result = { applied: [], skipped: [], errors: [] };

  for (const migration of migrations) {
    if (appliedSet.has(migration.id)) {
      result.skipped.push(migration.id);
      continue;
    }

    const client = await pgPool.connect();
    try {
      await client.query("BEGIN");
      await migration.up(client);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (id, description) VALUES ($1, $2)`,
        [migration.id, migration.description]
      );
      await client.query("COMMIT");
      result.applied.push(migration.id);
      console.log(`[migrations] Applied: ${migration.id} -- ${migration.description}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      result.errors.push({ id: migration.id, error: e.message });
      console.error(`[migrations] Failed: ${migration.id} -- ${e.message}`);
      break; // stop on first error
    } finally {
      client.release();
    }
  }

  return result;
}

/**
 * Get the current migration status.
 * @param {import('pg').Pool} pgPool
 * @param {{ migrationsDir?: string }} [opts]
 * @returns {Promise<{ applied: Array<{ id: string, description: string, applied_at: string }>, pending: string[] }>}
 */
export async function getMigrationStatus(pgPool, opts = {}) {
  await ensureMigrationsTable(pgPool);
  const appliedResult = await pgPool.query(
    `SELECT id, description, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY applied_at`
  );
  const appliedIds = new Set(appliedResult.rows.map((r) => r.id));
  const migrations = await discoverMigrations(opts.migrationsDir);
  const pending = migrations
    .filter((m) => !appliedIds.has(m.id))
    .map((m) => m.id);

  return {
    applied: appliedResult.rows,
    pending,
  };
}

/**
 * Roll back a specific migration by ID.
 * @param {import('pg').Pool} pgPool
 * @param {string} migrationId
 * @param {{ migrationsDir?: string }} [opts]
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function rollbackMigration(pgPool, migrationId, opts = {}) {
  await ensureMigrationsTable(pgPool);

  // Verify migration was applied
  const check = await pgPool.query(
    `SELECT id FROM ${MIGRATIONS_TABLE} WHERE id = $1`,
    [migrationId]
  );
  if (check.rows.length === 0) {
    return { success: false, error: `Migration ${migrationId} has not been applied` };
  }

  // Find the migration module
  const migrations = await discoverMigrations(opts.migrationsDir);
  const migration = migrations.find((m) => m.id === migrationId);
  if (!migration) {
    return { success: false, error: `Migration file not found for ${migrationId}` };
  }
  if (!migration.down) {
    return { success: false, error: `Migration ${migrationId} does not have a down function` };
  }

  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    await migration.down(client);
    await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE id = $1`, [migrationId]);
    await client.query("COMMIT");
    console.log(`[migrations] Rolled back: ${migrationId}`);
    return { success: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[migrations] Rollback failed: ${migrationId} -- ${e.message}`);
    return { success: false, error: e.message };
  } finally {
    client.release();
  }
}
