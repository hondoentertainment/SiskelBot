/**
 * Phase 61.2: Webhook inspector tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-webhook-inspector-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;
// Block real network if an accidental fetch happens; tests only exercise recordProbe.
process.env.ALLOW_WEBHOOK_LOCALHOST = "1";

const {
  recordProbe,
  listProbes,
  clearProbes,
  listDeliveries,
  replayDelivery,
  listReplays,
} = await import("../lib/webhook-inspector.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("recordProbe stores and listProbes returns entries in reverse order", async () => {
  await recordProbe({ url: "https://a.example/webhook", payload: { n: 1 } });
  await recordProbe({ url: "https://b.example/webhook", payload: { n: 2 } });
  const items = await listProbes();
  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://b.example/webhook");
  assert.equal(items[1].url, "https://a.example/webhook");
});

test("recordProbe requires a url", async () => {
  await assert.rejects(() => recordProbe({ payload: { a: 1 } }), /url is required/);
  await assert.rejects(() => recordProbe({}), /url is required/);
});

test("listDeliveries merges probes and applies limit", async () => {
  await clearProbes();
  for (let i = 0; i < 5; i++) {
    await recordProbe({ url: `https://x.example/${i}`, payload: { i } });
  }
  const items = await listDeliveries({ limit: 3 });
  assert.equal(items.length, 3);
  assert.ok(items.every((e) => e.kind === "probe" || e.kind === "dlq"));
});

test("listDeliveries filters by URL", async () => {
  await clearProbes();
  await recordProbe({ url: "https://match.example/wh", payload: {} });
  await recordProbe({ url: "https://other.example/wh", payload: {} });
  const items = await listDeliveries({ url: "https://match.example/wh" });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://match.example/wh");
});

test("listDeliveries filters by source", async () => {
  await clearProbes();
  await recordProbe({ url: "https://probe.example/wh", payload: {} });
  const probeOnly = await listDeliveries({ source: "probe" });
  assert.ok(probeOnly.every((e) => e.kind === "probe"));
  const dlqOnly = await listDeliveries({ source: "dlq" });
  assert.ok(dlqOnly.every((e) => e.kind === "dlq"));
});

test("clearProbes empties the live buffer", async () => {
  await recordProbe({ url: "https://temp.example/wh", payload: {} });
  await clearProbes();
  const probes = await listProbes();
  assert.equal(probes.length, 0);
});

test("replayDelivery fails without id or url", async () => {
  await assert.rejects(() => replayDelivery({}), /url is required/);
});

test("replayDelivery records a replay entry even when delivery fails", async () => {
  await clearProbes();
  // Use a URL that will fail immediately (DNS). Low retries keeps the test fast.
  const entry = await replayDelivery({
    url: "http://127.0.0.1:1/definitely-not-listening",
    payload: { hello: "world" },
    retries: 1,
  });
  assert.ok(entry.id);
  assert.equal(entry.url, "http://127.0.0.1:1/definitely-not-listening");
  assert.equal(entry.result.delivered, false);
  const replays = await listReplays();
  assert.ok(replays.some((r) => r.id === entry.id));
});

test("replayDelivery throws NOT_FOUND when id does not exist and no url override", async () => {
  await clearProbes();
  await assert.rejects(
    () => replayDelivery({ id: "no-such-id" }),
    (err) => err.code === "NOT_FOUND",
  );
});

test("replayDelivery with id override uses probe URL when not in DLQ", async () => {
  await clearProbes();
  const probe = await recordProbe({ url: "http://127.0.0.1:1/probe", payload: { x: 1 } });
  // Provide payload override so we land in the free-form branch.
  const entry = await replayDelivery({
    id: probe.id,
    payload: { x: 2 },
    retries: 1,
  });
  assert.equal(entry.url, "http://127.0.0.1:1/probe");
  assert.deepEqual(entry.payload, { x: 2 });
});
