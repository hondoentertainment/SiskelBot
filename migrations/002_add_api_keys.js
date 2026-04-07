export const id = "002_add_api_keys";
export const description = "Create api_keys table";

export async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      label TEXT,
      scopes TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`
  );
}

export async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS api_keys`);
}
