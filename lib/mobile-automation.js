// @ts-check
/**
 * Phase 55.5: Mobile automation.
 *
 * ADB / XCUITest bridge abstraction for mobile app testing. Provides a
 * pluggable driver registry (android / ios), deterministic mock drivers for
 * tests, and durable test sessions (persisted via json-path-store). Real
 * drivers (adb, appium, xcuitest, etc.) must be explicitly registered via
 * registerMobileDriver; no external processes are touched by default.
 *
 * @module mobile-automation
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;

/** Supported mobile platforms. */
export const PLATFORMS = ["android", "ios"];

const PLATFORM_SET = new Set(PLATFORMS);

// ----------------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------------

function storePath() {
  return join(getDataDir(), "mobile-automation-sessions.json");
}

async function loadStore() {
  const raw = await readJsonPath(storePath(), { version: STORE_VERSION, sessions: {} });
  if (!raw || typeof raw !== "object") return { version: STORE_VERSION, sessions: {} };
  if (!raw.sessions || typeof raw.sessions !== "object") raw.sessions = {};
  if (!raw.version) raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

// ----------------------------------------------------------------------------
// Pluggable driver registry
// ----------------------------------------------------------------------------

const drivers = new Map();

/**
 * Register a platform driver. A driver is an object exposing the core device
 * actions (listDevices, launchApp, tap, swipe, etc.).
 * @param {string} platform - "android" or "ios"
 * @param {object} driver
 */
export function registerMobileDriver(platform, driver) {
  if (!platform || typeof platform !== "string") {
    throw new Error("registerMobileDriver requires a platform name");
  }
  if (!PLATFORM_SET.has(platform)) {
    throw new Error(`invalid platform: ${platform}`);
  }
  if (!driver || typeof driver !== "object") {
    throw new Error("registerMobileDriver requires a driver object");
  }
  drivers.set(platform, driver);
}

/**
 * Look up a driver by platform name. Falls back to the built-in mock driver
 * if none has been registered.
 * @param {string} platform
 */
export function getMobileDriver(platform) {
  if (!PLATFORM_SET.has(platform)) {
    throw new Error(`invalid platform: ${platform}`);
  }
  return drivers.get(platform) || (platform === "android" ? mockAndroidDriver : mockIosDriver);
}

/** Clear all registered drivers — useful for tests. */
export function _clearDrivers() {
  drivers.clear();
}

// ----------------------------------------------------------------------------
// Mock drivers
// ----------------------------------------------------------------------------

function okTap(deviceId, x, y) {
  return { success: true, deviceId, x, y };
}

function okSwipe(deviceId, x1, y1, x2, y2) {
  return { success: true, deviceId, from: { x: x1, y: y1 }, to: { x: x2, y: y2 } };
}

/** Deterministic Android mock driver. */
export const mockAndroidDriver = {
  platform: "android",
  async listDevices() {
    return [{ id: "emulator-5554", state: "device", platform: "android", model: "Pixel_6_API_33" }];
  },
  async getDeviceInfo(deviceId) {
    return {
      id: deviceId,
      platform: "android",
      state: "device",
      model: "Pixel_6_API_33",
      sdk: 33,
      screen: { width: 1080, height: 2400, density: 420 },
    };
  },
  async launchApp(deviceId, packageName) {
    return { success: true, deviceId, packageName, pid: 1234 };
  },
  async killApp(deviceId, packageName) {
    return { success: true, deviceId, packageName };
  },
  async installApp(deviceId, apkPath) {
    return { success: true, deviceId, apkPath };
  },
  async installApk(deviceId, apkPath) {
    return { success: true, deviceId, apkPath };
  },
  async uninstallApp(deviceId, packageName) {
    return { success: true, deviceId, packageName };
  },
  async uninstallPackage(deviceId, packageName) {
    return { success: true, deviceId, packageName };
  },
  async getScreen(deviceId) {
    return { width: 1080, height: 2400, data: "base64:android-mock", deviceId };
  },
  async captureScreen(deviceId) {
    return { width: 1080, height: 2400, data: "base64:android-mock", deviceId };
  },
  async captureView(deviceId, bounds) {
    return { width: bounds?.width || 100, height: bounds?.height || 100, data: "base64:android-view", deviceId };
  },
  async recordScreen(deviceId, durationMs) {
    return { deviceId, durationMs, path: `/tmp/android-${deviceId}.mp4`, mock: true };
  },
  async tap(deviceId, x, y) {
    return okTap(deviceId, x, y);
  },
  async doubleTap(deviceId, x, y) {
    return { success: true, deviceId, x, y, gesture: "double_tap" };
  },
  async longPress(deviceId, x, y, durationMs) {
    return { success: true, deviceId, x, y, durationMs };
  },
  async swipe(deviceId, x1, y1, x2, y2) {
    return okSwipe(deviceId, x1, y1, x2, y2);
  },
  async typeText(deviceId, text) {
    return { success: true, deviceId, text };
  },
  async pressKey(deviceId, key) {
    return { success: true, deviceId, key };
  },
  async scroll(deviceId, direction, amount) {
    return { success: true, deviceId, direction, amount };
  },
  async pinchIn(deviceId, center) {
    return { success: true, deviceId, center, gesture: "pinch_in" };
  },
  async pinchOut(deviceId, center) {
    return { success: true, deviceId, center, gesture: "pinch_out" };
  },
  async findElements(_deviceId, query) {
    if (!query || typeof query !== "object") return [];
    const id = query.id || query.contentDesc || query.text || query.className || "mock-element";
    return [
      {
        elementId: `android-el-${id}`,
        id: query.id || null,
        text: query.text || "Mock Button",
        className: query.className || "android.widget.Button",
        contentDesc: query.contentDesc || null,
        bounds: { x: 100, y: 200, width: 300, height: 80 },
        visible: true,
      },
    ];
  },
  async getElementText(_deviceId, elementId) {
    return `text-of-${elementId}`;
  },
  async getPageSource(_deviceId) {
    return `<hierarchy><node class=\"android.widget.FrameLayout\"><node text=\"Mock\"/></node></hierarchy>`;
  },
  async grantPermission(deviceId, appId, permission) {
    return { success: true, deviceId, appId, permission, granted: true };
  },
  async revokePermission(deviceId, appId, permission) {
    return { success: true, deviceId, appId, permission, granted: false };
  },
};

/** Deterministic iOS mock driver. */
export const mockIosDriver = {
  platform: "ios",
  async listDevices() {
    return [{ id: "ios-sim-uuid-1", state: "Booted", platform: "ios", model: "iPhone_15" }];
  },
  async getDeviceInfo(deviceId) {
    return {
      id: deviceId,
      platform: "ios",
      state: "Booted",
      model: "iPhone_15",
      osVersion: "17.0",
      screen: { width: 1179, height: 2556, density: 460 },
    };
  },
  async launchApp(deviceId, bundleId) {
    return { success: true, deviceId, bundleId, pid: 5678 };
  },
  async killApp(deviceId, bundleId) {
    return { success: true, deviceId, bundleId };
  },
  async installApp(deviceId, ipaPath) {
    return { success: true, deviceId, ipaPath };
  },
  async uninstallApp(deviceId, bundleId) {
    return { success: true, deviceId, bundleId };
  },
  async getScreen(deviceId) {
    return { width: 1179, height: 2556, data: "base64:ios-mock", deviceId };
  },
  async captureScreen(deviceId) {
    return { width: 1179, height: 2556, data: "base64:ios-mock", deviceId };
  },
  async captureView(deviceId, bounds) {
    return { width: bounds?.width || 100, height: bounds?.height || 100, data: "base64:ios-view", deviceId };
  },
  async recordScreen(deviceId, durationMs) {
    return { deviceId, durationMs, path: `/tmp/ios-${deviceId}.mov`, mock: true };
  },
  async tap(deviceId, x, y) {
    return okTap(deviceId, x, y);
  },
  async doubleTap(deviceId, x, y) {
    return { success: true, deviceId, x, y, gesture: "double_tap" };
  },
  async longPress(deviceId, x, y, durationMs) {
    return { success: true, deviceId, x, y, durationMs };
  },
  async swipe(deviceId, x1, y1, x2, y2) {
    return okSwipe(deviceId, x1, y1, x2, y2);
  },
  async typeText(deviceId, text) {
    return { success: true, deviceId, text };
  },
  async pressKey(deviceId, key) {
    return { success: true, deviceId, key };
  },
  async scroll(deviceId, direction, amount) {
    return { success: true, deviceId, direction, amount };
  },
  async pinchIn(deviceId, center) {
    return { success: true, deviceId, center, gesture: "pinch_in" };
  },
  async pinchOut(deviceId, center) {
    return { success: true, deviceId, center, gesture: "pinch_out" };
  },
  async findElements(_deviceId, query) {
    if (!query || typeof query !== "object") return [];
    const id = query.id || query.text || query.className || "mock-element";
    return [
      {
        elementId: `ios-el-${id}`,
        id: query.id || null,
        text: query.text || "Mock Button",
        className: query.className || "XCUIElementTypeButton",
        contentDesc: null,
        bounds: { x: 50, y: 100, width: 200, height: 60 },
        visible: true,
      },
    ];
  },
  async getElementText(_deviceId, elementId) {
    return `text-of-${elementId}`;
  },
  async getPageSource(_deviceId) {
    return `<XCUIElementTypeApplication><XCUIElementTypeButton label=\"Mock\"/></XCUIElementTypeApplication>`;
  },
  async grantPermission(deviceId, appId, permission) {
    return { success: true, deviceId, appId, permission, granted: true };
  },
  async revokePermission(deviceId, appId, permission) {
    return { success: true, deviceId, appId, permission, granted: false };
  },
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function resolveDriverByPlatform(platform) {
  if (!PLATFORM_SET.has(platform)) {
    throw new Error(`invalid platform: ${platform}`);
  }
  return getMobileDriver(platform);
}

function platformForDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== "string") {
    throw new Error("deviceId is required");
  }
  // Naive heuristic: ids starting with "ios" or "iphone" are iOS.
  if (/^(ios|iphone|ipad|sim|[0-9A-F]{8}-)/i.test(deviceId)) return "ios";
  return "android";
}

async function resolveDriverForDevice(deviceId) {
  const platform = platformForDeviceId(deviceId);
  const driver = resolveDriverByPlatform(platform);
  return { driver, platform };
}

function requireMethod(driver, method) {
  if (typeof driver[method] !== "function") {
    throw new Error(`driver missing method: ${method}`);
  }
}

// ----------------------------------------------------------------------------
// Device management
// ----------------------------------------------------------------------------

/**
 * List devices across platforms. If a platform is provided, only that
 * platform is queried.
 * @param {string|null} platform
 */
export async function listDevices(platform = null) {
  if (platform != null) {
    if (!PLATFORM_SET.has(platform)) {
      throw new Error(`invalid platform: ${platform}`);
    }
    const driver = resolveDriverByPlatform(platform);
    requireMethod(driver, "listDevices");
    const list = await driver.listDevices();
    return (Array.isArray(list) ? list : []).map((d) => ({ ...d, platform }));
  }
  const all = [];
  for (const p of PLATFORMS) {
    try {
      const driver = resolveDriverByPlatform(p);
      if (typeof driver.listDevices !== "function") continue;
      const list = await driver.listDevices();
      for (const d of Array.isArray(list) ? list : []) {
        all.push({ ...d, platform: p });
      }
    } catch (_) {
      /* skip */
    }
  }
  return all;
}

export async function getDeviceInfo(deviceId) {
  if (!deviceId) throw new Error("deviceId is required");
  const { driver, platform } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "getDeviceInfo");
  const info = await driver.getDeviceInfo(deviceId);
  if (!info) throw new Error(`device ${deviceId} not found`);
  return { ...info, platform };
}

/**
 * Select a device matching criteria (platform, model, state).
 * Returns the first match or null.
 */
export async function selectDevice(criteria = {}) {
  const list = await listDevices(criteria.platform || null);
  if (list.length === 0) return null;
  const predicate = (d) => {
    if (criteria.model && d.model !== criteria.model) return false;
    if (criteria.state && d.state !== criteria.state) return false;
    if (criteria.id && d.id !== criteria.id) return false;
    return true;
  };
  return list.find(predicate) || null;
}

// ----------------------------------------------------------------------------
// App lifecycle
// ----------------------------------------------------------------------------

export async function launchApp(deviceId, appId) {
  if (!appId) throw new Error("appId is required");
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "launchApp");
  return driver.launchApp(deviceId, appId);
}

export async function killApp(deviceId, appId) {
  if (!appId) throw new Error("appId is required");
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "killApp");
  return driver.killApp(deviceId, appId);
}

export async function installApp(deviceId, path) {
  if (!path) throw new Error("path is required");
  const { driver } = await resolveDriverForDevice(deviceId);
  if (typeof driver.installApp === "function") {
    return driver.installApp(deviceId, path);
  }
  if (typeof driver.installApk === "function") {
    return driver.installApk(deviceId, path);
  }
  throw new Error("driver missing method: installApp");
}

export async function uninstallApp(deviceId, appId) {
  if (!appId) throw new Error("appId is required");
  const { driver } = await resolveDriverForDevice(deviceId);
  if (typeof driver.uninstallApp === "function") {
    return driver.uninstallApp(deviceId, appId);
  }
  if (typeof driver.uninstallPackage === "function") {
    return driver.uninstallPackage(deviceId, appId);
  }
  throw new Error("driver missing method: uninstallApp");
}

// ----------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------

function assertCoords(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("x and y must be finite numbers");
  }
  if (x < 0 || y < 0) {
    throw new Error("x and y must be non-negative");
  }
}

export async function tap(deviceId, x, y) {
  assertCoords(x, y);
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "tap");
  return driver.tap(deviceId, x, y);
}

export async function doubleTap(deviceId, x, y) {
  assertCoords(x, y);
  const { driver } = await resolveDriverForDevice(deviceId);
  if (typeof driver.doubleTap === "function") {
    return driver.doubleTap(deviceId, x, y);
  }
  // Fallback: two taps.
  await driver.tap(deviceId, x, y);
  return driver.tap(deviceId, x, y);
}

export async function longPress(deviceId, x, y, durationMs = 500) {
  assertCoords(x, y);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("durationMs must be a non-negative number");
  }
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "longPress");
  return driver.longPress(deviceId, x, y, durationMs);
}

export async function swipe(deviceId, from, to) {
  if (!from || !to) throw new Error("swipe requires from and to");
  assertCoords(from.x, from.y);
  assertCoords(to.x, to.y);
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "swipe");
  return driver.swipe(deviceId, from.x, from.y, to.x, to.y);
}

export async function typeText(deviceId, text) {
  if (typeof text !== "string") throw new Error("text must be a string");
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "typeText");
  return driver.typeText(deviceId, text);
}

export async function pressKey(deviceId, key) {
  if (typeof key !== "string" || !key) throw new Error("key must be a non-empty string");
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "pressKey");
  return driver.pressKey(deviceId, key);
}

export async function scroll(deviceId, direction, amount = 1) {
  const allowed = ["up", "down", "left", "right"];
  if (!allowed.includes(direction)) {
    throw new Error(`direction must be one of ${allowed.join(", ")}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("amount must be a positive number");
  }
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "scroll");
  return driver.scroll(deviceId, direction, amount);
}

export async function pinchIn(deviceId, center) {
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "pinchIn");
  return driver.pinchIn(deviceId, center || { x: 0, y: 0 });
}

export async function pinchOut(deviceId, center) {
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "pinchOut");
  return driver.pinchOut(deviceId, center || { x: 0, y: 0 });
}

// ----------------------------------------------------------------------------
// Screen capture
// ----------------------------------------------------------------------------

export async function captureScreen(deviceId) {
  const { driver } = await resolveDriverForDevice(deviceId);
  if (typeof driver.captureScreen === "function") {
    return driver.captureScreen(deviceId);
  }
  if (typeof driver.getScreen === "function") {
    return driver.getScreen(deviceId);
  }
  throw new Error("driver missing method: captureScreen");
}

export async function captureView(deviceId, bounds) {
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "captureView");
  return driver.captureView(deviceId, bounds || {});
}

export async function recordScreen(deviceId, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("durationMs must be positive");
  }
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "recordScreen");
  return driver.recordScreen(deviceId, durationMs);
}

// ----------------------------------------------------------------------------
// UI introspection
// ----------------------------------------------------------------------------

function validateQuery(query) {
  if (!query || typeof query !== "object") {
    throw new Error("query must be an object");
  }
  const allowed = ["id", "text", "className", "contentDesc", "xpath"];
  const hasAny = allowed.some((k) => typeof query[k] === "string" && query[k].length > 0);
  if (!hasAny) {
    throw new Error("query must include at least one of: id, text, className, contentDesc, xpath");
  }
}

export async function findElement(deviceId, query) {
  validateQuery(query);
  const list = await findElements(deviceId, query);
  return list.length > 0 ? list[0] : null;
}

export async function findElements(deviceId, query) {
  validateQuery(query);
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "findElements");
  const list = await driver.findElements(deviceId, query);
  return Array.isArray(list) ? list : [];
}

export async function getElementText(deviceId, elementId) {
  if (!elementId) throw new Error("elementId is required");
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "getElementText");
  return driver.getElementText(deviceId, elementId);
}

export async function getPageSource(deviceId) {
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "getPageSource");
  return driver.getPageSource(deviceId);
}

// ----------------------------------------------------------------------------
// Test sessions
// ----------------------------------------------------------------------------

export async function createTestSession(name, deviceId, appId) {
  if (!name || typeof name !== "string") throw new Error("session name is required");
  if (!deviceId) throw new Error("deviceId is required");
  if (!appId) throw new Error("appId is required");
  const platform = platformForDeviceId(deviceId);
  const id = `mobsess_${randomUUID()}`;
  const session = {
    id,
    name,
    deviceId,
    appId,
    platform,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: [],
    status: "open",
  };
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.sessions[id] = session;
    await saveStore(store);
    return session;
  });
}

function normalizeStep(step) {
  if (!step || typeof step !== "object") {
    throw new Error("step must be an object");
  }
  const type = String(step.type || "").trim();
  if (!type) throw new Error("step.type is required");
  return {
    type,
    args: step.args && typeof step.args === "object" ? step.args : {},
    timestamp: Number.isFinite(step.timestamp) ? step.timestamp : Date.now(),
    note: typeof step.note === "string" ? step.note : undefined,
  };
}

export async function recordStep(sessionId, step) {
  if (!sessionId) throw new Error("sessionId is required");
  const normalized = normalizeStep(step);
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const session = store.sessions[sessionId];
    if (!session) throw new Error(`session ${sessionId} not found`);
    session.steps.push(normalized);
    session.updatedAt = Date.now();
    await saveStore(store);
    return normalized;
  });
}

export async function getSession(sessionId) {
  if (!sessionId) return null;
  const store = await loadStore();
  return store.sessions[sessionId] || null;
}

export async function listSessions() {
  const store = await loadStore();
  return Object.values(store.sessions);
}

// ----------------------------------------------------------------------------
// Replay
// ----------------------------------------------------------------------------

async function executeStep(deviceId, step) {
  const { type, args = {} } = step;
  switch (type) {
    case "tap":
      return tap(deviceId, args.x, args.y);
    case "double_tap":
    case "doubleTap":
      return doubleTap(deviceId, args.x, args.y);
    case "long_press":
    case "longPress":
      return longPress(deviceId, args.x, args.y, args.durationMs || 500);
    case "swipe":
      return swipe(deviceId, { x: args.x1 ?? args.fromX, y: args.y1 ?? args.fromY }, { x: args.x2 ?? args.toX, y: args.y2 ?? args.toY });
    case "type":
    case "typeText":
      return typeText(deviceId, String(args.text || ""));
    case "key":
    case "pressKey":
      return pressKey(deviceId, String(args.key || ""));
    case "scroll":
      return scroll(deviceId, String(args.direction || "down"), Number(args.amount || 1));
    case "launch_app":
    case "launchApp":
      return launchApp(deviceId, String(args.appId || ""));
    case "kill_app":
    case "killApp":
      return killApp(deviceId, String(args.appId || ""));
    case "screenshot":
    case "captureScreen":
      return captureScreen(deviceId);
    case "wait": {
      const ms = Math.min(Math.max(Number(args.ms || 0), 0), 100);
      await new Promise((r) => setTimeout(r, ms));
      return { waited: ms };
    }
    default:
      throw new Error(`unknown step type: ${type}`);
  }
}

export async function replaySession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const results = [];
  let success = true;
  for (let i = 0; i < session.steps.length; i++) {
    const step = session.steps[i];
    try {
      const result = await executeStep(session.deviceId, step);
      results.push({ index: i, step, success: true, result });
    } catch (err) {
      success = false;
      results.push({ index: i, step, success: false, error: err?.message || String(err) });
      break;
    }
  }
  return { sessionId, success, steps: results, totalSteps: session.steps.length };
}

// ----------------------------------------------------------------------------
// Assertions
// ----------------------------------------------------------------------------

export async function assertElementVisible(deviceId, query) {
  const el = await findElement(deviceId, query);
  if (!el) {
    return { ok: false, reason: `element not found for query: ${JSON.stringify(query)}` };
  }
  if (el.visible === false) {
    return { ok: false, reason: `element present but not visible` };
  }
  return { ok: true, element: el };
}

export async function assertTextPresent(deviceId, text) {
  if (typeof text !== "string" || !text) {
    return { ok: false, reason: "text must be a non-empty string" };
  }
  try {
    const source = await getPageSource(deviceId);
    if (typeof source === "string" && source.includes(text)) {
      return { ok: true };
    }
  } catch (_) {
    /* fall through */
  }
  // Fallback: search by text query.
  const el = await findElement(deviceId, { text });
  if (el) return { ok: true, element: el };
  return { ok: false, reason: `text "${text}" not present` };
}

export async function waitForElement(deviceId, query, timeoutMs = 5000) {
  validateQuery(query);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("timeoutMs must be a non-negative number");
  }
  const pollInterval = Math.min(50, Math.max(5, Math.floor(timeoutMs / 20) || 5));
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() <= deadline) {
    try {
      const el = await findElement(deviceId, query);
      if (el) return { ok: true, element: el };
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() + pollInterval > deadline) break;
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  return {
    ok: false,
    reason: lastErr ? `element not found: ${lastErr.message}` : `element not found within ${timeoutMs}ms`,
  };
}

// ----------------------------------------------------------------------------
// Permissions
// ----------------------------------------------------------------------------

export async function grantPermission(deviceId, appId, permission) {
  if (!appId) throw new Error("appId is required");
  if (!permission) throw new Error("permission is required");
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "grantPermission");
  return driver.grantPermission(deviceId, appId, permission);
}

export async function revokePermission(deviceId, appId, permission) {
  if (!appId) throw new Error("appId is required");
  if (!permission) throw new Error("permission is required");
  const { driver } = await resolveDriverForDevice(deviceId);
  requireMethod(driver, "revokePermission");
  return driver.revokePermission(deviceId, appId, permission);
}

// ----------------------------------------------------------------------------
// Test-only helpers
// ----------------------------------------------------------------------------

export async function _resetSessions() {
  await withPathLock(storePath(), async () => {
    await saveStore({ version: STORE_VERSION, sessions: {} });
  });
}
