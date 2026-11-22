import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReadOnlySelect, capSelect, runGovernedQuery } from "../lib/governed-sql.js";
import { setSecret } from "../lib/secrets-store.js";
import { saveWorkspaceAgentSettings } from "../lib/workspace-agent-settings.js";
import { runTool } from "../lib/agent-tools.js";

test("read-only validator rejects writes, extra statements, and hidden keywords", () => {
  assert.equal(validateReadOnlySelect("SELECT id FROM notes").ok, true);
  assert.equal(validateReadOnlySelect("WITH s AS (SELECT 1) SELECT * FROM s").ok, true);
  assert.equal(validateReadOnlySelect("DELETE FROM notes").ok, false);
  assert.equal(validateReadOnlySelect("SELECT 1; DROP TABLE notes").ok, false);
  assert.equal(validateReadOnlySelect("SELECT 1 /* DELETE */ ").ok, true);
  assert.equal(validateReadOnlySelect("/* ok */ DELETE FROM notes").ok, false);
  assert.equal(validateReadOnlySelect("SELECT pg_read_file('secret')").ok, false);
  const capped = capSelect("SELECT id FROM notes", 5000);
  assert.match(capped.sql, /LIMIT 200$/);
  assert.equal(capped.maxRows, 200);
});

test("query_database uses the workspace secret, not DATABASE_URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sql-"));
  const prevStore = process.env.STORAGE_PATH;
  const prevFlag = process.env.AGENT_DB_QUERY;
  const prevDb = process.env.DATABASE_URL;
  process.env.STORAGE_PATH = dir;
  process.env.AGENT_DB_QUERY = "1";
  process.env.DATABASE_URL = "postgres://app-owner:secret@db.internal/app";
  try {
    const blocked = JSON.parse((await runTool("query_database", { query: "SELECT 1" }, {
      workspace: "default",
      workspaceUserId: "ada",
    })).content);
    assert.equal(blocked.code, "SQL_POLICY_DISABLED");

    await saveWorkspaceAgentSettings("ada", "default", { agentPolicy: { sqlQueryEnabled: true } });
    const missing = JSON.parse((await runTool("query_database", { query: "SELECT 1" }, {
      workspace: "default",
      workspaceUserId: "ada",
    })).content);
    assert.equal(missing.code, "SQL_NOT_CONFIGURED");
    assert.equal(String(missing.error).includes("app-owner"), false);

    await setSecret("workspace", "default", "sql_readonly_url", "postgres://reader:pw@db.example/analytics", "sql");
    let seen = "";
    const result = await runGovernedQuery({
      sql: "SELECT id FROM events",
      connectionString: "postgres://reader:pw@db.example/analytics",
      maxRows: 5,
      query: async (connectionString, sql) => {
        seen = `${connectionString} ${sql}`;
        return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
      },
    });
    assert.equal(result.ok, true);
    assert.match(seen, /postgres:\/\/reader/);
    assert.equal(seen.includes("app-owner"), false);
    assert.match(seen, /LIMIT 5/);
    assert.equal(result.rows.length, 2);

    const rejected = await runGovernedQuery({
      sql: "DROP TABLE events",
      connectionString: "postgres://reader:pw@db.example/analytics",
      query: async () => { throw new Error("should not run"); },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "SQL_REJECTED");
  } finally {
    if (prevStore === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = prevStore;
    if (prevFlag === undefined) delete process.env.AGENT_DB_QUERY;
    else process.env.AGENT_DB_QUERY = prevFlag;
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    rmSync(dir, { recursive: true, force: true });
  }
});
