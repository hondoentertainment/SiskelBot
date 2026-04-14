/**
 * Pure unit tests for the format() helper exported from
 * client/signal-strip.js. No DOM / JSDOM required — we just import the
 * module (which is DOM-guarded) and exercise format.*.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { format } from "../client/signal-strip.js";

test("format.cost renders sub-dollar estimates with 3 decimals", () => {
  assert.equal(format.cost(0.003), "$0.003");
  assert.equal(format.cost(0.0005), "$0.001"); // rounds via toFixed(3)
  assert.equal(format.cost(0), "$0.000");
  assert.equal(format.cost(-1), "$0.000");
  assert.equal(format.cost(NaN), "$0.000");
  assert.equal(format.cost(undefined), "$0.000");
});

test("format.cost uses 2 decimals above $1", () => {
  assert.equal(format.cost(1), "$1.00");
  assert.equal(format.cost(2.345), "$2.35");
});

test("format.latency renders seconds for >= 1000ms and ms otherwise", () => {
  assert.equal(format.latency(1400), "1.4s");
  assert.equal(format.latency(1000), "1.0s");
  assert.equal(format.latency(250), "250ms");
  assert.equal(format.latency(0), "—");
  assert.equal(format.latency(NaN), "—");
  assert.equal(format.latency(undefined), "—");
});

test("format.quality renders 0..1 score as N/5★", () => {
  assert.equal(format.quality(0.8), "4/5★");
  assert.equal(format.quality(1), "5/5★");
  assert.equal(format.quality(0), "0/5★");
  assert.equal(format.quality(0.5), "3/5★"); // rounds 2.5 -> 3
  assert.equal(format.quality(0.1), "1/5★"); // rounds 0.5 -> 1 (banker-less)
  // Out-of-range values clamp.
  assert.equal(format.quality(1.5), "5/5★");
  assert.equal(format.quality(-0.5), "0/5★");
  assert.equal(format.quality(NaN), "0/5★");
});

test("format.backendModel concatenates with a middle dot", () => {
  assert.equal(format.backendModel("openai", "gpt-4o-mini"), "openai · gpt-4o-mini");
  assert.equal(format.backendModel("", ""), "unknown · —");
  assert.equal(format.backendModel("ollama", null), "ollama · —");
});

test("format.breaker maps states to labels + degraded flag", () => {
  assert.deepEqual(format.breaker("closed"), { label: "healthy", degraded: false });
  assert.deepEqual(format.breaker("open"), { label: "degraded", degraded: true });
  assert.deepEqual(format.breaker("half_open"), { label: "recovering", degraded: true });
  assert.deepEqual(format.breaker("unknown"), { label: "healthy", degraded: false });
});
