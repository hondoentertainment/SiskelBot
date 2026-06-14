/**
 * Ship logs to external aggregation services via HTTP forwarders.
 * Supports: Datadog, Splunk HEC, Elasticsearch, Loki, custom HTTP.
 *
 * Logs are batched and flushed periodically (default: every 5s or when
 * the batch reaches 100 entries). Failed batches are retried with
 * exponential backoff, and dropped after 3 failed attempts.
 */

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;

// Built-in providers. Each defines:
//  - format(entry, batch): transform a single entry (or full batch for Loki)
//  - endpoint: default endpoint URL (nullable)
//  - auth(apiKey): returns headers for authentication
//  - body(formatted, batch): how to build the HTTP body from formatted entries
export const PROVIDERS = {
  datadog: {
    format: (entry) => ({
      ...entry,
      ddsource: "siskelbot",
      ddtags: process.env.LOG_SHIP_DD_TAGS || "env:prod,service:siskelbot",
    }),
    endpoint: "https://http-intake.logs.datadoghq.com/api/v2/logs",
    auth: (apiKey) => (apiKey ? { "DD-API-KEY": apiKey } : {}),
    body: (formatted) => JSON.stringify(formatted),
    batched: true,
  },
  splunk: {
    format: (entry) => ({
      event: entry,
      sourcetype: "_json",
      source: "siskelbot",
    }),
    endpoint: null,
    auth: (token) => (token ? { Authorization: `Splunk ${token}` } : {}),
    // Splunk HEC accepts one JSON object per line (no array).
    body: (formatted) => formatted.map((e) => JSON.stringify(e)).join("\n"),
    batched: false,
  },
  loki: {
    format: (entry, batch) => ({
      streams: [
        {
          stream: { service: "siskelbot" },
          values: batch.map((e) => {
            const tsMs = e.timestamp ? Date.parse(e.timestamp) : Date.now();
            const ns = String(BigInt(tsMs) * 1000000n);
            return [ns, JSON.stringify(e)];
          }),
        },
      ],
    }),
    endpoint: null,
    auth: (token) => (token ? { Authorization: `Bearer ${token}` } : {}),
    body: (formatted) => JSON.stringify(formatted),
    // Loki formats the whole batch as a single object (not per-entry).
    wholeBatch: true,
  },
  elasticsearch: {
    format: (entry) => entry,
    endpoint: null,
    auth: (token) => (token ? { Authorization: `ApiKey ${token}` } : {}),
    // Elasticsearch bulk API: each doc is preceded by an action line.
    body: (formatted) =>
      formatted
        .map((e) => `${JSON.stringify({ index: {} })}\n${JSON.stringify(e)}`)
        .join("\n") + "\n",
    contentType: "application/x-ndjson",
  },
  http: {
    format: (entry) => entry,
    endpoint: null,
    auth: () => ({}),
    body: (formatted) => JSON.stringify(formatted),
  },
};

/**
 * Create a log shipper.
 * @param {object} config
 * @param {string} config.provider - one of PROVIDERS keys
 * @param {string} [config.endpoint] - override provider endpoint
 * @param {string} [config.apiKey] - authentication token
 * @param {number} [config.batchSize]
 * @param {number} [config.flushIntervalMs]
 * @param {number} [config.maxRetries]
 * @param {function} [config.fetchImpl] - inject fetch (for tests)
 * @param {function} [config.onError] - callback on dropped batches
 * @param {function} [config.now] - inject clock (for tests)
 */
export function createLogShipper(config = {}) {
  const providerName = config.provider || "http";
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`Unknown log ship provider: ${providerName}`);
  }

  const endpoint = config.endpoint || provider.endpoint;
  if (!endpoint) {
    throw new Error(`Log ship provider "${providerName}" requires an endpoint`);
  }

  const apiKey = config.apiKey || "";
  const batchSize = Number(config.batchSize) || DEFAULT_BATCH_SIZE;
  const flushIntervalMs = Number(config.flushIntervalMs) || DEFAULT_FLUSH_INTERVAL_MS;
  const maxRetries = Number(config.maxRetries) || DEFAULT_MAX_RETRIES;
  const fetchImpl = config.fetchImpl || ((...args) => globalThis.fetch(...args));
  const onError = config.onError || ((err, batch) => {
    process.stderr.write(
      `[log-shipper] dropped batch of ${batch.length} entries: ${err.message}\n`,
    );
  });

  let batch = [];
  let stopped = false;
  let flushing = null;
  let timer = null;

  function startTimer() {
    if (stopped || timer) return;
    timer = setInterval(() => {
      flush().catch(() => {});
    }, flushIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function sendBatch(entries) {
    let formatted;
    if (provider.wholeBatch) {
      // Loki: format receives the whole batch as context.
      formatted = provider.format(entries[0], entries);
    } else {
      formatted = entries.map((e) => provider.format(e, entries));
    }

    const body = provider.body(formatted, entries);
    const headers = {
      "Content-Type": provider.contentType || "application/json",
      ...provider.auth(apiKey),
    };

    let attempt = 0;
    let lastErr = null;
    while (attempt < maxRetries) {
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body,
        });
        if (res && res.ok) return;
        const status = res && res.status ? res.status : "unknown";
        lastErr = new Error(`HTTP ${status}`);
      } catch (err) {
        lastErr = err;
      }
      attempt += 1;
      if (attempt < maxRetries) {
        const backoff = DEFAULT_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    onError(lastErr || new Error("unknown error"), entries);
  }

  async function flush() {
    if (batch.length === 0) return;
    // Serialize flushes so a slow send doesn't race with another.
    if (flushing) {
      await flushing;
    }
    const current = batch;
    batch = [];
    flushing = sendBatch(current).finally(() => {
      flushing = null;
    });
    await flushing;
  }

  function ship(logEntry) {
    if (stopped) return;
    batch.push(logEntry);
    startTimer();
    if (batch.length >= batchSize) {
      flush().catch(() => {});
    }
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try {
      await flush();
    } catch {
      // swallow — stop() must not throw
    }
  }

  return {
    ship,
    flush,
    stop,
    get batchSize() {
      return batch.length;
    },
    _config: { providerName, endpoint, batchSize, flushIntervalMs, maxRetries },
  };
}

// Singleton shipper for the global logger integration.
let globalShipper = null;

/**
 * Initialize log shipping from environment variables.
 * Returns the shipper if created, or null if not configured.
 *
 * Env vars:
 *   LOG_SHIP_PROVIDER — datadog|splunk|loki|elasticsearch|http
 *   LOG_SHIP_ENDPOINT — endpoint URL (required for non-datadog)
 *   LOG_SHIP_API_KEY  — authentication token
 *   LOG_SHIP_BATCH_SIZE         (default 100)
 *   LOG_SHIP_FLUSH_INTERVAL_MS  (default 5000)
 */
export function initLogShipping() {
  const provider = process.env.LOG_SHIP_PROVIDER;
  if (!provider) return null;

  try {
    const shipper = createLogShipper({
      provider,
      endpoint: process.env.LOG_SHIP_ENDPOINT,
      apiKey: process.env.LOG_SHIP_API_KEY,
      batchSize: process.env.LOG_SHIP_BATCH_SIZE
        ? Number(process.env.LOG_SHIP_BATCH_SIZE)
        : undefined,
      flushIntervalMs: process.env.LOG_SHIP_FLUSH_INTERVAL_MS
        ? Number(process.env.LOG_SHIP_FLUSH_INTERVAL_MS)
        : undefined,
    });
    globalShipper = shipper;

    // Flush on process exit.
    const onExit = () => {
      shipper.stop().catch(() => {});
    };
    process.once("beforeExit", onExit);
    process.once("SIGTERM", onExit);
    process.once("SIGINT", onExit);

    return shipper;
  } catch (err) {
    process.stderr.write(`[log-shipper] init failed: ${err.message}\n`);
    return null;
  }
}

export function getLogShipper() {
  return globalShipper;
}

export function setLogShipper(shipper) {
  globalShipper = shipper;
}

export function clearLogShipper() {
  globalShipper = null;
}
