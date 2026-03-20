/**
 * Phase 56: Eval harness target=trace (no HTTP).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runEvalSet } from "../lib/eval-runner.js";

test("runEvalSet trace target validates golden traces", async () => {
  const out = await runEvalSet({
    id: "offline-trace",
    name: "Offline trace",
    cases: [
      {
        id: "order-ok",
        target: "trace",
        trace: [
          { name: "list_context", arguments: {} },
          { name: "search_context", arguments: { query: "q" } },
        ],
        expectedToolSequence: ["list_context", "search_context"],
      },
      {
        id: "order-bad",
        target: "trace",
        trace: [{ name: "search_context", arguments: { query: "q" } }],
        expectedToolSequence: ["list_context"],
      },
    ],
  });
  assert.equal(out.total, 2);
  assert.equal(out.results.find((r) => r.caseId === "order-ok")?.pass, true);
  assert.equal(out.results.find((r) => r.caseId === "order-bad")?.pass, false);
});
