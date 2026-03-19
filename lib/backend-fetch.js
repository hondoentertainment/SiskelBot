/**
 * Phase 41: Backend fetch with timeout and retry.
 * Configurable timeout; retry with exponential backoff for 5xx and connection errors.
 * Skips retry when circuit breaker is open.
 */
import { isOpen } from "./circuit-breaker.js";

const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS) || 60_000;
const BACKEND_RETRY_MAX = Number(process.env.BACKEND_RETRY_MAX) || 2;
const BACKEND_RETRY_INITIAL_MS = Number(process.env.BACKEND_RETRY_INITIAL_MS) || 1000;

function isRetryableStatus(status) {
  return status >= 500 || status === 429;
}

function isRetryableError(err) {
  const msg = String(err?.message || err).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("aborted")
  );
}

/**
 * Fetch with timeout and optional retry. Use with circuit breaker in server.
 * @param {string} url - Request URL
 * @param {object} options - Fetch options (method, headers, body, etc.)
 * @param {string} backend - Backend identifier (for circuit breaker check on retry)
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeoutAndRetry(url, options, backend = "ollama") {
  const maxAttempts = 1 + Math.max(0, BACKEND_RETRY_MAX);
  let lastErr = null;
  let lastRes = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
    const signal =
      options?.signal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
    const mergedOptions = { ...options, signal: signal ?? controller.signal };

    try {
      const res = await fetch(url, mergedOptions);
      clearTimeout(timeoutId);

      if (attempt < maxAttempts && isRetryableStatus(res.status)) {
        lastRes = res;
        const delay = BACKEND_RETRY_INITIAL_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;

      if (err?.code === "CIRCUIT_OPEN") throw err;
      if (attempt >= maxAttempts || !isRetryableError(err)) throw err;

      const check = isOpen(backend);
      if (check.open) throw err;

      const delay = BACKEND_RETRY_INITIAL_MS * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (lastRes) return lastRes;
  throw lastErr || new Error("Backend request failed after retries");
}
