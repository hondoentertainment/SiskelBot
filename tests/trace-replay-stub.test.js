import test from "node:test";
import assert from "node:assert/strict";

const { buildStubBackend, turnsFromTrace } = await import("../lib/trace-replay-stub.js");

test("buildStubBackend: throws on non-array", () => {
  assert.throws(() => buildStubBackend(null), /turns/);
});

test("buildStubBackend: replays terminal text turn", async () => {
  const { fetch: stub, calls, exhausted } = buildStubBackend([{ content: "hello world" }]);
  const r = await stub("http://x", { method: "POST", body: JSON.stringify({ model: "m" }) });
  assert.equal(r.ok, true);
  const data = await r.json();
  assert.equal(data.choices[0].message.content, "hello world");
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(calls.length, 1);
  assert.equal(exhausted(), true);
});

test("buildStubBackend: replays tool-call turn", async () => {
  const { fetch: stub } = buildStubBackend([
    { tool_calls: [{ id: "c1", name: "search_context", arguments: { query: "foo" } }] },
    { content: "final" },
  ]);
  const first = await stub("http://x", { method: "POST", body: "{}" });
  const fd = await first.json();
  assert.equal(fd.choices[0].finish_reason, "tool_calls");
  assert.equal(fd.choices[0].message.tool_calls[0].function.name, "search_context");
  const second = await stub("http://x", { method: "POST", body: "{}" });
  const sd = await second.json();
  assert.equal(sd.choices[0].message.content, "final");
});

test("buildStubBackend: emits exhaustion message after last turn", async () => {
  const { fetch: stub } = buildStubBackend([{ content: "a" }]);
  await stub("http://x", {});
  const r = await stub("http://x", {});
  const d = await r.json();
  assert.ok(d.choices[0].message.content.includes("exhausted"));
});

test("turnsFromTrace: returns empty for malformed input", () => {
  assert.deepEqual(turnsFromTrace(null), []);
  assert.deepEqual(turnsFromTrace({}), []);
});

test("turnsFromTrace: converts steps to tool_calls + final text", () => {
  const t = turnsFromTrace({
    steps: [
      { type: "tool_call", name: "search_context", args: { q: "x" }, id: "a" },
      { type: "assistant_message", content: "done" },
    ],
  });
  assert.ok(t.length >= 2);
  assert.equal(t[0].tool_calls[0].name, "search_context");
  assert.equal(t[1].content, "done");
});

test("turnsFromTrace: appends terminal turn if trace ends on tool_calls", () => {
  const t = turnsFromTrace({
    steps: [{ type: "tool_call", name: "list_recipes" }],
    finalAnswer: "ok",
  });
  const last = t[t.length - 1];
  assert.equal(last.content, "ok");
});

test("turnsFromTrace: falls back to goldenTrace", () => {
  const t = turnsFromTrace({
    goldenTrace: [{ name: "a" }, { name: "b" }],
  });
  assert.equal(t[0].tool_calls.length, 2);
});
