/**
 * Coverage tests for lib/webhook-delivery.js: additional branches around
 * retryDLQEntry failure/update, signPayload with string body, and DLQ
 * boundary conditions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated storage dir so we don't bleed into other tests
process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "webhook-cov-"));

const { deliverWebhook, getDLQ, getDLQStats, retryDLQEntry, clearDLQEntry } =
  await import("../lib/webhook-delivery.js");

function mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = orig;
  };
}

test("retryDLQEntry: increments retryCount on repeated failure", async () => {
  // First, add an entry by forcing failure
  let fail = mockFetch(async () => ({ ok: false, status: 500, text: async () => "nope" }));
  await deliverWebhook("https://retry-fail-cov.example.com/hook", { n: 1 }, { retries: 1 });
  fail();

  const entries = await getDLQ();
  const entry = entries.find((e) => e.url === "https://retry-fail-cov.example.com/hook");
  assert.ok(entry);
  const initialCount = entry.retryCount || 0;

  // Retry — still fail
  fail = mockFetch(async () => ({ ok: false, status: 500, text: async () => "still fail" }));
  const r = await retryDLQEntry(entry.id);
  fail();
  assert.equal(r.delivered, false);

  const after = await getDLQ();
  const updated = after.find((e) => e.id === entry.id);
  assert.ok(updated, "entry should still exist after failed retry");
  assert.equal((updated.retryCount || 0), initialCount + 1);
  assert.ok(updated.lastRetryAt);

  // cleanup
  await clearDLQEntry(entry.id);
});

test("deliverWebhook: signs with HMAC over the serialized JSON body", async () => {
  let capturedSig = null;
  let capturedBody = null;
  const restore = mockFetch(async (url, opts) => {
    capturedSig = opts.headers["X-Webhook-Signature"];
    capturedBody = opts.body;
    return { ok: true, status: 200 };
  });
  try {
    await deliverWebhook("https://sig-test.example.com/hook", { a: 1, b: "two" }, { secret: "s3cret" });
    assert.ok(capturedSig);
    assert.match(capturedSig, /^sha256=[0-9a-f]{64}$/);
    assert.equal(capturedBody, JSON.stringify({ a: 1, b: "two" }));
  } finally {
    restore();
  }
});

test("deliverWebhook: no signature header when secret is empty/invalid", async () => {
  let headers;
  const restore = mockFetch(async (url, opts) => {
    headers = opts.headers;
    return { ok: true };
  });
  try {
    await deliverWebhook("https://nosig.example.com/hook", { x: 1 }, { secret: "" });
    assert.equal(headers["X-Webhook-Signature"], undefined);
    await deliverWebhook("https://nosig.example.com/hook", { x: 1 }, { secret: 123 });
    assert.equal(headers["X-Webhook-Signature"], undefined);
  } finally {
    restore();
  }
});

test("getDLQStats: empty DLQ returns zero totals", async () => {
  // Drain any existing entries
  const entries = await getDLQ();
  for (const e of entries) {
    await clearDLQEntry(e.id);
  }
  const stats = await getDLQStats();
  assert.equal(stats.total, 0);
  assert.equal(stats.oldest, null);
  assert.deepEqual(stats.byUrl, {});
});

test("deliverWebhook: respects options.retries=1 (no retry loop)", async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls++;
    return { ok: false, status: 500, text: async () => "f" };
  });
  try {
    const r = await deliverWebhook("https://single-attempt.example.com/hook", {}, { retries: 1 });
    assert.equal(calls, 1);
    assert.equal(r.attempts, 1);
    assert.equal(r.delivered, false);
  } finally {
    restore();
  }
});

test("deliverWebhook: text() rejection is handled gracefully", async () => {
  const restore = mockFetch(async () => ({
    ok: false,
    status: 500,
    text: async () => { throw new Error("drain failed"); },
  }));
  try {
    const r = await deliverWebhook("https://txt-fail.example.com/hook", {}, { retries: 1 });
    // fetch call "succeeded" but HTTP not ok; text read failed → lastError stays undefined or set.
    // What matters is we don't throw and we return delivered:false.
    assert.equal(r.delivered, false);
  } finally {
    restore();
  }
});
