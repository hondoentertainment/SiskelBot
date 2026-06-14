/** Pure unit tests for client/src/views/inspector-content.js */
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderChatSignals, renderTrajectoryTree, renderGraphNeighbors,
} from "../client/src/views/inspector-content.js";

test("renderChatSignals: all fields present", () => {
  const html = renderChatSignals({
    cost: 0.0042, latencyMs: 1420, model: "gpt-4o-mini",
    tokens: { prompt: 102, completion: 88 },
  });
  assert.match(html, /\$0\.0042/);
  assert.match(html, /1420 ms|1\.42 s/);
  assert.match(html, /gpt-4o-mini/);
  assert.match(html, /102 in \/ 88 out/);
});

test("renderChatSignals: missing fields render as em-dash", () => {
  assert.ok((renderChatSignals({}).match(/&mdash;/g) || []).length >= 4);
});

test("renderChatSignals: model name is HTML-escaped", () => {
  const html = renderChatSignals({ model: "<img onerror=x>" });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img onerror=x&gt;/);
});

test("renderTrajectoryTree: empty array shows empty state", () => {
  assert.match(renderTrajectoryTree([]), /No events yet/);
});

test("renderTrajectoryTree: groups mixed event types", () => {
  const html = renderTrajectoryTree([
    { type: "tool.call", payload: { tool: "search" } },
    { type: "tool.result", payload: { tool: "search", result: "ok" } },
    { type: "plan.update", payload: { summary: "step 1" } },
  ]);
  for (const re of [/tool\.call/, /tool\.result/, /plan\.update/, /step 1/]) assert.match(html, re);
});

test("renderTrajectoryTree: > 50 events truncated to last 50", () => {
  const events = [];
  for (let i = 0; i < 75; i++) events.push({ type: "tool.call", payload: { tool: `t${i}` } });
  const html = renderTrajectoryTree(events);
  assert.match(html, /Showing last 50 of 75/);
  assert.doesNotMatch(html, />t0\(/);
  assert.match(html, />t74\(/);
});

test("renderTrajectoryTree: HTML-escapes arbitrary string fields", () => {
  const html = renderTrajectoryTree([{ type: "plan.update", payload: { summary: "<script>x</script>" } }]);
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("renderGraphNeighbors: 0 neighbors empty state", () => {
  const html = renderGraphNeighbors({ entity: "Foo", neighbors: [] });
  assert.match(html, /Foo/); assert.match(html, /No related entities/);
});

test("renderGraphNeighbors: rows include name, relationship, data-entity", () => {
  const html = renderGraphNeighbors({
    entity: "Foo", neighbors: [{ id: "bar", name: "Bar", relationship: "uses" }],
  });
  assert.match(html, /Bar/); assert.match(html, /uses/); assert.match(html, /data-entity="bar"/);
});

test("renderGraphNeighbors: escapes entity + neighbor names", () => {
  const html = renderGraphNeighbors({
    entity: "<x>", neighbors: [{ id: "<y>", name: "<y>", relationship: "<z>" }],
  });
  assert.doesNotMatch(html, /<x>|<y>|<z>/);
  assert.match(html, /&lt;x&gt;/);
});
