/**
 * Phase 58: Stagnation detection for agent tool loops.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectStagnation } from "../lib/agent-stagnation.js";

test("detectStagnation false for single iteration", () => {
  assert.equal(detectStagnation([{ name: "search_context", args: { query: "a" }, iteration: 1 }]), false);
});

test("detectStagnation true when two iterations have identical tool fingerprints", () => {
  const log = [
    { name: "search_context", args: { query: "same" }, iteration: 1 },
    { name: "search_context", args: { query: "same" }, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), true);
});

test("detectStagnation false when args change", () => {
  const log = [
    { name: "search_context", args: { query: "a" }, iteration: 1 },
    { name: "search_context", args: { query: "b" }, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), false);
});

test("validation-only entries ignored in fingerprint", () => {
  const log = [
    { name: "search_context", args: {}, iteration: 1, validationError: true },
    { name: "search_context", args: {}, iteration: 2, validationError: true },
  ];
  assert.equal(detectStagnation(log), false);
});
