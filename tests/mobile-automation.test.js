/**
 * Phase 55.5: Mobile automation bridges tests.
 *
 * All shell-outs are mocked through an injected `exec` function so no real
 * `adb` or `xcrun` process is ever spawned.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-mobile-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createAdbSession,
  createXcuiSession,
  executeMobileCommand,
  listSupportedCommands,
  parseHierarchy,
  listMobileSessions,
  deleteMobileSession,
} = await import("../lib/mobile-automation.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

function mockExec() {
  const calls = [];
  const fn = (cmd, _opts, cb) => {
    calls.push(cmd);
    setImmediate(() => cb(null, `mock-ok: ${cmd}`, ""));
  };
  fn.calls = calls;
  return fn;
}

function failingExec(msg = "boom") {
  return (cmd, _opts, cb) => {
    setImmediate(() => cb(Object.assign(new Error(msg), { code: 1 }), "", msg));
  };
}

/* -------------------------------------------------------------------------- */
/* listSupportedCommands                                                      */
/* -------------------------------------------------------------------------- */

test("listSupportedCommands exposes the full command set", () => {
  const cmds = listSupportedCommands();
  for (const c of ["tap", "swipe", "type", "screenshot", "dump-hierarchy", "install-app", "launch", "back"]) {
    assert.ok(cmds.includes(c));
  }
});

/* -------------------------------------------------------------------------- */
/* createAdbSession                                                           */
/* -------------------------------------------------------------------------- */

test("createAdbSession returns a session for a device", async () => {
  const exec = mockExec();
  const s = await createAdbSession({ deviceId: "emulator-5554", exec });
  assert.equal(s.platform, "android");
  assert.equal(s.deviceId, "emulator-5554");
  assert.ok(s.id);
});

test("createAdbSession rejects missing fields", async () => {
  await assert.rejects(() => createAdbSession(null));
  await assert.rejects(() => createAdbSession({ deviceId: "" }));
  await assert.rejects(() => createAdbSession({ deviceId: "x" }));
});

test("createXcuiSession returns a session for an iOS simulator", async () => {
  const exec = mockExec();
  const s = await createXcuiSession({ udid: "SIM-UDID", bundleId: "com.example.app", exec });
  assert.equal(s.platform, "ios");
  assert.equal(s.deviceId, "SIM-UDID");
  assert.equal(s.bundleId, "com.example.app");
});

test("createXcuiSession rejects missing fields", async () => {
  await assert.rejects(() => createXcuiSession(null));
  await assert.rejects(() => createXcuiSession({ udid: "" }));
  await assert.rejects(() => createXcuiSession({ udid: "x" }));
});

/* -------------------------------------------------------------------------- */
/* executeMobileCommand                                                       */
/* -------------------------------------------------------------------------- */

test("executeMobileCommand runs an android tap", async () => {
  const exec = mockExec();
  const s = await createAdbSession({ deviceId: "d1", exec });
  const r = await executeMobileCommand(s, { action: "tap", x: 100, y: 200 });
  assert.equal(r.ok, true);
  assert.ok(r.command.includes("adb -s d1 shell input tap 100 200"));
  assert.ok(exec.calls.some((c) => c.includes("tap 100 200")));
});

test("executeMobileCommand runs android swipe/type/back", async () => {
  const exec = mockExec();
  const s = await createAdbSession({ deviceId: "d2", exec });
  const sw = await executeMobileCommand(s, { action: "swipe", x1: 0, y1: 0, x2: 100, y2: 100, durationMs: 200 });
  const ty = await executeMobileCommand(s, { action: "type", text: "hello" });
  const bk = await executeMobileCommand(s, { action: "back" });
  assert.ok(sw.command.includes("input swipe 0 0 100 100 200"));
  assert.ok(ty.command.includes("input text"));
  assert.ok(bk.command.includes("keyevent 4"));
});

test("executeMobileCommand runs iOS tap / launch", async () => {
  const exec = mockExec();
  const s = await createXcuiSession({ udid: "SIMX", bundleId: "io.example", exec });
  const tap = await executeMobileCommand(s, { action: "tap", x: 50, y: 60 });
  const launch = await executeMobileCommand(s, { action: "launch" });
  assert.ok(tap.command.includes("xcrun simctl io SIMX tap 50 60"));
  assert.ok(launch.command.includes("xcrun simctl launch SIMX io.example"));
});

test("executeMobileCommand rejects unknown actions", async () => {
  const exec = mockExec();
  const s = await createAdbSession({ deviceId: "d3", exec });
  await assert.rejects(() => executeMobileCommand(s, { action: "fly" }));
});

test("executeMobileCommand propagates exec failures as ok:false", async () => {
  const s = await createAdbSession({ deviceId: "d4", exec: failingExec("disconnected") });
  const r = await executeMobileCommand(s, { action: "screenshot" });
  assert.equal(r.ok, false);
  assert.equal(r.stderr, "disconnected");
});

test("executeMobileCommand rejects bad session / command", async () => {
  const exec = mockExec();
  const s = await createAdbSession({ deviceId: "d5", exec });
  await assert.rejects(() => executeMobileCommand(null, { action: "tap" }));
  await assert.rejects(() => executeMobileCommand(s, null));
});

/* -------------------------------------------------------------------------- */
/* parseHierarchy                                                             */
/* -------------------------------------------------------------------------- */

test("parseHierarchy parses Android uiautomator XML", () => {
  const xml = `
    <?xml version="1.0"?>
    <hierarchy>
      <node class="android.widget.Button" text="OK" bounds="[10,20][110,70]"/>
      <node class="android.widget.TextView" text="Hello" bounds="[0,0][200,40]"/>
    </hierarchy>
  `;
  const r = parseHierarchy(xml);
  assert.equal(r.source, "android_xml");
  assert.equal(r.nodes.length, 2);
  assert.equal(r.nodes[0].label, "OK");
  assert.deepEqual(r.nodes[0].bounds, { x: 10, y: 20, width: 100, height: 50 });
});

test("parseHierarchy parses iOS describe output", () => {
  const text = "Button: Submit\nLabel: Welcome\n";
  const r = parseHierarchy(text);
  assert.equal(r.source, "ios_describe");
  assert.equal(r.nodes.length, 2);
  assert.equal(r.nodes[0].role, "Button");
  assert.equal(r.nodes[0].label, "Submit");
});

test("parseHierarchy handles empty input", () => {
  const r = parseHierarchy("");
  assert.equal(r.source, "empty");
  assert.deepEqual(r.nodes, []);
});

/* -------------------------------------------------------------------------- */
/* Sessions persistence                                                       */
/* -------------------------------------------------------------------------- */

test("listMobileSessions returns persisted sessions", async () => {
  const list = await listMobileSessions();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 2);
  for (const s of list) {
    assert.ok(!("exec" in s));
  }
});

test("deleteMobileSession removes a session", async () => {
  const s = await createAdbSession({ deviceId: "gone", exec: mockExec() });
  const ok = await deleteMobileSession(s.id);
  assert.equal(ok, true);
  const list = await listMobileSessions();
  assert.ok(!list.some((x) => x.id === s.id));
  assert.equal(await deleteMobileSession("no-such-id"), false);
});
