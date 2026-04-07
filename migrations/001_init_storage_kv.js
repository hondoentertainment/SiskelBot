export const id = "001_init_storage_kv";
export const description = "Create storage_kv table";

export async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS storage_kv (
      path TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_storage_kv_updated ON storage_kv(updated_at)`
  );
}

export async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS storage_kv`);
}
