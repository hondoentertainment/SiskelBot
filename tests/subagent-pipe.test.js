/**
 * Unit tests for lib/subagent-pipe.js — real-time message piping between
 * parent and child agent sessions.
 *
 * Verifies:
 *   1. child tool.call → parent receives subagent.event with correct shape
 *   2. token events NOT forwarded
 *   3. cancel() calls cancelAgentSessionRun and publishes subagent.cancelled
 *   4. close() stops forwarding
 *   5. auto-close on child done event
 *   6. multiple pipes (2 children) → parent receives events from both,
 *      distinguishable by childSessionId
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate storage so agent-session / agent-run-stream modules don't collide
// with other test files.
const dir = mkdtempSync(join(tmpdir(), "subagent-pipe-"));
const prevStoragePath = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { createPipe } = await import("../lib/subagent-pipe.js");
const {
  getAgentRunEmitter,
  publishAgentRunEvent,
  __resetAgentRunStreamForTests,
} = await import("../lib/agent-run-stream.js");
const {
  bindSessionAbortController,
  cancelAgentSessionRun,
} = await import("../lib/agent-run-control.js");

test.afterEach(() => {
  __resetAgentRunStreamForTests();
});

test.after(() => {
  __resetAgentRunStreamForTests();
  if (prevStoragePath === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStoragePath;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. child tool.call event → parent receives subagent.event with correct shape
// ---------------------------------------------------------------------------
test("child tool.call is forwarded to parent as subagent.event", () => {
  const parentId = "parent-1";
  const childId = "child-1";

  const parentEmitter = getAgentRunEmitter(parentId);
  const parentEvents = [];
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  const pipe = createPipe({ parentSessionId: parentId, childSessionId: childId });

  // Simulate a child emitting a tool.call event.
  publishAgentRunEvent(childId, "tool.call", {
    toolName: "search_context",
    args: { query: "hello" },
  });

  assert.equal(parentEvents.length, 1);
  const ev = parentEvents[0];
  assert.equal(ev.type, "subagent.event");
  assert.equal(ev.payload.childSessionId, childId);
  assert.equal(ev.payload.originalType, "tool.call");
  assert.deepEqual(ev.payload.payload, {
    toolName: "search_context",
    args: { query: "hello" },
  });

  pipe.close();
});

// ---------------------------------------------------------------------------
// 1b. All forwarded types arrive correctly
// ---------------------------------------------------------------------------
test("all five forwarded types reach the parent", () => {
  const parentId = "parent-1b";
  const childId = "child-1b";

  const parentEmitter = getAgentRunEmitter(parentId);
  const parentEvents = [];
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  const pipe = createPipe({ parentSessionId: parentId, childSessionId: childId });

  const forwardedTypes = [
    "tool.call",
    "tool.result",
    "cost.update",
    "status.change",
    "error",
  ];

  for (const t of forwardedTypes) {
    publishAgentRunEvent(childId, t, { info: t });
  }

  assert.equal(parentEvents.length, forwardedTypes.length);
  for (let i = 0; i < forwardedTypes.length; i++) {
    assert.equal(parentEvents[i].payload.originalType, forwardedTypes[i]);
  }

  pipe.close();
});

// ---------------------------------------------------------------------------
// 2. token events NOT forwarded
// ---------------------------------------------------------------------------
test("token events are not forwarded to the parent", () => {
  const parentId = "parent-2";
  const childId = "child-2";

  const parentEmitter = getAgentRunEmitter(parentId);
  const parentEvents = [];
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  const pipe = createPipe({ parentSessionId: parentId, childSessionId: childId });

  publishAgentRunEvent(childId, "token", { text: "hello" });
  publishAgentRunEvent(childId, "token", { text: " world" });

  assert.equal(parentEvents.length, 0, "token events must not be forwarded");

  pipe.close();
});

// ---------------------------------------------------------------------------
// 2b. hitl.request events NOT forwarded
// ---------------------------------------------------------------------------
test("hitl.request events are not forwarded to the parent", () => {
  const parentId = "parent-2b";
  const childId = "child-2b";

  const parentEmitter = getAgentRunEmitter(parentId);
  const parentEvents = [];
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  const pipe = createPipe({ parentSessionId: parentId, childSessionId: childId });

  publishAgentRunEvent(childId, "hitl.request", { question: "approve?" });

  assert.equal(parentEvents.length, 0, "hitl.request must not be forwarded");

  pipe.close();
});

// ---------------------------------------------------------------------------
// 3. cancel() calls cancelAgentSessionRun and publishes subagent.cancelled
// ---------------------------------------------------------------------------
test("cancel() aborts the child run and publishes subagent.cancelled", () => {
  const parentId = "parent-3";
  const childId = "child-3";

  // Bind an AbortController for the child so cancelAgentSessionRun has
  // something to abort.
  const { controller, release } = bindSessionAbortController(childId);

  const parentEmitter = getAgentRunEmitter(parentId);
  const parentEvents = [];
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  let onCancelCalled = false;
  const pipe = createPipe({
    parentSessionId: parentId,
    childSessionId: childId,
    onCancel: () => { onCancelCalled = true; },
  });

  pipe.cancel("going off-track");

  // The AbortController should be aborted.
  assert.equal(controller.signal.aborted, true);

  // Parent should have received subagent.cancelled.
  const cancelled = parentEvents.filter((e) => e.type === "subagent.cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].payload.childSessionId, childId);
  assert.equal(cancelled[0].payload.reason, "going off-track");

  // onCancel callback should have been invoked.
  assert.equal(onCancelCalled, true);

  pipe.close();
  release();
});

// ---------------------------------------------------------------------------
// 3b. cancel() with no reason defaults to "cancelled by parent"
// ---------------------------------------------------------------------------
test("cancel() with no reason uses default message", () => {
  const parentId = "parent-3b";
  const childId = "child-3b";

  const parentEmitter = getAgentRunEmitter(parentId);
  const parentEvents = [];
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  const pipe = createPipe({ parentSessionId: parentId, childSessionId: childId });
  pipe.cancel();

  const cancelled = parentEvents.filter((e) => e.type === "subagent.cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].payload.reason, "cancelled by parent");

  pipe.close();
});

// ---------------------------------------------------------------------------
// 4. close() stops forwarding
// ---------------------------------------------------------------------------
test("close() stops forwarding events from child to parent", () => {
  const parentId = "parent-4";
  const childId = "child-4";

  const parentEmitter = getAgentRunEmitter(parentId);
  const parentEvents = [];
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  const pipe = createPipe({ parentSessionId: parentId, childSessionId: childId });

  // One event before close.
  publishAgentRunEvent(childId, "tool.call", { toolName: "a" });
  assert.equal(parentEvents.length, 1);

  pipe.close();
  assert.equal(pipe.closed, true);

  // Events after close must not appear on the parent.
  publishAgentRunEvent(childId, "tool.call", { toolName: "b" });
  assert.equal(parentEvents.length, 1, "no new events after close");
});

// ---------------------------------------------------------------------------
// 4b. close() is idempotent
// ---------------------------------------------------------------------------
test("calling close() multiple times does not throw", () => {
  const parentId = "parent-4b";
  const childId = "child-4b";

  const pipe = createPipe({ parentSessionId: parentId, childSessionId: childId });
  pipe.close();
  assert.doesNotThrow(() => pipe.close());
  assert.equal(pipe.closed, true);
});

// ---------------------------------------------------------------------------
// 5. Auto-close on child done event
// ---------------------------------------------------------------------------
test("pipe auto-closes when child emits done", () => {
  const parentId = "parent-5";
  const childId = "child-5";

  const parentEmitter = getAgentRunEmitter(parentId);
  const parentEvents = [];
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  const pipe = createPipe({ parentSessionId: parentId, childSessionId: childId });

  // Events before done.
  publishAgentRunEvent(childId, "tool.result", { result: "ok" });
  assert.equal(parentEvents.length, 1);

  // Emit done — pipe should auto-close.
  publishAgentRunEvent(childId, "done", { status: "completed" });
  assert.equal(pipe.closed, true);

  // The done event itself should NOT be forwarded (it is not in the
  // forwarded set; auto-close happens instead).
  assert.equal(parentEvents.length, 1, "done itself is not forwarded");

  // Further events must not arrive.
  publishAgentRunEvent(childId, "tool.call", { toolName: "nope" });
  assert.equal(parentEvents.length, 1);
});

// ---------------------------------------------------------------------------
// 6. Multiple pipes (2 children) → parent receives from both
// ---------------------------------------------------------------------------
test("parent can observe two children via separate pipes", () => {
  const parentId = "parent-6";
  const childA = "child-6a";
  const childB = "child-6b";

  const parentEmitter = getAgentRunEmitter(parentId);
  const parentEvents = [];
  parentEmitter.on("event", (ev) => parentEvents.push(ev));

  const pipeA = createPipe({ parentSessionId: parentId, childSessionId: childA });
  const pipeB = createPipe({ parentSessionId: parentId, childSessionId: childB });

  publishAgentRunEvent(childA, "tool.call", { toolName: "from-a" });
  publishAgentRunEvent(childB, "tool.call", { toolName: "from-b" });
  publishAgentRunEvent(childA, "error", { message: "oops-a" });
  publishAgentRunEvent(childB, "cost.update", { totalUsd: 0.01 });

  assert.equal(parentEvents.length, 4);

  // Events from child A
  const fromA = parentEvents.filter((e) => e.payload.childSessionId === childA);
  assert.equal(fromA.length, 2);
  assert.equal(fromA[0].payload.originalType, "tool.call");
  assert.equal(fromA[0].payload.payload.toolName, "from-a");
  assert.equal(fromA[1].payload.originalType, "error");

  // Events from child B
  const fromB = parentEvents.filter((e) => e.payload.childSessionId === childB);
  assert.equal(fromB.length, 2);
  assert.equal(fromB[0].payload.originalType, "tool.call");
  assert.equal(fromB[0].payload.payload.toolName, "from-b");
  assert.equal(fromB[1].payload.originalType, "cost.update");

  pipeA.close();
  pipeB.close();
});

// ---------------------------------------------------------------------------
// 7. onEvent callback receives forwarded events
// ---------------------------------------------------------------------------
test("onEvent callback is invoked for each forwarded event", () => {
  const parentId = "parent-7";
  const childId = "child-7";

  const callbackCalls = [];
  const pipe = createPipe({
    parentSessionId: parentId,
    childSessionId: childId,
    onEvent: (type, payload) => callbackCalls.push({ type, payload }),
  });

  publishAgentRunEvent(childId, "tool.call", { toolName: "x" });
  publishAgentRunEvent(childId, "token", { text: "skip" }); // not forwarded
  publishAgentRunEvent(childId, "tool.result", { result: "y" });

  assert.equal(callbackCalls.length, 2);
  assert.equal(callbackCalls[0].type, "tool.call");
  assert.equal(callbackCalls[1].type, "tool.result");

  pipe.close();
});

// ---------------------------------------------------------------------------
// 8. Validation: missing session IDs throw
// ---------------------------------------------------------------------------
test("createPipe throws when parentSessionId is missing", () => {
  assert.throws(
    () => createPipe({ parentSessionId: "", childSessionId: "c" }),
    /parentSessionId is required/,
  );
});

test("createPipe throws when childSessionId is missing", () => {
  assert.throws(
    () => createPipe({ parentSessionId: "p", childSessionId: "" }),
    /childSessionId is required/,
  );
});
