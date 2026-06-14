export const id = "003_add_audit_log";
export const description = "Create audit_log table with indexes";

export async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      user_id TEXT,
      workspace_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      details JSONB,
      ip_address TEXT,
      user_agent TEXT
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_workspace ON audit_log(workspace_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action)`
  );
}

export async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS audit_log`);
}
