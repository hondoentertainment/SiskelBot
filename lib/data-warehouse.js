/**
 * Phase 39.5: Data warehouse export.
 *
 * Manages scheduled ETL exports of SiskelBot data to external warehouses
 * (Snowflake, BigQuery, Redshift, S3). Exports are persisted as configs and
 * can be run on-demand or via the cron scheduler. Supports incremental
 * exports based on a date column to avoid re-exporting unchanged rows.
 *
 * Public API:
 *   createExport(config)         - persist a new export config
 *   updateExport(id, patch)      - update an existing config
 *   listExports(workspaceId)     - list configs for a workspace
 *   getExport(id)                - load a single config
 *   deleteExport(id)             - remove a config and history
 *   runExport(id)                - execute an export now
 *   getExportHistory(id)         - get past run results
 *   runDueExports()              - cron tick: run any due schedules
 *   _resetForTesting()           - clear in-memory cache (tests only)
 */

import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { TABLE_SCHEMAS } from "./warehouse-schemas.js";

export { TABLE_SCHEMAS } from "./warehouse-schemas.js";

const STORE_VERSION = 1;
const MAX_HISTORY_PER_EXPORT = 100;
const VALID_DESTINATIONS = new Set(["snowflake", "bigquery", "redshift", "s3"]);

function storePath() {
  return join(getDataDir(), "data-warehouse-exports.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    _version: STORE_VERSION,
    exports: {},
    history: {},
    cursors: {},
  });
  data.exports = data.exports || {};
  data.history = data.history || {};
  data.cursors = data.cursors || {};
  return data;
}

async function saveStore(data) {
  data._version = STORE_VERSION;
  await writeJsonPath(storePath(), data);
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(arr, max) {
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}

async function loadAdapter(destination) {
  switch (destination) {
    case "snowflake":
      return import("./warehouse-adapters/snowflake.js");
    case "bigquery":
      return import("./warehouse-adapters/bigquery.js");
    case "redshift":
      return import("./warehouse-adapters/redshift.js");
    case "s3":
    default:
      return import("./warehouse-adapters/s3.js");
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("createExport: config object required");
  }
  if (!config.name || typeof config.name !== "string") {
    throw new Error("createExport: name required");
  }
  if (!VALID_DESTINATIONS.has(config.destination)) {
    throw new Error(`createExport: invalid destination "${config.destination}"`);
  }
  if (!Array.isArray(config.tables) || config.tables.length === 0) {
    throw new Error("createExport: tables (non-empty array) required");
  }
  for (const t of config.tables) {
    if (!TABLE_SCHEMAS[t]) {
      throw new Error(`createExport: unknown table "${t}"`);
    }
  }
  if (config.incremental && !config.dateColumn) {
    throw new Error("createExport: incremental exports require dateColumn");
  }
}

/**
 * Persist a new export config.
 *
 * @param {object} config
 * @param {string} config.name
 * @param {"snowflake"|"bigquery"|"redshift"|"s3"} config.destination
 * @param {object} [config.credentials]
 * @param {string[]} config.tables
 * @param {string} [config.schedule] - cron expression
 * @param {boolean} [config.incremental]
 * @param {string} [config.dateColumn]
 * @param {string} [config.workspaceId]
 * @returns {Promise<object>}
 */
export async function createExport(config) {
  validateConfig(config);
  const id = randomUUID();
  const entry = {
    id,
    name: config.name.trim(),
    destination: config.destination,
    credentials: config.credentials || {},
    tables: config.tables.slice(),
    schedule: config.schedule ? String(config.schedule).trim() : null,
    incremental: !!config.incremental,
    dateColumn: config.dateColumn || null,
    workspaceId: config.workspaceId || "default",
    enabled: config.enabled !== false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await withPathLock(storePath(), async () => {
    const data = await loadStore();
    data.exports[id] = entry;
    data.history[id] = [];
    await saveStore(data);
  });
  return entry;
}

/**
 * Update an existing export config.
 */
export async function updateExport(id, patch) {
  if (!id) throw new Error("updateExport: id required");
  return withPathLock(storePath(), async () => {
    const data = await loadStore();
    const existing = data.exports[id];
    if (!existing) return null;
    const merged = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    };
    if (patch && patch.tables) {
      for (const t of patch.tables) {
        if (!TABLE_SCHEMAS[t]) {
          throw new Error(`updateExport: unknown table "${t}"`);
        }
      }
    }
    if (merged.destination && !VALID_DESTINATIONS.has(merged.destination)) {
      throw new Error(`updateExport: invalid destination "${merged.destination}"`);
    }
    if (merged.incremental && !merged.dateColumn) {
      throw new Error("updateExport: incremental exports require dateColumn");
    }
    data.exports[id] = merged;
    await saveStore(data);
    return merged;
  });
}

/**
 * List exports, optionally scoped to a workspace.
 */
export async function listExports(workspaceId) {
  const data = await loadStore();
  const all = Object.values(data.exports);
  if (!workspaceId) return all;
  return all.filter((e) => e.workspaceId === workspaceId);
}

/**
 * Get a single export config.
 */
export async function getExport(id) {
  if (!id) return null;
  const data = await loadStore();
  return data.exports[id] || null;
}

/**
 * Delete an export config and its history.
 */
export async function deleteExport(id) {
  if (!id) return false;
  return withPathLock(storePath(), async () => {
    const data = await loadStore();
    if (!data.exports[id]) return false;
    delete data.exports[id];
    delete data.history[id];
    delete data.cursors[id];
    await saveStore(data);
    return true;
  });
}

/**
 * Get the run history for a single export.
 */
export async function getExportHistory(id) {
  if (!id) throw new Error("getExportHistory: id required");
  const data = await loadStore();
  return Array.isArray(data.history[id]) ? data.history[id] : [];
}

async function appendHistory(id, entry) {
  await withPathLock(storePath(), async () => {
    const data = await loadStore();
    const list = Array.isArray(data.history[id]) ? data.history[id] : [];
    list.push({ id: randomUUID(), at: nowIso(), ...entry });
    data.history[id] = clamp(list, MAX_HISTORY_PER_EXPORT);
    await saveStore(data);
  });
}

async function getCursor(exportId, table) {
  const data = await loadStore();
  return data.cursors?.[exportId]?.[table] || null;
}

async function setCursor(exportId, table, value) {
  await withPathLock(storePath(), async () => {
    const data = await loadStore();
    if (!data.cursors[exportId]) data.cursors[exportId] = {};
    data.cursors[exportId][table] = value;
    await saveStore(data);
  });
}

/**
 * Default data source: pulls rows from SiskelBot storage. Can be replaced
 * via runExport's `dataSource` option for testing.
 */
async function defaultLoadTable(table, opts = {}) {
  const { workspaceId = "default", since = null, dateColumn = null } = opts;
  // Lazy import to avoid circular deps and to keep tests lightweight.
  const storage = await import("./storage.js");
  let items = [];
  try {
    if (typeof storage.list === "function") {
      items = await storage.list(table, workspaceId);
    }
  } catch {
    items = [];
  }
  if (since && dateColumn && Array.isArray(items)) {
    const sinceMs = new Date(since).getTime();
    items = items.filter((row) => {
      const v = row?.[dateColumn];
      if (!v) return false;
      const ms = new Date(v).getTime();
      return Number.isFinite(ms) && ms > sinceMs;
    });
  }
  return Array.isArray(items) ? items : [];
}

/**
 * Coerce a row into the column types declared by the schema. Drops any
 * fields that aren't in the schema and converts dates / numbers / booleans.
 */
export function coerceRow(row, schema) {
  if (!row || typeof row !== "object" || !schema) return {};
  const out = {};
  for (const [col, type] of Object.entries(schema)) {
    const v = row[col];
    if (v === undefined || v === null) {
      out[col] = null;
      continue;
    }
    switch (type) {
      case "string":
        out[col] = typeof v === "string" ? v : JSON.stringify(v);
        break;
      case "integer":
        out[col] = Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null;
        break;
      case "number":
      case "float":
        out[col] = Number.isFinite(Number(v)) ? Number(v) : null;
        break;
      case "boolean":
        out[col] = !!v;
        break;
      case "timestamp":
      case "date":
        try {
          out[col] = new Date(v).toISOString();
        } catch {
          out[col] = null;
        }
        break;
      case "json":
        out[col] = typeof v === "object" ? v : { value: v };
        break;
      default:
        out[col] = v;
    }
  }
  return out;
}

/**
 * Execute an export now.
 *
 * @param {string} exportId
 * @param {object} [opts]
 * @param {Function} [opts.dataSource] - override (table, opts) => rows[]
 * @param {Function} [opts.adapterFactory] - override async (destination) => adapter
 * @returns {Promise<{status, rowsExported, duration, errors, tables}>}
 */
export async function runExport(exportId, opts = {}) {
  if (!exportId) throw new Error("runExport: exportId required");
  const cfg = await getExport(exportId);
  if (!cfg) {
    return { status: "failed", rowsExported: 0, duration: 0, errors: ["export not found"] };
  }
  if (!cfg.enabled) {
    return { status: "skipped", rowsExported: 0, duration: 0, errors: ["export disabled"] };
  }

  const start = Date.now();
  const errors = [];
  let rowsExported = 0;
  const tableResults = [];

  let adapter;
  try {
    const adapterMod = opts.adapterFactory
      ? await opts.adapterFactory(cfg.destination)
      : await loadAdapter(cfg.destination);
    adapter = await adapterMod.connect(cfg.credentials || {});
  } catch (e) {
    const failure = {
      status: "failed",
      rowsExported: 0,
      duration: Date.now() - start,
      errors: [`connect: ${e.message}`],
      tables: [],
    };
    await appendHistory(exportId, failure);
    return failure;
  }

  const loadFn = opts.dataSource || defaultLoadTable;
  const newCursors = {};

  for (const table of cfg.tables) {
    const schema = TABLE_SCHEMAS[table];
    if (!schema) {
      errors.push(`${table}: schema not found`);
      tableResults.push({ table, rows: 0, error: "schema not found" });
      continue;
    }
    let since = null;
    if (cfg.incremental && cfg.dateColumn) {
      since = await getCursor(exportId, table);
    }
    let rows = [];
    try {
      rows = await loadFn(table, {
        workspaceId: cfg.workspaceId,
        since,
        dateColumn: cfg.dateColumn,
      });
    } catch (e) {
      errors.push(`${table}: load failed: ${e.message}`);
      tableResults.push({ table, rows: 0, error: e.message });
      continue;
    }

    const coerced = rows.map((r) => coerceRow(r, schema));

    try {
      if (typeof adapter.createTable === "function") {
        await adapter.createTable(table, schema);
      }
      if (coerced.length > 0 && typeof adapter.insertBatch === "function") {
        await adapter.insertBatch(table, coerced);
      }
      rowsExported += coerced.length;
      tableResults.push({ table, rows: coerced.length });
      // Update cursor to most recent dateColumn value seen.
      if (cfg.incremental && cfg.dateColumn) {
        let max = since;
        for (const r of rows) {
          const v = r?.[cfg.dateColumn];
          if (!v) continue;
          if (!max || new Date(v).getTime() > new Date(max).getTime()) {
            max = v;
          }
        }
        if (max) newCursors[table] = max;
      }
    } catch (e) {
      errors.push(`${table}: insert failed: ${e.message}`);
      tableResults.push({ table, rows: 0, error: e.message });
    }
  }

  try {
    if (typeof adapter.close === "function") await adapter.close();
  } catch {
    // best-effort
  }

  // Persist any new cursors only when no errors occurred for that table.
  for (const [table, value] of Object.entries(newCursors)) {
    const failed = tableResults.find((r) => r.table === table && r.error);
    if (!failed) await setCursor(exportId, table, value);
  }

  const duration = Date.now() - start;
  const status = errors.length === 0 ? "success" : (rowsExported > 0 ? "partial" : "failed");
  const result = { status, rowsExported, duration, errors, tables: tableResults };
  await appendHistory(exportId, result);
  return result;
}

/**
 * Run any export schedules whose cron has matched within the past 2 minutes.
 * Mirrors the approach used by lib/scheduler.js#runDueJobsVercel.
 */
export async function runDueExports() {
  const data = await loadStore();
  const all = Object.values(data.exports).filter((e) => e.enabled && e.schedule);
  let ran = 0;
  const results = [];
  for (const e of all) {
    let isDue = false;
    try {
      const mod = await import("cron-parser");
      const parseExpression = mod.parseExpression || mod.default?.parseExpression;
      if (!parseExpression) continue;
      const interval = parseExpression(e.schedule, { currentDate: new Date() });
      const prevMs = interval.prev().toDate().getTime();
      if (Date.now() - prevMs < 120_000) isDue = true;
    } catch {
      continue;
    }
    if (!isDue) continue;
    try {
      const r = await runExport(e.id);
      results.push({ id: e.id, ...r });
      ran++;
    } catch (err) {
      results.push({ id: e.id, status: "failed", errors: [err.message] });
    }
  }
  return { ran, results };
}

/**
 * Test-only reset of the store file.
 */
export async function _resetForTesting() {
  await writeJsonPath(storePath(), {
    _version: STORE_VERSION,
    exports: {},
    history: {},
    cursors: {},
  });
}
