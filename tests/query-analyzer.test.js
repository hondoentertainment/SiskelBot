import test from "node:test";
import assert from "node:assert/strict";
import {
  createQueryAnalyzer,
  normalizeQuery,
  extractTables,
  extractWhereColumns,
} from "../lib/query-analyzer.js";

// Ensure the slow threshold is predictable across tests.
process.env.SLOW_QUERY_THRESHOLD_MS = "100";

test("normalizeQuery: replaces string literals with ?", () => {
  const q = "SELECT * FROM users WHERE name = 'alice'";
  assert.equal(normalizeQuery(q), "SELECT * FROM users WHERE name = ?");
});

test("normalizeQuery: replaces numeric literals with ?", () => {
  const q = "SELECT * FROM users WHERE id = 42 AND age > 18";
  assert.equal(
    normalizeQuery(q),
    "SELECT * FROM users WHERE id = ? AND age > ?"
  );
});

test("normalizeQuery: replaces positional parameters ($1, $2) with ?", () => {
  const q = "SELECT * FROM users WHERE id = $1 AND name = $2";
  assert.equal(
    normalizeQuery(q),
    "SELECT * FROM users WHERE id = ? AND name = ?"
  );
});

test("normalizeQuery: collapses repeated whitespace and trims", () => {
  const q = "  SELECT\n  *\tFROM  users\n\nWHERE id = 1  ";
  assert.equal(normalizeQuery(q), "SELECT * FROM users WHERE id = ?");
});

test("normalizeQuery: equivalent queries map to the same fingerprint", () => {
  const a = "SELECT * FROM users WHERE id = 1";
  const b = "SELECT * FROM users WHERE id = 99";
  const c = "SELECT * FROM users WHERE id = $1";
  assert.equal(normalizeQuery(a), normalizeQuery(b));
  assert.equal(normalizeQuery(a), normalizeQuery(c));
});

test("normalizeQuery: empty/null input returns empty string", () => {
  assert.equal(normalizeQuery(""), "");
  assert.equal(normalizeQuery(null), "");
  assert.equal(normalizeQuery(undefined), "");
});

test("extractTables: captures FROM and JOIN tables", () => {
  const q = "SELECT * FROM users u JOIN orders o ON u.id = o.user_id";
  const tables = extractTables(q);
  assert.ok(tables.includes("users"));
  assert.ok(tables.includes("orders"));
});

test("extractWhereColumns: captures simple WHERE columns", () => {
  const q = "SELECT * FROM users WHERE email = 'x' AND created_at > 123";
  const cols = extractWhereColumns(q);
  assert.ok(cols.includes("email"));
  assert.ok(cols.includes("created_at"));
});

test("recordQuery: aggregates stats for the same fingerprint", () => {
  const a = createQueryAnalyzer();
  a.recordQuery("SELECT * FROM users WHERE id = 1", [], 10);
  a.recordQuery("SELECT * FROM users WHERE id = 2", [], 20);
  a.recordQuery("SELECT * FROM users WHERE id = 3", [], 30);

  const fp = normalizeQuery("SELECT * FROM users WHERE id = 1");
  const stats = a.getQueryStats(fp);
  assert.equal(stats.count, 3);
  assert.equal(stats.totalMs, 60);
  assert.equal(stats.avgMs, 20);
  assert.equal(stats.maxMs, 30);
  assert.equal(stats.minMs, 10);
  assert.equal(stats.errors, 0);
});

test("recordQuery: tracks errors", () => {
  const a = createQueryAnalyzer();
  a.recordQuery("SELECT * FROM users WHERE id = 1", [], 5);
  a.recordQuery("SELECT * FROM users WHERE id = 1", [], 5, new Error("boom"));
  const fp = normalizeQuery("SELECT * FROM users WHERE id = 1");
  const stats = a.getQueryStats(fp);
  assert.equal(stats.count, 2);
  assert.equal(stats.errors, 1);
});

test("recordQuery: ignores empty queries", () => {
  const a = createQueryAnalyzer();
  a.recordQuery("", [], 10);
  a.recordQuery(null, [], 10);
  assert.equal(a._size().queries, 0);
});

test("getSlowQueries: captures queries over the threshold", () => {
  const a = createQueryAnalyzer();
  a.recordQuery("SELECT * FROM users WHERE id = 1", [], 10);
  a.recordQuery("SELECT * FROM users WHERE id = 2", [], 150);
  a.recordQuery("SELECT * FROM orders WHERE id = 3", [], 500);

  const slow = a.getSlowQueries(10);
  assert.equal(slow.length, 2);
  // Newest-first ordering
  assert.ok(slow[0].durationMs >= 500);
  assert.ok(slow.every((s) => s.durationMs >= 100));
});

test("getSlowQueries: excludes queries below threshold", () => {
  const a = createQueryAnalyzer();
  a.recordQuery("SELECT 1", [], 1);
  a.recordQuery("SELECT 2", [], 50);
  a.recordQuery("SELECT 3", [], 99);
  assert.equal(a.getSlowQueries(10).length, 0);
});

test("getSlowQueries: respects the limit argument", () => {
  const a = createQueryAnalyzer();
  for (let i = 0; i < 20; i++) {
    a.recordQuery(`SELECT * FROM users WHERE id = ${i}`, [], 200);
  }
  assert.equal(a.getSlowQueries(5).length, 5);
});

test("getTopQueries: sorts by total_time by default", () => {
  const a = createQueryAnalyzer();
  a.recordQuery("SELECT * FROM a WHERE id = 1", [], 10);
  a.recordQuery("SELECT * FROM a WHERE id = 2", [], 10);
  a.recordQuery("SELECT * FROM a WHERE id = 3", [], 10);
  a.recordQuery("SELECT * FROM b WHERE id = 1", [], 200);
  const top = a.getTopQueries("total_time", 10);
  // Even though `a` has more calls, `b` has higher totalMs (200 vs 30).
  assert.ok(top[0].sample.includes("FROM b"));
});

test("getTopQueries: sorts by count", () => {
  const a = createQueryAnalyzer();
  a.recordQuery("SELECT * FROM a WHERE id = 1", [], 10);
  a.recordQuery("SELECT * FROM a WHERE id = 2", [], 10);
  a.recordQuery("SELECT * FROM a WHERE id = 3", [], 10);
  a.recordQuery("SELECT * FROM b WHERE id = 1", [], 200);
  const top = a.getTopQueries("count", 10);
  assert.ok(top[0].sample.includes("FROM a"));
  assert.equal(top[0].count, 3);
});

test("getTopQueries: sorts by avg_time", () => {
  const a = createQueryAnalyzer();
  // `a` averages 10ms, `b` averages 200ms
  a.recordQuery("SELECT * FROM a WHERE id = 1", [], 10);
  a.recordQuery("SELECT * FROM a WHERE id = 2", [], 10);
  a.recordQuery("SELECT * FROM b WHERE id = 1", [], 200);
  const top = a.getTopQueries("avg_time", 10);
  assert.ok(top[0].sample.includes("FROM b"));
});

test("getTopQueries: sorts by max_time", () => {
  const a = createQueryAnalyzer();
  a.recordQuery("SELECT * FROM a WHERE id = 1", [], 10);
  a.recordQuery("SELECT * FROM a WHERE id = 2", [], 50);
  a.recordQuery("SELECT * FROM b WHERE id = 1", [], 25);
  a.recordQuery("SELECT * FROM b WHERE id = 2", [], 25);
  const top = a.getTopQueries("max_time", 10);
  assert.ok(top[0].sample.includes("FROM a"));
});

test("getTopQueries: respects the limit", () => {
  const a = createQueryAnalyzer();
  for (let i = 0; i < 10; i++) {
    a.recordQuery(`SELECT * FROM t${i} WHERE id = 1`, [], 5);
  }
  assert.equal(a.getTopQueries("count", 3).length, 3);
});

test("clear: resets all stats", () => {
  const a = createQueryAnalyzer();
  a.recordQuery("SELECT * FROM users WHERE id = 1", [], 200);
  a.clear();
  assert.equal(a._size().queries, 0);
  assert.equal(a._size().slow, 0);
  assert.equal(a.getSlowQueries(10).length, 0);
  assert.equal(a.getTopQueries("count", 10).length, 0);
});

test("getQueryStats: returns null for unknown fingerprint", () => {
  const a = createQueryAnalyzer();
  assert.equal(a.getQueryStats("nope"), null);
});

// ─── Mock pg pool tests ───────────────────────────

function mockPool(responses) {
  // responses: Array<{ match: RegExp | string, rows: any[] }> or Function
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (typeof responses === "function") {
        return responses(sql, params);
      }
      for (const r of responses) {
        if (
          (r.match instanceof RegExp && r.match.test(sql)) ||
          (typeof r.match === "string" && sql.includes(r.match))
        ) {
          if (r.error) throw r.error;
          return { rows: r.rows || [] };
        }
      }
      return { rows: [] };
    },
  };
}

test("analyzeQuery: rejects non-SELECT statements", async () => {
  const a = createQueryAnalyzer();
  const pool = mockPool([]);
  await assert.rejects(
    () => a.analyzeQuery(pool, "UPDATE users SET name = 'x'"),
    /only SELECT/i
  );
  await assert.rejects(
    () => a.analyzeQuery(pool, "DELETE FROM users"),
    /only SELECT/i
  );
});

test("analyzeQuery: rejects empty queries", async () => {
  const a = createQueryAnalyzer();
  const pool = mockPool([]);
  await assert.rejects(() => a.analyzeQuery(pool, ""), /query is required/);
});

test("analyzeQuery: rejects missing pool", async () => {
  const a = createQueryAnalyzer();
  await assert.rejects(
    () => a.analyzeQuery(null, "SELECT 1"),
    /pool with \.query/
  );
});

test("analyzeQuery: issues EXPLAIN ANALYZE and parses plan", async () => {
  const a = createQueryAnalyzer();
  const mockPlan = [
    {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "users",
        "Total Cost": 123.45,
        "Actual Rows": 5000,
        "Actual Total Time": 42.1,
      },
      "Execution Time": 45.2,
      "Planning Time": 0.8,
    },
  ];
  const pool = mockPool([
    { match: /^EXPLAIN.*SELECT/i, rows: [{ "QUERY PLAN": mockPlan }] },
  ]);
  const result = await a.analyzeQuery(pool, "SELECT * FROM users");
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /^EXPLAIN \(ANALYZE, BUFFERS, FORMAT JSON\)/);
  assert.equal(result.estimatedCost, 123.45);
  assert.equal(result.actualTime, 45.2);
  assert.equal(result.planningTime, 0.8);
  // Should detect the seq scan on a wide table
  assert.ok(
    result.recommendations.some(
      (r) => r.type === "seq_scan" && r.table === "users"
    )
  );
});

test("suggestIndexes: builds suggestions from slow queries", async () => {
  const a = createQueryAnalyzer();
  // Record a few slow queries against the same table+column.
  a.recordQuery(
    "SELECT * FROM orders WHERE customer_id = 1",
    [],
    250
  );
  a.recordQuery(
    "SELECT * FROM orders WHERE customer_id = 2",
    [],
    300
  );
  a.recordQuery(
    "SELECT * FROM orders WHERE customer_id = 3",
    [],
    275
  );

  // Mock pool reports no existing indexes, so the suggestion should survive.
  const pool = mockPool([
    { match: /pg_indexes/i, rows: [] },
  ]);
  const suggestions = await a.suggestIndexes(pool);
  assert.ok(suggestions.length >= 1);
  const s = suggestions.find((x) => x.table === "orders");
  assert.ok(s, "expected a suggestion for the `orders` table");
  assert.deepEqual(s.columns, ["customer_id"]);
  assert.match(s.createStatement, /CREATE INDEX.*orders.*customer_id/i);
  assert.ok(s.occurrences >= 3);
});

test("suggestIndexes: skips suggestions already covered by existing indexes", async () => {
  const a = createQueryAnalyzer();
  a.recordQuery(
    "SELECT * FROM orders WHERE customer_id = 1",
    [],
    250
  );
  // Pool reports an existing index covering `customer_id`.
  const pool = mockPool([
    {
      match: /pg_indexes/i,
      rows: [
        {
          tablename: "orders",
          indexname: "idx_orders_customer_id",
          indexdef:
            "CREATE INDEX idx_orders_customer_id ON orders USING btree (customer_id)",
        },
      ],
    },
  ]);
  const suggestions = await a.suggestIndexes(pool);
  const s = suggestions.find((x) => x.table === "orders");
  assert.equal(s, undefined);
});

test("suggestIndexes: works without a pool (no existing-index enrichment)", async () => {
  const a = createQueryAnalyzer();
  a.recordQuery(
    "SELECT * FROM orders WHERE customer_id = 1",
    [],
    250
  );
  const suggestions = await a.suggestIndexes(null);
  assert.ok(suggestions.some((s) => s.table === "orders"));
});

test("getTableStats: projects pg_stat_user_tables rows", async () => {
  const a = createQueryAnalyzer();
  const pool = mockPool([
    {
      match: /pg_stat_user_tables/i,
      rows: [
        {
          table: "users",
          row_count: "1000",
          seq_scans: "20",
          idx_scans: "80",
          dead_tuples: "50",
          n_tup_ins: "100",
          n_tup_upd: "50",
          n_tup_del: "10",
          last_autovacuum: null,
          last_autoanalyze: null,
        },
      ],
    },
  ]);
  const stats = await a.getTableStats(pool);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].table, "users");
  assert.equal(stats[0].rowCount, 1000);
  assert.equal(stats[0].seqScans, 20);
  assert.equal(stats[0].idxScans, 80);
  assert.equal(stats[0].deadTuples, 50);
  // 80 / (20 + 80) = 0.8
  assert.equal(stats[0].idxScanRatio, 0.8);
  // 50 / 1000 * 100 = 5%
  assert.equal(stats[0].bloatPct, 5);
});

test("getTableStats: rejects missing pool", async () => {
  const a = createQueryAnalyzer();
  await assert.rejects(() => a.getTableStats(null), /pool with \.query/);
});
