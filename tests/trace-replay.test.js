import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate data directory for tests
const testDataDir = mkdtempSync(join(tmpdir(), "trace-replay-test-"));
process.env.STORAGE_PATH = testDataDir;

const { recordTrace, listTraces, getTrace, deleteTrace, traceToEvalCase, autoRecordEnabled } = await import("../lib/trace-recorder.js");
const { replayTrace, replayTraceRecord, replayAll } = await import("../lib/trace-replay.js");

test.after(() => {
  try {
    rmSync(testDataDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

// --- recordTrace + getTrace ---

test("recordTrace saves and getTrace retrieves a trace", async () => {
  const traceData = {
    runId: "test-run-1",
    workspace: "default",
    steps: [
      { type: "tool_call", name: "list_context", argsPreview: "{}" },
      { type: "tool_result", name: "list_context", ok: true },
      { type: "tool_call", name: "search_context", argsPreview: '{"query":"docs"}' },
      { type: "tool_result", name: "search_context", ok: true },
    ],
    toolCalls: [
      { name: "list_context", args: {} },
      { name: "search_context", args: { query: "docs" } },
    ],
    stopReason: "model_finished",
  };

  const { traceId } = await recordTrace(traceData);
  assert.ok(traceId, "recordTrace returns a traceId");

  const retrieved = await getTrace(traceId);
  assert.ok(retrieved, "getTrace returns the trace");
  assert.equal(retrieved.traceId, traceId);
  assert.equal(retrieved.workspace, "default");
  assert.equal(retrieved.stopReason, "model_finished");
  assert.equal(retrieved.steps.length, 4);
  assert.equal(retrieved.toolCalls.length, 2);
});

test("recordTrace rejects non-object input", async () => {
  await assert.rejects(() => recordTrace(null), /non-null object/);
  await assert.rejects(() => recordTrace("string"), /non-null object/);
});

test("getTrace returns null for missing trace", async () => {
  const result = await getTrace("nonexistent-id");
  assert.equal(result, null);
});

// --- listTraces ---

test("listTraces returns recorded traces", async () => {
  await recordTrace({ runId: "list-test-1", workspace: "ws1", type: "agent", steps: [] });
  await recordTrace({ runId: "list-test-2", workspace: "ws1", type: "swarm", steps: [] });
  await recordTrace({ runId: "list-test-3", workspace: "ws2", type: "agent", steps: [] });

  const all = await listTraces();
  assert.ok(all.items.length >= 3, "lists all traces");
  assert.ok(all.total >= 3);

  const ws1Only = await listTraces({ workspace: "ws1" });
  assert.ok(ws1Only.items.length >= 2);
  for (const item of ws1Only.items) {
    assert.equal(item.workspace, "ws1");
  }

  const agentOnly = await listTraces({ type: "agent" });
  for (const item of agentOnly.items) {
    assert.equal(item.type, "agent");
  }
});

// --- deleteTrace ---

test("deleteTrace removes a trace", async () => {
  const { traceId } = await recordTrace({ runId: "del-test", steps: [] });
  const before = await getTrace(traceId);
  assert.ok(before);

  const deleted = await deleteTrace(traceId);
  assert.equal(deleted, true);

  const after = await getTrace(traceId);
  assert.equal(after, null);
});

test("deleteTrace returns false for missing trace", async () => {
  const result = await deleteTrace("nonexistent");
  assert.equal(result, false);
});

// --- traceToEvalCase ---

test("traceToEvalCase converts trace with steps to staging_trace eval case", () => {
  const trace = {
    traceId: "eval-case-test",
    steps: [
      { type: "tool_call", name: "list_context", argsPreview: "{}" },
      { type: "tool_result", name: "list_context", ok: true },
      { type: "tool_call", name: "search_context", argsPreview: '{"query":"hello"}' },
    ],
    toolCalls: [
      { name: "list_context", args: {} },
      { name: "search_context", args: { query: "hello" } },
    ],
  };

  const evalCase = traceToEvalCase(trace);
  assert.equal(evalCase.target, "staging_trace");
  assert.ok(evalCase.id.includes("eval-case-test"));
  assert.deepEqual(evalCase.expectedToolSequence, ["list_context", "search_context"]);
  assert.equal(evalCase.expectedMinAgentActivityToolCalls, 2);
  assert.ok(evalCase.stagingTraceFile.includes("eval-case-test"));
});

test("traceToEvalCase converts trace with toolCalls fallback", () => {
  const trace = {
    traceId: "tc-fallback",
    steps: [],
    toolCalls: [{ name: "get_recipe", args: { name: "deploy" } }],
  };

  const evalCase = traceToEvalCase(trace);
  assert.deepEqual(evalCase.expectedToolSequence, ["get_recipe"]);
});

test("traceToEvalCase throws on null input", () => {
  assert.throws(() => traceToEvalCase(null), /non-null object/);
});

// --- replayTrace ---

test("replayTrace passes for a valid trace with matching expectations", async () => {
  const { traceId } = await recordTrace({
    runId: "replay-pass",
    steps: [
      { type: "tool_call", name: "list_context", argsPreview: "{}" },
      { type: "tool_call", name: "search_context", argsPreview: '{"query":"test"}' },
    ],
    toolCalls: [
      { name: "list_context", args: {} },
      { name: "search_context", args: { query: "test" } },
    ],
  });

  const result = await replayTrace(traceId);
  assert.equal(result.pass, true, `Expected pass but got: ${result.reason}`);
  assert.equal(result.traceId, traceId);
  assert.deepEqual(result.toolNames, ["list_context", "search_context"]);
});

test("replayTrace fails for nonexistent trace", async () => {
  const result = await replayTrace("does-not-exist");
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("not found"));
});

test("replayTrace fails with wrong expectations", async () => {
  const { traceId } = await recordTrace({
    runId: "replay-fail",
    steps: [
      { type: "tool_call", name: "list_context", argsPreview: "{}" },
    ],
    toolCalls: [{ name: "list_context", args: {} }],
  });

  const result = await replayTrace(traceId, {
    expectedToolSequence: ["search_context"],
  });
  assert.equal(result.pass, false);
  assert.ok(result.reason);
});

test("replayTrace with custom expectations overrides auto", async () => {
  const { traceId } = await recordTrace({
    runId: "replay-custom",
    steps: [
      { type: "tool_call", name: "list_context", argsPreview: "{}" },
      { type: "tool_call", name: "search_context", argsPreview: "{}" },
    ],
    toolCalls: [
      { name: "list_context", args: {} },
      { name: "search_context", args: {} },
    ],
  });

  const result = await replayTrace(traceId, {
    expectedToolNames: ["list_context", "search_context"],
  });
  assert.equal(result.pass, true, `Expected pass but got: ${result.reason}`);
});

// --- replayTraceRecord ---

test("replayTraceRecord works with inline record", () => {
  const trace = {
    traceId: "inline-test",
    toolCalls: [
      { name: "list_context", args: {} },
      { name: "search_context", args: { query: "test" } },
    ],
    steps: [],
  };

  const result = replayTraceRecord(trace);
  assert.equal(result.pass, true, `Expected pass but got: ${result.reason}`);
  assert.deepEqual(result.toolNames, ["list_context", "search_context"]);
});

test("replayTraceRecord fails for trace with no tool calls", () => {
  const result = replayTraceRecord({ traceId: "empty", steps: [], toolCalls: [] });
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("no tool calls"));
});

// --- replayAll ---

test("replayAll runs all traces and returns summary", async () => {
  // Record a couple fresh traces for this test
  await recordTrace({
    runId: "replay-all-1",
    workspace: "replay-all-ws",
    steps: [
      { type: "tool_call", name: "list_context", argsPreview: "{}" },
    ],
    toolCalls: [{ name: "list_context", args: {} }],
  });
  await recordTrace({
    runId: "replay-all-2",
    workspace: "replay-all-ws",
    steps: [
      { type: "tool_call", name: "search_context", argsPreview: '{"query":"x"}' },
    ],
    toolCalls: [{ name: "search_context", args: { query: "x" } }],
  });

  const result = await replayAll({ workspace: "replay-all-ws" });
  assert.ok(result.total >= 2);
  assert.equal(result.passed + result.failed, result.total);
  assert.ok(Array.isArray(result.results));
});

// --- autoRecordEnabled ---

test("autoRecordEnabled reads RECORD_TRACES env", () => {
  const orig = process.env.RECORD_TRACES;
  try {
    process.env.RECORD_TRACES = "1";
    assert.equal(autoRecordEnabled(), true);
    process.env.RECORD_TRACES = "0";
    assert.equal(autoRecordEnabled(), false);
    delete process.env.RECORD_TRACES;
    assert.equal(autoRecordEnabled(), false);
  } finally {
    if (orig !== undefined) process.env.RECORD_TRACES = orig;
    else delete process.env.RECORD_TRACES;
  }
});
