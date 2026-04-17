import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessagesTokens,
  getModelContextWindow,
  __resetEnvOverridesForTests,
} from "../lib/token-counter.js";

// --- estimateTokens ---

test("estimateTokens returns 0 for empty string", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens returns 0 for non-string input", () => {
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(42), 0);
});

test("estimateTokens returns ~3 for 'hello world' (11 chars / 3.5 ≈ 4)", () => {
  const tokens = estimateTokens("hello world");
  assert.ok(tokens >= 3 && tokens <= 4, `expected 3-4 tokens, got ${tokens}`);
});

test("estimateTokens scales proportionally with text length", () => {
  const short = estimateTokens("hello");
  const long = estimateTokens("hello".repeat(100));
  assert.ok(long > short * 50, "longer text should produce proportionally more tokens");
});

test("estimateTokens returns 1 for a single character", () => {
  assert.equal(estimateTokens("a"), 1);
});

// --- estimateMessagesTokens ---

test("estimateMessagesTokens returns 0 for empty array", () => {
  assert.equal(estimateMessagesTokens([]), 0);
});

test("estimateMessagesTokens returns 0 for non-array", () => {
  assert.equal(estimateMessagesTokens(null), 0);
  assert.equal(estimateMessagesTokens("not an array"), 0);
});

test("estimateMessagesTokens sums tokens for 3 messages with per-message overhead", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello, how are you?" },
    { role: "assistant", content: "I am doing well, thank you!" },
  ];
  const total = estimateMessagesTokens(messages);
  // Each message: estimateTokens(role + content) + 4 overhead
  // Total should be reasonable (roughly 30-50 tokens for these short messages)
  assert.ok(total > 20, `expected > 20 tokens, got ${total}`);
  assert.ok(total < 80, `expected < 80 tokens, got ${total}`);
});

test("estimateMessagesTokens includes tool_calls in estimation", () => {
  const withoutTools = [{ role: "assistant", content: "hello" }];
  const withTools = [
    {
      role: "assistant",
      content: "hello",
      tool_calls: [{ id: "tc1", function: { name: "search", arguments: '{"q":"test"}' } }],
    },
  ];
  const tokensWithout = estimateMessagesTokens(withoutTools);
  const tokensWith = estimateMessagesTokens(withTools);
  assert.ok(tokensWith > tokensWithout, "messages with tool_calls should have more tokens");
});

test("estimateMessagesTokens skips null entries in array", () => {
  const messages = [null, { role: "user", content: "hi" }, null];
  const total = estimateMessagesTokens(messages);
  // Only 1 real message
  assert.ok(total > 0);
  const singleMsg = estimateMessagesTokens([{ role: "user", content: "hi" }]);
  assert.equal(total, singleMsg);
});

// --- getModelContextWindow ---

test("getModelContextWindow returns correct values for known models", () => {
  assert.equal(getModelContextWindow("gpt-4o"), 128_000);
  assert.equal(getModelContextWindow("gpt-4o-mini"), 128_000);
  assert.equal(getModelContextWindow("gpt-4"), 8192);
  assert.equal(getModelContextWindow("gpt-3.5-turbo"), 16_384);
  assert.equal(getModelContextWindow("llama3.1"), 131_072);
  assert.equal(getModelContextWindow("claude-3-sonnet"), 200_000);
});

test("getModelContextWindow returns 8192 for unknown models", () => {
  assert.equal(getModelContextWindow("unknown-model-xyz"), 8192);
  assert.equal(getModelContextWindow(""), 8192);
});

test("getModelContextWindow returns 8192 for non-string input", () => {
  assert.equal(getModelContextWindow(null), 8192);
  assert.equal(getModelContextWindow(undefined), 8192);
});

test("getModelContextWindow respects MODEL_CONTEXT_WINDOWS env override", (t) => {
  const orig = process.env.MODEL_CONTEXT_WINDOWS;
  process.env.MODEL_CONTEXT_WINDOWS = "my-model:32000,gpt-4:16000";
  __resetEnvOverridesForTests();
  t.after(() => {
    if (orig !== undefined) process.env.MODEL_CONTEXT_WINDOWS = orig;
    else delete process.env.MODEL_CONTEXT_WINDOWS;
    __resetEnvOverridesForTests();
  });

  assert.equal(getModelContextWindow("my-model"), 32_000);
  // Env override takes precedence over built-in
  assert.equal(getModelContextWindow("gpt-4"), 16_000);
  // Non-overridden model still uses built-in
  assert.equal(getModelContextWindow("gpt-4o"), 128_000);
});

test("getModelContextWindow ignores invalid env override entries", (t) => {
  const orig = process.env.MODEL_CONTEXT_WINDOWS;
  process.env.MODEL_CONTEXT_WINDOWS = "good:5000,bad:notanumber,,also-bad:";
  __resetEnvOverridesForTests();
  t.after(() => {
    if (orig !== undefined) process.env.MODEL_CONTEXT_WINDOWS = orig;
    else delete process.env.MODEL_CONTEXT_WINDOWS;
    __resetEnvOverridesForTests();
  });

  assert.equal(getModelContextWindow("good"), 5000);
  assert.equal(getModelContextWindow("bad"), 8192); // falls back to default
});
