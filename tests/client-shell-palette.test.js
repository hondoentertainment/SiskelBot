/**
 * Tests for the pure pieces of the SPA command palette:
 * filter() and score().
 */
import test from "node:test";
import assert from "node:assert/strict";

import { filter, score } from "../client/src/palette.js";

const ACTIONS = [
  { id: "go:home", title: "Go to Home", hint: "g h" },
  { id: "go:chat", title: "Go to Chat", hint: "g c" },
  { id: "go:runs", title: "Go to Runs", hint: "g r" },
  { id: "go:knowledge", title: "Go to Knowledge", hint: "g k" },
  { id: "new:recipe", title: "Create Recipe", hint: "" },
  { id: "toggle:nav", title: "Toggle Navigation", hint: "Cmd+\\" }
];

test("filter returns all actions in registration order for empty query", () => {
  const out = filter(ACTIONS, "");
  assert.equal(out.length, ACTIONS.length);
  assert.deepEqual(out.map(a => a.id), ACTIONS.map(a => a.id));
});

test("filter returns all actions for null/undefined query", () => {
  assert.equal(filter(ACTIONS, null).length, ACTIONS.length);
  assert.equal(filter(ACTIONS, undefined).length, ACTIONS.length);
});

test("filter fuzzy-matches subsequence queries", () => {
  const out = filter(ACTIONS, "gch");
  const ids = out.map(a => a.id);
  assert.ok(ids.includes("go:chat"), "Go to Chat should match 'gch'");
});

test("filter ranks exact substring matches above fuzzy matches", () => {
  const out = filter(ACTIONS, "home");
  assert.ok(out.length >= 1);
  assert.equal(out[0].id, "go:home");
});

test("filter is case-insensitive", () => {
  const lower = filter(ACTIONS, "recipe");
  const upper = filter(ACTIONS, "RECIPE");
  assert.equal(lower.length, upper.length);
  assert.equal(lower[0].id, upper[0].id);
});

test("filter returns empty array when nothing matches", () => {
  const out = filter(ACTIONS, "zzzzzz");
  assert.equal(out.length, 0);
});

test("filter matches against hints too", () => {
  const out = filter(ACTIONS, "Cmd");
  const ids = out.map(a => a.id);
  assert.ok(ids.includes("toggle:nav"), "hint 'Cmd+\\' should match 'Cmd'");
});

test("filter preserves registration order among equally-scoring results", () => {
  // "go" is a prefix of every title starting with "Go to ..."; expect
  // those to come out in their original order.
  const out = filter(ACTIONS, "go");
  const goOnes = out.filter(a => a.id.startsWith("go:")).map(a => a.id);
  const originalGo = ACTIONS.filter(a => a.id.startsWith("go:")).map(a => a.id);
  assert.deepEqual(goOnes, originalGo);
});

test("filter does not mutate input actions", () => {
  const snapshot = JSON.parse(JSON.stringify(ACTIONS));
  filter(ACTIONS, "home");
  assert.deepEqual(ACTIONS, snapshot);
});

test("filter handles non-array input defensively", () => {
  assert.deepEqual(filter(null, "x"), []);
  assert.deepEqual(filter(undefined, "x"), []);
});

test("score returns -1 when characters cannot be matched as subsequence", () => {
  assert.equal(score("Home", "xyz"), -1);
});

test("score rewards prefix matches over mid-string matches", () => {
  const prefix = score("Home", "ho");
  const mid = score("Go to Home", "ho");
  assert.ok(prefix > mid, `expected prefix ${prefix} > mid ${mid}`);
});

test("score returns 0 for empty query (neutral)", () => {
  assert.equal(score("anything", ""), 0);
});
