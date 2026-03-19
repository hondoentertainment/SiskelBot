/**
 * Phase 50: Optional SQLite KV backend — mirrors JSON storage paths as keys.
 * Set STORAGE_BACKEND=sqlite. Requires optional dependency better-sqlite3.
 */
import { createRequire } from "module";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

const require = createRequire(import.meta.url);

/** @type {Map<string, import('better-sqlite3').Database>} */
const _dbs = new Map();
/** @type {Set<string>} */
const _failedDirs = new Set();

function tryOpenDb(dataDir) {
  if (process.env.STORAGE_BACKEND !== "sqlite") return null;
  if (_failedDirs.has(dataDir)) return null;
  let db = _dbs.get(dataDir);
  if (db) return db;
  try {
    const Database = require("better-sqlite3");
    ensureDir(dataDir);
    const dbPath = join(dataDir, "storage-kv.db");
    db = new Database(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS kv (path TEXT PRIMARY KEY, data TEXT NOT NULL)");
    _dbs.set(dataDir, db);
    return db;
  } catch (e) {
    console.warn("[storage-sqlite-kv] SQLite unavailable, falling back to JSON files:", e.message);
    _failedDirs.add(dataDir);
    return null;
  }
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * @param {string} filePath - absolute or normalized path used as key
 * @param {() => string} getDataDir
 * @returns {object|null} parsed JSON or null if not in sqlite
 */
export function sqliteKvLoad(filePath, getDataDir) {
  const dataDir = getDataDir();
  const db = tryOpenDb(dataDir);
  if (!db) return null;
  const row = db.prepare("SELECT data FROM kv WHERE path = ?").get(filePath);
  if (!row?.data) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

/**
 * @returns {boolean} true if persisted to sqlite
 */
export function sqliteKvSave(filePath, data, getDataDir) {
  const dataDir = getDataDir();
  const db = tryOpenDb(dataDir);
  if (!db) return false;
  db.prepare("INSERT OR REPLACE INTO kv (path, data) VALUES (?, ?)").run(filePath, JSON.stringify(data));
  return true;
}

export function sqliteKvEnabled() {
  return process.env.STORAGE_BACKEND === "sqlite";
}
