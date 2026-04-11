/**
 * Phase 39.5: Schema definitions for data warehouse exports.
 *
 * Each table maps a column name to a logical type that adapters translate
 * to their concrete SQL/JSON types. Supported logical types:
 *   - string     (VARCHAR / STRING)
 *   - integer    (INT / INT64)
 *   - number     (FLOAT / FLOAT64)
 *   - boolean    (BOOL / BOOLEAN)
 *   - timestamp  (TIMESTAMP_NTZ / TIMESTAMP)
 *   - date       (DATE)
 *   - json       (VARIANT / JSON)
 */

export const TABLE_SCHEMAS = {
  conversations: {
    id: "string",
    workspace_id: "string",
    user_id: "string",
    title: "string",
    model: "string",
    message_count: "integer",
    created_at: "timestamp",
    updated_at: "timestamp",
    metadata: "json",
  },
  messages: {
    id: "string",
    conversation_id: "string",
    role: "string",
    content: "string",
    model: "string",
    prompt_tokens: "integer",
    completion_tokens: "integer",
    total_tokens: "integer",
    cost: "number",
    created_at: "timestamp",
    metadata: "json",
  },
  knowledge_documents: {
    id: "string",
    workspace_id: "string",
    title: "string",
    content: "string",
    source: "string",
    chunk_count: "integer",
    bytes: "integer",
    created_at: "timestamp",
    updated_at: "timestamp",
    metadata: "json",
  },
  usage_events: {
    id: "string",
    workspace_id: "string",
    user_id: "string",
    event_type: "string",
    model: "string",
    backend: "string",
    prompt_tokens: "integer",
    completion_tokens: "integer",
    total_tokens: "integer",
    cost: "number",
    latency_ms: "integer",
    success: "boolean",
    created_at: "timestamp",
    metadata: "json",
  },
  audit_log: {
    id: "string",
    workspace_id: "string",
    user_id: "string",
    action: "string",
    resource: "string",
    source: "string",
    ok: "boolean",
    error: "string",
    timestamp: "timestamp",
    payload: "json",
  },
};

/**
 * Resolve a logical type to a concrete SQL type for a destination.
 */
export function sqlTypeFor(destination, logicalType) {
  const map = {
    snowflake: {
      string: "VARCHAR",
      integer: "INTEGER",
      number: "FLOAT",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP_NTZ",
      date: "DATE",
      json: "VARIANT",
    },
    bigquery: {
      string: "STRING",
      integer: "INT64",
      number: "FLOAT64",
      boolean: "BOOL",
      timestamp: "TIMESTAMP",
      date: "DATE",
      json: "JSON",
    },
    redshift: {
      string: "VARCHAR(MAX)",
      integer: "BIGINT",
      number: "DOUBLE PRECISION",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      date: "DATE",
      json: "SUPER",
    },
  };
  return map[destination]?.[logicalType] || "VARCHAR";
}

/**
 * Build a CREATE TABLE statement for a destination + schema.
 */
export function buildCreateTableSQL(destination, table, schema) {
  const cols = Object.entries(schema)
    .map(([name, type]) => `  ${name} ${sqlTypeFor(destination, type)}`)
    .join(",\n");
  return `CREATE TABLE IF NOT EXISTS ${table} (\n${cols}\n)`;
}
