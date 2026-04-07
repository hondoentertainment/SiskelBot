/**
 * Webhook delivery with retry and dead-letter queue (DLQ).
 *
 * Retries failed deliveries with exponential backoff. After all retries
 * are exhausted the payload is persisted to a DLQ for manual inspection
 * and retry.
 */
import { join } from "path";
import { randomUUID, createHmac } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const DLQ_MAX = 500;
const FETCH_TIMEOUT_MS = 15_000;

function getDlqPath() {
  return join(getDataDir(), "webhook-dlq.json");
}

function signPayload(body, secret) {
  if (!secret || typeof secret !== "string") return null;
  const hmac = createHmac("sha256", secret.trim());
  hmac.update(typeof body === "string" ? body : JSON.stringify(body));
  return hmac.digest("hex");
}

/**
 * Deliver a webhook payload to the given URL with retry + exponential backoff.
 *
 * @param {string} url
 * @param {object} payload
 * @param {object} [options]
 * @param {string} [options.secret]   HMAC signing secret
 * @param {number} [options.timeout]  Fetch timeout in ms
 * @param {number} [options.retries]  Max attempts (default MAX_RETRIES)
 * @returns {Promise<{delivered: boolean, attempts: number, error?: string}>}
 */
export async function deliverWebhook(url, payload, options = {}) {
  const maxAttempts = options.retries ?? MAX_RETRIES;
  const timeout = options.timeout ?? FETCH_TIMEOUT_MS;
  const secret = options.secret;

  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  const sig = signPayload(body, secret);
  if (sig) headers["X-Webhook-Signature"] = `sha256=${sig}`;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Backoff: attempt 1 = immediate, attempt 2 = 1s, attempt 3 = 4s
    if (attempt > 1) {
      const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 2);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        return { delivered: true, attempts: attempt };
      }
      const text = await res.text().catch(() => "");
      lastError = `HTTP ${res.status}: ${text?.slice(0, 200)}`;
    } catch (err) {
      lastError = err.message;
    }

    console.warn(`[webhook-delivery] ${url} attempt ${attempt}/${maxAttempts} failed: ${lastError}`);
  }

  // All attempts exhausted -- add to DLQ
  await addToDLQ(url, payload, lastError);
  return { delivered: false, attempts: maxAttempts, error: lastError };
}

async function addToDLQ(url, payload, error) {
  const path = getDlqPath();
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { entries: [] });
    const entries = Array.isArray(data.entries) ? data.entries : [];

    entries.push({
      id: randomUUID(),
      url,
      payload,
      error,
      failedAt: new Date().toISOString(),
      retryCount: 0,
    });

    // Cap at DLQ_MAX, drop oldest entries when full
    if (entries.length > DLQ_MAX) {
      data.entries = entries.slice(entries.length - DLQ_MAX);
    } else {
      data.entries = entries;
    }
    await writeJsonPath(path, data);
  });
}

/**
 * Return all DLQ entries.
 */
export async function getDLQ() {
  const data = await readJsonPath(getDlqPath(), { entries: [] });
  return Array.isArray(data.entries) ? data.entries : [];
}

/**
 * Remove a single DLQ entry by id.
 * @returns {Promise<boolean>} true if entry was found and removed
 */
export async function clearDLQEntry(id) {
  const path = getDlqPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { entries: [] });
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const before = entries.length;
    data.entries = entries.filter((e) => e.id !== id);
    if (data.entries.length === before) return false;
    await writeJsonPath(path, data);
    return true;
  });
}

/**
 * Retry a DLQ entry: re-deliver, then remove from DLQ on success.
 * @returns {Promise<{delivered: boolean, attempts: number, error?: string}>}
 */
export async function retryDLQEntry(id) {
  const entries = await getDLQ();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { delivered: false, attempts: 0, error: "DLQ entry not found" };

  const result = await deliverWebhook(entry.url, entry.payload, { retries: MAX_RETRIES });

  if (result.delivered) {
    await clearDLQEntry(id);
  } else {
    // Update retryCount and error
    const path = getDlqPath();
    await withPathLock(path, async () => {
      const data = await readJsonPath(path, { entries: [] });
      const e = (data.entries || []).find((x) => x.id === id);
      if (e) {
        e.retryCount = (e.retryCount || 0) + 1;
        e.lastRetryAt = new Date().toISOString();
        e.error = result.error;
        await writeJsonPath(path, data);
      }
    });
  }

  return result;
}

/**
 * DLQ statistics.
 */
export async function getDLQStats() {
  const entries = await getDLQ();
  const byUrl = {};
  let oldest = null;
  for (const e of entries) {
    const key = e.url || "unknown";
    byUrl[key] = (byUrl[key] || 0) + 1;
    if (!oldest || e.failedAt < oldest) oldest = e.failedAt;
  }
  return { total: entries.length, oldest, byUrl };
}

export { MAX_RETRIES, BACKOFF_BASE_MS, DLQ_MAX };
