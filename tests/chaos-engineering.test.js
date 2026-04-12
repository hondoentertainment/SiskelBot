/**
 * Phase 59.1: Chaos engineering tests.
 *
 * Covers FAULT_TYPES, ChaosInjector rule CRUD + probability, applyFault by
 * type, withChaos decorator, chaosMiddleware, experiment lifecycle + steady
 * state, hypothesis validation, and built-in fault primitives.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate storage before importing the library.
process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "chaos-test-"));

const {
  FAULT_TYPES,
  ChaosInjector,
  withChaos,
  chaosMiddleware,
  createExperiment,
  startExperiment,
  stopExperiment,
  getExperiment,
  listExperiments,
  recordFaultEvent,
  getFaultHistory,
  recordSteadyStateMetric,
  validateSteadyState,
  injectLatency,
  injectError,
  injectPartialResponse,
  injectDataCorruption,
} = await import("../lib/chaos-engineering.js");

// ─── FAULT_TYPES ────────────────────────────────────────────────────────────

test("FAULT_TYPES exposes all expected fault keys", () => {
  const expected = [
    "latency",
    "error",
    "timeout",
    "partial_response",
    "rate_limit",
    "network_partition",
    "slow_response",
    "data_corruption",
  ];
  for (const key of expected) {
    assert.ok(FAULT_TYPES[key], `missing fault type: ${key}`);
    assert.equal(typeof FAULT_TYPES[key].description, "string");
  }
});

// ─── ChaosInjector.addRule / removeRule ─────────────────────────────────────

test("ChaosInjector addRule and removeRule manage rules", () => {
  const inj = new ChaosInjector();
  const rule = inj.addRule({ type: "latency", targetPattern: "/api/x", params: { ms: 50 } });
  assert.ok(rule.id);
  assert.equal(rule.type, "latency");
  assert.equal(rule.enabled, true);
  assert.equal(inj.listRules().length, 1);
  assert.equal(inj.removeRule(rule.id), true);
  assert.equal(inj.listRules().length, 0);
  assert.equal(inj.removeRule("nope"), false);
});

test("ChaosInjector.addRule rejects invalid type and probability", () => {
  const inj = new ChaosInjector();
  assert.throws(() => inj.addRule({ type: "bogus" }), /invalid fault type/);
  assert.throws(
    () => inj.addRule({ type: "latency", probability: 2 }),
    /probability must be/,
  );
});

// ─── shouldInject w/ probability ────────────────────────────────────────────

test("ChaosInjector.shouldInject returns matching rule when probability=1", async () => {
  const inj = new ChaosInjector();
  inj.addRule({ type: "latency", targetPattern: "/api/x", probability: 1, params: { ms: 1 } });
  const rule = await inj.shouldInject({ target: "/api/x" });
  assert.ok(rule);
  assert.equal(rule.type, "latency");
});

test("ChaosInjector.shouldInject returns null when probability=0", async () => {
  const inj = new ChaosInjector();
  inj.addRule({ type: "latency", targetPattern: "/api/x", probability: 0 });
  const rule = await inj.shouldInject({ target: "/api/x" });
  assert.equal(rule, null);
});

test("ChaosInjector.shouldInject skips disabled rules", async () => {
  const inj = new ChaosInjector();
  inj.addRule({ type: "latency", targetPattern: "*", probability: 1, enabled: false });
  const rule = await inj.shouldInject({ target: "/anything" });
  assert.equal(rule, null);
});

// ─── applyFault ────────────────────────────────────────────────────────────

test("applyFault(latency) delays and returns data", async () => {
  const inj = new ChaosInjector();
  const r = inj.addRule({ type: "latency", params: { ms: 40 } });
  const start = Date.now();
  const out = await inj.applyFault(r, { data: "hello" });
  const elapsed = Date.now() - start;
  assert.equal(out, "hello");
  assert.ok(elapsed >= 30, `elapsed ${elapsed}ms should be >= 30`);
});

test("applyFault(error) throws a chaos error", async () => {
  const inj = new ChaosInjector();
  const r = inj.addRule({ type: "error", params: { code: "BOOM" } });
  await assert.rejects(() => inj.applyFault(r, {}), /BOOM/);
});

test("applyFault(timeout) throws ETIMEDOUT", async () => {
  const inj = new ChaosInjector();
  const r = inj.addRule({ type: "timeout" });
  await assert.rejects(() => inj.applyFault(r, {}), (err) => err.code === "ETIMEDOUT");
});

test("applyFault(rate_limit) throws with statusCode 429", async () => {
  const inj = new ChaosInjector();
  const r = inj.addRule({ type: "rate_limit" });
  await assert.rejects(() => inj.applyFault(r, {}), (err) => err.statusCode === 429);
});

test("applyFault(partial_response) truncates data", async () => {
  const inj = new ChaosInjector();
  const r = inj.addRule({ type: "partial_response", params: { keepRatio: 0.5 } });
  const out = await inj.applyFault(r, { data: "abcdefgh" });
  assert.equal(out, "abcd");
});

test("applyFault(data_corruption) returns modified data of same length", async () => {
  const inj = new ChaosInjector();
  const r = inj.addRule({ type: "data_corruption", params: { rate: 1 } });
  const input = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const out = await inj.applyFault(r, { data: input });
  assert.equal(out.length, input.length);
  // At least one byte must differ.
  let diff = 0;
  for (let i = 0; i < input.length; i += 1) if (out[i] !== input[i]) diff += 1;
  assert.ok(diff > 0, "expected at least one byte to differ");
});

// ─── withChaos decorator ────────────────────────────────────────────────────

test("withChaos wraps fn and calls through when no rule matches", async () => {
  const inj = new ChaosInjector();
  const fn = async (x) => x * 2;
  const wrapped = withChaos(fn, inj);
  assert.equal(await wrapped(5), 10);
});

test("withChaos wraps fn and applies error fault", async () => {
  const inj = new ChaosInjector();
  inj.addRule({ type: "error", targetPattern: "failing", probability: 1, params: { code: "CHAOS_ERR" } });
  const fn = async () => "ok";
  const wrapped = withChaos(fn, inj, { contextFn: () => ({ target: "failing" }) });
  await assert.rejects(() => wrapped(), /CHAOS_ERR/);
});

test("withChaos applies latency before underlying call", async () => {
  const inj = new ChaosInjector();
  inj.addRule({ type: "latency", targetPattern: "*", probability: 1, params: { ms: 30 } });
  const wrapped = withChaos(async () => "ok", inj);
  const t = Date.now();
  const out = await wrapped("foo");
  assert.equal(out, "ok");
  assert.ok(Date.now() - t >= 20);
});

// ─── chaosMiddleware ────────────────────────────────────────────────────────

test("chaosMiddleware calls next() when no rule matches", () => {
  const inj = new ChaosInjector();
  const mw = chaosMiddleware(inj);
  let called = false;
  const req = { originalUrl: "/api/foo" };
  const res = { status() { return this; }, json() { return this; } };
  return new Promise((resolve, reject) => {
    mw(req, res, (err) => {
      if (err) return reject(err);
      called = true;
      assert.equal(called, true);
      resolve();
    });
  });
});

test("chaosMiddleware returns injected error response for error faults", async () => {
  const inj = new ChaosInjector();
  inj.addRule({ type: "rate_limit", targetPattern: "/api/fail", probability: 1 });
  const mw = chaosMiddleware(inj);
  const req = { originalUrl: "/api/fail" };
  let statusCode = null;
  let body = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(b) { body = b; return this; },
  };
  await new Promise((resolve) => mw(req, res, () => resolve()));
  assert.equal(statusCode, 429);
  assert.ok(body.error);
  assert.equal(body.error.injected, true);
});

// ─── Experiment lifecycle ──────────────────────────────────────────────────

test("createExperiment persists a new experiment", async () => {
  const exp = await createExperiment("latency-study", {
    faults: ["latency"],
    targets: ["/api/chat"],
    duration: 5_000,
  });
  assert.ok(exp.id);
  assert.equal(exp.status, "created");
  assert.equal(exp.name, "latency-study");
  const fetched = await getExperiment(exp.id);
  assert.equal(fetched.id, exp.id);
});

test("createExperiment rejects missing name", async () => {
  await assert.rejects(() => createExperiment(""), /name is required/);
});

test("startExperiment / stopExperiment toggle status", async () => {
  const exp = await createExperiment("lifecycle-exp");
  const started = await startExperiment(exp.id);
  assert.equal(started.status, "running");
  assert.ok(started.startedAt);
  const stopped = await stopExperiment(exp.id);
  assert.equal(stopped.status, "stopped");
  assert.ok(stopped.stoppedAt);
});

test("listExperiments supports filter by status", async () => {
  const all = await listExperiments();
  assert.ok(Array.isArray(all));
  assert.ok(all.length >= 1);
  const running = await listExperiments({ status: "running" });
  for (const e of running) assert.equal(e.status, "running");
});

// ─── Fault events ──────────────────────────────────────────────────────────

test("recordFaultEvent and getFaultHistory store events", async () => {
  const exp = await createExperiment("history-exp");
  await recordFaultEvent({ ruleId: "r1", type: "latency", target: "/api/x", experimentId: exp.id });
  await recordFaultEvent({ ruleId: "r2", type: "error", target: "/api/y", experimentId: exp.id });
  const history = await getFaultHistory(exp.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].experimentId, exp.id);
  const all = await getFaultHistory();
  assert.ok(all.length >= 2);
});

// ─── Steady state / hypothesis ─────────────────────────────────────────────

test("validateSteadyState returns valid when hypothesis is met", async () => {
  const exp = await createExperiment("steady-met");
  await startExperiment(exp.id);
  await recordSteadyStateMetric(exp.id, { name: "availability", value: 0.99 });
  await recordSteadyStateMetric(exp.id, { name: "availability", value: 0.995 });
  const result = await validateSteadyState(exp.id, {
    metric: "availability",
    op: ">=",
    threshold: 0.98,
  });
  assert.equal(result.valid, true);
  assert.ok(result.reason.includes("met"));
});

test("validateSteadyState returns violation when hypothesis fails", async () => {
  const exp = await createExperiment("steady-violation");
  await recordSteadyStateMetric(exp.id, { name: "latency_p95", value: 500 });
  await recordSteadyStateMetric(exp.id, { name: "latency_p95", value: 600 });
  const result = await validateSteadyState(exp.id, {
    metric: "latency_p95",
    op: "<",
    threshold: 200,
  });
  assert.equal(result.valid, false);
  assert.ok(typeof result.deviation === "number");
  assert.ok(result.reason.includes("violated"));
});

test("validateSteadyState handles missing metric", async () => {
  const exp = await createExperiment("steady-missing");
  const result = await validateSteadyState(exp.id, {
    metric: "ghost",
    op: ">",
    threshold: 0,
  });
  assert.equal(result.valid, false);
  assert.ok(/no metrics/.test(result.reason));
});

// ─── Built-in fault implementations ────────────────────────────────────────

test("injectLatency resolves after the given delay", async () => {
  const start = Date.now();
  await injectLatency(30);
  assert.ok(Date.now() - start >= 25);
});

test("injectError throws with the given code", () => {
  assert.throws(() => injectError("MY_ERR"), /MY_ERR/);
});

test("injectPartialResponse truncates strings, arrays, buffers, objects", () => {
  assert.equal(injectPartialResponse("abcdefgh", 0.5), "abcd");
  assert.deepEqual(injectPartialResponse([1, 2, 3, 4, 5, 6], 0.5), [1, 2, 3]);
  const buf = Buffer.from([1, 2, 3, 4]);
  const partial = injectPartialResponse(buf, 0.5);
  assert.equal(partial.length, 2);
  const obj = { a: 1, b: 2, c: 3, d: 4 };
  const po = injectPartialResponse(obj, 0.5);
  assert.equal(Object.keys(po).length, 2);
});

test("injectDataCorruption modifies bytes in a buffer", () => {
  const input = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]);
  const out = injectDataCorruption(input, 1);
  assert.equal(out.length, input.length);
  let diff = 0;
  for (let i = 0; i < input.length; i += 1) if (out[i] !== input[i]) diff += 1;
  assert.ok(diff > 0, "expected at least one byte changed");
});

test("injectDataCorruption with rate=0 returns unchanged data", () => {
  const input = "stable";
  assert.equal(injectDataCorruption(input, 0), input);
});

// ─── Rules listing and reset ────────────────────────────────────────────────

test("ChaosInjector.listRules supports type filter", () => {
  const inj = new ChaosInjector();
  inj.addRule({ type: "latency" });
  inj.addRule({ type: "error" });
  inj.addRule({ type: "latency", enabled: false });
  assert.equal(inj.listRules({ type: "latency" }).length, 2);
  assert.equal(inj.listRules({ enabled: true }).length, 2);
  assert.equal(inj.listRules({ enabled: false }).length, 1);
});

test("ChaosInjector.reset clears rules and stats", async () => {
  const inj = new ChaosInjector();
  const r = inj.addRule({ type: "latency", params: { ms: 1 } });
  await inj.applyFault(r, { data: "x" });
  assert.ok(inj.getStats().injected >= 1);
  inj.reset();
  assert.equal(inj.listRules().length, 0);
  assert.equal(inj.getStats().injected, 0);
  assert.equal(inj.getStats().checks, 0);
});
