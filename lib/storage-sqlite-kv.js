/**
 * Phase 50: Optional SQLite KV backend — mirrors JSON storage paths as keys.
 * Set STORAGE_BACKEND=sqlite. Requires optional dependency better-sqlite3.
 * Phase 69: Optional OpenTelemetry spans for KV load/save (db.system=sqlite).
 */
import { createRequire } from "module";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const require = createRequire(import.meta.url);

const sqliteTracer = trace.getTracer("siskel-bot-sqlite", "1.0.0");

/**
 * @template T
 * @param {string} op
 * @param {string} filePath
 * @param {() => T} fn
 * @returns {T}
 */
function withSqliteSpan(op, filePath, fn) {
  if (process.env.OTEL_ENABLED !== "1") return fn();
  const suffix = String(filePath || "").slice(-120);
  return sqliteTracer.startActiveSpan(
    `sqlite.kv.${op}`,
    {
      attributes: {
        "db.system": "sqlite",
        "db.operation": op,
        "siskel.storage.path_suffix": suffix,
      },
    },
    (span) => {
      try {
        const out = fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return out;
      } catch (e) {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message || String(e) });
        throw e;
      } finally {
        span.end();
      }
    }
  );
}

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
  return withSqliteSpan("SELECT", filePath, () => {
    const row = db.prepare("SELECT data FROM kv WHERE path = ?").get(filePath);
    if (!row?.data) return null;
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  });
}

/**
 * @returns {boolean} true if persisted to sqlite
 */
export function sqliteKvSave(filePath, data, getDataDir) {
  const dataDir = getDataDir();
  const db = tryOpenDb(dataDir);
  if (!db) return false;
  return withSqliteSpan("INSERT", filePath, () => {
    db.prepare("INSERT OR REPLACE INTO kv (path, data) VALUES (?, ?)").run(filePath, JSON.stringify(data));
    return true;
  });
}

export function sqliteKvEnabled() {
  return process.env.STORAGE_BACKEND === "sqlite";
}
