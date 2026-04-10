/**
 * Tests for lib/log-shipper.js — log batching, retry, provider formats.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createLogShipper,
  PROVIDERS,
  initLogShipping,
  getLogShipper,
  clearLogShipper,
} from "../lib/log-shipper.js";

function makeFetchMock({ fail = 0, failWith = null, status = 200 } = {}) {
  const calls = [];
  let remainingFails = fail;
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (remainingFails > 0) {
      remainingFails -= 1;
      if (failWith === "throw") throw new Error("network down");
      return { ok: false, status: 500 };
    }
    return { ok: true, status };
  };
  return { fn, calls };
}

function makeEntry(overrides = {}) {
  return {
    timestamp: "2026-04-10T00:00:00.000Z",
    level: "info",
    module: "test",
    message: "hello",
    ...overrides,
  };
}

test("createLogShipper throws on unknown provider", () => {
  assert.throws(
    () => createLogShipper({ provider: "bogus", endpoint: "http://x" }),
    /Unknown log ship provider/,
  );
});

test("createLogShipper throws when endpoint missing (non-datadog)", () => {
  assert.throws(
    () => createLogShipper({ provider: "splunk" }),
    /requires an endpoint/,
  );
});

test("datadog provider has default endpoint", () => {
  const { fn } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "datadog",
    apiKey: "dd-key",
    fetchImpl: fn,
  });
  assert.equal(shipper._config.endpoint, "https://http-intake.logs.datadoghq.com/api/v2/logs");
});

test("batching: flushes when batch reaches batchSize", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://logs.example.com",
    batchSize: 3,
    flushIntervalMs: 60000,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry({ message: "1" }));
  shipper.ship(makeEntry({ message: "2" }));
  assert.equal(calls.length, 0, "no flush before batch full");
  shipper.ship(makeEntry({ message: "3" }));
  // allow microtasks to settle
  await new Promise((r) => setImmediate(r));
  await shipper.flush();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.length, 3);
  assert.equal(body[0].message, "1");
  await shipper.stop();
});

test("batching: manual flush sends current batch", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://x",
    batchSize: 100,
    flushIntervalMs: 60000,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry());
  shipper.ship(makeEntry());
  await shipper.flush();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.length, 2);
  await shipper.stop();
});

test("flush is a no-op when batch is empty", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://x",
    fetchImpl: fn,
  });
  await shipper.flush();
  assert.equal(calls.length, 0);
  await shipper.stop();
});

test("interval-based flushing fires on timer", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://x",
    batchSize: 1000,
    flushIntervalMs: 20,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry());
  // Wait longer than flushIntervalMs.
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(calls.length >= 1, `expected at least 1 call, got ${calls.length}`);
  await shipper.stop();
});

test("retry: succeeds after a transient failure", async () => {
  const { fn, calls } = makeFetchMock({ fail: 1 });
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://x",
    batchSize: 1,
    flushIntervalMs: 60000,
    maxRetries: 3,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry());
  await shipper.flush();
  // May already have flushed from batch size trigger; give time for retry backoff.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(calls.length, 2, "should have retried once and succeeded");
  await shipper.stop();
});

test("retry: drops batch and calls onError after max retries", async () => {
  const { fn, calls } = makeFetchMock({ fail: 99 });
  const dropped = [];
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://x",
    batchSize: 100,
    flushIntervalMs: 60000,
    maxRetries: 3,
    fetchImpl: fn,
    onError: (err, batch) => dropped.push({ err, batch }),
  });
  shipper.ship(makeEntry({ message: "doomed" }));
  await shipper.flush();
  // Wait through backoff: ~500 + 1000 = 1500ms
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(calls.length, 3, "should attempt exactly maxRetries times");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].batch.length, 1);
  assert.equal(dropped[0].batch[0].message, "doomed");
  await shipper.stop();
});

test("retry: handles fetch throwing (not just !ok)", async () => {
  const { fn, calls } = makeFetchMock({ fail: 99, failWith: "throw" });
  const dropped = [];
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://x",
    batchSize: 100,
    flushIntervalMs: 60000,
    maxRetries: 2,
    fetchImpl: fn,
    onError: (err, batch) => dropped.push({ err, batch }),
  });
  shipper.ship(makeEntry());
  await shipper.flush();
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(calls.length, 2);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].err.message, /network down/);
  await shipper.stop();
});

test("datadog provider: formats with ddsource and ddtags, DD-API-KEY header", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "datadog",
    apiKey: "dd-secret",
    batchSize: 1,
    flushIntervalMs: 60000,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry({ message: "dd-test" }));
  await shipper.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://http-intake.logs.datadoghq.com/api/v2/logs");
  assert.equal(calls[0].opts.headers["DD-API-KEY"], "dd-secret");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body[0].ddsource, "siskelbot");
  assert.ok(body[0].ddtags.includes("service:siskelbot"));
  assert.equal(body[0].message, "dd-test");
  await shipper.stop();
});

test("splunk provider: wraps entries as event objects with Splunk auth", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "splunk",
    endpoint: "https://splunk.example.com/services/collector",
    apiKey: "splunk-token",
    batchSize: 2,
    flushIntervalMs: 60000,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry({ message: "a" }));
  shipper.ship(makeEntry({ message: "b" }));
  await shipper.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, "Splunk splunk-token");
  const lines = calls[0].opts.body.trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.sourcetype, "_json");
  assert.equal(first.source, "siskelbot");
  assert.equal(first.event.message, "a");
  await shipper.stop();
});

test("loki provider: packages entries into streams/values with ns timestamps", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "loki",
    endpoint: "http://loki.example.com/loki/api/v1/push",
    apiKey: "loki-token",
    batchSize: 2,
    flushIntervalMs: 60000,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry({ message: "l1" }));
  shipper.ship(makeEntry({ message: "l2" }));
  await shipper.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer loki-token");
  const body = JSON.parse(calls[0].opts.body);
  assert.ok(Array.isArray(body.streams));
  assert.equal(body.streams[0].stream.service, "siskelbot");
  assert.equal(body.streams[0].values.length, 2);
  const [ns, line] = body.streams[0].values[0];
  assert.match(ns, /^\d+$/, "ns timestamp should be numeric string");
  const parsed = JSON.parse(line);
  assert.equal(parsed.message, "l1");
  await shipper.stop();
});

test("elasticsearch provider: emits NDJSON bulk format with ApiKey auth", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "elasticsearch",
    endpoint: "http://es.example.com/_bulk",
    apiKey: "es-key",
    batchSize: 2,
    flushIntervalMs: 60000,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry({ message: "e1" }));
  shipper.ship(makeEntry({ message: "e2" }));
  await shipper.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers["Content-Type"], "application/x-ndjson");
  assert.equal(calls[0].opts.headers.Authorization, "ApiKey es-key");
  const lines = calls[0].opts.body.trim().split("\n");
  // 2 entries * 2 lines (action + doc) = 4 lines
  assert.equal(lines.length, 4);
  assert.deepEqual(JSON.parse(lines[0]), { index: {} });
  assert.equal(JSON.parse(lines[1]).message, "e1");
  assert.equal(JSON.parse(lines[3]).message, "e2");
  await shipper.stop();
});

test("http provider: posts array of entries with no auth", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://logs.example.com/ingest",
    batchSize: 1,
    flushIntervalMs: 60000,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry({ message: "custom" }));
  await shipper.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://logs.example.com/ingest");
  assert.equal(calls[0].opts.headers.Authorization, undefined);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].message, "custom");
  await shipper.stop();
});

test("graceful shutdown: stop() flushes remaining batch", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://x",
    batchSize: 1000,
    flushIntervalMs: 60000,
    fetchImpl: fn,
  });
  shipper.ship(makeEntry({ message: "final-1" }));
  shipper.ship(makeEntry({ message: "final-2" }));
  await shipper.stop();
  assert.equal(calls.length, 1, "stop should trigger a final flush");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.length, 2);
});

test("ship after stop is a no-op", async () => {
  const { fn, calls } = makeFetchMock();
  const shipper = createLogShipper({
    provider: "http",
    endpoint: "http://x",
    fetchImpl: fn,
  });
  await shipper.stop();
  shipper.ship(makeEntry({ message: "dropped" }));
  await shipper.flush();
  assert.equal(calls.length, 0);
});

test("PROVIDERS export: has all expected providers", () => {
  assert.ok(PROVIDERS.datadog);
  assert.ok(PROVIDERS.splunk);
  assert.ok(PROVIDERS.loki);
  assert.ok(PROVIDERS.elasticsearch);
  assert.ok(PROVIDERS.http);
});

test("initLogShipping: returns null when LOG_SHIP_PROVIDER unset", () => {
  const saved = process.env.LOG_SHIP_PROVIDER;
  delete process.env.LOG_SHIP_PROVIDER;
  clearLogShipper();
  try {
    const result = initLogShipping();
    assert.equal(result, null);
    assert.equal(getLogShipper(), null);
  } finally {
    if (saved !== undefined) process.env.LOG_SHIP_PROVIDER = saved;
  }
});

test("initLogShipping: configures shipper from env vars", async () => {
  const saved = {
    provider: process.env.LOG_SHIP_PROVIDER,
    endpoint: process.env.LOG_SHIP_ENDPOINT,
    apiKey: process.env.LOG_SHIP_API_KEY,
    batchSize: process.env.LOG_SHIP_BATCH_SIZE,
    flushIntervalMs: process.env.LOG_SHIP_FLUSH_INTERVAL_MS,
  };
  process.env.LOG_SHIP_PROVIDER = "http";
  process.env.LOG_SHIP_ENDPOINT = "http://test.local/logs";
  process.env.LOG_SHIP_API_KEY = "key";
  process.env.LOG_SHIP_BATCH_SIZE = "50";
  process.env.LOG_SHIP_FLUSH_INTERVAL_MS = "1000";
  clearLogShipper();
  try {
    const shipper = initLogShipping();
    assert.ok(shipper);
    assert.equal(shipper._config.providerName, "http");
    assert.equal(shipper._config.endpoint, "http://test.local/logs");
    assert.equal(shipper._config.batchSize, 50);
    assert.equal(shipper._config.flushIntervalMs, 1000);
    assert.strictEqual(getLogShipper(), shipper);
    await shipper.stop();
  } finally {
    clearLogShipper();
    for (const [k, v] of Object.entries(saved)) {
      const envKey = {
        provider: "LOG_SHIP_PROVIDER",
        endpoint: "LOG_SHIP_ENDPOINT",
        apiKey: "LOG_SHIP_API_KEY",
        batchSize: "LOG_SHIP_BATCH_SIZE",
        flushIntervalMs: "LOG_SHIP_FLUSH_INTERVAL_MS",
      }[k];
      if (v !== undefined) process.env[envKey] = v;
      else delete process.env[envKey];
    }
  }
});

test("initLogShipping: returns null and logs on init failure", () => {
  const saved = {
    provider: process.env.LOG_SHIP_PROVIDER,
    endpoint: process.env.LOG_SHIP_ENDPOINT,
  };
  process.env.LOG_SHIP_PROVIDER = "splunk"; // requires endpoint
  delete process.env.LOG_SHIP_ENDPOINT;
  clearLogShipper();

  const origWrite = process.stderr.write;
  const writes = [];
  process.stderr.write = (msg) => { writes.push(msg); return true; };
  try {
    const result = initLogShipping();
    assert.equal(result, null);
    assert.ok(writes.some((w) => /init failed/.test(w)));
  } finally {
    process.stderr.write = origWrite;
    clearLogShipper();
    if (saved.provider !== undefined) process.env.LOG_SHIP_PROVIDER = saved.provider;
    else delete process.env.LOG_SHIP_PROVIDER;
    if (saved.endpoint !== undefined) process.env.LOG_SHIP_ENDPOINT = saved.endpoint;
    else delete process.env.LOG_SHIP_ENDPOINT;
  }
});

test("logger integration: routes entries to registered shipper", async () => {
  const { setLogShipper } = await import("../lib/log-shipper.js");
  const originalFormat = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "json";
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-ship`);

  const shipped = [];
  const fakeShipper = {
    ship(entry) { shipped.push(entry); },
    flush() {},
    stop() {},
  };
  setLogShipper(fakeShipper);

  const origLog = console.log;
  console.log = () => {};
  try {
    const log = createLogger("ship-test");
    log.info("hi", { foo: 1 });
    log.error("oops", { code: 9 });
  } finally {
    console.log = origLog;
    setLogShipper(null);
    if (originalFormat !== undefined) process.env.LOG_FORMAT = originalFormat;
    else delete process.env.LOG_FORMAT;
  }

  assert.equal(shipped.length, 2);
  assert.equal(shipped[0].message, "hi");
  assert.equal(shipped[0].foo, 1);
  assert.equal(shipped[1].message, "oops");
  assert.equal(shipped[1].code, 9);
});

test("logger integration: shipping failure does not break logger", async () => {
  const { setLogShipper } = await import("../lib/log-shipper.js");
  const originalFormat = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "json";
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-ship-fail`);

  setLogShipper({
    ship() { throw new Error("shipper broken"); },
  });

  const lines = [];
  const origLog = console.log;
  console.log = (msg) => lines.push(msg);
  try {
    const log = createLogger("ship-fail");
    log.info("still logs");
  } finally {
    console.log = origLog;
    setLogShipper(null);
    if (originalFormat !== undefined) process.env.LOG_FORMAT = originalFormat;
    else delete process.env.LOG_FORMAT;
  }

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.message, "still logs");
});
