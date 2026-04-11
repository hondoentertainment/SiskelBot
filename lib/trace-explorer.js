/**
 * Phase 31.1: In-memory trace explorer.
 *
 * Captures finished OpenTelemetry spans into a bounded in-process buffer and
 * exposes them through a small query API. This is **not** a replacement for
 * Jaeger / Tempo / Honeycomb — it is a zero-dependency developer aid so you
 * can visualize what is happening inside a single SiskelBot instance without
 * having to run a full tracing backend.
 *
 * For production multi-instance deployments, point the OTLP exporter at a
 * real backend. See `docs/TRACING.md` for details.
 */

/**
 * @typedef {Object} ExplorerSpan
 * @property {string} traceId
 * @property {string} spanId
 * @property {string|null} parentSpanId
 * @property {string} name
 * @property {string} service
 * @property {Record<string, any>} attributes
 * @property {number} startTime   - epoch millis
 * @property {number} endTime     - epoch millis
 * @property {number} duration    - millis
 * @property {"ok"|"error"|"unset"} status
 * @property {string} [statusMessage]
 * @property {Array<{name:string, time:number, attributes?:Record<string,any>}>} [events]
 */

/**
 * Coerce a potentially-exotic OTel attribute value to something JSON-safe.
 * @param {any} value
 */
function sanitizeAttrValue(value) {
  if (value == null) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeAttrValue);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

/**
 * @param {Record<string, any>|undefined} attrs
 */
function sanitizeAttrs(attrs) {
  if (!attrs || typeof attrs !== "object") return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = sanitizeAttrValue(v);
  }
  return out;
}

/**
 * Convert an OpenTelemetry [seconds, nanos] hrTime tuple (or a number) to
 * epoch milliseconds. Falls back to Date.now() when nothing sensible is
 * provided.
 * @param {[number, number] | number | undefined} hr
 */
function hrToMillis(hr) {
  if (Array.isArray(hr) && hr.length === 2) {
    return hr[0] * 1000 + hr[1] / 1e6;
  }
  if (typeof hr === "number" && Number.isFinite(hr)) {
    return hr;
  }
  return Date.now();
}

/**
 * Normalize an SDK ReadableSpan into our internal ExplorerSpan shape.
 * Accepts both raw OTel ReadableSpans and plain objects that already match.
 * @param {any} span
 * @returns {ExplorerSpan | null}
 */
export function normalizeSpan(span) {
  if (!span || typeof span !== "object") return null;

  // Already normalized (plain object input)
  if (
    typeof span.traceId === "string" &&
    typeof span.spanId === "string" &&
    typeof span.startTime === "number" &&
    typeof span.endTime === "number"
  ) {
    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId || null,
      name: String(span.name || "span"),
      service: String(span.service || "siskel-bot"),
      attributes: sanitizeAttrs(span.attributes),
      startTime: span.startTime,
      endTime: span.endTime,
      duration: Math.max(0, span.endTime - span.startTime),
      status: span.status === "error" || span.status === "ok" ? span.status : "unset",
      statusMessage: span.statusMessage,
      events: Array.isArray(span.events) ? span.events : [],
    };
  }

  // OpenTelemetry ReadableSpan shape
  const ctx = typeof span.spanContext === "function" ? span.spanContext() : span.spanContext;
  if (!ctx || !ctx.traceId || !ctx.spanId) return null;

  const startTime = hrToMillis(span.startTime);
  const endTime = hrToMillis(span.endTime);
  const resourceAttrs = span.resource?.attributes || {};
  const service =
    resourceAttrs["service.name"] ||
    process.env.OTEL_SERVICE_NAME ||
    "siskel-bot";

  // Map OTel SpanStatusCode → string. 0=UNSET, 1=OK, 2=ERROR.
  let status = "unset";
  if (span.status && typeof span.status.code === "number") {
    if (span.status.code === 2) status = "error";
    else if (span.status.code === 1) status = "ok";
  }

  /** @type {Array<{name:string,time:number,attributes?:Record<string,any>}>} */
  const events = Array.isArray(span.events)
    ? span.events.map((ev) => ({
        name: String(ev.name || ""),
        time: hrToMillis(ev.time),
        attributes: sanitizeAttrs(ev.attributes),
      }))
    : [];

  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanId || span.parentSpanContext?.spanId || null,
    name: String(span.name || "span"),
    service: String(service),
    attributes: sanitizeAttrs(span.attributes),
    startTime,
    endTime,
    duration: Math.max(0, endTime - startTime),
    status,
    statusMessage: span.status?.message,
    events,
  };
}

/**
 * Create an in-memory trace explorer.
 *
 * @param {Object} [options]
 * @param {number} [options.maxTraces=1000]   - maximum distinct traces retained; oldest evicted first.
 * @param {number} [options.retentionMs=3600000] - default retention window for prune().
 * @param {number} [options.maxSpansPerTrace=5000] - safety limit per trace id.
 */
export function createTraceExplorer(options = {}) {
  const maxTraces = Number.isFinite(options.maxTraces) ? options.maxTraces : 1000;
  const retentionMs = Number.isFinite(options.retentionMs) ? options.retentionMs : 60 * 60 * 1000;
  const maxSpansPerTrace = Number.isFinite(options.maxSpansPerTrace) ? options.maxSpansPerTrace : 5000;

  /**
   * traceId -> { spans: ExplorerSpan[], firstSeen, lastSeen }
   * Iteration order of Map preserves insertion order, which we use as an
   * approximation of "age" for LRU eviction.
   * @type {Map<string, { spans: ExplorerSpan[], firstSeen: number, lastSeen: number }>}
   */
  const traces = new Map();

  function touch(traceId, entry) {
    traces.delete(traceId);
    traces.set(traceId, entry);
  }

  function evictIfNeeded() {
    while (traces.size > maxTraces) {
      const oldest = traces.keys().next().value;
      if (oldest == null) break;
      traces.delete(oldest);
    }
  }

  return {
    /**
     * Record a single span. Accepts either an OTel ReadableSpan or a plain
     * object matching the ExplorerSpan shape.
     * @param {any} span
     */
    recordSpan(span) {
      const normalized = normalizeSpan(span);
      if (!normalized) return;

      let entry = traces.get(normalized.traceId);
      if (!entry) {
        entry = {
          spans: [],
          firstSeen: normalized.startTime,
          lastSeen: normalized.endTime,
        };
      }

      if (entry.spans.length >= maxSpansPerTrace) return;

      entry.spans.push(normalized);
      if (normalized.startTime < entry.firstSeen) entry.firstSeen = normalized.startTime;
      if (normalized.endTime > entry.lastSeen) entry.lastSeen = normalized.endTime;

      touch(normalized.traceId, entry);
      evictIfNeeded();
    },

    /**
     * Return all spans for a trace, sorted by start time ascending.
     * @param {string} traceId
     * @returns {ExplorerSpan[] | null}
     */
    getTrace(traceId) {
      const entry = traces.get(traceId);
      if (!entry) return null;
      return [...entry.spans].sort((a, b) => a.startTime - b.startTime);
    },

    /**
     * List recent traces, newest last-activity first.
     *
     * @param {Object} [filter]
     * @param {number} [filter.limit=50]
     * @param {string} [filter.service]     - filter by service name (root span)
     * @param {"ok"|"error"|"unset"} [filter.status] - filter by overall trace status
     * @param {number} [filter.minDuration] - millis
     * @param {number} [filter.startTime]   - only traces with lastSeen >= startTime
     * @param {string} [filter.name]        - substring match against root span name
     */
    listTraces(filter = {}) {
      const limit = Number.isFinite(filter.limit) ? filter.limit : 50;
      /** @type {any[]} */
      const out = [];
      // Iterate newest-first (Map insertion order = oldest first, so reverse)
      const entries = Array.from(traces.entries()).reverse();
      for (const [traceId, entry] of entries) {
        const spans = entry.spans;
        if (spans.length === 0) continue;

        // Determine root span (no parent, or parent not in this trace)
        const ids = new Set(spans.map((s) => s.spanId));
        const root =
          spans.find((s) => !s.parentSpanId || !ids.has(s.parentSpanId)) || spans[0];

        const duration = entry.lastSeen - entry.firstSeen;
        const hasError = spans.some((s) => s.status === "error");
        const overallStatus = hasError ? "error" : root.status;

        if (filter.service && root.service !== filter.service) continue;
        if (filter.status && overallStatus !== filter.status) continue;
        if (filter.minDuration != null && duration < filter.minDuration) continue;
        if (filter.startTime != null && entry.lastSeen < filter.startTime) continue;
        if (filter.name && !root.name.toLowerCase().includes(String(filter.name).toLowerCase())) continue;

        out.push({
          traceId,
          name: root.name,
          service: root.service,
          rootSpanId: root.spanId,
          startTime: entry.firstSeen,
          endTime: entry.lastSeen,
          duration,
          spanCount: spans.length,
          status: overallStatus,
        });

        if (out.length >= limit) break;
      }
      return out;
    },

    /**
     * Return the trace as a tree structure. Each node contains the span plus
     * its children recursively. Orphan spans (whose parent isn't present)
     * become additional roots.
     * @param {string} traceId
     */
    getTraceTree(traceId) {
      const entry = traces.get(traceId);
      if (!entry) return null;

      const spans = [...entry.spans].sort((a, b) => a.startTime - b.startTime);
      /** @type {Map<string, any>} */
      const byId = new Map();
      for (const s of spans) {
        byId.set(s.spanId, { ...s, children: [] });
      }

      const roots = [];
      for (const s of spans) {
        const node = byId.get(s.spanId);
        if (s.parentSpanId && byId.has(s.parentSpanId)) {
          byId.get(s.parentSpanId).children.push(node);
        } else {
          roots.push(node);
        }
      }
      return {
        traceId,
        startTime: entry.firstSeen,
        endTime: entry.lastSeen,
        duration: entry.lastSeen - entry.firstSeen,
        spanCount: spans.length,
        roots,
      };
    },

    /**
     * Aggregate counters across the currently retained traces.
     */
    getStats() {
      /** @type {Record<string, number>} */
      const byService = {};
      /** @type {Record<string, number>} */
      const byStatus = { ok: 0, error: 0, unset: 0 };
      let totalSpans = 0;

      for (const entry of traces.values()) {
        for (const s of entry.spans) {
          totalSpans += 1;
          byService[s.service] = (byService[s.service] || 0) + 1;
          byStatus[s.status] = (byStatus[s.status] || 0) + 1;
        }
      }

      return {
        totalTraces: traces.size,
        totalSpans,
        byService,
        byStatus,
        maxTraces,
        retentionMs,
      };
    },

    /**
     * Drop traces whose lastSeen is older than `retentionMs` from "now"
     * (or from `olderThan` if provided, for deterministic tests).
     * @param {number} [olderThan] - epoch millis; defaults to Date.now().
     * @returns {number} number of traces removed
     */
    prune(olderThan) {
      const now = typeof olderThan === "number" ? olderThan : Date.now();
      const cutoff = now - retentionMs;
      let removed = 0;
      for (const [traceId, entry] of traces.entries()) {
        if (entry.lastSeen < cutoff) {
          traces.delete(traceId);
          removed += 1;
        }
      }
      return removed;
    },

    /** Wipe the in-memory buffer (useful in tests). */
    clear() {
      traces.clear();
    },

    /** Number of retained traces. */
    size() {
      return traces.size;
    },
  };
}

/**
 * Shared process-wide explorer used by the tracing-spans processor and the
 * HTTP routes. Created eagerly so that `import` ordering doesn't matter.
 */
export const globalTraceExplorer = createTraceExplorer({
  maxTraces: Number(process.env.TRACE_EXPLORER_MAX_TRACES) || 1000,
  retentionMs: Number(process.env.TRACE_EXPLORER_RETENTION_MS) || 60 * 60 * 1000,
});
