/**
 * Phase 69: OpenTelemetry span helper utilities for deeper instrumentation.
 * Wraps async functions in spans with error recording, adds events, and records errors.
 *
 * Phase 31.1: Optional in-process trace explorer span processor. When
 * `TRACE_EXPLORER=1` is set, `createTraceExplorerSpanProcessor()` is passed
 * to the NodeSDK so every finished span is forwarded to the in-memory
 * explorer for visual inspection via `/api/v1/traces/explorer`.
 */
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { globalTraceExplorer } from "./trace-explorer.js";

const tracer = trace.getTracer("siskel-bot", "1.0.0");

/**
 * Build a SpanProcessor that mirrors each finished span into the in-process
 * trace explorer. Returns `null` when the feature flag is disabled so callers
 * can unconditionally spread the result into the SDK processors array.
 *
 * @returns {import('@opentelemetry/sdk-trace-base').SpanProcessor | null}
 */
export function createTraceExplorerSpanProcessor() {
  if (process.env.TRACE_EXPLORER !== "1") return null;

  // Minimal SimpleSpanProcessor-compatible shape. We implement the interface
  // inline to avoid pulling in sdk-trace-base at module load time for users
  // who never enable the explorer.
  return {
    onStart() {
      // no-op; explorer captures completed spans only
    },
    /**
     * @param {any} span - OTel ReadableSpan
     */
    onEnd(span) {
      try {
        globalTraceExplorer.recordSpan(span);
      } catch (_) {
        /* never let instrumentation break the app */
      }
    },
    async forceFlush() {
      /* nothing buffered */
    },
    async shutdown() {
      /* nothing buffered */
    },
  };
}

/**
 * Wrap an async function in a named span with attributes and automatic error recording.
 * The span is set as active for the duration of `fn`, so nested calls see it as parent.
 *
 * @param {string} name - Span name (e.g. "swarm.specialist.dispatch")
 * @param {Record<string, string|number|boolean>} attributes - Span attributes set at creation
 * @param {(span: import("@opentelemetry/api").Span) => Promise<T>} fn - Async function to execute within the span
 * @returns {Promise<T>}
 * @template T
 */
export async function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes: attributes || {} }, async (span) => {
    try {
      const result = await fn(span);
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Add an event to the currently active span (no-op if no active span).
 * @param {string} name - Event name
 * @param {Record<string, string|number|boolean>} [attributes] - Event attributes
 */
export function addSpanEvent(name, attributes) {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(name, attributes || {});
  }
}

/**
 * Record an error on the currently active span (no-op if no active span).
 * Sets span status to ERROR.
 * @param {Error|string} error
 */
export function recordSpanError(error) {
  const span = trace.getActiveSpan();
  if (!span) return;
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
}
