/**
 * Phase 55.1: Screen-control agent tests.
 *
 * Covers action types, validation, sequences, pluggable executors,
 * safety rails, recording, durable sessions, and undo/rollback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated STORAGE_PATH so persisted state does not pollute the
// project data dir or leak between suites.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-screen-control-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  ACTION_TYPES,
  Action,
  ActionSequence,
  registerExecutor,
  getExecutor,
  mockExecutor,
  FORBIDDEN_PATTERNS,
  validateAction,
  sanitizeAction,
  executeAction,
  executeSequence,
  ActionRecorder,
  createSession,
  getSession,
  listSessions,
  recordSessionAction,
  getSessionActions,
  undoLastAction,
  clickAt,
  typeText,
  pressKey,
  takeScreenshot,
  waitMs,
} = await import("../lib/screen-control.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- ACTION_TYPES ----

test("ACTION_TYPES lists all known action types", () => {
  assert.ok(Array.isArray(ACTION_TYPES));
  assert.ok(ACTION_TYPES.includes("click"));
  assert.ok(ACTION_TYPES.includes("type"));
  assert.ok(ACTION_TYPES.includes("key"));
  assert.ok(ACTION_TYPES.includes("screenshot"));
  assert.ok(ACTION_TYPES.includes("drag"));
  assert.ok(ACTION_TYPES.includes("scroll"));
  assert.ok(ACTION_TYPES.includes("wait"));
  assert.ok(ACTION_TYPES.includes("focus_window"));
});

// ---- Action validation ----

test("Action validates click coordinates", () => {
  const ok = new Action({ type: "click", args: { x: 10, y: 20 } });
  assert.equal(ok.validate(), true);
  const bad = new Action({ type: "click", args: { x: "a", y: 20 } });
  assert.throws(() => bad.validate(), /numeric x and y/);
});

test("Action validates type text", () => {
  const ok = new Action({ type: "type", args: { text: "hello" } });
  assert.equal(ok.validate(), true);
  const bad = new Action({ type: "type", args: {} });
  assert.throws(() => bad.validate(), /string text/);
});

test("Action validates wait ms", () => {
  const ok = new Action({ type: "wait", args: { ms: 100 } });
  assert.equal(ok.validate(), true);
  const bad = new Action({ type: "wait", args: { ms: -5 } });
  assert.throws(() => bad.validate(), /non-negative/);
});

test("Action validates unknown type", () => {
  const a = new Action({ type: "nope", args: {} });
  assert.throws(() => a.validate(), /Unknown action type/);
});

// ---- ActionSequence ----

test("ActionSequence add appends and validates", () => {
  const seq = new ActionSequence();
  seq.add(new Action({ type: "click", args: { x: 1, y: 2 } }));
  seq.add({ type: "type", args: { text: "hi" } });
  assert.equal(seq.length(), 2);
});

test("ActionSequence remove by index", () => {
  const seq = new ActionSequence([
    { type: "click", args: { x: 1, y: 2 } },
    { type: "type", args: { text: "hi" } },
  ]);
  const removed = seq.remove(0);
  assert.equal(removed.type, "click");
  assert.equal(seq.length(), 1);
  assert.throws(() => seq.remove(99), /valid index/);
});

test("ActionSequence toJSON/fromJSON roundtrip", () => {
  const seq = new ActionSequence();
  seq.add(new Action({ type: "click", args: { x: 5, y: 6 }, timestamp: 1000 }));
  seq.add(new Action({ type: "wait", args: { ms: 10 }, timestamp: 2000 }));
  const json = seq.toJSON();
  const parsed = ActionSequence.fromJSON(json);
  assert.equal(parsed.length(), 2);
  assert.equal(parsed.getActions()[0].type, "click");
  assert.equal(parsed.getActions()[0].args.x, 5);
  assert.equal(parsed.getActions()[1].args.ms, 10);
});

// ---- Executor registry ----

test("registerExecutor + getExecutor", () => {
  const custom = { click: async () => ({ custom: true }) };
  registerExecutor("custom-test", custom);
  assert.equal(getExecutor("custom-test"), custom);
  assert.equal(getExecutor("does-not-exist"), undefined);
});

test("mockExecutor click succeeds", async () => {
  const result = await mockExecutor.click({ x: 12, y: 34 });
  assert.equal(result.success, true);
  assert.deepEqual(result.position, { x: 12, y: 34 });
});

test("mockExecutor type succeeds", async () => {
  const result = await mockExecutor.type({ text: "hello" });
  assert.equal(result.success, true);
  assert.equal(result.text, "hello");
});

test("mockExecutor screenshot returns data", async () => {
  const result = await mockExecutor.screenshot();
  assert.ok(result.data);
  assert.ok(Number.isFinite(result.width));
  assert.ok(Number.isFinite(result.height));
});

// ---- Safety rails ----

test("validateAction blocks forbidden typing patterns", () => {
  const action = new Action({ type: "type", args: { text: "rm -rf /tmp" } });
  const result = validateAction(action);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /forbidden/i);
});

test("validateAction blocks forbidden key combos", () => {
  const action = new Action({ type: "key", args: { key: "ctrl+alt+del" } });
  const result = validateAction(action);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /forbidden/i);
});

test("validateAction enforces allowedTypes policy", () => {
  const action = new Action({ type: "click", args: { x: 1, y: 2 } });
  const result = validateAction(action, { allowedTypes: ["type"] });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /not in allowedTypes/);
});

test("validateAction enforces screen bounds", () => {
  const action = new Action({ type: "click", args: { x: 9999, y: 9999 } });
  const result = validateAction(action, { screenBounds: { width: 800, height: 600 } });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /bounds/);
});

test("validateAction allows safe actions", () => {
  const action = new Action({ type: "type", args: { text: "hello world" } });
  assert.equal(validateAction(action).allowed, true);
});

test("sanitizeAction redacts dangerous typing text", () => {
  const action = new Action({ type: "type", args: { text: "run rm -rf /tmp now" } });
  const sanitized = sanitizeAction(action);
  assert.ok(sanitized);
  assert.match(sanitized.args.text, /\[REDACTED\]/);
  assert.doesNotMatch(sanitized.args.text, /rm -rf/);
});

test("sanitizeAction returns null for dangerous key combos", () => {
  const action = new Action({ type: "key", args: { key: "ctrl+alt+del" } });
  assert.equal(sanitizeAction(action), null);
});

test("FORBIDDEN_PATTERNS exposes typing and keys arrays", () => {
  assert.ok(Array.isArray(FORBIDDEN_PATTERNS.typing));
  assert.ok(Array.isArray(FORBIDDEN_PATTERNS.keys));
  assert.ok(FORBIDDEN_PATTERNS.typing.length > 0);
});

// ---- executeAction ----

test("executeAction with mock executor succeeds", async () => {
  const action = new Action({ type: "click", args: { x: 50, y: 60 } });
  const result = await executeAction(action);
  assert.equal(result.success, true);
  assert.deepEqual(result.result.position, { x: 50, y: 60 });
});

test("executeAction dryRun skips execution", async () => {
  const action = new Action({ type: "click", args: { x: 50, y: 60 } });
  const result = await executeAction(action, { dryRun: true });
  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.result, null);
});

test("executeAction rejects forbidden text", async () => {
  const action = new Action({ type: "type", args: { text: "DROP TABLE users" } });
  const result = await executeAction(action);
  assert.equal(result.success, false);
  assert.match(result.reason, /forbidden/i);
});

test("executeAction rejects invalid action", async () => {
  const result = await executeAction({ type: "bogus", args: {} });
  assert.equal(result.success, false);
});

test("executeAction rejects unknown executor name", async () => {
  const action = new Action({ type: "click", args: { x: 1, y: 2 } });
  const result = await executeAction(action, { executor: "no-such-executor" });
  assert.equal(result.success, false);
  assert.match(result.reason, /Unknown executor/);
});

// ---- executeSequence ----

test("executeSequence runs all actions", async () => {
  const seq = new ActionSequence([
    { type: "click", args: { x: 1, y: 2 } },
    { type: "type", args: { text: "hi" } },
    { type: "screenshot", args: {} },
  ]);
  const result = await executeSequence(seq);
  assert.equal(result.success, true);
  assert.equal(result.steps.length, 3);
  for (const step of result.steps) {
    assert.equal(step.success, true);
  }
});

test("executeSequence stops on failure", async () => {
  const seq = new ActionSequence([
    { type: "click", args: { x: 1, y: 2 } },
    { type: "type", args: { text: "rm -rf /" } },
    { type: "click", args: { x: 3, y: 4 } },
  ]);
  const result = await executeSequence(seq);
  assert.equal(result.success, false);
  assert.equal(result.stoppedAt, 1);
  assert.equal(result.steps.length, 2);
});

test("executeSequence handles empty sequence", async () => {
  const result = await executeSequence(new ActionSequence([]));
  assert.equal(result.success, true);
  assert.equal(result.steps.length, 0);
});

test("executeSequence continueOnFailure keeps going", async () => {
  const seq = new ActionSequence([
    { type: "click", args: { x: 1, y: 2 } },
    { type: "type", args: { text: "rm -rf /" } },
    { type: "click", args: { x: 3, y: 4 } },
  ]);
  const result = await executeSequence(seq, { continueOnFailure: true });
  assert.equal(result.steps.length, 3);
  assert.equal(result.success, false);
  assert.equal(result.steps[0].success, true);
  assert.equal(result.steps[1].success, false);
  assert.equal(result.steps[2].success, true);
});

// ---- ActionRecorder ----

test("ActionRecorder records actions", () => {
  const rec = new ActionRecorder();
  rec.start();
  rec.record({ type: "click", args: { x: 1, y: 2 } });
  rec.record({ type: "type", args: { text: "hi" } });
  const seq = rec.stop();
  assert.equal(seq.length(), 2);
  assert.equal(seq.getActions()[0].type, "click");
});

test("ActionRecorder throws when not started", () => {
  const rec = new ActionRecorder();
  assert.throws(() => rec.record({ type: "click", args: { x: 1, y: 2 } }), /not started/);
});

// ---- Sessions ----

test("createSession + recordSessionAction persists actions", async () => {
  const session = await createSession("test-session", { workspaceId: "ws1" });
  assert.ok(session.id.startsWith("scrsess_"));
  assert.equal(session.name, "test-session");

  await recordSessionAction(session.id, { type: "click", args: { x: 1, y: 2 } });
  await recordSessionAction(session.id, { type: "type", args: { text: "hi" } });

  const actions = await getSessionActions(session.id);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, "click");
  assert.equal(actions[1].type, "type");
});

test("listSessions filters by workspaceId", async () => {
  await createSession("ws-a-1", { workspaceId: "wsA" });
  await createSession("ws-a-2", { workspaceId: "wsA" });
  await createSession("ws-b-1", { workspaceId: "wsB" });

  const wsA = await listSessions("wsA");
  assert.ok(wsA.length >= 2);
  assert.ok(wsA.every((s) => s.workspaceId === "wsA"));

  const all = await listSessions();
  assert.ok(all.length >= 3);
});

test("getSession returns null for unknown id", async () => {
  const s = await getSession("scrsess_does_not_exist");
  assert.equal(s, null);
});

test("recordSessionAction rejects unknown session", async () => {
  await assert.rejects(
    () => recordSessionAction("scrsess_unknown", { type: "click", args: { x: 1, y: 2 } }),
    /not found/,
  );
});

// ---- Undo / rollback ----

test("undoLastAction pops the last recorded action", async () => {
  const session = await createSession("undo-session", { workspaceId: "wsU" });
  await recordSessionAction(session.id, { type: "click", args: { x: 1, y: 2 } });
  await recordSessionAction(session.id, { type: "type", args: { text: "hello" } });

  const undo1 = await undoLastAction(session.id);
  assert.equal(undo1.undone.type, "type");
  assert.equal(undo1.remaining, 1);

  const undo2 = await undoLastAction(session.id);
  assert.equal(undo2.undone.type, "click");
  assert.equal(undo2.remaining, 0);

  const undo3 = await undoLastAction(session.id);
  assert.equal(undo3.undone, null);
});

// ---- High-level primitives ----

test("clickAt convenience primitive", async () => {
  const result = await clickAt(100, 200);
  assert.equal(result.success, true);
  assert.deepEqual(result.result.position, { x: 100, y: 200 });
});

test("typeText convenience primitive", async () => {
  const result = await typeText("hello");
  assert.equal(result.success, true);
  assert.equal(result.result.text, "hello");
});

test("pressKey convenience primitive", async () => {
  const result = await pressKey("Enter");
  assert.equal(result.success, true);
  assert.equal(result.result.key, "Enter");
});

test("takeScreenshot convenience primitive", async () => {
  const result = await takeScreenshot();
  assert.equal(result.success, true);
  assert.ok(result.result.data);
});

test("waitMs uses mock wait", async () => {
  const start = Date.now();
  const result = await waitMs(5);
  assert.equal(result.success, true);
  assert.ok(Date.now() - start >= 0);
});
