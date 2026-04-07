export const id = "004_add_agent_sessions";
export const description = "Create agent_sessions table";

export async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      model TEXT,
      status TEXT DEFAULT 'active',
      messages JSONB DEFAULT '[]',
      tool_calls JSONB DEFAULT '[]',
      iterations INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_user ON agent_sessions(user_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace ON agent_sessions(workspace_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status)`
  );
}

export async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS agent_sessions`);
}
