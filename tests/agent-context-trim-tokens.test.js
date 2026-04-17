import test from "node:test";
import assert from "node:assert/strict";
import { trimToTokenBudget } from "../lib/agent-context-trim.js";
import { estimateMessagesTokens } from "../lib/token-counter.js";

/**
 * Helper: build a message array with a system prompt, a user message,
 * and N tool rounds (each = 1 assistant with tool_calls + 1 tool reply).
 */
function buildMessages({ systemContent, userContent, toolRounds = 0, toolContentSize = 200 }) {
  const msgs = [];
  if (systemContent) msgs.push({ role: "system", content: systemContent });
  msgs.push({ role: "user", content: userContent || "Hello" });
  for (let i = 0; i < toolRounds; i++) {
    msgs.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `tc-${i}`, type: "function", function: { name: `tool_${i}`, arguments: "{}" } }],
    });
    msgs.push({
      role: "tool",
      tool_call_id: `tc-${i}`,
      content: "x".repeat(toolContentSize),
    });
  }
  return msgs;
}

// --- Messages within budget ---

test("messages within budget are returned unchanged", () => {
  const messages = buildMessages({ systemContent: "You are helpful.", userContent: "Hi", toolRounds: 1, toolContentSize: 50 });
  // Use a very large budget so everything fits
  const result = trimToTokenBudget(messages, { maxContextTokens: 100_000, reserveTokens: 100 });
  assert.equal(result.trimmedMessages.length, messages.length);
  assert.equal(result.tokensBefore, result.tokensAfter);
  assert.equal(result.roundsRemoved, 0);
  // Contents should match
  for (let i = 0; i < messages.length; i++) {
    assert.deepEqual(result.trimmedMessages[i], messages[i]);
  }
});

test("empty messages array returns empty result", () => {
  const result = trimToTokenBudget([], { model: "gpt-4" });
  assert.deepEqual(result.trimmedMessages, []);
  assert.equal(result.tokensBefore, 0);
  assert.equal(result.tokensAfter, 0);
  assert.equal(result.roundsRemoved, 0);
});

test("non-array input returns empty result", () => {
  const result = trimToTokenBudget(null, {});
  assert.deepEqual(result.trimmedMessages, []);
  assert.equal(result.roundsRemoved, 0);
});

// --- Oldest tool rounds removed when exceeding budget ---

test("oldest tool rounds are removed when exceeding budget; system + latest user preserved", () => {
  // Build messages with many large tool rounds to exceed a small budget
  const messages = buildMessages({
    systemContent: "System prompt.",
    userContent: "User question.",
    toolRounds: 5,
    toolContentSize: 500,
  });
  const totalTokens = estimateMessagesTokens(messages);

  // Set a budget smaller than total but large enough to keep system + user + some rounds
  const budget = Math.floor(totalTokens * 0.5);
  const result = trimToTokenBudget(messages, { maxContextTokens: budget, reserveTokens: 0 });

  assert.ok(result.roundsRemoved > 0, "should have removed at least one tool round");
  assert.ok(result.tokensAfter <= budget, `tokensAfter (${result.tokensAfter}) should be <= budget (${budget})`);
  assert.ok(result.tokensAfter < result.tokensBefore, "tokensAfter should be less than tokensBefore");

  // System message preserved
  assert.equal(result.trimmedMessages[0].role, "system");
  assert.equal(result.trimmedMessages[0].content, "System prompt.");

  // The user message is still present
  const hasUser = result.trimmedMessages.some((m) => m.role === "user" && m.content === "User question.");
  assert.ok(hasUser, "user message should be preserved");
});

test("tool rounds are removed oldest-first", () => {
  const messages = buildMessages({
    systemContent: "sys",
    userContent: "usr",
    toolRounds: 4,
    toolContentSize: 300,
  });

  // The tool rounds are in order: tool_0, tool_1, tool_2, tool_3
  // After trimming, the oldest (tool_0) should be removed first

  const totalTokens = estimateMessagesTokens(messages);
  // Budget that allows ~2 tool rounds
  const budget = Math.floor(totalTokens * 0.55);
  const result = trimToTokenBudget(messages, { maxContextTokens: budget, reserveTokens: 0 });

  assert.ok(result.roundsRemoved >= 1);

  // Check that remaining tool rounds are the later ones, not the earlier ones
  const toolNames = result.trimmedMessages
    .filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
    .map((m) => m.tool_calls[0].function.name);

  // Remaining should be from the end (highest index)
  if (toolNames.length > 0) {
    const maxRoundIdx = Math.max(...toolNames.map((n) => parseInt(n.split("_")[1])));
    assert.equal(maxRoundIdx, 3, "newest tool round (tool_3) should be preserved");
  }
});

// --- Deeply over budget ---

test("all tool rounds removed + oldest non-system truncated when deeply over budget", () => {
  const messages = buildMessages({
    systemContent: "S",
    userContent: "U",
    toolRounds: 3,
    toolContentSize: 1000,
  });

  // Set budget so small that even removing all tool rounds won't be enough
  // unless we also remove non-system messages. In practice this means a very
  // tight budget.
  const result = trimToTokenBudget(messages, { maxContextTokens: 10, reserveTokens: 0 });

  // All 3 tool rounds should be gone
  assert.equal(result.roundsRemoved, 3);
  assert.ok(result.tokensAfter <= result.tokensBefore);

  // System message should still be present if possible
  const systemPresent = result.trimmedMessages.some((m) => m.role === "system");
  assert.ok(systemPresent, "system message should be preserved");
});

// --- Return shape ---

test("return object has correct shape with all required fields", () => {
  const messages = buildMessages({ systemContent: "sys", userContent: "hi", toolRounds: 1 });
  const result = trimToTokenBudget(messages, { model: "gpt-4o" });

  assert.ok("trimmedMessages" in result);
  assert.ok("tokensBefore" in result);
  assert.ok("tokensAfter" in result);
  assert.ok("roundsRemoved" in result);
  assert.ok(Array.isArray(result.trimmedMessages));
  assert.ok(typeof result.tokensBefore === "number");
  assert.ok(typeof result.tokensAfter === "number");
  assert.ok(typeof result.roundsRemoved === "number");
});

// --- Model-based defaults ---

test("model option determines default context window budget", () => {
  // gpt-4 has 8192 context window; 85% = 6963 minus 2000 reserve = 4963 budget
  // gpt-4o has 128000 context window; 85% = 108800 minus 2000 reserve = 106800 budget
  // The same messages should fit in gpt-4o budget but might not in gpt-4 budget

  const bigMessages = buildMessages({
    systemContent: "System prompt here.",
    userContent: "User question.",
    toolRounds: 10,
    toolContentSize: 1000,
  });

  const resultSmall = trimToTokenBudget(bigMessages, { model: "gpt-4" });
  const resultLarge = trimToTokenBudget(bigMessages, { model: "gpt-4o" });

  // gpt-4 should need more trimming than gpt-4o
  assert.ok(
    resultSmall.roundsRemoved >= resultLarge.roundsRemoved,
    `gpt-4 should remove >= rounds (${resultSmall.roundsRemoved}) compared to gpt-4o (${resultLarge.roundsRemoved})`
  );
});

// --- reserveTokens ---

test("reserveTokens reduces effective budget", () => {
  const messages = buildMessages({
    systemContent: "sys",
    userContent: "usr",
    toolRounds: 5,
    toolContentSize: 300,
  });

  const totalTokens = estimateMessagesTokens(messages);
  // With no reserve, everything should fit
  const noReserve = trimToTokenBudget(messages, { maxContextTokens: totalTokens + 100, reserveTokens: 0 });
  assert.equal(noReserve.roundsRemoved, 0);

  // With a large reserve, some rounds should be trimmed
  const bigReserve = trimToTokenBudget(messages, { maxContextTokens: totalTokens + 100, reserveTokens: totalTokens });
  assert.ok(bigReserve.roundsRemoved > 0, "large reserveTokens should force trimming");
});

// --- Backward compatibility: opts can be omitted ---

test("trimToTokenBudget works with no opts (uses defaults)", () => {
  const messages = [
    { role: "system", content: "hi" },
    { role: "user", content: "hello" },
  ];
  const result = trimToTokenBudget(messages);
  assert.ok(result.trimmedMessages.length > 0);
  assert.equal(result.roundsRemoved, 0);
});
