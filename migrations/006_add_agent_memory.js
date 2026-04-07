export const id = "006_add_agent_memory";
export const description = "Create agent_memory table with full-text search";

export async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id TEXT,
      category TEXT DEFAULT 'general',
      content TEXT NOT NULL,
      metadata JSONB,
      approved BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_agent_memory_workspace ON agent_memory(workspace_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_agent_memory_category ON agent_memory(category)`
  );

  // Full-text search index on content
  await pool.query(`
    ALTER TABLE agent_memory
    ADD COLUMN IF NOT EXISTS search_vector TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_agent_memory_fts ON agent_memory USING GIN(search_vector)`
  );
}

export async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS agent_memory`);
}
