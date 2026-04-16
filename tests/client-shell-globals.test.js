/** Pure unit tests for the shell-globals event emitter. */
import test from "node:test";
import assert from "node:assert/strict";
import { createEmitter } from "../client/src/shell/shell-globals.js";

test("emit invokes a single registered handler with payload", () => {
  const e = createEmitter();
  const got = [];
  e.on("x", (p) => got.push(p));
  e.emit("x", { a: 1 });
  assert.deepEqual(got, [{ a: 1 }]);
});

test("emit fans out to multiple handlers in registration order", () => {
  const e = createEmitter();
  const calls = [];
  e.on("x", () => calls.push("a"));
  e.on("x", () => calls.push("b"));
  e.on("x", () => calls.push("c"));
  e.emit("x", null);
  assert.deepEqual(calls, ["a", "b", "c"]);
});

test("off removes a handler so it stops receiving events", () => {
  const e = createEmitter();
  let count = 0;
  const h = () => { count++; };
  e.on("x", h);
  e.emit("x");
  e.off("x", h);
  e.emit("x");
  assert.equal(count, 1);
});

test("emit with no handlers does not throw", () => {
  const e = createEmitter();
  assert.doesNotThrow(() => e.emit("nope", { v: 1 }));
  e.on("y", () => {});
  e.off("y", () => {});
  assert.doesNotThrow(() => e.emit("nope"));
});

test("multiple events are isolated", () => {
  const e = createEmitter();
  const a = []; const b = [];
  e.on("a", (p) => a.push(p));
  e.on("b", (p) => b.push(p));
  e.emit("a", 1); e.emit("b", 2); e.emit("a", 3);
  assert.deepEqual(a, [1, 3]); assert.deepEqual(b, [2]);
});
