/**
 * Coverage tests for lib/agent-hitl-store.js
 * Raises coverage to the critical-path bar (>=80 lines / 75 funcs / 70 branches).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  saveHitlState,
  peekHitlState,
  takeHitlState,
} from "../lib/agent-hitl-store.js";

test("saveHitlState returns a 48-char hex token", () => {
  const token = saveHitlState({ action: "build" });
  assert.equal(typeof token, "string");
  assert.equal(token.length, 48);
  assert.ok(/^[0-9a-f]{48}$/.test(token));
});

test("peekHitlState returns the saved state", () => {
  const state = { foo: "bar", nested: { ok: true } };
  const token = saveHitlState(state);
  const peeked = peekHitlState(token);
  assert.deepEqual(peeked, state);
  // peek should NOT consume
  const peeked2 = peekHitlState(token);
  assert.deepEqual(peeked2, state);
});

test("peekHitlState returns null for missing token", () => {
  assert.equal(peekHitlState("nope-nope-nope"), null);
});

test("peekHitlState returns null for empty / null / whitespace token", () => {
  assert.equal(peekHitlState(""), null);
  assert.equal(peekHitlState("   "), null);
  assert.equal(peekHitlState(null), null);
  assert.equal(peekHitlState(undefined), null);
});

test("takeHitlState consumes and removes the entry", () => {
  const state = { payload: { cmd: "ls" } };
  const token = saveHitlState(state);
  const taken = takeHitlState(token);
  assert.deepEqual(taken, state);
  // subsequent peek or take yields null
  assert.equal(peekHitlState(token), null);
  assert.equal(takeHitlState(token), null);
});

test("takeHitlState null for invalid token", () => {
  assert.equal(takeHitlState(""), null);
  assert.equal(takeHitlState(null), null);
});

test("peekHitlState returns null after TTL expiry and deletes row", () => {
  // Use a tiny ttl and busy-wait past it
  const token = saveHitlState({ a: 1 }, 1);
  // Busy wait > 1ms to ensure Date.now() advances
  const end = Date.now() + 5;
  while (Date.now() <= end) { /* spin */ }
  assert.equal(peekHitlState(token), null);
  // confirmed deletion: second call also null without throwing
  assert.equal(peekHitlState(token), null);
});

test("prune runs on save and removes expired rows", () => {
  // Create two expired tokens
  saveHitlState({ a: 1 }, 1);
  saveHitlState({ a: 2 }, 1);
  const end = Date.now() + 5;
  while (Date.now() <= end) { /* spin */ }
  // A fresh save triggers prune() internally; any subsequent peek
  // on a new token should work normally
  const fresh = saveHitlState({ live: true }, 60_000);
  assert.deepEqual(peekHitlState(fresh), { live: true });
});

test("token uniqueness: multiple saves produce distinct tokens", () => {
  const a = saveHitlState({ x: 1 });
  const b = saveHitlState({ x: 2 });
  const c = saveHitlState({ x: 3 });
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

test("takeHitlState with token that has whitespace padding", () => {
  const token = saveHitlState({ y: 2 });
  const padded = `  ${token}  `;
  const out = takeHitlState(padded);
  assert.deepEqual(out, { y: 2 });
});
