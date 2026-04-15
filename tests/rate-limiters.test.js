/**
 * Smoke tests for lib/rate-limiters.js — factory must expose the expected
 * limiter set and honour the RATE_LIMIT_PER_KEY=null short-circuit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiters } from "../lib/rate-limiters.js";

test("createRateLimiters is callable and returns the expected keys", () => {
  const limiters = createRateLimiters({
    apiError: () => {},
    isAuthConfigured: () => false,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_MAX: 60,
    RATE_LIMIT_MAX_PER_USER: 60,
    RATE_LIMIT_PER_KEY: null,
  });
  const expected = [
    "perKeyChatRateLimiter",
    "chatRateLimiter",
    "integrationRateLimiter",
    "knowledgeIndexRateLimiter",
    "embeddingsRateLimiter",
    "storageRateLimiter",
    "pluginsActionsRateLimiter",
    "marketplaceRateLimiter",
    "webhooksRateLimiter",
    "executeStepRateLimiter",
    "evalRateLimiter",
  ];
  for (const name of expected) {
    assert.equal(
      typeof limiters[name],
      "function",
      `expected ${name} to be a middleware function`,
    );
  }
});

test("perKeyChatRateLimiter is a passthrough when RATE_LIMIT_PER_KEY is null", () => {
  const { perKeyChatRateLimiter } = createRateLimiters({
    apiError: () => {},
    isAuthConfigured: () => false,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_MAX: 60,
    RATE_LIMIT_MAX_PER_USER: 60,
    RATE_LIMIT_PER_KEY: null,
  });
  let called = false;
  perKeyChatRateLimiter({}, {}, () => {
    called = true;
  });
  assert.equal(called, true, "expected next() to be invoked");
});
