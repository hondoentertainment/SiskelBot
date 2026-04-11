/**
 * Phase 35.4: Query performance analyzer for PostgreSQL.
 *
 * Tracks slow queries, aggregates stats by normalized fingerprint, suggests
 * missing indexes from observed slow queries, and wraps pg EXPLAIN ANALYZE
 * for ad-hoc inspection. Backend-agnostic: the analyzer never imports `pg`
 * directly; callers pass a pool/client with a `.query()` method.
 *
 * Typical usage:
 *
 *   import { globalQueryAnalyzer } from "./query-analyzer.js";
 *
 *   async function query(text, params) {
 *     const start = Date.now();
 *     try {
 *       const result = await pool.query(text, params);
 *       globalQueryAnalyzer.recordQuery(text, params, Date.now() - start);
 *       return result;
 *     } catch (err) {
 *       globalQueryAnalyzer.recordQuery(text, params, Date.now() - start, err);
 *       throw err;
 *     }
 *   }
 */

const SLOW_QUERY_THRESHOLD_MS =
  Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 100;
const MAX_RECORDED_QUERIES = 1000;
const MAX_SLOW_QUERY_BUFFER = 500;

/**
 * Normalize a SQL query by replacing literals and numeric parameters.
 * The result is suitable as a fingerprint key for aggregating stats across
 * calls that differ only by bound values.
 *
 * @param {string} query
 * @returns {string}
 */
export function normalizeQuery(query) {
  return String(query ?? "")
    .replace(/'[^']*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\b\d+\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract table names that appear after FROM / JOIN / UPDATE / INTO clauses.
 * Best-effort only — used for index suggestions, not for routing or
 * security.
 *
 * @param {string} query
 * @returns {string[]} lowercased, de-duplicated table names
 */
export function extractTables(query) {
  const q = String(query ?? "");
  const tables = new Set();
  const re =
    /\b(?:from|join|update|into)\s+(?:only\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)/gi;
  let m;
  while ((m = re.exec(q)) !== null) {
    const t = m[1].toLowerCase().replace(/^"|"$/g, "");
    if (t && !["select", "where", "set"].includes(t)) tables.add(t);
  }
  return Array.from(tables);
}

/**
 * Extract column references that appear in WHERE clauses of the query.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function extractWhereColumns(query) {
  const q = String(query ?? "");
  const cols = new Set();
  // Capture the (first) WHERE clause; stop at ORDER BY / GROUP BY / LIMIT /
  // RETURNING / end of string.
  const whereMatch = q.match(
    /\bwhere\b([\s\S]*?)(?:\border\s+by\b|\bgroup\s+by\b|\blimit\b|\breturning\b|$)/i
  );
  if (!whereMatch) return [];
  const clause = whereMatch[1];
  const re = /([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:=|<|>|<=|>=|!=|<>|in\b|like\b)/gi;
  let m;
  while ((m = re.exec(clause)) !== null) {
    const c = m[1].toLowerCase();
    if (
      !["and", "or", "not", "where", "is", "null", "in", "like"].includes(c)
    ) {
      cols.add(c);
    }
  }
  return Array.from(cols);
}

/**
 * Create a new query analyzer instance with an isolated in-memory store.
 * Tests should use a fresh instance; production code uses
 * {@link globalQueryAnalyzer}.
 */
export function createQueryAnalyzer() {
  /** @type {Map<string, { fingerprint: string, sample: string, count: number, totalMs: number, maxMs: number, minMs: number, errors: number, lastSeen: number, firstSeen: number }>} */
  const queries = new Map();
  /** @type {Array<{ query: string, fingerprint: string, durationMs: number, timestamp: number, params?: any, error?: string }>} */
  const slowQueries = [];

  function slowThreshold() {
    return Number(process.env.SLOW_QUERY_THRESHOLD_MS) || SLOW_QUERY_THRESHOLD_MS;
  }

  return {
    /**
     * Record a completed query. Aggregates stats by normalized fingerprint
     * and, if `durationMs` exceeds the slow-query threshold, also appends
     * the full query text to the slow-query ring buffer.
     *
     * @param {string} query
     * @param {any} params
     * @param {number} durationMs
     * @param {Error} [error]
     */
    recordQuery(query, params, durationMs, error) {
      const fingerprint = normalizeQuery(query);
      if (!fingerprint) return;
      const now = Date.now();
      const ms = Math.max(0, Number(durationMs) || 0);
      let entry = queries.get(fingerprint);
      if (!entry) {
        // Evict oldest fingerprint if we're past the cap.
        if (queries.size >= MAX_RECORDED_QUERIES) {
          let oldestKey = null;
          let oldestTs = Infinity;
          for (const [k, v] of queries) {
            if (v.lastSeen < oldestTs) {
              oldestTs = v.lastSeen;
              oldestKey = k;
            }
          }
          if (oldestKey) queries.delete(oldestKey);
        }
        entry = {
          fingerprint,
          sample: String(query),
          count: 0,
          totalMs: 0,
          maxMs: 0,
          minMs: Infinity,
          errors: 0,
          lastSeen: now,
          firstSeen: now,
        };
        queries.set(fingerprint, entry);
      }
      entry.count += 1;
      entry.totalMs += ms;
      if (ms > entry.maxMs) entry.maxMs = ms;
      if (ms < entry.minMs) entry.minMs = ms;
      entry.lastSeen = now;
      if (error) entry.errors += 1;

      if (ms >= slowThreshold()) {
        slowQueries.push({
          query: String(query),
          fingerprint,
          durationMs: ms,
          timestamp: now,
          params: params == null ? undefined : params,
          error: error ? String(error.message || error) : undefined,
        });
        if (slowQueries.length > MAX_SLOW_QUERY_BUFFER) {
          slowQueries.splice(0, slowQueries.length - MAX_SLOW_QUERY_BUFFER);
        }
      }
    },

    /**
     * Get aggregated stats for a single normalized fingerprint.
     *
     * @param {string} fingerprint
     */
    getQueryStats(fingerprint) {
      const entry = queries.get(String(fingerprint || ""));
      if (!entry) return null;
      return {
        fingerprint: entry.fingerprint,
        sample: entry.sample,
        count: entry.count,
        totalMs: entry.totalMs,
        avgMs: entry.count > 0 ? entry.totalMs / entry.count : 0,
        maxMs: entry.maxMs,
        minMs: entry.minMs === Infinity ? 0 : entry.minMs,
        errors: entry.errors,
        lastSeen: entry.lastSeen,
        firstSeen: entry.firstSeen,
      };
    },

    /**
     * Return the most recent slow-query instances (newest first).
     *
     * @param {number} [limit=50]
     */
    getSlowQueries(limit = 50) {
      const lim = Math.max(1, Math.min(MAX_SLOW_QUERY_BUFFER, Number(limit) || 50));
      const out = [];
      // Iterate newest-first.
      for (let i = slowQueries.length - 1; i >= 0 && out.length < lim; i--) {
        const sq = slowQueries[i];
        const entry = queries.get(sq.fingerprint);
        out.push({
          query: sq.query,
          fingerprint: sq.fingerprint,
          durationMs: sq.durationMs,
          timestamp: sq.timestamp,
          params: sq.params,
          error: sq.error,
          count: entry?.count ?? 1,
          avgMs: entry && entry.count > 0 ? entry.totalMs / entry.count : sq.durationMs,
        });
      }
      return out;
    },

    /**
     * Return top aggregated queries sorted by one of:
     * `'count' | 'total_time' | 'avg_time' | 'max_time'`.
     *
     * @param {string} [sortBy='total_time']
     * @param {number} [limit=20]
     */
    getTopQueries(sortBy = "total_time", limit = 20) {
      const lim = Math.max(1, Math.min(MAX_RECORDED_QUERIES, Number(limit) || 20));
      const all = Array.from(queries.values()).map((e) => ({
        fingerprint: e.fingerprint,
        sample: e.sample,
        count: e.count,
        totalMs: e.totalMs,
        avgMs: e.count > 0 ? e.totalMs / e.count : 0,
        maxMs: e.maxMs,
        minMs: e.minMs === Infinity ? 0 : e.minMs,
        errors: e.errors,
        lastSeen: e.lastSeen,
      }));
      const sorters = {
        count: (a, b) => b.count - a.count,
        total_time: (a, b) => b.totalMs - a.totalMs,
        avg_time: (a, b) => b.avgMs - a.avgMs,
        max_time: (a, b) => b.maxMs - a.maxMs,
      };
      const sorter = sorters[sortBy] || sorters.total_time;
      all.sort(sorter);
      return all.slice(0, lim);
    },

    /**
     * Run EXPLAIN ANALYZE on a query against the given pool, and return a
     * structured summary of the plan, cost, and actual timing.
     *
     * @param {{ query: Function }} pool
     * @param {string} query
     * @param {any[]} [params]
     */
    async analyzeQuery(pool, query, params) {
      if (!pool || typeof pool.query !== "function") {
        throw new Error("pool with .query() is required");
      }
      const trimmed = String(query || "").trim();
      if (!trimmed) throw new Error("query is required");
      // Reject statements that could mutate state.
      if (!/^\s*select\b/i.test(trimmed)) {
        throw new Error("only SELECT queries may be analyzed");
      }
      const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${trimmed}`;
      const result = await pool.query(explainSql, params || []);
      const rows = result?.rows || [];
      const plan = rows[0]?.["QUERY PLAN"] || rows[0] || null;
      const planNode =
        Array.isArray(plan) && plan[0]?.Plan
          ? plan[0].Plan
          : plan?.Plan || plan;
      const topLevel = Array.isArray(plan) ? plan[0] : plan;
      const estimatedCost = planNode?.["Total Cost"] ?? null;
      const actualTime =
        topLevel?.["Execution Time"] ?? planNode?.["Actual Total Time"] ?? null;
      const planningTime = topLevel?.["Planning Time"] ?? null;

      const recommendations = [];
      const scanSeq = findNodes(planNode, (n) => n?.["Node Type"] === "Seq Scan");
      for (const s of scanSeq) {
        if ((s["Actual Rows"] || 0) > 1000) {
          recommendations.push({
            type: "seq_scan",
            table: s["Relation Name"] || "unknown",
            rows: s["Actual Rows"],
            message: `Sequential scan on ${s["Relation Name"]} reading ${s["Actual Rows"]} rows. Consider adding an index on the filter column.`,
          });
        }
      }
      if ((actualTime ?? 0) > slowThreshold()) {
        recommendations.push({
          type: "slow_execution",
          message: `Query took ${Math.round(actualTime)}ms (threshold ${slowThreshold()}ms).`,
        });
      }

      return {
        plan,
        estimatedCost,
        actualTime,
        planningTime,
        recommendations,
      };
    },

    /**
     * Generate index suggestions based on recorded slow queries. For each
     * slow query, heuristically picks WHERE-clause columns on the first
     * referenced table as an index candidate.
     *
     * @param {{ query: Function }} [pool] - optional pool to enrich with
     *   existing index info. When omitted, returns raw heuristics.
     */
    async suggestIndexes(pool) {
      /** @type {Map<string, { table: string, columns: string[], reason: string, occurrences: number, totalMs: number, sample: string }>} */
      const suggestions = new Map();

      const slowByFingerprint = new Map();
      for (const sq of slowQueries) {
        const bucket = slowByFingerprint.get(sq.fingerprint) || [];
        bucket.push(sq);
        slowByFingerprint.set(sq.fingerprint, bucket);
      }

      for (const [fingerprint, instances] of slowByFingerprint) {
        const sample = instances[0]?.query || fingerprint;
        const tables = extractTables(sample);
        const cols = extractWhereColumns(sample);
        if (!tables.length || !cols.length) continue;
        const primaryTable = tables[0];
        // Strip the `table.` prefix if present.
        const normalizedCols = cols.map((c) =>
          c.includes(".") ? c.split(".").pop() : c
        );
        const key = `${primaryTable}|${normalizedCols.sort().join(",")}`;
        const existing = suggestions.get(key);
        const entry = queries.get(fingerprint);
        const totalMs = entry?.totalMs || instances.reduce((a, b) => a + b.durationMs, 0);
        if (existing) {
          existing.occurrences += instances.length;
          existing.totalMs += totalMs;
        } else {
          suggestions.set(key, {
            table: primaryTable,
            columns: normalizedCols,
            reason: `Slow ${instances.length === 1 ? "query" : "queries"} filter on ${normalizedCols.join(", ")}`,
            occurrences: instances.length,
            totalMs,
            sample,
          });
        }
      }

      // Optionally enrich with the pre-existing index set so we can skip
      // suggestions that are already covered.
      let existingIndexes = new Map();
      if (pool && typeof pool.query === "function") {
        try {
          const r = await pool.query(
            `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`
          );
          for (const row of r?.rows || []) {
            const t = (row.tablename || "").toLowerCase();
            const list = existingIndexes.get(t) || [];
            list.push(String(row.indexdef || "").toLowerCase());
            existingIndexes.set(t, list);
          }
        } catch {
          // Ignore — suggestions still work without existing-index info.
        }
      }

      const out = [];
      for (const s of suggestions.values()) {
        const existing = existingIndexes.get(s.table) || [];
        const alreadyCovered = existing.some((def) =>
          s.columns.every((c) => def.includes(c))
        );
        if (alreadyCovered) continue;
        const expectedImprovement = estimateImprovement(s);
        out.push({
          table: s.table,
          columns: s.columns,
          reason: s.reason,
          occurrences: s.occurrences,
          totalMs: s.totalMs,
          expectedImprovement,
          createStatement: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${s.table}_${s.columns.join("_")} ON ${s.table} (${s.columns.join(", ")})`,
          sample: s.sample,
        });
      }
      out.sort((a, b) => b.totalMs - a.totalMs);
      return out;
    },

    /**
     * Query `pg_stat_user_tables` and return per-table scan stats.
     *
     * @param {{ query: Function }} pool
     */
    async getTableStats(pool) {
      if (!pool || typeof pool.query !== "function") {
        throw new Error("pool with .query() is required");
      }
      const sql = `
        SELECT
          relname AS table,
          n_live_tup AS row_count,
          seq_scan AS seq_scans,
          idx_scan AS idx_scans,
          n_dead_tup AS dead_tuples,
          n_tup_ins AS inserts,
          n_tup_upd AS updates,
          n_tup_del AS deletes,
          last_autovacuum,
          last_autoanalyze
        FROM pg_stat_user_tables
        ORDER BY n_live_tup DESC NULLS LAST
      `;
      const r = await pool.query(sql);
      return (r?.rows || []).map((row) => {
        const seq = Number(row.seq_scans || 0);
        const idx = Number(row.idx_scans || 0);
        const total = seq + idx;
        const scanRatio = total > 0 ? idx / total : null;
        const rowCount = Number(row.row_count || 0);
        const deadTuples = Number(row.dead_tuples || 0);
        const bloatPct = rowCount > 0 ? (deadTuples / rowCount) * 100 : 0;
        return {
          table: row.table,
          rowCount,
          seqScans: seq,
          idxScans: idx,
          deadTuples,
          bloatPct: Math.round(bloatPct * 100) / 100,
          idxScanRatio: scanRatio,
          inserts: Number(row.inserts || 0),
          updates: Number(row.updates || 0),
          deletes: Number(row.deletes || 0),
          lastAutovacuum: row.last_autovacuum || null,
          lastAutoanalyze: row.last_autoanalyze || null,
        };
      });
    },

    /** Reset all recorded stats. */
    clear() {
      queries.clear();
      slowQueries.length = 0;
    },

    /** Internal: raw sizes for introspection/tests. */
    _size() {
      return { queries: queries.size, slow: slowQueries.length };
    },
  };
}

function findNodes(root, pred) {
  const out = [];
  if (!root) return out;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (pred(node)) out.push(node);
    const children = node?.Plans || node?.plans;
    if (Array.isArray(children)) {
      for (const c of children) stack.push(c);
    }
  }
  return out;
}

function estimateImprovement(suggestion) {
  // Rough heuristic — missing indexes typically cut latency by 10x-100x
  // for selective filters. We scale with how much cumulative time this
  // fingerprint is burning.
  if (suggestion.totalMs > 10_000) return "high";
  if (suggestion.totalMs > 1_000) return "medium";
  return "low";
}

export const globalQueryAnalyzer = createQueryAnalyzer();
