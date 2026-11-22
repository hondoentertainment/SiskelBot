/**
 * Read-only SQL for a workspace-owned connection string.
 * The app DATABASE_URL is never used. SELECT/WITH only, one statement,
 * row cap, and no file or admin functions.
 */

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute|call|do|into|set|reset|comment|vacuum|analyze|refresh|listen|notify|load|lock|reindex|cluster|discard|prepare|deallocate|merge|replace)\b/i;
const BLOCKED_FN = /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|dblink_exec)\b/i;

export function validateReadOnlySelect(sql) {
  let text = String(sql || "");
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ");
  text = text.trim();
  if (!text) return { ok: false, error: "query is required" };
  if (text.endsWith(";")) text = text.slice(0, -1).trim();
  if (text.includes(";")) return { ok: false, error: "Only a single SELECT statement is allowed" };
  if (!/^(select|with)\b/i.test(text)) return { ok: false, error: "Only SELECT queries are allowed" };
  if (FORBIDDEN.test(text) || BLOCKED_FN.test(text)) {
    return { ok: false, error: "Query contains a forbidden keyword or function" };
  }
  return { ok: true, sql: text };
}

export function capSelect(sql, maxRows) {
  const cap = Math.min(200, Math.max(1, Number(maxRows) || 50));
  return { sql: `SELECT * FROM (${sql}) AS governed_sql LIMIT ${cap}`, maxRows: cap };
}

export function assertReadOnlyUrl(connectionString) {
  const value = String(connectionString || "").trim();
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    return { ok: false, error: "Workspace SQL secret must be a postgres:// URL" };
  }
  return { ok: true, connectionString: value };
}

async function defaultQuery(connectionString, sql) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, statement_timeout: 5000 });
  await client.connect();
  try {
    await client.query("SET statement_timeout = 5000");
    const result = await client.query(sql);
    return { rows: result.rows, rowCount: result.rowCount };
  } finally {
    await client.end();
  }
}

/**
 * @param {{ sql: string, connectionString: string, maxRows?: number, query?: Function }} input
 */
export async function runGovernedQuery(input) {
  const url = assertReadOnlyUrl(input?.connectionString);
  if (!url.ok) return { ok: false, code: "SQL_NOT_CONFIGURED", error: url.error };
  const validated = validateReadOnlySelect(input.sql);
  if (!validated.ok) return { ok: false, code: "SQL_REJECTED", error: validated.error };
  const capped = capSelect(validated.sql, input.maxRows);
  const query = input.query || defaultQuery;
  try {
    const result = await query(url.connectionString, capped.sql);
    const rows = Array.isArray(result?.rows) ? result.rows.slice(0, capped.maxRows) : [];
    return { ok: true, rows, rowCount: rows.length, maxRows: capped.maxRows };
  } catch (err) {
    return { ok: false, code: "SQL_ERROR", error: err.message };
  }
}
