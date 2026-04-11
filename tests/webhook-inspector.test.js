/**
 * Phase 61.2: webhook-inspector tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-webhookinspect-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  captureDelivery,
  listDeliveries,
  replayDelivery,
  filterDeliveries,
  clearCapture,
  normalizeDelivery,
  listReplays,
} = await import("../lib/webhook-inspector.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("normalizeDelivery applies defaults", () => {
  const n = normalizeDelivery({ url: "https://hook", event: "push" });
  assert.equal(n.method, "POST");
  assert.equal(n.direction, "incoming");
  assert.equal(n.event, "push");
  assert.equal(n.url, "https://hook");
  assert.deepEqual(n.headers, {});
});

test("normalizeDelivery rejects bad input", () => {
  assert.throws(() => normalizeDelivery(null));
  assert.throws(() => normalizeDelivery({ event: "no url" }));
});

test("captureDelivery persists and listDeliveries returns it", async () => {
  await clearCapture();
  const d = await captureDelivery({
    url: "https://hook.example.com",
    event: "payment.success",
    body: { amount: 100 },
    headers: { "X-Signature": "abc" },
    source: "stripe",
  });
  assert.ok(d.id);
  const all = await listDeliveries();
  assert.ok(all.some((x) => x.id === d.id));
});

test("captureDelivery rejects invalid input", async () => {
  await assert.rejects(() => captureDelivery({ event: "x" }));
});

test("filterDeliveries filters by event/direction/source", async () => {
  await clearCapture();
  await captureDelivery({ url: "https://a", event: "ping", source: "gh" });
  await captureDelivery({ url: "https://a", event: "push", source: "gh" });
  await captureDelivery({ url: "https://b", event: "push", source: "gitlab", direction: "outgoing" });
  const byEvent = await filterDeliveries({ event: "push" });
  assert.equal(byEvent.length, 2);
  const byDirection = await filterDeliveries({ direction: "outgoing" });
  assert.equal(byDirection.length, 1);
  const bySource = await filterDeliveries({ source: "gh" });
  assert.equal(bySource.length, 2);
});

test("filterDeliveries matches urlContains", async () => {
  await clearCapture();
  await captureDelivery({ url: "https://api.foo.com/hooks", event: "x" });
  await captureDelivery({ url: "https://api.bar.com/hooks", event: "x" });
  const result = await filterDeliveries({ urlContains: "foo" });
  assert.equal(result.length, 1);
});

test("replayDelivery calls injected transport with request payload", async () => {
  await clearCapture();
  const d = await captureDelivery({
    url: "https://hook.test",
    event: "x",
    body: { foo: 1 },
    headers: { Authorization: "Bearer abc" },
  });
  let calledWith = null;
  const transport = async (req) => {
    calledWith = req;
    return { status: 200, body: { ok: true } };
  };
  const replay = await replayDelivery(d.id, { transport });
  assert.ok(calledWith);
  assert.equal(calledWith.url, "https://hook.test");
  assert.equal(calledWith.headers.Authorization, "Bearer abc");
  assert.equal(replay.responseStatus, 200);
  assert.deepEqual(replay.responseBody, { ok: true });
});

test("replayDelivery captures transport errors", async () => {
  await clearCapture();
  const d = await captureDelivery({ url: "https://hook.test", event: "x" });
  const transport = async () => { throw new Error("network down"); };
  const replay = await replayDelivery(d.id, { transport });
  assert.equal(replay.error, "network down");
  assert.equal(replay.responseStatus, 0);
});

test("replayDelivery rejects for unknown id", async () => {
  await assert.rejects(() => replayDelivery("nope"));
});

test("replayDelivery supports overrideUrl", async () => {
  await clearCapture();
  const d = await captureDelivery({ url: "https://hook.test", event: "x" });
  let calledWith = null;
  const transport = async (req) => {
    calledWith = req;
    return { status: 204 };
  };
  await replayDelivery(d.id, { transport, overrideUrl: "https://new.test" });
  assert.equal(calledWith.url, "https://new.test");
});

test("listReplays returns replay history per delivery", async () => {
  await clearCapture();
  const d = await captureDelivery({ url: "https://hook.test", event: "x" });
  const transport = async () => ({ status: 200 });
  await replayDelivery(d.id, { transport });
  await replayDelivery(d.id, { transport });
  const replays = await listReplays(d.id);
  assert.ok(replays.length >= 2);
});

test("clearCapture removes one capture and all captures", async () => {
  await clearCapture();
  const a = await captureDelivery({ url: "https://a", event: "x" });
  const b = await captureDelivery({ url: "https://b", event: "x" });
  await clearCapture(a.id);
  const remaining = await listDeliveries();
  assert.ok(!remaining.some((d) => d.id === a.id));
  assert.ok(remaining.some((d) => d.id === b.id));
  await clearCapture();
  const empty = await listDeliveries();
  assert.equal(empty.length, 0);
});
