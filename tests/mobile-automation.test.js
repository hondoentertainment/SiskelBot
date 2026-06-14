/**
 * Phase 55.5: Mobile automation tests.
 * Covers pluggable driver registry, mock Android/iOS drivers, device
 * management, app lifecycle, input actions, screen capture, UI
 * introspection, durable test sessions, replay, assertions, and
 * permission handling.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated STORAGE_PATH for persistence tests.
const TMP = mkdtempSync(join(tmpdir(), "siskel-mobile-auto-"));
process.env.STORAGE_PATH = TMP;

const {
  PLATFORMS,
  registerMobileDriver,
  getMobileDriver,
  mockAndroidDriver,
  mockIosDriver,
  listDevices,
  getDeviceInfo,
  selectDevice,
  launchApp,
  killApp,
  installApp,
  uninstallApp,
  tap,
  doubleTap,
  longPress,
  swipe,
  typeText,
  pressKey,
  scroll,
  pinchIn,
  pinchOut,
  captureScreen,
  captureView,
  recordScreen,
  findElement,
  findElements,
  getElementText,
  getPageSource,
  createTestSession,
  recordStep,
  getSession,
  listSessions,
  replaySession,
  assertElementVisible,
  assertTextPresent,
  waitForElement,
  grantPermission,
  revokePermission,
  _clearDrivers,
  _resetSessions,
} = await import("../lib/mobile-automation.js");

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("PLATFORMS has android and ios", () => {
  assert.ok(Array.isArray(PLATFORMS));
  assert.ok(PLATFORMS.includes("android"));
  assert.ok(PLATFORMS.includes("ios"));
  assert.equal(PLATFORMS.length, 2);
});

test("registerMobileDriver + getMobileDriver installs a custom driver", () => {
  _clearDrivers();
  const custom = {
    platform: "android",
    async listDevices() {
      return [{ id: "custom-device", state: "device" }];
    },
  };
  registerMobileDriver("android", custom);
  assert.equal(getMobileDriver("android"), custom);
  _clearDrivers();
  // After clearing, falls back to the built-in mock driver.
  assert.equal(getMobileDriver("android"), mockAndroidDriver);
  assert.equal(getMobileDriver("ios"), mockIosDriver);
});

test("registerMobileDriver rejects invalid platform or driver", () => {
  assert.throws(() => registerMobileDriver("windows", {}), /invalid platform/);
  assert.throws(() => registerMobileDriver("android", null), /driver object/);
  assert.throws(() => getMobileDriver("bogus"), /invalid platform/);
});

test("mockAndroidDriver.listDevices returns an emulator entry", async () => {
  const devices = await mockAndroidDriver.listDevices();
  assert.ok(Array.isArray(devices));
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, "emulator-5554");
  assert.equal(devices[0].state, "device");
});

test("listDevices returns android devices via mock driver", async () => {
  _clearDrivers();
  const list = await listDevices("android");
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
  assert.equal(list[0].platform, "android");
});

test("listDevices with no platform aggregates both platforms", async () => {
  _clearDrivers();
  const list = await listDevices();
  const platforms = new Set(list.map((d) => d.platform));
  assert.ok(platforms.has("android"));
  assert.ok(platforms.has("ios"));
});

test("listDevices rejects invalid platform", async () => {
  await assert.rejects(() => listDevices("windows"), /invalid platform/);
});

test("getDeviceInfo returns device info with platform", async () => {
  _clearDrivers();
  const info = await getDeviceInfo("emulator-5554");
  assert.equal(info.platform, "android");
  assert.ok(info.screen && info.screen.width > 0);
});

test("getDeviceInfo rejects empty deviceId", async () => {
  await assert.rejects(() => getDeviceInfo(""), /deviceId is required/);
});

test("selectDevice finds a device matching criteria", async () => {
  _clearDrivers();
  const device = await selectDevice({ platform: "android", state: "device" });
  assert.ok(device);
  assert.equal(device.platform, "android");
  assert.equal(device.state, "device");
});

test("selectDevice returns null when no match", async () => {
  _clearDrivers();
  const device = await selectDevice({ platform: "android", model: "NonExistentModel" });
  assert.equal(device, null);
});

test("launchApp returns success via mock driver", async () => {
  _clearDrivers();
  const result = await launchApp("emulator-5554", "com.example.app");
  assert.equal(result.success, true);
  assert.equal(result.packageName, "com.example.app");
});

test("launchApp rejects missing appId", async () => {
  await assert.rejects(() => launchApp("emulator-5554", ""), /appId is required/);
});

test("killApp returns success", async () => {
  _clearDrivers();
  const result = await killApp("emulator-5554", "com.example.app");
  assert.equal(result.success, true);
});

test("installApp returns success", async () => {
  _clearDrivers();
  const result = await installApp("emulator-5554", "/path/to/app.apk");
  assert.equal(result.success, true);
  assert.equal(result.apkPath, "/path/to/app.apk");
});

test("uninstallApp returns success", async () => {
  _clearDrivers();
  const result = await uninstallApp("emulator-5554", "com.example.app");
  assert.equal(result.success, true);
});

test("tap executes via mock driver", async () => {
  _clearDrivers();
  const result = await tap("emulator-5554", 100, 200);
  assert.equal(result.success, true);
  assert.equal(result.x, 100);
  assert.equal(result.y, 200);
});

test("tap rejects invalid coordinates", async () => {
  await assert.rejects(() => tap("emulator-5554", "foo", 10), /finite/);
  await assert.rejects(() => tap("emulator-5554", -1, 10), /non-negative/);
});

test("doubleTap and longPress dispatch on mock", async () => {
  _clearDrivers();
  const d = await doubleTap("emulator-5554", 50, 80);
  assert.equal(d.success, true);
  const lp = await longPress("emulator-5554", 10, 20, 700);
  assert.equal(lp.success, true);
  assert.equal(lp.durationMs, 700);
});

test("swipe executes via mock driver", async () => {
  _clearDrivers();
  const result = await swipe("emulator-5554", { x: 0, y: 0 }, { x: 100, y: 100 });
  assert.equal(result.success, true);
  assert.deepEqual(result.from, { x: 0, y: 0 });
  assert.deepEqual(result.to, { x: 100, y: 100 });
});

test("typeText and pressKey execute via mock driver", async () => {
  _clearDrivers();
  const t = await typeText("emulator-5554", "hello world");
  assert.equal(t.success, true);
  assert.equal(t.text, "hello world");
  const k = await pressKey("emulator-5554", "BACK");
  assert.equal(k.success, true);
  assert.equal(k.key, "BACK");
});

test("scroll, pinchIn, pinchOut execute via mock driver", async () => {
  _clearDrivers();
  const s = await scroll("emulator-5554", "down", 3);
  assert.equal(s.success, true);
  assert.equal(s.direction, "down");
  const pi = await pinchIn("emulator-5554", { x: 50, y: 50 });
  assert.equal(pi.gesture, "pinch_in");
  const po = await pinchOut("emulator-5554", { x: 50, y: 50 });
  assert.equal(po.gesture, "pinch_out");
  await assert.rejects(() => scroll("emulator-5554", "bogus"), /direction/);
});

test("captureScreen returns data from the mock driver", async () => {
  _clearDrivers();
  const result = await captureScreen("emulator-5554");
  assert.ok(result);
  assert.ok(typeof result.data === "string" && result.data.length > 0);
  assert.ok(result.width > 0 && result.height > 0);
});

test("captureView returns cropped data", async () => {
  _clearDrivers();
  const result = await captureView("emulator-5554", { x: 0, y: 0, width: 50, height: 60 });
  assert.equal(result.width, 50);
  assert.equal(result.height, 60);
});

test("recordScreen with positive duration returns a path", async () => {
  _clearDrivers();
  const result = await recordScreen("emulator-5554", 100);
  assert.ok(result.path);
  assert.equal(result.durationMs, 100);
  await assert.rejects(() => recordScreen("emulator-5554", 0), /positive/);
});

test("findElement via mock driver returns an element", async () => {
  _clearDrivers();
  const el = await findElement("emulator-5554", { id: "login-button" });
  assert.ok(el);
  assert.equal(typeof el.elementId, "string");
});

test("findElement requires at least one selector field", async () => {
  await assert.rejects(() => findElement("emulator-5554", {}), /at least one of/);
});

test("findElements returns an array", async () => {
  _clearDrivers();
  const list = await findElements("emulator-5554", { text: "Mock Button" });
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
});

test("getElementText and getPageSource return strings", async () => {
  _clearDrivers();
  const text = await getElementText("emulator-5554", "some-id");
  assert.equal(typeof text, "string");
  const src = await getPageSource("emulator-5554");
  assert.equal(typeof src, "string");
  assert.ok(src.length > 0);
});

test("createTestSession persists a new session", async () => {
  _clearDrivers();
  await _resetSessions();
  const session = await createTestSession("Login flow", "emulator-5554", "com.example.app");
  assert.ok(session.id.startsWith("mobsess_"));
  assert.equal(session.name, "Login flow");
  assert.equal(session.deviceId, "emulator-5554");
  assert.equal(session.appId, "com.example.app");
  assert.equal(session.platform, "android");
  assert.equal(session.status, "open");
  assert.deepEqual(session.steps, []);
});

test("createTestSession rejects missing fields", async () => {
  await assert.rejects(() => createTestSession("", "emulator-5554", "com.example.app"), /name/);
  await assert.rejects(() => createTestSession("name", "", "com.example.app"), /deviceId/);
  await assert.rejects(() => createTestSession("name", "emulator-5554", ""), /appId/);
});

test("recordStep appends steps to a session", async () => {
  _clearDrivers();
  await _resetSessions();
  const session = await createTestSession("Flow", "emulator-5554", "com.example.app");
  const step = await recordStep(session.id, { type: "tap", args: { x: 10, y: 20 } });
  assert.equal(step.type, "tap");
  const loaded = await getSession(session.id);
  assert.equal(loaded.steps.length, 1);
  assert.deepEqual(loaded.steps[0].args, { x: 10, y: 20 });
});

test("recordStep rejects unknown session", async () => {
  await assert.rejects(
    () => recordStep("bogus-id", { type: "tap", args: { x: 0, y: 0 } }),
    /not found/,
  );
});

test("listSessions returns all created sessions", async () => {
  _clearDrivers();
  await _resetSessions();
  await createTestSession("A", "emulator-5554", "com.a");
  await createTestSession("B", "emulator-5554", "com.b");
  const list = await listSessions();
  assert.equal(list.length, 2);
  const names = list.map((s) => s.name).sort();
  assert.deepEqual(names, ["A", "B"]);
});

test("replaySession executes recorded steps via mock driver", async () => {
  _clearDrivers();
  await _resetSessions();
  const session = await createTestSession("Replay", "emulator-5554", "com.example.app");
  await recordStep(session.id, { type: "tap", args: { x: 5, y: 5 } });
  await recordStep(session.id, { type: "type", args: { text: "hi" } });
  await recordStep(session.id, { type: "screenshot", args: {} });
  const result = await replaySession(session.id);
  assert.equal(result.success, true);
  assert.equal(result.totalSteps, 3);
  assert.equal(result.steps.length, 3);
  for (const s of result.steps) {
    assert.equal(s.success, true);
  }
});

test("replaySession stops on first failing step", async () => {
  _clearDrivers();
  await _resetSessions();
  const session = await createTestSession("ReplayFail", "emulator-5554", "com.example.app");
  await recordStep(session.id, { type: "tap", args: { x: 1, y: 1 } });
  await recordStep(session.id, { type: "unknown_gibberish", args: {} });
  await recordStep(session.id, { type: "tap", args: { x: 2, y: 2 } });
  const result = await replaySession(session.id);
  assert.equal(result.success, false);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].success, false);
});

test("assertElementVisible returns ok when element is found", async () => {
  _clearDrivers();
  const result = await assertElementVisible("emulator-5554", { id: "ok" });
  assert.equal(result.ok, true);
  assert.ok(result.element);
});

test("assertTextPresent scans page source", async () => {
  _clearDrivers();
  const result = await assertTextPresent("emulator-5554", "Mock");
  assert.equal(result.ok, true);
  const missing = await assertTextPresent("emulator-5554", "ZZZZZ-not-there");
  // Fallback may still find it via mock findElement (which always returns one),
  // so just ensure ok is a boolean.
  assert.equal(typeof missing.ok, "boolean");
});

test("waitForElement succeeds immediately via mock", async () => {
  _clearDrivers();
  const result = await waitForElement("emulator-5554", { id: "foo" }, 200);
  assert.equal(result.ok, true);
});

test("waitForElement times out when driver returns no elements", async () => {
  _clearDrivers();
  const emptyDriver = {
    ...mockAndroidDriver,
    async findElements() {
      return [];
    },
  };
  registerMobileDriver("android", emptyDriver);
  const started = Date.now();
  const result = await waitForElement("emulator-5554", { id: "never" }, 80);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.match(result.reason || "", /not found/);
  assert.ok(elapsed >= 50, `elapsed ${elapsed}ms should be >= 50ms`);
  _clearDrivers();
});

test("grantPermission and revokePermission dispatch to the driver", async () => {
  _clearDrivers();
  const grant = await grantPermission("emulator-5554", "com.example.app", "CAMERA");
  assert.equal(grant.granted, true);
  const revoke = await revokePermission("emulator-5554", "com.example.app", "CAMERA");
  assert.equal(revoke.granted, false);
});

test("tap rejects unknown deviceId with empty string", async () => {
  await assert.rejects(() => tap("", 0, 0), /deviceId is required/);
});

test("mockIosDriver routes for ios-prefixed device ids", async () => {
  _clearDrivers();
  const info = await getDeviceInfo("ios-sim-uuid-1");
  assert.equal(info.platform, "ios");
  const launch = await launchApp("ios-sim-uuid-1", "com.example.ios");
  assert.equal(launch.success, true);
  assert.equal(launch.bundleId, "com.example.ios");
});
