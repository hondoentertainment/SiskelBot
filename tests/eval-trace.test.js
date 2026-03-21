/**
 * Phase 56: Eval harness target=trace (no HTTP).
 * Phase 65: Example eval set includes golden-trace cases (offline).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { runEvalSet } from "../lib/eval-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

test("example eval set trace cases pass offline (Phase 65)", async () => {
  const raw = readFileSync(join(__dirname, "../data/eval-sets/example.json"), "utf8");
  const example = JSON.parse(raw);
  const traceOnly = {
    ...example,
    cases: (example.cases || []).filter((c) => c.target === "trace"),
  };
  assert.ok(traceOnly.cases.length >= 1, "example.json should include trace cases");
  const out = await runEvalSet(traceOnly, { baseUrl: "http://127.0.0.1:9" });
  assert.equal(out.passed, out.total, "all golden-trace cases should pass");
  for (const r of out.results) {
    assert.equal(r.pass, true, r.caseId + ": " + (r.reason || ""));
  }
});
