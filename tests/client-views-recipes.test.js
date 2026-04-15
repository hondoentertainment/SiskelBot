/**
 * Unit tests for the pure helpers exported by client/src/views/recipes.js.
 * No JSDOM — helpers are DOM-free and tested directly. The file also
 * depends on `import.meta.url` and the global `document` at import time,
 * but both are guarded inside ensureStylesheet() / CSS_HREF and do not
 * execute on import.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sortRecipesByName,
  formatSteps,
  summarizeRun,
} from "../client/src/views/recipes.js";

test("sortRecipesByName handles empty and non-array inputs", () => {
  assert.deepEqual(sortRecipesByName([]), []);
  assert.deepEqual(sortRecipesByName(null), []);
  assert.deepEqual(sortRecipesByName(undefined), []);
  assert.deepEqual(sortRecipesByName("nope"), []);
});

test("sortRecipesByName sorts case-insensitively and is stable on ties", () => {
  const input = [
    { id: "3", name: "Bravo" },
    { id: "1", name: "alpha" },
    { id: "2", name: "Alpha" },      // tie with id:1 after lowercase
    { id: "4", name: "charlie" },
    { id: "5", name: "" },           // empty name sorts to top
  ];
  const out = sortRecipesByName(input);
  // Order of ids: 5 (empty), 1, 2 (tie stable), 3, 4
  assert.deepEqual(out.map((r) => r.id), ["5", "1", "2", "3", "4"]);
  // Input not mutated.
  assert.equal(input[0].id, "3");
});

test("formatSteps returns [] for missing / malformed steps", () => {
  assert.deepEqual(formatSteps({}), []);
  assert.deepEqual(formatSteps({ steps: null }), []);
  assert.deepEqual(formatSteps(null), []);
  assert.deepEqual(formatSteps({ steps: "not-an-array" }), []);
});

test("formatSteps formats nested payloads, falls back through fields, and truncates", () => {
  const recipe = {
    steps: [
      { action: "shell", payload: { command: "npm test" } },
      { type: "run_recipe", recipe: "deploy-staging" },
      { action: "fetch_url", payload: "https://example.com/ping" },
      { action: "noop" }, // no summary-able fields
      { action: "log", payload: { message: "x".repeat(200) } }, // forces truncation via JSON.stringify
      "just a string step",
    ],
  };
  const rows = formatSteps(recipe);
  assert.equal(rows.length, 6);

  assert.deepEqual(rows[0], { index: 1, action: "shell", summary: "npm test" });
  // Nested recipe name picked up via step.recipe fallback.
  assert.deepEqual(rows[1], { index: 2, action: "run_recipe", summary: "deploy-staging" });
  // String payload used directly.
  assert.deepEqual(rows[2], { index: 3, action: "fetch_url", summary: "https://example.com/ping" });
  // No fields to summarise => empty summary but action still reported.
  assert.deepEqual(rows[3], { index: 4, action: "noop", summary: "" });
  // Long JSON payload is truncated to 120 chars with ellipsis.
  assert.equal(rows[4].action, "log");
  assert.ok(rows[4].summary.length <= 120, `got length ${rows[4].summary.length}`);
  assert.ok(rows[4].summary.endsWith("…"));
  // Bare string step => action fallback "step".
  assert.deepEqual(rows[5], { index: 6, action: "step", summary: "just a string step" });
});

test("summarizeRun handles success shapes including stdout/stderr preview", () => {
  const bare = summarizeRun({ ok: true });
  assert.equal(bare.ok, true);
  assert.equal(bare.title, "Run complete");
  assert.ok(/successfully/i.test(bare.detail));

  const withOutput = summarizeRun({ ok: true, stdout: "hello\n", stderr: "warn\n" });
  assert.equal(withOutput.ok, true);
  assert.ok(withOutput.detail.includes("stdout:"));
  assert.ok(withOutput.detail.includes("hello"));
  assert.ok(withOutput.detail.includes("stderr:"));
  assert.ok(withOutput.detail.includes("warn"));
});

test("summarizeRun handles error shapes (legacy, structured, Error, null)", () => {
  // Legacy { error, code } shape from recipes route.
  const legacy = summarizeRun({ error: "Recipe not found", code: "NOT_FOUND" });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.title, "Failed: NOT_FOUND");
  assert.ok(legacy.detail.includes("Recipe not found"));

  // ok:false with stderr preview.
  const failedWithStderr = summarizeRun({
    ok: false,
    error: "step failed",
    code: "RUN_FAILED",
    stderr: "boom",
  });
  assert.equal(failedWithStderr.ok, false);
  assert.equal(failedWithStderr.title, "Failed: RUN_FAILED");
  assert.ok(failedWithStderr.detail.includes("step failed"));
  assert.ok(failedWithStderr.detail.includes("boom"));

  // Structured apiError-style envelope.
  const structured = summarizeRun({ error: { code: "UNAUTHORIZED", message: "sign in" } });
  assert.equal(structured.ok, false);
  assert.equal(structured.title, "Failed: UNAUTHORIZED");
  assert.equal(structured.detail, "sign in");

  // Thrown Error.
  const netErr = summarizeRun(new Error("network down"));
  assert.equal(netErr.ok, false);
  assert.equal(netErr.title, "Request failed");
  assert.equal(netErr.detail, "network down");

  // Null / undefined.
  const none = summarizeRun(null);
  assert.equal(none.ok, false);
  assert.equal(none.title, "No response");
});
