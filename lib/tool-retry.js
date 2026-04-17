/**
 * Retry helper with exponential backoff for transient tool failures.
 * @module tool-retry
 */

/** @type {Set<string>} Network error codes considered transient. */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNRESET",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "FETCH_ERROR",
]);

/** @type {Set<number>} HTTP status codes considered transient. */
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Classify whether an error is transient (worth retrying).
 *
 * Returns `true` for:
 *   - Network errors (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ECONNRESET, etc.)
 *   - HTTP 429 / 500 / 502 / 503 / 504
 *   - fetch failures (TypeError with "fetch" in message)
 *   - Errors with `.transient === true`
 *
 * Returns `false` for:
 *   - Validation errors (status 400, 422, or name containing "Validation")
 *   - 404 Not Found
 *   - Permission / auth errors (status 401, 403, or code containing "DENIED" / "FORBIDDEN")
 *   - Everything else not matching a transient pattern
 *
 * @param {Error & { code?: string; status?: number; statusCode?: number; transient?: boolean }} error
 * @returns {boolean}
 */
export function isTransientError(error) {
  if (!error) return false;

  // Explicit transient marker
  if (error.transient === true) return true;

  const code = typeof error.code === "string" ? error.code : "";
  const status = Number(error.status || error.statusCode) || 0;
  const name = typeof error.name === "string" ? error.name : "";
  const message = typeof error.message === "string" ? error.message : "";

  // Non-transient: validation / bad-request
  if (status === 400 || status === 422) return false;
  if (name.includes("Validation") || code === "VALIDATION_ERROR") return false;

  // Non-transient: not found
  if (status === 404) return false;

  // Non-transient: permission / auth
  if (status === 401 || status === 403) return false;
  if (code.includes("DENIED") || code.includes("FORBIDDEN")) return false;
  if (code === "TOOL_NOT_ALLOWED" || code === "TOOL_NOT_ALLOWED_WORKSPACE") return false;

  // Transient: network-level codes
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;

  // Transient: HTTP server errors and rate limiting
  if (status && TRANSIENT_HTTP_STATUSES.has(status)) return true;

  // Transient: fetch TypeError (e.g. "Failed to fetch", "fetch failed")
  if (error instanceof TypeError && /fetch/i.test(message)) return true;

  return false;
}

/**
 * Compute delay with exponential backoff and jitter.
 * delay = min(baseDelayMs * 2^attempt, maxDelayMs) * jitter
 * where jitter ∈ [0.5, 1.0)
 *
 * @param {number} attempt - Zero-based attempt index
 * @param {number} baseDelayMs
 * @param {number} maxDelayMs
 * @returns {number} Delay in milliseconds
 */
export function computeDelay(attempt, baseDelayMs, maxDelayMs) {
  const raw = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  const jitter = 0.5 + Math.random() * 0.5;
  return Math.round(raw * jitter);
}

/**
 * Execute an async function with retry and exponential backoff for transient errors.
 *
 * @template T
 * @param {() => Promise<T>} fn - The async function to execute
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3] - Maximum number of retries (total attempts = maxRetries + 1)
 * @param {number} [opts.baseDelayMs=1000] - Base delay in milliseconds
 * @param {number} [opts.maxDelayMs=8000] - Maximum delay cap in milliseconds
 * @param {(error: Error) => boolean} [opts.isTransient] - Classifier; defaults to isTransientError
 * @param {(error: Error, attempt: number, delayMs: number) => void} [opts.onRetry] - Optional retry callback
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 8000,
    isTransient: classifier = isTransientError,
    onRetry,
  } = opts;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // If not transient or retries exhausted, throw immediately
      if (!classifier(err) || attempt >= maxRetries) {
        throw err;
      }

      const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs);

      if (typeof onRetry === "function") {
        try {
          onRetry(err, attempt + 1, delayMs);
        } catch {
          // onRetry callback errors are swallowed
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Should not reach here, but safety net
  throw lastError;
}
