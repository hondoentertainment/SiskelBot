#!/usr/bin/env node
/**
 * Storage migration CLI for SiskelBot.
 *
 * Migrates data between storage backends (json, sqlite, postgres).
 *
 * Usage:
 *   node scripts/migrate-storage.mjs --from=json --to=postgres [--dry-run] [--verbose]
 *   node scripts/migrate-storage.mjs --from=postgres --to=json [--dry-run] [--verbose]
 *   node scripts/migrate-storage.mjs --from=json --to=sqlite  [--dry-run] [--verbose]
 *   node scripts/migrate-storage.mjs --from=sqlite --to=json  [--dry-run] [--verbose]
 *   node scripts/migrate-storage.mjs --from=sqlite --to=postgres [--dry-run] [--verbose]
 *   node scripts/migrate-storage.mjs --from=postgres --to=sqlite [--dry-run] [--verbose]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// Load .env
try {
  const dotenv = (await import("dotenv")).default;
  dotenv.config({ path: join(PROJECT_ROOT, ".env") });
} catch {
  // dotenv not available
}

const VALID_BACKENDS = ["json", "sqlite", "postgres"];

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function getArg(name) {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const fromBackend = getArg("from");
const toBackend = getArg("to");
const dryRun = hasFlag("dry-run");
const verbose = hasFlag("verbose");

function usage() {
  console.log(`Usage: node scripts/migrate-storage.mjs --from=<backend> --to=<backend> [--dry-run] [--verbose]

Backends: json, sqlite, postgres

Options:
  --from=<backend>   Source backend
  --to=<backend>     Target backend
  --dry-run          Show what would be migrated without writing
  --verbose          Show detailed progress

Examples:
  node scripts/migrate-storage.mjs --from=json --to=postgres
  node scripts/migrate-storage.mjs --from=postgres --to=json --dry-run
  node scripts/migrate-storage.mjs --from=json --to=sqlite --verbose`);
}

if (!fromBackend || !toBackend || hasFlag("help") || hasFlag("h")) {
  usage();
  process.exit(fromBackend && toBackend ? 1 : 0);
}

if (!VALID_BACKENDS.includes(fromBackend)) {
  console.error(`Error: Invalid --from backend "${fromBackend}". Must be one of: ${VALID_BACKENDS.join(", ")}`);
  process.exit(1);
}

if (!VALID_BACKENDS.includes(toBackend)) {
  console.error(`Error: Invalid --to backend "${toBackend}". Must be one of: ${VALID_BACKENDS.join(", ")}`);
  process.exit(1);
}

if (fromBackend === toBackend) {
  console.error(`Error: --from and --to must be different (both are "${fromBackend}").`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDataDir() {
  return process.env.STORAGE_PATH || join(PROJECT_ROOT, "data");
}

function log(msg) {
  if (verbose) console.log(msg);
}

/** Recursively walk a directory yielding file paths. */
function walkDir(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// JSON backend reader / writer
// ---------------------------------------------------------------------------

function jsonReadAll() {
  const dataDir = getDataDir();
  const files = walkDir(dataDir);
  const entries = [];
  for (const filePath of files) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const data = JSON.parse(raw);
      entries.push({ path: filePath, data });
    } catch (e) {
      entries.push({ path: filePath, data: null, error: e.message });
    }
  }
  return entries;
}

function jsonWriteEntry(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 0), "utf8");
}

// ---------------------------------------------------------------------------
// PostgreSQL backend reader / writer
// ---------------------------------------------------------------------------

async function pgConnect() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) {
    console.error("Error: DATABASE_URL environment variable is required for postgres backend.");
    process.exit(1);
  }
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({
    connectionString: connStr,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Ensure table exists
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS storage_kv (
        path TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      )`);
  } finally {
    c.release();
  }
  return pool;
}

async function pgReadAll(pool) {
  const r = await pool.query("SELECT path, data FROM storage_kv ORDER BY path");
  return (r.rows || []).map((row) => ({
    path: row.path,
    data: typeof row.data === "object" && row.data !== null ? row.data : JSON.parse(String(row.data)),
  }));
}

async function pgWriteEntry(pool, path, data) {
  await pool.query(
    `INSERT INTO storage_kv (path, data, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [path, JSON.stringify(data)]
  );
}

// ---------------------------------------------------------------------------
// SQLite backend reader / writer
// ---------------------------------------------------------------------------

function sqliteOpen() {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const require = createRequire(import.meta.url);
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (e) {
    console.error("Error: better-sqlite3 is required for sqlite backend. Install with: npm install better-sqlite3");
    process.exit(1);
  }
  const dbPath = join(dataDir, "storage-kv.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS kv (path TEXT PRIMARY KEY, data TEXT NOT NULL)");
  return db;
}

function sqliteReadAll(db) {
  const rows = db.prepare("SELECT path, data FROM kv ORDER BY path").all();
  return rows.map((row) => {
    try {
      return { path: row.path, data: JSON.parse(row.data) };
    } catch (e) {
      return { path: row.path, data: null, error: e.message };
    }
  });
}

function sqliteWriteEntry(db, path, data) {
  db.prepare("INSERT OR REPLACE INTO kv (path, data) VALUES (?, ?)").run(path, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Migration logic
// ---------------------------------------------------------------------------

async function readSource(backend) {
  if (backend === "json") {
    return jsonReadAll();
  } else if (backend === "postgres") {
    const pool = await pgConnect();
    const entries = await pgReadAll(pool);
    await pool.end();
    return entries;
  } else if (backend === "sqlite") {
    const db = sqliteOpen();
    const entries = sqliteReadAll(db);
    db.close();
    return entries;
  }
  throw new Error(`Unknown backend: ${backend}`);
}

async function writeTarget(backend, entries) {
  const errors = [];
  let written = 0;

  // In dry-run mode, just count valid entries without connecting
  if (dryRun) {
    for (const entry of entries) {
      if (entry.error || entry.data == null) {
        errors.push({ path: entry.path, error: entry.error || "null data" });
        continue;
      }
      log(`  [dry-run] Would write: ${entry.path}`);
      written++;
    }
    return { written, errors };
  }

  if (backend === "json") {
    for (const entry of entries) {
      if (entry.error || entry.data == null) {
        errors.push({ path: entry.path, error: entry.error || "null data" });
        continue;
      }
      const filePath = entry.path;
      try {
        jsonWriteEntry(filePath, entry.data);
        log(`  Wrote: ${filePath}`);
        written++;
      } catch (e) {
        errors.push({ path: filePath, error: e.message });
      }
    }
  } else if (backend === "postgres") {
    const pool = await pgConnect();
    for (const entry of entries) {
      if (entry.error || entry.data == null) {
        errors.push({ path: entry.path, error: entry.error || "null data" });
        continue;
      }
      try {
        await pgWriteEntry(pool, entry.path, entry.data);
        log(`  Upserted: ${entry.path}`);
        written++;
      } catch (e) {
        errors.push({ path: entry.path, error: e.message });
      }
    }
    await pool.end();
  } else if (backend === "sqlite") {
    const db = sqliteOpen();
    for (const entry of entries) {
      if (entry.error || entry.data == null) {
        errors.push({ path: entry.path, error: entry.error || "null data" });
        continue;
      }
      try {
        sqliteWriteEntry(db, entry.path, entry.data);
        log(`  Upserted: ${entry.path}`);
        written++;
      } catch (e) {
        errors.push({ path: entry.path, error: e.message });
      }
    }
    db.close();
  }

  return { written, errors };
}

async function migrate() {
  const startTime = Date.now();

  console.log(`Migrating storage: ${fromBackend} -> ${toBackend}${dryRun ? " [DRY RUN]" : ""}`);
  console.log();

  // Read source
  console.log(`Reading from ${fromBackend}...`);
  let entries;
  try {
    entries = await readSource(fromBackend);
  } catch (e) {
    console.error(`Error reading from ${fromBackend}: ${e.message}`);
    process.exit(1);
  }

  const total = entries.length;
  const readErrors = entries.filter((e) => e.error);
  console.log(`  Found ${total} record(s)${readErrors.length ? ` (${readErrors.length} read error(s))` : ""}`);
  console.log();

  if (total === 0) {
    console.log("Nothing to migrate.");
    process.exit(0);
  }

  // Show each entry being migrated
  const validEntries = entries.filter((e) => !e.error && e.data != null);
  if (verbose || dryRun) {
    for (const entry of validEntries) {
      const dataDir = getDataDir();
      const display = entry.path.startsWith(dataDir)
        ? relative(PROJECT_ROOT, entry.path)
        : entry.path;
      const targetDisplay = display;
      console.log(`  Migrated: ${display} -> ${targetDisplay}`);
    }
    if (readErrors.length) {
      console.log();
      console.log("  Read errors:");
      for (const e of readErrors) {
        console.log(`    ${e.path}: ${e.error}`);
      }
    }
    console.log();
  }

  // Write target
  console.log(`Writing to ${toBackend}${dryRun ? " (dry run, no writes)" : ""}...`);
  const { written, errors: writeErrors } = await writeTarget(toBackend, entries);

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log();
  console.log("--- Migration Summary ---");
  console.log(`  Source:          ${fromBackend}`);
  console.log(`  Target:          ${toBackend}`);
  console.log(`  Total records:   ${total}`);
  console.log(`  Migrated:        ${written}`);
  console.log(`  Read errors:     ${readErrors.length}`);
  console.log(`  Write errors:    ${writeErrors.length}`);
  console.log(`  Dry run:         ${dryRun ? "yes" : "no"}`);
  console.log(`  Time elapsed:    ${elapsed}s`);

  if (writeErrors.length > 0) {
    console.log();
    console.log("  Write errors:");
    for (const e of writeErrors) {
      console.log(`    ${e.path}: ${e.error}`);
    }
  }

  if (readErrors.length + writeErrors.length > 0) {
    process.exit(1);
  }
}

migrate().catch((e) => {
  console.error("Fatal error:", e.message || e);
  process.exit(1);
});
