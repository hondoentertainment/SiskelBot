/**
 * Tests for lib/ab-router.js — multi-model A/B routing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRoutingConfig,
  selectBackend,
  logRouting,
  getRoutingStats,
  resetStats,
} from "../lib/ab-router.js";
import { recordFailure } from "../lib/circuit-breaker.js";

// --- parseRoutingConfig ---

test("parseRoutingConfig: valid two-backend config", () => {
  const result = parseRoutingConfig("ollama:0.8,openai:0.2");
  assert.equal(result.length, 2);
  assert.equal(result[0].backend, "ollama");
  assert.equal(result[1].backend, "openai");
  // Weights normalised to sum to 1
  const sum = result.reduce((s, e) => s + e.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights should sum to 1, got ${sum}`);
  assert.ok(Math.abs(result[0].weight - 0.8) < 1e-9);
  assert.ok(Math.abs(result[1].weight - 0.2) < 1e-9);
});

test("parseRoutingConfig: single backend", () => {
  const result = parseRoutingConfig("vllm:1");
  assert.equal(result.length, 1);
  assert.equal(result[0].backend, "vllm");
  assert.ok(Math.abs(result[0].weight - 1) < 1e-9);
});

test("parseRoutingConfig: normalises unequal weights", () => {
  const result = parseRoutingConfig("ollama:3,openai:1");
  assert.equal(result.length, 2);
  assert.ok(Math.abs(result[0].weight - 0.75) < 1e-9);
  assert.ok(Math.abs(result[1].weight - 0.25) < 1e-9);
});

test("parseRoutingConfig: empty/null/undefined returns empty", () => {
  assert.deepEqual(parseRoutingConfig(""), []);
  assert.deepEqual(parseRoutingConfig(null), []);
  assert.deepEqual(parseRoutingConfig(undefined), []);
});

test("parseRoutingConfig: invalid entries are skipped", () => {
  const result = parseRoutingConfig("ollama:0.8,bad,openai:abc,vllm:0.2");
  assert.equal(result.length, 2);
  assert.equal(result[0].backend, "ollama");
  assert.equal(result[1].backend, "vllm");
});

test("parseRoutingConfig: zero/negative weights are skipped", () => {
  const result = parseRoutingConfig("ollama:0,openai:-1,vllm:1");
  assert.equal(result.length, 1);
  assert.equal(result[0].backend, "vllm");
});

test("parseRoutingConfig: trims whitespace and lowercases", () => {
  const result = parseRoutingConfig(" Ollama : 0.5 , OpenAI : 0.5 ");
  assert.equal(result.length, 2);
  assert.equal(result[0].backend, "ollama");
  assert.equal(result[1].backend, "openai");
});

// --- selectBackend ---

test("selectBackend: returns null for empty config", () => {
  assert.equal(selectBackend([], "req-1"), null);
  assert.equal(selectBackend(null, "req-1"), null);
});

test("selectBackend: single backend always selected", () => {
  const config = parseRoutingConfig("ollama:1");
  for (let i = 0; i < 20; i++) {
    assert.equal(selectBackend(config, `req-${i}`), "ollama");
  }
});

test("selectBackend: deterministic for same requestId", () => {
  const config = parseRoutingConfig("ollama:0.5,openai:0.5");
  const first = selectBackend(config, "stable-request-id-42");
  for (let i = 0; i < 50; i++) {
    assert.equal(selectBackend(config, "stable-request-id-42"), first);
  }
});

test("selectBackend: distributes roughly according to weights", () => {
  const config = parseRoutingConfig("ollama:0.8,openai:0.2");
  const counts = { ollama: 0, openai: 0 };
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const backend = selectBackend(config, `dist-test-${i}-${Math.random()}`);
    counts[backend]++;
  }
  // Expect ollama ~80% with some tolerance
  const ollamaRatio = counts.ollama / N;
  assert.ok(ollamaRatio > 0.7, `ollama ratio ${ollamaRatio} should be > 0.7`);
  assert.ok(ollamaRatio < 0.9, `ollama ratio ${ollamaRatio} should be < 0.9`);
});

test("selectBackend: falls through when circuit breaker is open", () => {
  const config = parseRoutingConfig("badbackend:0.9,openai:0.1");
  // Open circuit for badbackend by recording many failures
  const threshold = Number(process.env.CIRCUIT_BREAKER_FAILURES) || 5;
  for (let i = 0; i < threshold + 1; i++) {
    recordFailure("badbackend");
  }
  // All requests should go to openai since badbackend circuit is open
  for (let i = 0; i < 20; i++) {
    assert.equal(selectBackend(config, `fallthrough-${i}`), "openai");
  }
});

// --- logRouting + getRoutingStats ---

test("logRouting increments stats and getRoutingStats returns counts", () => {
  resetStats();
  const config = parseRoutingConfig("ollama:0.5,openai:0.5");

  logRouting("req-1", "ollama", config);
  logRouting("req-2", "ollama", config);
  logRouting("req-3", "openai", config);

  const stats = getRoutingStats();
  assert.equal(stats.ollama, 2);
  assert.equal(stats.openai, 1);
});

test("resetStats clears routing stats", () => {
  resetStats();
  const config = parseRoutingConfig("ollama:1");
  logRouting("req-1", "ollama", config);
  assert.equal(getRoutingStats().ollama, 1);
  resetStats();
  assert.deepEqual(getRoutingStats(), {});
});
