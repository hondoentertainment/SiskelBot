// @ts-check
/**
 * Phase 55.5: Mobile automation bridges.
 *
 * Thin wrappers around ADB (Android) and XCUITest (iOS Simulator). The
 * actual shell-out is injected via an `exec` option so unit tests can mock
 * both platforms without spawning real processes. No dependency on adbkit
 * or the XCTest runner is required.
 *
 * Session model:
 *   - `createAdbSession({ deviceId, exec })`
 *   - `createXcuiSession({ udid, bundleId, exec })`
 *   - `executeMobileCommand(session, { action, ... })`
 *
 * Supported actions: tap, swipe, type, screenshot, dump-hierarchy,
 * install-app, launch, back.
 *
 * Every mutating command is logged into `json-path-store.js` so replays and
 * trace analysis are possible.
 *
 * @module mobile-automation
 */
import { randomUUID } from "crypto";
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const SUPPORTED_COMMANDS = [
  "tap",
  "swipe",
  "type",
  "screenshot",
  "dump-hierarchy",
  "install-app",
  "launch",
  "back",
];

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

function sessionsPath() {
  return join(getDataDir(), "mobile-automation.json");
}

async function loadStore() {
  const data = await readJsonPath(sessionsPath(), {
    version: STORE_VERSION,
    sessions: {},
  });
  if (!data || typeof data !== "object") return { version: STORE_VERSION, sessions: {} };
  if (!data.sessions || typeof data.sessions !== "object") data.sessions = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(sessionsPath(), {
    version: STORE_VERSION,
    sessions: data.sessions || {},
  });
}

async function recordEvent(sessionId, event) {
  if (!sessionId) return;
  const path = sessionsPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const s = data.sessions[sessionId];
    if (!s) return;
    s.events = Array.isArray(s.events) ? s.events : [];
    s.events.push({ at: new Date().toISOString(), ...event });
    if (s.events.length > 500) s.events = s.events.slice(-500);
    data.sessions[sessionId] = s;
    await saveStore(data);
  });
}

async function persistSession(session) {
  const path = sessionsPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    data.sessions[session.id] = { ...session, exec: undefined };
    await saveStore(data);
  });
}

/* -------------------------------------------------------------------------- */
/* Supported commands                                                         */
/* -------------------------------------------------------------------------- */

/** Return the list of supported mobile automation actions. */
export function listSupportedCommands() {
  return [...SUPPORTED_COMMANDS];
}

/* -------------------------------------------------------------------------- */
/* ADB session                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} MobileSession
 * @property {string} id
 * @property {"android"|"ios"} platform
 * @property {string} deviceId
 * @property {string} [bundleId]
 * @property {Function} exec
 * @property {string} createdAt
 */

/**
 * Create an ADB-backed Android session. `exec` MUST be provided in tests so
 * no real `adb` process is invoked.
 *
 * @param {{ deviceId: string, exec: Function }} opts
 * @returns {Promise<MobileSession>}
 */
export async function createAdbSession(opts) {
  if (!opts || typeof opts !== "object") throw new Error("opts required");
  const deviceId = typeof opts.deviceId === "string" ? opts.deviceId : "";
  if (!deviceId) throw new Error("deviceId is required");
  if (typeof opts.exec !== "function") {
    throw new Error("exec function is required (inject for tests)");
  }
  /** @type {MobileSession} */
  const session = {
    id: randomUUID(),
    platform: "android",
    deviceId,
    exec: opts.exec,
    createdAt: new Date().toISOString(),
  };
  await persistSession(session);
  return session;
}

/**
 * Create an XCUITest-backed iOS Simulator session.
 *
 * @param {{ udid: string, bundleId?: string, exec: Function }} opts
 * @returns {Promise<MobileSession>}
 */
export async function createXcuiSession(opts) {
  if (!opts || typeof opts !== "object") throw new Error("opts required");
  const udid = typeof opts.udid === "string" ? opts.udid : "";
  if (!udid) throw new Error("udid is required");
  if (typeof opts.exec !== "function") {
    throw new Error("exec function is required (inject for tests)");
  }
  /** @type {MobileSession} */
  const session = {
    id: randomUUID(),
    platform: "ios",
    deviceId: udid,
    bundleId: opts.bundleId || "",
    exec: opts.exec,
    createdAt: new Date().toISOString(),
  };
  await persistSession(session);
  return session;
}

/* -------------------------------------------------------------------------- */
/* Command execution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the shell command for a given action + session.
 *
 * @param {MobileSession} session
 * @param {object} cmd
 * @returns {string}
 */
function buildCommandString(session, cmd) {
  const action = String(cmd.action || "");
  if (session.platform === "android") {
    const d = session.deviceId;
    switch (action) {
      case "tap":
        return `adb -s ${d} shell input tap ${Number(cmd.x) || 0} ${Number(cmd.y) || 0}`;
      case "swipe":
        return `adb -s ${d} shell input swipe ${Number(cmd.x1) || 0} ${Number(cmd.y1) || 0} ${Number(cmd.x2) || 0} ${Number(cmd.y2) || 0} ${Number(cmd.durationMs) || 300}`;
      case "type":
        return `adb -s ${d} shell input text ${JSON.stringify(String(cmd.text || ""))}`;
      case "screenshot":
        return `adb -s ${d} exec-out screencap -p`;
      case "dump-hierarchy":
        return `adb -s ${d} shell uiautomator dump /dev/tty`;
      case "install-app":
        return `adb -s ${d} install -r ${JSON.stringify(String(cmd.path || ""))}`;
      case "launch":
        return `adb -s ${d} shell monkey -p ${String(cmd.package || "")} -c android.intent.category.LAUNCHER 1`;
      case "back":
        return `adb -s ${d} shell input keyevent 4`;
      default:
        throw new Error(`unknown android action: ${action}`);
    }
  }
  // iOS via simctl / xcrun.
  const u = session.deviceId;
  switch (action) {
    case "tap":
      return `xcrun simctl io ${u} tap ${Number(cmd.x) || 0} ${Number(cmd.y) || 0}`;
    case "swipe":
      return `xcrun simctl io ${u} swipe ${Number(cmd.x1) || 0} ${Number(cmd.y1) || 0} ${Number(cmd.x2) || 0} ${Number(cmd.y2) || 0}`;
    case "type":
      return `xcrun simctl io ${u} input text ${JSON.stringify(String(cmd.text || ""))}`;
    case "screenshot":
      return `xcrun simctl io ${u} screenshot -`;
    case "dump-hierarchy":
      return `xcrun simctl io ${u} describe`;
    case "install-app":
      return `xcrun simctl install ${u} ${JSON.stringify(String(cmd.path || ""))}`;
    case "launch":
      return `xcrun simctl launch ${u} ${String(cmd.bundleId || session.bundleId || "")}`;
    case "back":
      // iOS has no system back button -> noop that still reports success.
      return `xcrun simctl io ${u} describe`;
    default:
      throw new Error(`unknown ios action: ${action}`);
  }
}

/**
 * Execute a mobile command against a session. Returns `{ ok, stdout, stderr, command }`.
 *
 * @param {MobileSession} session
 * @param {{ action: string, [k: string]: any }} cmd
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, command: string, action: string }>}
 */
export async function executeMobileCommand(session, cmd) {
  if (!session || !session.exec) {
    throw new Error("session is required");
  }
  if (!cmd || typeof cmd !== "object") {
    throw new Error("command is required");
  }
  if (!SUPPORTED_COMMANDS.includes(String(cmd.action))) {
    throw new Error(`unsupported action: ${cmd.action}`);
  }
  const commandString = buildCommandString(session, cmd);
  return new Promise((resolvePromise) => {
    let finished = false;
    try {
      session.exec(commandString, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (finished) return;
        finished = true;
        const out = {
          ok: !err,
          stdout: stdout != null ? String(stdout) : "",
          stderr: stderr != null ? String(stderr) : "",
          command: commandString,
          action: cmd.action,
        };
        recordEvent(session.id, {
          action: cmd.action,
          ok: out.ok,
          command: commandString,
        }).catch(() => {});
        resolvePromise(out);
      });
    } catch (err) {
      if (finished) return;
      finished = true;
      resolvePromise({
        ok: false,
        stdout: "",
        stderr: String(err?.message || err),
        command: commandString,
        action: cmd.action,
      });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Hierarchy parsing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Parse a UI hierarchy dump into `{ nodes, raw }`. Supports two input
 * formats:
 *   - Android `uiautomator dump` XML: `<node ... bounds="[x,y][x2,y2]" text="..."/>`
 *   - iOS `simctl describe` free-form text with lines like `>> Label name`
 *
 * Returns a flat list of nodes with `{ role, label, bounds?, text? }`.
 *
 * @param {string} dumpText
 * @returns {{ nodes: Array<object>, raw: string, source: string }}
 */
export function parseHierarchy(dumpText) {
  const raw = typeof dumpText === "string" ? dumpText : "";
  if (!raw.trim()) {
    return { nodes: [], raw, source: "empty" };
  }
  /** @type {Array<object>} */
  const nodes = [];
  if (/<node\b/.test(raw)) {
    // Android XML
    const re = /<node\b([^>]*?)\/?>/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const attrText = m[1];
      const text = attrGet(attrText, "text");
      const resource = attrGet(attrText, "resource-id");
      const className = attrGet(attrText, "class");
      const boundsStr = attrGet(attrText, "bounds");
      let bounds = null;
      if (boundsStr) {
        const mm = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
        if (mm) {
          bounds = {
            x: Number(mm[1]),
            y: Number(mm[2]),
            width: Number(mm[3]) - Number(mm[1]),
            height: Number(mm[4]) - Number(mm[2]),
          };
        }
      }
      nodes.push({
        role: className || "node",
        label: text || resource || "",
        text,
        resource,
        bounds,
      });
    }
    return { nodes, raw, source: "android_xml" };
  }
  // iOS simctl describe: split on lines, look for "label" / "identifier".
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z][a-zA-Z]*)\s*:\s*(.+?)\s*$/);
    if (m) {
      nodes.push({ role: m[1], label: m[2], text: m[2], resource: "", bounds: null });
    }
  }
  return { nodes, raw, source: "ios_describe" };
}

function attrGet(attrText, name) {
  const re = new RegExp(`${name}="([^"]*)"`);
  const m = attrText.match(re);
  return m ? m[1] : "";
}

/* -------------------------------------------------------------------------- */
/* Session listing                                                            */
/* -------------------------------------------------------------------------- */

/** List persisted sessions (without the exec function). */
export async function listMobileSessions() {
  const data = await loadStore();
  return Object.values(data.sessions || {}).map((s) => ({
    id: s.id,
    platform: s.platform,
    deviceId: s.deviceId,
    bundleId: s.bundleId || "",
    createdAt: s.createdAt,
    eventCount: Array.isArray(s.events) ? s.events.length : 0,
  }));
}

/** Delete a session record. */
export async function deleteMobileSession(id) {
  if (!id) return false;
  const path = sessionsPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    if (!data.sessions[id]) return false;
    delete data.sessions[id];
    await saveStore(data);
    return true;
  });
}
