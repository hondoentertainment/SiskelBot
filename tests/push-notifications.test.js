/**
 * Phase 37.2: Tests for lib/push-notifications.js.
 *
 * FCM and APNS transports are mocked via setPushTransport so tests never
 * hit the real Google or Apple endpoints.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  sendFCM,
  sendAPNS,
  registerDeviceToken,
  unregisterDeviceTokenForUser,
  getDeviceTokens,
  notifyUser,
  isPushConfigured,
  setPushTransport,
} from "../lib/push-notifications.js";

function mockOk(body = {}, status = 200, headers = {}) {
  return async (_url, _opts) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] || null },
    json: async () => body,
  });
}

function mockFail(status = 500, body = { reason: "nope" }) {
  return async () => ({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => body,
  });
}

// ─── sendFCM ────────────────────────────────────────────────────────────────

test("sendFCM succeeds with injected transport", async () => {
  setPushTransport({ fcm: mockOk({ message_id: "fcm-123" }) });
  try {
    const res = await sendFCM("device-abc", { title: "Hi", body: "Test" });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.id, "fcm-123");
  } finally {
    setPushTransport({ fcm: null });
  }
});

test("sendFCM reports upstream failures", async () => {
  setPushTransport({ fcm: mockFail(500, { error: "Upstream exploded" }) });
  try {
    const res = await sendFCM("device-abc", { title: "Hi", body: "Test" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 500);
    assert.ok(res.error);
  } finally {
    setPushTransport({ fcm: null });
  }
});

test("sendFCM throws when token is missing", async () => {
  setPushTransport({ fcm: mockOk() });
  try {
    await assert.rejects(() => sendFCM("", { title: "x", body: "y" }), /token is required/);
  } finally {
    setPushTransport({ fcm: null });
  }
});

test("sendFCM calls the expected URL with FCM headers", async () => {
  const captured = {};
  setPushTransport({
    fcm: async (url, opts) => {
      captured.url = url;
      captured.headers = opts.headers;
      captured.body = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ message_id: "ok" }),
      };
    },
  });
  try {
    await sendFCM("tok", { title: "T", body: "B", data: { a: 1 } });
    assert.ok(captured.url.includes("fcm"));
    assert.equal(captured.body.to, "tok");
    assert.equal(captured.body.notification.title, "T");
    assert.equal(captured.body.data.a, 1);
    assert.ok(String(captured.headers.Authorization || captured.headers.authorization || "").startsWith("key="));
  } finally {
    setPushTransport({ fcm: null });
  }
});

// ─── sendAPNS ───────────────────────────────────────────────────────────────

test("sendAPNS succeeds with injected transport", async () => {
  setPushTransport({ apns: mockOk({}, 200, { "apns-id": "apns-xyz" }) });
  try {
    const res = await sendAPNS("device-token-hex", { title: "Hi", body: "Test" });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.id, "apns-xyz");
  } finally {
    setPushTransport({ apns: null });
  }
});

test("sendAPNS reports upstream failures", async () => {
  setPushTransport({ apns: mockFail(410, { reason: "BadDeviceToken" }) });
  try {
    const res = await sendAPNS("device-token-hex", { title: "Hi", body: "Test" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 410);
    assert.equal(res.error, "BadDeviceToken");
  } finally {
    setPushTransport({ apns: null });
  }
});

test("sendAPNS builds the correct /3/device URL", async () => {
  const captured = {};
  setPushTransport({
    apns: async (url, opts) => {
      captured.url = url;
      captured.headers = opts.headers;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "id-1" },
        json: async () => ({}),
      };
    },
  });
  try {
    await sendAPNS("ABC123", { title: "T", body: "B" });
    assert.ok(captured.url.endsWith("/3/device/ABC123"));
    assert.ok(String(captured.headers.Authorization || captured.headers.authorization || "").startsWith("bearer"));
  } finally {
    setPushTransport({ apns: null });
  }
});

// ─── Device token storage ──────────────────────────────────────────────────

test("registerDeviceToken persists a token", async () => {
  const uid = "push-test-user-" + Date.now();
  const record = await registerDeviceToken(uid, "android", "tok-" + Date.now());
  assert.ok(record.id);
  assert.equal(record.platform, "android");
  const list = await getDeviceTokens(uid);
  assert.ok(list.some((d) => d.id === record.id));
});

test("registerDeviceToken normalizes platform aliases", async () => {
  const uid = "push-test-user-" + Date.now() + "-a";
  const ios = await registerDeviceToken(uid, "APNS", "tok-ios-" + Date.now());
  const and = await registerDeviceToken(uid, "FCM", "tok-and-" + Date.now());
  assert.equal(ios.platform, "ios");
  assert.equal(and.platform, "android");
});

test("registerDeviceToken rejects missing args", async () => {
  await assert.rejects(() => registerDeviceToken("", "ios", "t"), /userId/);
  await assert.rejects(() => registerDeviceToken("u", "", "t"), /platform/);
  await assert.rejects(() => registerDeviceToken("u", "ios", ""), /token/);
});

test("registerDeviceToken rejects unknown platform", async () => {
  await assert.rejects(() => registerDeviceToken("u", "blackberry", "t"), /platform must be/);
});

test("registerDeviceToken is idempotent for the same token", async () => {
  const uid = "push-test-user-" + Date.now() + "-b";
  const token = "dup-tok-" + Date.now();
  const first = await registerDeviceToken(uid, "ios", token);
  const again = await registerDeviceToken(uid, "ios", token);
  assert.equal(first.id, again.id);
  const list = await getDeviceTokens(uid);
  assert.equal(list.filter((d) => d.token === token).length, 1);
});

test("unregisterDeviceTokenForUser removes the token", async () => {
  const uid = "push-test-user-" + Date.now() + "-c";
  const token = "rm-tok-" + Date.now();
  await registerDeviceToken(uid, "android", token);
  const removed = await unregisterDeviceTokenForUser(uid, token);
  assert.equal(removed, true);
  const list = await getDeviceTokens(uid);
  assert.equal(list.find((d) => d.token === token), undefined);
});

test("unregisterDeviceTokenForUser returns false for unknown token", async () => {
  const uid = "push-test-user-" + Date.now() + "-d";
  const removed = await unregisterDeviceTokenForUser(uid, "nonexistent");
  assert.equal(removed, false);
});

// ─── notifyUser ─────────────────────────────────────────────────────────────

test("notifyUser dispatches to all devices and tallies results", async () => {
  const uid = "push-test-user-" + Date.now() + "-e";
  await registerDeviceToken(uid, "android", "and-" + Date.now());
  await registerDeviceToken(uid, "ios", "ios-" + Date.now());

  let fcmCalls = 0;
  let apnsCalls = 0;
  setPushTransport({
    fcm: async () => {
      fcmCalls++;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message_id: "x" }) };
    },
    apns: async () => {
      apnsCalls++;
      return { ok: true, status: 200, headers: { get: () => "y" }, json: async () => ({}) };
    },
  });
  try {
    const result = await notifyUser(uid, "T", "B", { key: "val" });
    assert.equal(result.sent, 2);
    assert.equal(result.failed, 0);
    assert.equal(fcmCalls, 1);
    assert.equal(apnsCalls, 1);
  } finally {
    setPushTransport({ fcm: null, apns: null });
  }
});

test("notifyUser with no devices returns zero counts", async () => {
  const uid = "push-test-user-empty-" + Date.now();
  const result = await notifyUser(uid, "T", "B");
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.results, []);
});

test("notifyUser counts failures when transport errors", async () => {
  const uid = "push-test-user-fail-" + Date.now();
  await registerDeviceToken(uid, "android", "fail-tok-" + Date.now());
  setPushTransport({ fcm: mockFail(500, { error: "boom" }) });
  try {
    const result = await notifyUser(uid, "T", "B");
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1);
  } finally {
    setPushTransport({ fcm: null });
  }
});

// ─── Config flags ──────────────────────────────────────────────────────────

test("isPushConfigured reflects injected transport", () => {
  setPushTransport({ fcm: mockOk(), apns: mockOk() });
  try {
    const cfg = isPushConfigured();
    assert.equal(cfg.configured, true);
    assert.equal(cfg.fcm, true);
    assert.equal(cfg.apns, true);
  } finally {
    setPushTransport({ fcm: null, apns: null });
  }
});
