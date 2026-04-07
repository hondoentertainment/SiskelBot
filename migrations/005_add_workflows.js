export const id = "005_add_workflows";
export const description = "Create workflows and workflow_runs tables";

export async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      steps JSONB DEFAULT '[]',
      trigger_type TEXT,
      trigger_config JSONB,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_workflows_workspace ON workflows(workspace_id)`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      input JSONB,
      output JSONB,
      error TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id)`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status)`
  );
}

export async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS workflow_runs`);
  await pool.query(`DROP TABLE IF EXISTS workflows`);
}
