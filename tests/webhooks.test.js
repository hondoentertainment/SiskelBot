import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/webhooks-test-" + Date.now();
});

await test("validateWebhookUrl rejects empty string", async () => {
  const { validateWebhookUrl } = await import("../lib/webhooks.js");
  const r = validateWebhookUrl("");
  assert.equal(r.valid, false);
  assert.ok(r.reason);
});

await test("validateWebhookUrl rejects non-HTTPS URL", async () => {
  const { validateWebhookUrl } = await import("../lib/webhooks.js");
  const r = validateWebhookUrl("http://example.com/hook");
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes("HTTPS"));
});

await test("validateWebhookUrl rejects localhost by default", async () => {
  const { validateWebhookUrl } = await import("../lib/webhooks.js");
  const r = validateWebhookUrl("https://localhost/hook");
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes("localhost"));
});

await test("validateWebhookUrl rejects private IPs", async () => {
  const { validateWebhookUrl } = await import("../lib/webhooks.js");
  const r = validateWebhookUrl("https://192.168.1.1/hook");
  assert.equal(r.valid, false);
});

await test("validateWebhookUrl accepts valid HTTPS URL", async () => {
  const { validateWebhookUrl } = await import("../lib/webhooks.js");
  const r = validateWebhookUrl("https://example.com/webhook");
  assert.equal(r.valid, true);
});

await test("validateWebhookUrl rejects invalid URL", async () => {
  const { validateWebhookUrl } = await import("../lib/webhooks.js");
  const r = validateWebhookUrl("not a url at all");
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes("Invalid URL"));
});

await test("listWebhooks returns empty array for new workspace", async () => {
  const { listWebhooks } = await import("../lib/webhooks.js");
  const list = await listWebhooks("wh-test-ws");
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 0);
});

await test("addWebhook creates a webhook and strips secret from result", async () => {
  const { addWebhook } = await import("../lib/webhooks.js");
  const wh = await addWebhook(
    { url: "https://example.com/hook", events: ["message_sent"], secret: "mysecret" },
    "wh-test-ws"
  );
  assert.ok(wh.id);
  assert.equal(wh.url, "https://example.com/hook");
  assert.deepEqual(wh.events, ["message_sent"]);
  assert.equal(wh.secret, undefined);
});

await test("addWebhook throws for invalid URL", async () => {
  const { addWebhook } = await import("../lib/webhooks.js");
  await assert.rejects(
    () => addWebhook({ url: "http://badurl.com/hook", events: ["message_sent"] }, "wh-test-ws"),
    { message: /HTTPS/ }
  );
});

await test("addWebhook throws when no valid events provided", async () => {
  const { addWebhook } = await import("../lib/webhooks.js");
  await assert.rejects(
    () => addWebhook({ url: "https://example.com/hook", events: ["invalid_event"] }, "wh-test-ws"),
    { message: /event/ }
  );
});

await test("listWebhooks returns added webhooks without secrets", async () => {
  const { listWebhooks } = await import("../lib/webhooks.js");
  const list = await listWebhooks("wh-test-ws");
  assert.ok(list.length >= 1);
  for (const w of list) {
    assert.equal(w.secret, undefined);
  }
});

await test("removeWebhook removes an existing webhook", async () => {
  const { addWebhook, removeWebhook, listWebhooks } = await import("../lib/webhooks.js");
  const wh = await addWebhook(
    { url: "https://example.com/removeme", events: ["plan_created"] },
    "wh-test-ws"
  );
  const removed = await removeWebhook(wh.id, "wh-test-ws");
  assert.equal(removed, true);

  const list = await listWebhooks("wh-test-ws");
  assert.ok(!list.find(w => w.id === wh.id));
});

await test("removeWebhook returns false for nonexistent id", async () => {
  const { removeWebhook } = await import("../lib/webhooks.js");
  const removed = await removeWebhook("nonexistent-id", "wh-test-ws");
  assert.equal(removed, false);
});

await test("addWebhook filters out unknown events", async () => {
  const { addWebhook } = await import("../lib/webhooks.js");
  const wh = await addWebhook(
    { url: "https://example.com/filtered", events: ["message_sent", "fake_event", "plan_created"] },
    "wh-test-ws"
  );
  assert.deepEqual(wh.events, ["message_sent", "plan_created"]);
});
