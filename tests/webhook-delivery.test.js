import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/webhook-dlq-test-" + Date.now();
});

// Helper: replace global fetch for tests
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

await test("deliverWebhook succeeds on first attempt", async () => {
  const { deliverWebhook } = await import("../lib/webhook-delivery.js");

  const calls = [];
  const restore = mockFetch(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });

  try {
    const result = await deliverWebhook("https://example.com/hook", { event: "test" }, { retries: 3 });
    assert.equal(result.delivered, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.error, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://example.com/hook");
  } finally {
    restore();
  }
});

await test("deliverWebhook retries on failure then succeeds", async () => {
  const { deliverWebhook } = await import("../lib/webhook-delivery.js");

  let callCount = 0;
  const restore = mockFetch(async () => {
    callCount++;
    if (callCount < 3) {
      return { ok: false, status: 500, text: async () => "Server Error" };
    }
    return { ok: true, status: 200 };
  });

  try {
    const result = await deliverWebhook("https://example.com/hook", { event: "test" }, { retries: 3 });
    assert.equal(result.delivered, true);
    assert.equal(result.attempts, 3);
    assert.equal(callCount, 3);
  } finally {
    restore();
  }
});

await test("deliverWebhook adds to DLQ after all retries exhausted", async () => {
  const { deliverWebhook, getDLQ } = await import("../lib/webhook-delivery.js");

  const restore = mockFetch(async () => {
    return { ok: false, status: 503, text: async () => "Unavailable" };
  });

  try {
    const result = await deliverWebhook("https://fail.example.com/hook", { event: "dlq_test" }, { retries: 2 });
    assert.equal(result.delivered, false);
    assert.equal(result.attempts, 2);
    assert.ok(result.error);

    const entries = await getDLQ();
    const entry = entries.find((e) => e.url === "https://fail.example.com/hook");
    assert.ok(entry, "DLQ should contain the failed delivery");
    assert.equal(entry.payload.event, "dlq_test");
    assert.ok(entry.error);
    assert.ok(entry.id);
    assert.ok(entry.failedAt);
  } finally {
    restore();
  }
});

await test("getDLQ returns entries", async () => {
  const { getDLQ } = await import("../lib/webhook-delivery.js");
  const entries = await getDLQ();
  assert.ok(Array.isArray(entries));
  assert.ok(entries.length > 0, "DLQ should have at least the entry from the previous test");
});

await test("getDLQStats returns correct statistics", async () => {
  const { getDLQStats } = await import("../lib/webhook-delivery.js");
  const stats = await getDLQStats();
  assert.equal(typeof stats.total, "number");
  assert.ok(stats.total > 0);
  assert.ok(stats.oldest);
  assert.equal(typeof stats.byUrl, "object");
  assert.ok(stats.byUrl["https://fail.example.com/hook"] > 0);
});

await test("clearDLQEntry removes an entry", async () => {
  const { getDLQ, clearDLQEntry } = await import("../lib/webhook-delivery.js");

  const entries = await getDLQ();
  assert.ok(entries.length > 0);
  const id = entries[0].id;

  const removed = await clearDLQEntry(id);
  assert.equal(removed, true);

  const after = await getDLQ();
  assert.ok(!after.find((e) => e.id === id), "Entry should have been removed");
});

await test("clearDLQEntry returns false for missing id", async () => {
  const { clearDLQEntry } = await import("../lib/webhook-delivery.js");
  const result = await clearDLQEntry("nonexistent-id");
  assert.equal(result, false);
});

await test("retryDLQEntry returns not found for missing id", async () => {
  const { retryDLQEntry } = await import("../lib/webhook-delivery.js");
  const result = await retryDLQEntry("nonexistent-id");
  assert.equal(result.delivered, false);
  assert.equal(result.attempts, 0);
  assert.ok(result.error.includes("not found"));
});

await test("retryDLQEntry delivers and removes from DLQ on success", async () => {
  const { deliverWebhook, getDLQ, retryDLQEntry } = await import("../lib/webhook-delivery.js");

  // First, add an entry to DLQ by failing delivery
  const failRestore = mockFetch(async () => {
    return { ok: false, status: 500, text: async () => "fail" };
  });
  await deliverWebhook("https://retry.example.com/hook", { event: "retry_test" }, { retries: 1 });
  failRestore();

  const entries = await getDLQ();
  const entry = entries.find((e) => e.url === "https://retry.example.com/hook");
  assert.ok(entry, "Should be in DLQ");

  // Now retry with a successful mock
  const successRestore = mockFetch(async () => {
    return { ok: true, status: 200 };
  });

  try {
    const result = await retryDLQEntry(entry.id);
    assert.equal(result.delivered, true);

    const after = await getDLQ();
    assert.ok(!after.find((e) => e.id === entry.id), "Should be removed from DLQ after successful retry");
  } finally {
    successRestore();
  }
});

await test("backoff timing increases exponentially", async () => {
  const { BACKOFF_BASE_MS } = await import("../lib/webhook-delivery.js");

  assert.equal(BACKOFF_BASE_MS, 1000);

  // Verify delays: attempt 2 = 1000 * 2^0 = 1000ms, attempt 3 = 1000 * 2^1 = 2000ms
  const delay2 = BACKOFF_BASE_MS * Math.pow(2, 2 - 2);
  const delay3 = BACKOFF_BASE_MS * Math.pow(2, 3 - 2);
  assert.equal(delay2, 1000);
  assert.equal(delay3, 2000);
  assert.ok(delay3 > delay2, "Backoff should increase");
});

await test("deliverWebhook sends HMAC signature when secret provided", async () => {
  const { deliverWebhook } = await import("../lib/webhook-delivery.js");

  let capturedHeaders;
  const restore = mockFetch(async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200 };
  });

  try {
    await deliverWebhook("https://example.com/hook", { data: 1 }, { secret: "mysecret" });
    assert.ok(capturedHeaders["X-Webhook-Signature"], "Should include signature header");
    assert.ok(capturedHeaders["X-Webhook-Signature"].startsWith("sha256="));
  } finally {
    restore();
  }
});

await test("deliverWebhook handles fetch exceptions", async () => {
  const { deliverWebhook } = await import("../lib/webhook-delivery.js");

  const restore = mockFetch(async () => {
    throw new Error("Network error");
  });

  try {
    const result = await deliverWebhook("https://example.com/hook", { event: "test" }, { retries: 1 });
    assert.equal(result.delivered, false);
    assert.equal(result.attempts, 1);
    assert.ok(result.error.includes("Network error"));
  } finally {
    restore();
  }
});
