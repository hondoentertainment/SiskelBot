/**
 * Phase 39.5: data warehouse export tests.
 *
 * Covers CRUD on export configs, the S3 adapter (with mocked SDK),
 * schema mapping helpers, incremental export filtering by date column,
 * and error paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate file storage per-test-run before importing modules.
const TMP = mkdtempSync(join(tmpdir(), "data-warehouse-"));
process.env.STORAGE_PATH = TMP;

const dwMod = await import("../lib/data-warehouse.js");
const schemasMod = await import("../lib/warehouse-schemas.js");
const s3Mod = await import("../lib/warehouse-adapters/s3.js");

const {
  createExport,
  updateExport,
  listExports,
  getExport,
  deleteExport,
  runExport,
  getExportHistory,
  coerceRow,
  _resetForTesting,
} = dwMod;
const { TABLE_SCHEMAS, sqlTypeFor, buildCreateTableSQL } = schemasMod;

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
});

async function reset() {
  await _resetForTesting();
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

test("createExport: validates required fields", async () => {
  await reset();
  await assert.rejects(() => createExport({}), /name required/);
  await assert.rejects(
    () => createExport({ name: "x", destination: "bogus", tables: ["conversations"] }),
    /invalid destination/
  );
  await assert.rejects(
    () => createExport({ name: "x", destination: "s3", tables: [] }),
    /tables/
  );
  await assert.rejects(
    () => createExport({ name: "x", destination: "s3", tables: ["nope"] }),
    /unknown table/
  );
  await assert.rejects(
    () =>
      createExport({
        name: "x",
        destination: "s3",
        tables: ["messages"],
        incremental: true,
      }),
    /dateColumn/
  );
});

test("createExport: persists a valid config", async () => {
  await reset();
  const entry = await createExport({
    name: "Nightly to S3",
    destination: "s3",
    credentials: { bucket: "my-bucket" },
    tables: ["conversations", "messages"],
    schedule: "0 3 * * *",
    incremental: false,
    workspaceId: "ws1",
  });
  assert.ok(entry.id);
  assert.equal(entry.name, "Nightly to S3");
  assert.equal(entry.destination, "s3");
  assert.equal(entry.enabled, true);
  assert.deepEqual(entry.tables, ["conversations", "messages"]);

  const fetched = await getExport(entry.id);
  assert.equal(fetched.id, entry.id);
});

test("listExports: filters by workspaceId", async () => {
  await reset();
  await createExport({
    name: "ws1 export",
    destination: "s3",
    tables: ["conversations"],
    workspaceId: "ws1",
  });
  await createExport({
    name: "ws2 export",
    destination: "s3",
    tables: ["conversations"],
    workspaceId: "ws2",
  });
  const all = await listExports();
  assert.equal(all.length, 2);
  const ws1 = await listExports("ws1");
  assert.equal(ws1.length, 1);
  assert.equal(ws1[0].workspaceId, "ws1");
});

test("updateExport: merges patch and validates", async () => {
  await reset();
  const entry = await createExport({
    name: "X",
    destination: "s3",
    tables: ["conversations"],
  });
  const updated = await updateExport(entry.id, { name: "Renamed", schedule: "*/5 * * * *" });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.schedule, "*/5 * * * *");
  assert.equal(updated.id, entry.id);

  // Invalid patch
  await assert.rejects(
    () => updateExport(entry.id, { destination: "bogus" }),
    /invalid destination/
  );
  // Unknown table
  await assert.rejects(
    () => updateExport(entry.id, { tables: ["nope"] }),
    /unknown table/
  );

  // Returns null for missing id
  const missing = await updateExport("nonexistent-id", { name: "x" });
  assert.equal(missing, null);
});

test("deleteExport: removes config and history", async () => {
  await reset();
  const entry = await createExport({
    name: "X",
    destination: "s3",
    tables: ["conversations"],
  });
  const removed = await deleteExport(entry.id);
  assert.equal(removed, true);

  const fetched = await getExport(entry.id);
  assert.equal(fetched, null);

  const removedAgain = await deleteExport(entry.id);
  assert.equal(removedAgain, false);
});

// ---------------------------------------------------------------------------
// Schema mapping
// ---------------------------------------------------------------------------

test("TABLE_SCHEMAS: includes all required tables", () => {
  const required = [
    "conversations",
    "messages",
    "knowledge_documents",
    "usage_events",
    "audit_log",
  ];
  for (const t of required) {
    assert.ok(TABLE_SCHEMAS[t], `${t} should be defined`);
    assert.ok(Object.keys(TABLE_SCHEMAS[t]).length > 0);
  }
});

test("sqlTypeFor: maps logical types per destination", () => {
  assert.equal(sqlTypeFor("snowflake", "string"), "VARCHAR");
  assert.equal(sqlTypeFor("snowflake", "json"), "VARIANT");
  assert.equal(sqlTypeFor("bigquery", "string"), "STRING");
  assert.equal(sqlTypeFor("bigquery", "integer"), "INT64");
  assert.equal(sqlTypeFor("redshift", "json"), "SUPER");
  assert.equal(sqlTypeFor("redshift", "boolean"), "BOOLEAN");
  assert.equal(sqlTypeFor("snowflake", "unknown-type"), "VARCHAR");
});

test("buildCreateTableSQL: produces a valid statement", () => {
  const sql = buildCreateTableSQL("snowflake", "conversations", TABLE_SCHEMAS.conversations);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS conversations/);
  assert.match(sql, /id VARCHAR/);
  assert.match(sql, /metadata VARIANT/);
});

test("coerceRow: converts values to schema types", () => {
  const schema = {
    id: "string",
    count: "integer",
    score: "number",
    flag: "boolean",
    when: "timestamp",
    extras: "json",
  };
  const row = coerceRow(
    {
      id: 42,
      count: "17",
      score: "3.14",
      flag: 1,
      when: "2026-04-11T00:00:00Z",
      extras: { a: 1 },
      ignored: "dropped",
    },
    schema
  );
  assert.equal(row.id, "42");
  assert.equal(row.count, 17);
  assert.equal(row.score, 3.14);
  assert.equal(row.flag, true);
  assert.equal(row.when, "2026-04-11T00:00:00.000Z");
  assert.deepEqual(row.extras, { a: 1 });
  assert.equal(row.ignored, undefined);
});

test("coerceRow: handles null and undefined gracefully", () => {
  const schema = { id: "string", count: "integer" };
  const row = coerceRow({ id: null, count: undefined }, schema);
  assert.equal(row.id, null);
  assert.equal(row.count, null);
});

// ---------------------------------------------------------------------------
// S3 adapter (mocked SDK)
// ---------------------------------------------------------------------------

test("s3 adapter: requires bucket", async () => {
  await assert.rejects(() => s3Mod.connect({}), /bucket required/);
});

test("s3 adapter: writes batches via injected client", async () => {
  const sent = [];
  const fakeClient = {
    send: async (cmd) => {
      sent.push(cmd);
      return {};
    },
    destroy: () => {},
  };
  class FakePutObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const adapter = await s3Mod.connect({
    bucket: "my-bucket",
    prefix: "tests/",
    s3Client: fakeClient,
    PutObjectCommand: FakePutObjectCommand,
  });
  await adapter.createTable("conversations", TABLE_SCHEMAS.conversations);
  await adapter.insertBatch("conversations", [
    { id: "c1", title: "hello" },
    { id: "c2", title: "world" },
  ]);
  // Empty batch should be a no-op.
  await adapter.insertBatch("conversations", []);
  await adapter.close();

  assert.equal(sent.length, 1);
  const put = sent[0];
  assert.equal(put.input.Bucket, "my-bucket");
  assert.match(put.input.Key, /^tests\/conversations\/dt=\d{4}-\d{2}-\d{2}\//);
  assert.match(put.input.Key, /\.jsonl$/);
  assert.equal(put.input.ContentType, "application/x-ndjson");
  // Body should be NDJSON.
  const lines = String(put.input.Body).split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { id: "c1", title: "hello" });
  assert.equal(adapter.writtenKeys.length, 1);
});

// ---------------------------------------------------------------------------
// runExport with injected adapter + data source
// ---------------------------------------------------------------------------

test("runExport: success path with injected adapter and data source", async () => {
  await reset();
  const entry = await createExport({
    name: "test",
    destination: "s3",
    tables: ["conversations", "messages"],
  });

  const inserts = [];
  const fakeAdapter = {
    createTable: async () => {},
    insertBatch: async (table, rows) => {
      inserts.push({ table, count: rows.length });
    },
    close: async () => {},
  };
  const adapterFactory = async () => ({ connect: async () => fakeAdapter });

  const dataByTable = {
    conversations: [
      { id: "c1", title: "Hello" },
      { id: "c2", title: "World" },
    ],
    messages: [{ id: "m1", role: "user", content: "hi" }],
  };
  const dataSource = async (table) => dataByTable[table] || [];

  const result = await runExport(entry.id, { adapterFactory, dataSource });
  assert.equal(result.status, "success");
  assert.equal(result.rowsExported, 3);
  assert.equal(result.errors.length, 0);
  assert.equal(result.tables.length, 2);

  const history = await getExportHistory(entry.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].rowsExported, 3);
});

test("runExport: returns failed when export id is unknown", async () => {
  await reset();
  const result = await runExport("nonexistent-id");
  assert.equal(result.status, "failed");
  assert.match(result.errors.join(" "), /not found/);
});

test("runExport: skipped when export disabled", async () => {
  await reset();
  const entry = await createExport({
    name: "off",
    destination: "s3",
    tables: ["conversations"],
  });
  await updateExport(entry.id, { enabled: false });
  const result = await runExport(entry.id);
  assert.equal(result.status, "skipped");
});

test("runExport: connect failure produces failed result with error", async () => {
  await reset();
  const entry = await createExport({
    name: "boom",
    destination: "s3",
    tables: ["conversations"],
  });
  const adapterFactory = async () => ({
    connect: async () => {
      throw new Error("creds bad");
    },
  });
  const result = await runExport(entry.id, {
    adapterFactory,
    dataSource: async () => [],
  });
  assert.equal(result.status, "failed");
  assert.match(result.errors[0], /creds bad/);
  // History should record the failure.
  const history = await getExportHistory(entry.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "failed");
});

test("runExport: per-table insert error produces partial status", async () => {
  await reset();
  const entry = await createExport({
    name: "partial",
    destination: "s3",
    tables: ["conversations", "messages"],
  });
  const fakeAdapter = {
    createTable: async () => {},
    insertBatch: async (table) => {
      if (table === "messages") throw new Error("insert blew up");
    },
    close: async () => {},
  };
  const adapterFactory = async () => ({ connect: async () => fakeAdapter });
  const dataSource = async (table) => {
    if (table === "conversations") return [{ id: "c1", title: "ok" }];
    if (table === "messages") return [{ id: "m1", role: "user", content: "x" }];
    return [];
  };
  const result = await runExport(entry.id, { adapterFactory, dataSource });
  assert.equal(result.status, "partial");
  assert.equal(result.rowsExported, 1);
  assert.ok(result.errors.some((e) => e.includes("messages")));
});

// ---------------------------------------------------------------------------
// Incremental exports
// ---------------------------------------------------------------------------

test("runExport: incremental filters by dateColumn and advances cursor", async () => {
  await reset();
  const entry = await createExport({
    name: "incremental",
    destination: "s3",
    tables: ["messages"],
    incremental: true,
    dateColumn: "created_at",
  });

  const allRows = [
    { id: "m1", role: "user", content: "old", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", role: "user", content: "mid", created_at: "2026-02-01T00:00:00Z" },
    { id: "m3", role: "user", content: "new", created_at: "2026-03-01T00:00:00Z" },
  ];

  const calls = [];
  const fakeAdapter = {
    createTable: async () => {},
    insertBatch: async (table, rows) => {
      calls.push({ table, rows });
    },
    close: async () => {},
  };
  const adapterFactory = async () => ({ connect: async () => fakeAdapter });

  // Simulate the storage layer with a custom data source that respects
  // the `since` filter just like defaultLoadTable would.
  const dataSource = async (table, opts) => {
    if (opts.since) {
      const sinceMs = new Date(opts.since).getTime();
      return allRows.filter((r) => new Date(r[opts.dateColumn]).getTime() > sinceMs);
    }
    return allRows;
  };

  // First run: no cursor → exports everything.
  const r1 = await runExport(entry.id, { adapterFactory, dataSource });
  assert.equal(r1.status, "success");
  assert.equal(r1.rowsExported, 3);
  assert.equal(calls[0].rows.length, 3);

  // Second run: cursor should now be at the most-recent row, so nothing new.
  calls.length = 0;
  const r2 = await runExport(entry.id, { adapterFactory, dataSource });
  assert.equal(r2.status, "success");
  assert.equal(r2.rowsExported, 0);

  // Add a newer row and run again.
  allRows.push({
    id: "m4",
    role: "user",
    content: "newer",
    created_at: "2026-04-01T00:00:00Z",
  });
  calls.length = 0;
  const r3 = await runExport(entry.id, { adapterFactory, dataSource });
  assert.equal(r3.status, "success");
  assert.equal(r3.rowsExported, 1);
  assert.equal(calls[0].rows.length, 1);
  assert.equal(calls[0].rows[0].id, "m4");
});

test("runExport: incremental cursor not advanced on insert failure", async () => {
  await reset();
  const entry = await createExport({
    name: "incremental-fail",
    destination: "s3",
    tables: ["messages"],
    incremental: true,
    dateColumn: "created_at",
  });

  const rows = [
    { id: "m1", role: "user", content: "x", created_at: "2026-01-01T00:00:00Z" },
  ];
  const fakeAdapter = {
    createTable: async () => {},
    insertBatch: async () => {
      throw new Error("nope");
    },
    close: async () => {},
  };
  const adapterFactory = async () => ({ connect: async () => fakeAdapter });
  const dataSource = async () => rows;

  const r1 = await runExport(entry.id, { adapterFactory, dataSource });
  assert.equal(r1.status, "failed");

  // Second run: data source should be called with no cursor (cursor not set).
  let observedSince;
  const dataSource2 = async (_table, opts) => {
    observedSince = opts.since;
    return [];
  };
  await runExport(entry.id, { adapterFactory: async () => ({ connect: async () => fakeAdapter }), dataSource: dataSource2 });
  assert.equal(observedSince, null);
});

test("getExportHistory: requires id", async () => {
  await assert.rejects(() => getExportHistory(""), /id required/);
});
