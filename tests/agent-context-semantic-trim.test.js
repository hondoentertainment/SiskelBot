import test from "node:test";
import assert from "node:assert/strict";
import {
  semanticTrimEnabled,
  scoreRoundRelevance,
  trimBySemanticRelevance,
} from "../lib/agent-context-semantic-trim.js";

test("semanticTrimEnabled: false by default", () => {
  const prev = process.env.AGENT_SEMANTIC_TRIM;
  delete process.env.AGENT_SEMANTIC_TRIM;
  try {
    assert.equal(semanticTrimEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.AGENT_SEMANTIC_TRIM = prev;
  }
});

test("scoreRoundRelevance: returns 0 for empty inputs", () => {
  assert.equal(scoreRoundRelevance("", ["x"]), 0);
  assert.equal(scoreRoundRelevance("some text", []), 0);
});

test("scoreRoundRelevance: returns fraction of keyword hits", () => {
  const score = scoreRoundRelevance("deploy the application to prod", ["deploy", "missing", "prod"]);
  assert.equal(score, 2 / 3);
});

test("trimBySemanticRelevance: no trim when under budget", () => {
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const result = trimBySemanticRelevance(messages, { budget: 99999, userGoal: "x" });
  assert.equal(result.roundsRemoved, 0);
  assert.equal(result.trimmedMessages.length, 3);
});

test("trimBySemanticRelevance: drops least relevant tool rounds first", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "deploy the app" },
    { role: "assistant", tool_calls: [{ id: "a", function: { name: "search", arguments: '{"query":"deploy"}' } }] },
    { role: "tool", tool_call_id: "a", content: "deploy instructions found" },
    { role: "assistant", tool_calls: [{ id: "b", function: { name: "search", arguments: '{"query":"cats"}' } }] },
    { role: "tool", tool_call_id: "b", content: "unrelated cat pictures" },
  ];
  const result = trimBySemanticRelevance(messages, { budget: 50, userGoal: "deploy the app to prod" });
  // The irrelevant (cats) round should be dropped before the deploy-related one
  const stillHasDeploy = result.trimmedMessages.some(
    (m) => typeof m.content === "string" && m.content.includes("deploy instructions"),
  );
  const stillHasCats = result.trimmedMessages.some(
    (m) => typeof m.content === "string" && m.content.includes("cat pictures"),
  );
  if (result.roundsRemoved > 0) {
    assert.ok(stillHasDeploy || !stillHasCats, "expected deploy round retained over cats round");
  }
});

test("trimBySemanticRelevance: budget=0 leaves messages unchanged", () => {
  const messages = [{ role: "user", content: "x" }];
  const result = trimBySemanticRelevance(messages, { budget: 0, userGoal: "x" });
  assert.equal(result.roundsRemoved, 0);
  assert.deepEqual(result.trimmedMessages, messages);
});

test("trimBySemanticRelevance: empty input returns empty result", () => {
  const result = trimBySemanticRelevance([], { budget: 100, userGoal: "x" });
  assert.deepEqual(result.trimmedMessages, []);
  assert.equal(result.tokensBefore, 0);
});
