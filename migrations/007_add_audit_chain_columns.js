export const id = "007_add_audit_chain_columns";
export const description = "Add hash-chain columns to audit_log for tamper-evident immutability";

export async function up(pool) {
  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS hash TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT DEFAULT NULL`);
  await pool.query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS sequence BIGINT DEFAULT NULL`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_sequence ON audit_log(workspace_id, sequence)`
  );
}

export async function down(pool) {
  await pool.query(`DROP INDEX IF EXISTS idx_audit_log_sequence`);
  await pool.query(`ALTER TABLE audit_log DROP COLUMN IF EXISTS sequence`);
  await pool.query(`ALTER TABLE audit_log DROP COLUMN IF EXISTS prev_hash`);
  await pool.query(`ALTER TABLE audit_log DROP COLUMN IF EXISTS hash`);
}
