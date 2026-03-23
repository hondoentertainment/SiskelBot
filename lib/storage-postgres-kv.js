/**
 * Phase 46: Optional PostgreSQL KV — same logical paths as JSON/SQLite keys.
 * Set STORAGE_BACKEND=postgres and DATABASE_URL (connection string).
 */
import pg from "pg";

let _pool = null;
let _initPromise = null;
let _failed = false;

export function postgresKvEnabled() {
  return process.env.STORAGE_BACKEND === "postgres" && Boolean(process.env.DATABASE_URL?.trim());
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
        await c.query(`
          CREATE TABLE IF NOT EXISTS storage_kv (
            path TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT now()
          )`);
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
    const r = await pool.query("SELECT data FROM storage_kv WHERE path = $1", [filePath]);
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
    await pool.query(
      `INSERT INTO storage_kv (path, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [filePath, JSON.stringify(data)]
    );
    return true;
  } catch (e) {
    console.warn("[storage-postgres-kv] save failed:", e.message);
    return false;
  }
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
  const r = await pool.query("SELECT path, data FROM storage_kv ORDER BY path");
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
    await c.query("BEGIN");
    if (replaceAll) {
      await c.query("DELETE FROM storage_kv");
    }
    for (const row of entries) {
      if (!row?.path || row.data == null || typeof row.data !== "object") continue;
      await c.query(
        `INSERT INTO storage_kv (path, data, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [row.path, JSON.stringify(row.data)]
      );
    }
    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.warn("[storage-postgres-kv] import snapshot failed:", e.message);
    return false;
  } finally {
    c.release();
  }
}
