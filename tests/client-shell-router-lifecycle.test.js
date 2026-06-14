/**
 * Tests for the mount/unmount lifecycle bookkeeping in the SPA router.
 *
 * Uses the pure `runWithLifecycle` helper exported from client/src/router.js
 * — no DOM or window required.
 *
 * Contract under test:
 *   - A view's `mount(ctx)` may return void, a cleanup function, or a
 *     Promise resolving to one of those.
 *   - Before the next mount runs, the previous cleanup is awaited.
 *   - A throwing cleanup does not break navigation.
 *   - When the previous view returned nothing, no error is thrown.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runWithLifecycle } from "../client/src/router.js";

test("runWithLifecycle calls previous view's unmount before new mount", async () => {
  let unmountCalls = 0;
  const prevUnmount = () => { unmountCalls += 1; };
  const mountB = () => () => {};
  await runWithLifecycle(prevUnmount, mountB, { path: "/b" });
  assert.equal(unmountCalls, 1);
});

test("runWithLifecycle returns the new view's unmount function for storage", async () => {
  const fn = () => {};
  const result = await runWithLifecycle(null, () => fn, { path: "/a" });
  assert.equal(result, fn);
});

test("runWithLifecycle awaits a Promise-returning mount and unwraps its cleanup", async () => {
  const cleanup = () => {};
  const mountAsync = async () => cleanup;
  const result = await runWithLifecycle(null, mountAsync, { path: "/a" });
  assert.equal(result, cleanup);
});

test("runWithLifecycle treats void/non-function mount results as no cleanup", async () => {
  assert.equal(await runWithLifecycle(null, () => undefined, {}), null);
  assert.equal(await runWithLifecycle(null, () => 42, {}), null);
  assert.equal(await runWithLifecycle(null, () => ({ not: "a function" }), {}), null);
});

test("runWithLifecycle swallows errors from a throwing unmount and still mounts the next view", async () => {
  const errs = [];
  const prevUnmount = () => { throw new Error("boom"); };
  const newCleanup = () => {};
  let mounted = false;
  const mountB = () => { mounted = true; return newCleanup; };
  const result = await runWithLifecycle(prevUnmount, mountB, {}, (e, where) => errs.push(where));
  assert.equal(mounted, true, "next view still mounted");
  assert.equal(result, newCleanup, "new cleanup returned");
  assert.deepEqual(errs, ["unmount"]);
});

test("runWithLifecycle swallows errors from a throwing loader and returns null", async () => {
  const errs = [];
  const result = await runWithLifecycle(
    null,
    () => { throw new Error("loader failed"); },
    {},
    (e, where) => errs.push(where),
  );
  assert.equal(result, null);
  assert.deepEqual(errs, ["loader"]);
});

test("runWithLifecycle is safe when previous view returned nothing (null unmount)", async () => {
  let called = false;
  const mountB = () => { called = true; return () => {}; };
  await runWithLifecycle(null, mountB, {});
  assert.equal(called, true);
  await runWithLifecycle(undefined, mountB, {});
  // And a non-function prev unmount is ignored rather than thrown-on.
  await runWithLifecycle({ notCallable: true }, mountB, {});
  assert.equal(called, true);
});

test("runWithLifecycle awaits an async prev unmount before invoking next mount", async () => {
  const order = [];
  const prevUnmount = async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push("unmount");
  };
  const mountB = () => { order.push("mount"); return () => {}; };
  await runWithLifecycle(prevUnmount, mountB, {});
  assert.deepEqual(order, ["unmount", "mount"]);
});

test("runWithLifecycle: two sequential navigations call each cleanup exactly once", async () => {
  const calls = { a: 0, b: 0 };
  const unmountA = () => { calls.a += 1; };
  const unmountB = () => { calls.b += 1; };

  // First navigation: no previous, loader returns A's unmount.
  const afterA = await runWithLifecycle(null, () => unmountA, { path: "/a" });
  assert.equal(afterA, unmountA);

  // Second navigation: prev is A, loader returns B's unmount.
  const afterB = await runWithLifecycle(afterA, () => unmountB, { path: "/b" });
  assert.equal(calls.a, 1);
  assert.equal(afterB, unmountB);

  // Third navigation: prev is B, loader returns nothing.
  const afterC = await runWithLifecycle(afterB, () => {}, { path: "/c" });
  assert.equal(calls.b, 1);
  assert.equal(afterC, null);
});

test("runWithLifecycle: loader=null or undefined is a no-op that still runs the prev unmount", async () => {
  let called = 0;
  const prev = () => { called += 1; };
  assert.equal(await runWithLifecycle(prev, null, {}), null);
  assert.equal(await runWithLifecycle(prev, undefined, {}), null);
  assert.equal(called, 2);
});
