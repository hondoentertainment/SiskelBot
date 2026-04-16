/**
 * Pure unit tests for the new content-search helpers added to the SPA
 * command palette: debounce(), classifyResultType(), and buildPaletteRows().
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  debounce,
  classifyResultType,
  buildPaletteRows,
} from "../client/src/palette.js";

// ---------- debounce ----------

test("debounce: trailing-edge fires once after wait", async () => {
  let calls = 0;
  let lastArgs = null;
  const fn = debounce((...a) => { calls++; lastArgs = a; }, 20);
  fn("a", 1);
  assert.equal(calls, 0, "should not fire synchronously");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1);
  assert.deepEqual(lastArgs, ["a", 1]);
});

test("debounce: multiple calls reset the timer and fire once with last args", async () => {
  let calls = 0;
  let lastArgs = null;
  const fn = debounce((...a) => { calls++; lastArgs = a; }, 25);
  fn("first");
  await new Promise((r) => setTimeout(r, 5));
  fn("second");
  await new Promise((r) => setTimeout(r, 5));
  fn("third");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1);
  assert.deepEqual(lastArgs, ["third"]);
});

test("debounce: cancel() prevents pending invocation", async () => {
  let calls = 0;
  const fn = debounce(() => { calls++; }, 20);
  fn();
  fn.cancel();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 0);
});

test("debounce: cancel() is a no-op when nothing is pending", () => {
  const fn = debounce(() => {}, 10);
  // Should not throw.
  fn.cancel();
  assert.ok(true);
});

test("debounce: cancel() then a fresh call still fires", async () => {
  let calls = 0;
  const fn = debounce(() => { calls++; }, 15);
  fn();
  fn.cancel();
  fn();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1);
});

// ---------- classifyResultType ----------

test("classifyResultType: type=conversation -> chat", () => {
  assert.equal(classifyResultType({ type: "conversation" }), "chat");
  assert.equal(classifyResultType({ type: "conversations" }), "chat");
  assert.equal(classifyResultType({ type: "chat" }), "chat");
  assert.equal(classifyResultType({ type: "message" }), "chat");
});

test("classifyResultType: type=knowledge|doc|document -> doc", () => {
  assert.equal(classifyResultType({ type: "knowledge" }), "doc");
  assert.equal(classifyResultType({ type: "doc" }), "doc");
  assert.equal(classifyResultType({ type: "document" }), "doc");
});

test("classifyResultType: type=recipe -> recipe", () => {
  assert.equal(classifyResultType({ type: "recipe" }), "recipe");
  assert.equal(classifyResultType({ type: "recipes" }), "recipe");
});

test("classifyResultType: type=run / agent_run -> run", () => {
  assert.equal(classifyResultType({ type: "run" }), "run");
  assert.equal(classifyResultType({ type: "agent-run" }), "run");
  assert.equal(classifyResultType({ type: "agent_run" }), "run");
});

test("classifyResultType: URL heuristic for chat", () => {
  assert.equal(classifyResultType({ url: "/conversations/abc" }), "chat");
  assert.equal(classifyResultType({ url: "/chat/123" }), "chat");
});

test("classifyResultType: URL heuristic for doc", () => {
  assert.equal(classifyResultType({ url: "/knowledge/x" }), "doc");
  assert.equal(classifyResultType({ url: "/docs/x" }), "doc");
  assert.equal(classifyResultType({ url: "/documents/x" }), "doc");
});

test("classifyResultType: URL heuristic for recipe", () => {
  assert.equal(classifyResultType({ url: "/recipes/build" }), "recipe");
});

test("classifyResultType: URL heuristic for run", () => {
  assert.equal(classifyResultType({ url: "/runs/42" }), "run");
  assert.equal(classifyResultType({ url: "/agent-sessions/abc" }), "run");
});

test("classifyResultType: unknown -> other (fallback)", () => {
  assert.equal(classifyResultType({}), "other");
  assert.equal(classifyResultType({ type: "weird-thing" }), "other");
  assert.equal(classifyResultType({ url: "/some/random/path" }), "other");
  assert.equal(classifyResultType(null), "other");
  assert.equal(classifyResultType(undefined), "other");
  assert.equal(classifyResultType("string"), "other");
});

test("classifyResultType: type takes precedence over URL", () => {
  // type says chat, url says recipe -> chat wins
  assert.equal(
    classifyResultType({ type: "conversation", url: "/recipes/x" }),
    "chat",
  );
});

// ---------- buildPaletteRows ----------

const ACTIONS = [
  { id: "go:home", title: "Go to Home", hint: "g h" },
  { id: "go:chat", title: "Go to Chat", hint: "g c" },
];

test("buildPaletteRows: only actions when contentResults empty", () => {
  const rows = buildPaletteRows(ACTIONS, "go", []);
  assert.equal(rows[0].kind, "header");
  assert.equal(rows[0].label, "Actions");
  assert.equal(rows.filter(r => r.kind === "header").length, 1);
  assert.equal(rows.filter(r => r.kind === "action").length, ACTIONS.length);
  assert.equal(rows.filter(r => r.kind === "content").length, 0);
});

test("buildPaletteRows: both sections when actions and content present", () => {
  const content = [
    { type: "conversation", title: "About foo", url: "/conversations/1", snippet: "..." },
    { type: "knowledge", title: "Foo doc", url: "/knowledge/2", snippet: "x" },
  ];
  const rows = buildPaletteRows(ACTIONS, "foo", content);
  const headers = rows.filter(r => r.kind === "header").map(r => r.label);
  assert.deepEqual(headers, ["Actions", "Content"]);
  // Actions header is first, content header sits after all actions.
  assert.equal(rows[0].kind, "header");
  assert.equal(rows[0].label, "Actions");
  // Find the Content header position
  const contentHeaderIdx = rows.findIndex(r => r.kind === "header" && r.label === "Content");
  assert.equal(contentHeaderIdx, 1 + ACTIONS.length, "Content header should follow all action rows");
  // Content rows should carry icons + classified types
  const contentRows = rows.filter(r => r.kind === "content");
  assert.equal(contentRows.length, 2);
  assert.equal(contentRows[0].type, "chat");
  assert.equal(contentRows[1].type, "doc");
  assert.ok(contentRows[0].icon, "icon should be populated");
});

test("buildPaletteRows: content section hidden when query is empty even with results", () => {
  const content = [{ type: "conversation", title: "x", url: "/x" }];
  const rows = buildPaletteRows(ACTIONS, "", content);
  assert.equal(rows.filter(r => r.kind === "content").length, 0);
  assert.equal(rows.filter(r => r.kind === "header" && r.label === "Content").length, 0);
});

test("buildPaletteRows: content section hidden when query is whitespace", () => {
  const content = [{ type: "conversation", title: "x", url: "/x" }];
  const rows = buildPaletteRows(ACTIONS, "   ", content);
  assert.equal(rows.filter(r => r.kind === "content").length, 0);
});

test("buildPaletteRows: empty actions and empty content -> empty array", () => {
  const rows = buildPaletteRows([], "anything", []);
  assert.deepEqual(rows, []);
});

test("buildPaletteRows: empty actions but non-empty content -> only Content section", () => {
  const content = [{ type: "recipe", title: "Build", url: "/recipes/build" }];
  const rows = buildPaletteRows([], "build", content);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "header");
  assert.equal(rows[0].label, "Content");
  assert.equal(rows[1].kind, "content");
  assert.equal(rows[1].type, "recipe");
});

test("buildPaletteRows: defensive against non-array inputs", () => {
  assert.deepEqual(buildPaletteRows(null, "q", null), []);
  assert.deepEqual(buildPaletteRows(undefined, "q", undefined), []);
});

test("buildPaletteRows: content row falls back to id/name when title missing", () => {
  const content = [{ type: "doc", id: "doc-7", url: "/knowledge/doc-7" }];
  const rows = buildPaletteRows([], "doc", content);
  const contentRow = rows.find(r => r.kind === "content");
  assert.equal(contentRow.title, "doc-7");
});

test("buildPaletteRows: untitled fallback when nothing usable", () => {
  const content = [{ url: "/x" }];
  const rows = buildPaletteRows([], "x", content);
  const contentRow = rows.find(r => r.kind === "content");
  assert.equal(contentRow.title, "(untitled)");
});
