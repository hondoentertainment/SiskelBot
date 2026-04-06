/**
 * Phase 69: OpenTelemetry span helper utilities for deeper instrumentation.
 * Wraps async functions in spans with error recording, adds events, and records errors.
 */
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("siskel-bot", "1.0.0");

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
