/**
 * Unit tests for the pure helpers exported from
 * client/src/views/recipes.js. No JSDOM required.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { validateStepArgs, moveStep, isValidRecipeName } = await import(
  "../client/src/views/recipes.js"
);

test("validateStepArgs: empty string is valid empty object", () => {
  assert.deepEqual(validateStepArgs(""), { ok: true, value: {} });
  assert.deepEqual(validateStepArgs("   "), { ok: true, value: {} });
  assert.deepEqual(validateStepArgs("\n\t  "), { ok: true, value: {} });
  assert.deepEqual(validateStepArgs(undefined), { ok: true, value: {} });
});

test("validateStepArgs: valid JSON object passes through", () => {
  const r = validateStepArgs('{"q": "hello", "n": 3}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { q: "hello", n: 3 });
});

test("validateStepArgs: invalid JSON fails with message", () => {
  const r = validateStepArgs('{"q":');
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid JSON/);
});

test("validateStepArgs: arrays and primitives are rejected", () => {
  const arr = validateStepArgs("[1,2,3]");
  assert.equal(arr.ok, false);
  assert.match(arr.error, /JSON object/);

  const num = validateStepArgs("42");
  assert.equal(num.ok, false);
  assert.match(num.error, /JSON object/);

  const str = validateStepArgs('"hello"');
  assert.equal(str.ok, false);
  assert.match(str.error, /JSON object/);

  const nul = validateStepArgs("null");
  assert.equal(nul.ok, false);
  assert.match(nul.error, /JSON object/);
});

test("moveStep: forward and backward moves return new array", () => {
  const a = [{ t: "a" }, { t: "b" }, { t: "c" }];
  const fwd = moveStep(a, 0, 2);
  assert.deepEqual(fwd.map((x) => x.t), ["b", "c", "a"]);
  assert.notStrictEqual(fwd, a);

  const back = moveStep(a, 2, 0);
  assert.deepEqual(back.map((x) => x.t), ["c", "a", "b"]);
  assert.deepEqual(a.map((x) => x.t), ["a", "b", "c"], "input not mutated");
});

test("moveStep: same index is a no-op (returns new array of same order)", () => {
  const a = [1, 2, 3];
  const r = moveStep(a, 1, 1);
  assert.deepEqual(r, [1, 2, 3]);
  assert.notStrictEqual(r, a);
});

test("moveStep: out-of-bounds indices are clamped", () => {
  const a = ["x", "y", "z"];
  assert.deepEqual(moveStep(a, -5, 0), ["x", "y", "z"]); // clamp -5→0, no-op
  assert.deepEqual(moveStep(a, 0, 99), ["y", "z", "x"]); // clamp 99→2, move 0→2
  assert.deepEqual(moveStep(a, 100, -100), ["z", "x", "y"]); // clamp 100→2, -100→0
});

test("moveStep: single-element array is returned unchanged", () => {
  assert.deepEqual(moveStep([{ t: "a" }], 0, 0), [{ t: "a" }]);
  assert.deepEqual(moveStep([{ t: "a" }], 0, 5), [{ t: "a" }]);
  assert.deepEqual(moveStep([], 0, 0), []);
  assert.deepEqual(moveStep(null, 0, 0), []);
});

test("isValidRecipeName: accepts lowercase, hyphen, dot, digits", () => {
  assert.equal(isValidRecipeName("a"), true);
  assert.equal(isValidRecipeName("my-recipe"), true);
  assert.equal(isValidRecipeName("my.recipe"), true);
  assert.equal(isValidRecipeName("my_recipe"), true);
  assert.equal(isValidRecipeName("recipe123"), true);
  assert.equal(isValidRecipeName("123-abc"), true);
  assert.equal(isValidRecipeName("a".repeat(64)), true);
});

test("isValidRecipeName: rejects empty, uppercase, leading hyphen/dot, length > 64, special", () => {
  assert.equal(isValidRecipeName(""), false);
  assert.equal(isValidRecipeName("MyRecipe"), false);
  assert.equal(isValidRecipeName("UPPER"), false);
  assert.equal(isValidRecipeName("-start"), false);
  assert.equal(isValidRecipeName(".start"), false);
  assert.equal(isValidRecipeName("_start"), false);
  assert.equal(isValidRecipeName("a".repeat(65)), false);
  assert.equal(isValidRecipeName("has space"), false);
  assert.equal(isValidRecipeName("has/slash"), false);
  assert.equal(isValidRecipeName("emoji-🚀"), false);
  assert.equal(isValidRecipeName(null), false);
  assert.equal(isValidRecipeName(undefined), false);
  assert.equal(isValidRecipeName(42), false);
});
