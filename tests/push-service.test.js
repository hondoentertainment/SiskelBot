/**
 * Tests for lib/push-service.js — subscription CRUD, preferences, topics,
 * sendPush with mocked adapters, and quiet-hours filtering.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-push-"));
process.env.STORAGE_PATH = tempDir;

const {
  registerSubscription,
  unregisterSubscription,
  listUserSubscriptions,
  getNotificationPreferences,
  setNotificationPreferences,
  sendPush,
  sendBulkPush,
  subscribeToTopic,
  unsubscribeFromTopic,
  publishToTopic,
  isInQuietHours,
  setAdapters,
  _resetAdapters,
} = await import("../lib/push-service.js");

test.after(() => {
  try { rmSync(tempDir, { recursive: true }); } catch (_) {}
});

// ── Subscription CRUD ──

test("registerSubscription stores a subscription and returns id", async () => {
  const result = await registerSubscription("alice", {
    platform: "fcm",
    token: "fcm-token-1",
    metadata: { device: "pixel" },
  });
  assert.ok(result.id);
  assert.equal(result.platform, "fcm");
  assert.equal(result.token, "fcm-token-1");
  assert.ok(result.createdAt);
});

test("registerSubscription rejects unknown platform", async () => {
  await assert.rejects(
    () => registerSubscription("alice", { platform: "carrier-pigeon", token: "x" }),
    /platform must be one of/,
  );
});

test("registerSubscription rejects missing token", async () => {
  await assert.rejects(
    () => registerSubscription("alice", { platform: "fcm" }),
    /token is required/,
  );
});

test("listUserSubscriptions returns all registered subs", async () => {
  const user = "list-user-" + Date.now();
  await registerSubscription(user, { platform: "fcm", token: "t1" });
  await registerSubscription(user, { platform: "web", token: { endpoint: "https://push.example/ep/abc", keys: { p256dh: "p", auth: "a" } } });
  const subs = await listUserSubscriptions(user);
  assert.equal(subs.length, 2);
  const platforms = subs.map((s) => s.platform).sort();
  assert.deepEqual(platforms, ["fcm", "web"]);
});

test("registerSubscription dedupes identical platform+token", async () => {
  const user = "dedupe-user-" + Date.now();
  await registerSubscription(user, { platform: "fcm", token: "same-token" });
  await registerSubscription(user, { platform: "fcm", token: "same-token" });
  const subs = await listUserSubscriptions(user);
  assert.equal(subs.length, 1);
});

test("unregisterSubscription removes a subscription", async () => {
  const user = "unreg-user-" + Date.now();
  const rec = await registerSubscription(user, { platform: "fcm", token: "tok" });
  const res = await unregisterSubscription(rec.id, user);
  assert.equal(res.removed, true);
  const subs = await listUserSubscriptions(user);
  assert.equal(subs.length, 0);
});

test("unregisterSubscription returns removed=false for unknown id", async () => {
  const res = await unregisterSubscription("nonexistent-id", "ghost-user");
  assert.equal(res.removed, false);
});

// ── Preferences ──

test("getNotificationPreferences returns defaults for new user", async () => {
  const prefs = await getNotificationPreferences("new-user-" + Date.now());
  assert.ok(prefs.channels);
  assert.equal(prefs.channels.fcm, true);
  assert.equal(prefs.channels.email, true);
  assert.equal(prefs.channels.sms, false);
  assert.equal(prefs.quietHours, null);
});

test("setNotificationPreferences merges with existing preferences", async () => {
  const user = "prefs-user-" + Date.now();
  await setNotificationPreferences(user, { channels: { email: false } });
  const after = await getNotificationPreferences(user);
  assert.equal(after.channels.email, false);
  assert.equal(after.channels.fcm, true); // unchanged
});

test("setNotificationPreferences accepts valid quietHours", async () => {
  const user = "qh-user-" + Date.now();
  const prefs = await setNotificationPreferences(user, {
    quietHours: { start: "22:00", end: "08:00" },
  });
  assert.equal(prefs.quietHours.start, "22:00");
  assert.equal(prefs.quietHours.end, "08:00");
});

test("setNotificationPreferences rejects malformed quietHours", async () => {
  await assert.rejects(
    () => setNotificationPreferences("bad-qh", { quietHours: { start: "bad", end: "08:00" } }),
    /HH:MM/,
  );
});

// ── Quiet hours logic ──

test("isInQuietHours returns false when no quietHours set", () => {
  assert.equal(isInQuietHours({}), false);
  assert.equal(isInQuietHours({ quietHours: null }), false);
});

test("isInQuietHours detects same-day window", () => {
  const prefs = { quietHours: { start: "09:00", end: "17:00", timezoneOffsetMinutes: 0 } };
  const midDay = new Date(Date.UTC(2025, 0, 1, 12, 0, 0));
  const morning = new Date(Date.UTC(2025, 0, 1, 8, 0, 0));
  assert.equal(isInQuietHours(prefs, midDay), true);
  assert.equal(isInQuietHours(prefs, morning), false);
});

test("isInQuietHours detects wrap-around window", () => {
  const prefs = { quietHours: { start: "22:00", end: "08:00", timezoneOffsetMinutes: 0 } };
  const late = new Date(Date.UTC(2025, 0, 1, 23, 0, 0));
  const early = new Date(Date.UTC(2025, 0, 1, 3, 0, 0));
  const noon = new Date(Date.UTC(2025, 0, 1, 12, 0, 0));
  assert.equal(isInQuietHours(prefs, late), true);
  assert.equal(isInQuietHours(prefs, early), true);
  assert.equal(isInQuietHours(prefs, noon), false);
});

// ── Mocked adapter sending ──

function installMockAdapters() {
  const calls = [];
  const make = (platform) => async (token, notification) => {
    calls.push({ platform, token, notification });
    return { ok: true, id: `mock-${platform}-${calls.length}` };
  };
  setAdapters({
    fcm: make("fcm"),
    apns: make("apns"),
    web: make("web"),
    email: make("email"),
    sms: make("sms"),
  });
  return calls;
}

test("sendPush dispatches to all user subscriptions via mocked adapters", async () => {
  const user = "send-user-" + Date.now();
  const calls = installMockAdapters();

  await registerSubscription(user, { platform: "fcm", token: "fcm-t" });
  await registerSubscription(user, { platform: "apns", token: "apns-t" });

  const result = await sendPush(user, { title: "Hello", body: "World" });
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.results.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.platform).sort(), ["apns", "fcm"]);

  _resetAdapters();
});

test("sendPush respects disabled channels", async () => {
  const user = "channel-user-" + Date.now();
  installMockAdapters();

  await registerSubscription(user, { platform: "fcm", token: "fcm-t" });
  await registerSubscription(user, { platform: "email", token: "e@example.com" });
  await setNotificationPreferences(user, { channels: { email: false } });

  const result = await sendPush(user, { title: "Hi" });
  assert.equal(result.sent, 1); // fcm only
  const emailResult = result.results.find((r) => r.platform === "email");
  assert.ok(emailResult.skipped);
  assert.equal(emailResult.reason, "channel_disabled");

  _resetAdapters();
});

test("sendPush handles adapter failure as non-fatal", async () => {
  const user = "fail-user-" + Date.now();
  setAdapters({
    fcm: async () => ({ ok: false, error: "boom" }),
  });
  await registerSubscription(user, { platform: "fcm", token: "fcm-t" });
  const result = await sendPush(user, { title: "Hi" });
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].error, "boom");
  _resetAdapters();
});

test("sendPush requires title or body", async () => {
  await assert.rejects(
    () => sendPush("anyone", {}),
    /title or body/,
  );
});

test("sendPush returns empty result when user has no subscriptions", async () => {
  installMockAdapters();
  const result = await sendPush("no-subs-" + Date.now(), { title: "Hi" });
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.results.length, 0);
  _resetAdapters();
});

test("sendPush skips delivery during quiet hours unless bypassed", async () => {
  const user = "quiet-user-" + Date.now();
  const calls = installMockAdapters();
  await registerSubscription(user, { platform: "fcm", token: "t" });
  // Force quiet hours to always be "in" using a 00:01 window straddling now.
  // Easier: use a wrap window that covers the full day.
  await setNotificationPreferences(user, {
    quietHours: { start: "00:00", end: "23:59", timezoneOffsetMinutes: 0 },
  });

  const skipped = await sendPush(user, { title: "Quiet" });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "quiet_hours");
  assert.equal(calls.length, 0);

  const forced = await sendPush(user, { title: "Loud", bypassQuietHours: true });
  assert.equal(forced.sent, 1);
  assert.equal(calls.length, 1);

  _resetAdapters();
});

// ── Topics ──

test("subscribeToTopic and unsubscribeFromTopic track subscribers", async () => {
  const topic = "updates-" + Date.now();
  await subscribeToTopic("user-a", topic);
  await subscribeToTopic("user-b", topic);
  await subscribeToTopic("user-a", topic); // dedupe

  installMockAdapters();
  await registerSubscription("user-a", { platform: "fcm", token: "a" });
  await registerSubscription("user-b", { platform: "fcm", token: "b" });

  const published = await publishToTopic(topic, { title: "Topic hello" });
  assert.equal(published.sent, 2);

  await unsubscribeFromTopic("user-a", topic);
  const afterUnsub = await publishToTopic(topic, { title: "Solo" });
  assert.equal(afterUnsub.sent, 1);

  _resetAdapters();
});

test("subscribeToTopic rejects empty topic", async () => {
  await assert.rejects(() => subscribeToTopic("u", ""), /non-empty/);
});

// ── Bulk ──

test("sendBulkPush aggregates per-user results", async () => {
  installMockAdapters();
  const u1 = "bulk-1-" + Date.now();
  const u2 = "bulk-2-" + Date.now();
  await registerSubscription(u1, { platform: "fcm", token: "t1" });
  await registerSubscription(u2, { platform: "apns", token: "t2" });

  const result = await sendBulkPush([u1, u2], { title: "Bulk", body: "Body" });
  assert.equal(result.sent, 2);
  assert.ok(result.users[u1]);
  assert.ok(result.users[u2]);

  _resetAdapters();
});
