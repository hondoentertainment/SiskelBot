/**
 * Phase 46: Optional PostgreSQL KV — same logical paths as JSON/SQLite keys.
 * Set STORAGE_BACKEND=postgres and DATABASE_URL (connection string).
 *
 * Phase 35.4: all query execution is routed through `instrumentedQuery`,
 * which records per-query stats into `globalQueryAnalyzer`.
 */
import pg from "pg";
import { globalQueryAnalyzer } from "./query-analyzer.js";

let _pool = null;
let _initPromise = null;
let _failed = false;

/** Safe SQL identifier for the KV table (shared Neon DBs must not collide). */
function kvTable() {
  const raw = (process.env.STORAGE_KV_TABLE || "siskelbot_storage_kv").trim();
  const safe = raw.replace(/[^a-zA-Z0-9_]/g, "") || "siskelbot_storage_kv";
  return safe;
}

/**
 * Run a query via the shared pool and record stats in the query analyzer.
 * Used internally and exported so other storage modules (or tests) can share
 * the same instrumentation.
 *
 * @param {{ query: Function }} pool
 * @param {string} text
 * @param {any[]} [params]
 */
export async function instrumentedQuery(pool, text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    globalQueryAnalyzer.recordQuery(text, params, Date.now() - start);
    return result;
  } catch (err) {
    globalQueryAnalyzer.recordQuery(text, params, Date.now() - start, err);
    throw err;
  }
}

export function postgresKvEnabled() {
  return process.env.STORAGE_BACKEND?.trim() === "postgres" && Boolean(process.env.DATABASE_URL?.trim());
}

async function ensurePool() {
  if (!postgresKvEnabled() || _failed) return null;
  if (_pool) return _pool;
  if (!_initPromise) {
    _initPromise = (async () => {
      const pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: Math.min(50, Math.max(2, Number(process.env.PG_POOL_MAX) || 10)),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });
      const c = await pool.connect();
      try {
        await instrumentedQuery(
          c,
          `CREATE TABLE IF NOT EXISTS ${kvTable()} (
            path TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT now()
          )`
        );
      } finally {
        c.release();
      }
      _pool = pool;
      return pool;
    })().catch((e) => {
      console.warn("[storage-postgres-kv] Failed to init:", e.message);
      _failed = true;
      _initPromise = null;
      return null;
    });
  }
  return _initPromise;
}

/**
 * @param {string} filePath
 * @returns {Promise<object|null>} parsed JSON or null if missing / backend off
 */
export async function postgresKvLoad(filePath) {
  try {
    const pool = await ensurePool();
    if (!pool) return null;
    const r = await instrumentedQuery(pool, `SELECT data FROM ${kvTable()} WHERE path = $1`, [filePath]);
    const row = r.rows?.[0];
    if (!row || row.data == null) return null;
    return typeof row.data === "object" ? row.data : JSON.parse(String(row.data));
  } catch (e) {
    console.warn("[storage-postgres-kv] load failed:", e.message);
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {object} data
 * @returns {Promise<boolean>}
 */
export async function postgresKvSave(filePath, data) {
  try {
    const pool = await ensurePool();
    if (!pool) return false;
    await instrumentedQuery(
      pool,
      `INSERT INTO ${kvTable()} (path, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [filePath, JSON.stringify(data)]
    );
    return true;
  } catch (e) {
    console.warn("[storage-postgres-kv] save failed:", e.message);
    return false;
  }
}

/**
 * Phase 35.4: expose the active pool (initializing it if needed) so that
 * admin tooling can run EXPLAIN, `pg_indexes`, and `pg_stat_user_tables`
 * queries. Returns null when the Postgres backend is disabled.
 */
export async function getPostgresPool() {
  return await ensurePool();
}

/** @returns {Promise<void>} */
export async function closePostgresPool() {
  if (_pool) {
    await _pool.end().catch(() => {});
    _pool = null;
  }
  _initPromise = null;
}

/**
 * Phase 68: Full KV export for backup (ordered by path).
 * @returns {Promise<Array<{ path: string, data: object }>>}
 */
export async function postgresKvExportAll() {
  const pool = await ensurePool();
  if (!pool) return [];
  const r = await instrumentedQuery(pool, `SELECT path, data FROM ${kvTable()} ORDER BY path`);
  return (r.rows || []).map((row) => ({
    path: row.path,
    data: typeof row.data === "object" && row.data !== null ? row.data : JSON.parse(String(row.data)),
  }));
}

/**
 * Phase 68: Restore KV from backup snapshot (replaces all rows when replaceAll).
 * @param {Array<{ path: string, data: object }>} entries
 * @param {{ replaceAll?: boolean }} [opts]
 */
export async function postgresKvImportSnapshot(entries, opts = {}) {
  const replaceAll = opts.replaceAll !== false;
  const pool = await ensurePool();
  if (!pool || !Array.isArray(entries)) return false;
  const c = await pool.connect();
  try {
    await instrumentedQuery(c, "BEGIN");
    if (replaceAll) {
      await instrumentedQuery(c, `DELETE FROM ${kvTable()}`);
    }
    for (const row of entries) {
      if (!row?.path || row.data == null || typeof row.data !== "object") continue;
      await instrumentedQuery(
        c,
        `INSERT INTO ${kvTable()} (path, data, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [row.path, JSON.stringify(row.data)]
      );
    }
    await instrumentedQuery(c, "COMMIT");
    return true;
  } catch (e) {
    await instrumentedQuery(c, "ROLLBACK").catch(() => {});
    console.warn("[storage-postgres-kv] import snapshot failed:", e.message);
    return false;
  } finally {
    c.release();
  }
}
