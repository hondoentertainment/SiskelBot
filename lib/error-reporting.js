/**
 * Phase 38: Error reporting webhook.
 * When unhandled errors occur in production, POST to ERROR_REPORT_WEBHOOK_URL.
 */

const ERROR_REPORT_WEBHOOK = process.env.ERROR_REPORT_WEBHOOK_URL?.trim() || null;

/**
 * Report an error to the configured webhook (non-blocking).
 * @param {Error} err - The error
 * @param {object} [context] - Optional context (requestId, path, etc.)
 */
export async function reportError(err, context = {}) {
  if (!ERROR_REPORT_WEBHOOK || !err) return;

  const payload = {
    message: err.message,
    name: err.name,
    stack: err.stack?.slice(0, 2000),
    timestamp: new Date().toISOString(),
    ...context,
  };

  try {
    const res = await fetch(ERROR_REPORT_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[error-reporting] Webhook returned ${res.status}`);
    }
  } catch (e) {
    console.warn("[error-reporting] Failed to send:", e.message);
  }
}

export function isConfigured() {
  return Boolean(ERROR_REPORT_WEBHOOK);
}

/**
 * Register process-level handlers for uncaught errors (production only).
 */
export function initErrorReporting() {
  if (!ERROR_REPORT_WEBHOOK || process.env.NODE_ENV !== "production") return;

  process.on("uncaughtException", (err) => {
    reportError(err, { source: "uncaughtException" });
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    reportError(err, { source: "unhandledRejection" });
  });
}
