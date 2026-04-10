/**
 * Phase 31.3: Synthetic monitor tests.
 * Covers register/unregister, HTTP check with a local server, history and stats,
 * uptime calculation, and start/stop periodic execution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createSyntheticMonitor,
  registerBuiltInChecks,
  parsePeriod,
} from "../lib/synthetic-monitor.js";

/**
 * Spin up a minimal HTTP server for tests.
 * The handler receives (req, res) and should respond.
 */
function startLocalServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({ srv, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test("registerCheck stores config and unregisterCheck removes it", () => {
  const monitor = createSyntheticMonitor();
  monitor.registerCheck({
    id: "probe1",
    name: "Probe 1",
    type: "http",
    target: { url: "http://127.0.0.1/health" },
    expected: { status: 200 },
  });
  let list = monitor.listChecks();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "probe1");
  assert.equal(list[0].type, "http");

  const removed = monitor.unregisterCheck("probe1");
  assert.equal(removed, true);
  list = monitor.listChecks();
  assert.equal(list.length, 0);

  // Unregistering an unknown check returns false
  assert.equal(monitor.unregisterCheck("nope"), false);
});

test("registerCheck rejects missing/invalid config", () => {
  const monitor = createSyntheticMonitor();
  assert.throws(() => monitor.registerCheck(null), /config is required/);
  assert.throws(() => monitor.registerCheck({ type: "http" }), /id is required/);
  assert.throws(
    () => monitor.registerCheck({ id: "x", type: "nonsense" }),
    /invalid type/,
  );
});

test("runCheck executes an HTTP check and returns pass on 200", async () => {
  const { srv, baseUrl } = await startLocalServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ backend: "test" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const monitor = createSyntheticMonitor();
    monitor.registerCheck({
      id: "ok",
      type: "http",
      target: { url: `${baseUrl}/ok` },
      expected: { status: 200, contentType: "application/json", jsonField: "backend" },
    });
    const result = await monitor.runCheck("ok");
    assert.equal(result.status, "pass");
    assert.equal(result.id, "ok");
    assert.ok(result.durationMs >= 0);
    assert.equal(result.error, null);
  } finally {
    srv.close();
  }
});

test("runCheck returns fail on wrong status", async () => {
  const { srv, baseUrl } = await startLocalServer((_req, res) => {
    res.writeHead(500);
    res.end("oops");
  });
  try {
    const monitor = createSyntheticMonitor();
    monitor.registerCheck({
      id: "down",
      type: "http",
      target: { url: `${baseUrl}/anything` },
      expected: { status: 200 },
    });
    const result = await monitor.runCheck("down");
    assert.equal(result.status, "fail");
    assert.match(result.error, /expected status/);
  } finally {
    srv.close();
  }
});

test("runCheck returns fail when jsonField missing", async () => {
  const { srv, baseUrl } = await startLocalServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ foo: "bar" }));
  });
  try {
    const monitor = createSyntheticMonitor();
    monitor.registerCheck({
      id: "missing-field",
      type: "http",
      target: { url: `${baseUrl}/` },
      expected: { status: 200, jsonField: "backend" },
    });
    const result = await monitor.runCheck("missing-field");
    assert.equal(result.status, "fail");
    assert.match(result.error, /backend/);
  } finally {
    srv.close();
  }
});

test("runCheck HTTP check supports string URL target", async () => {
  const { srv, baseUrl } = await startLocalServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  try {
    const monitor = createSyntheticMonitor();
    monitor.registerCheck({
      id: "string-url",
      type: "http",
      target: `${baseUrl}/`,
    });
    const result = await monitor.runCheck("string-url");
    assert.equal(result.status, "pass");
  } finally {
    srv.close();
  }
});

test("runCheck on unknown check throws", async () => {
  const monitor = createSyntheticMonitor();
  await assert.rejects(() => monitor.runCheck("does-not-exist"), /unknown check/);
});

test("script check: pass from a truthy function", async () => {
  const monitor = createSyntheticMonitor();
  monitor.registerCheck({
    id: "script-pass",
    type: "script",
    target: () => ({ status: "pass", output: "all good" }),
  });
  const result = await monitor.runCheck("script-pass");
  assert.equal(result.status, "pass");
  assert.equal(result.output, "all good");
});

test("script check: fail from returning false", async () => {
  const monitor = createSyntheticMonitor();
  monitor.registerCheck({
    id: "script-fail",
    type: "script",
    target: () => false,
  });
  const result = await monitor.runCheck("script-fail");
  assert.equal(result.status, "fail");
});

test("script check: fail on thrown error", async () => {
  const monitor = createSyntheticMonitor();
  monitor.registerCheck({
    id: "script-throw",
    type: "script",
    target: () => {
      throw new Error("boom");
    },
  });
  const result = await monitor.runCheck("script-throw");
  assert.equal(result.status, "fail");
  assert.match(result.error, /boom/);
});

test("getCheckHistory returns recent runs in order", async () => {
  const monitor = createSyntheticMonitor();
  let passNext = true;
  monitor.registerCheck({
    id: "alt",
    type: "script",
    target: () => (passNext ? { status: "pass" } : { status: "fail", error: "down" }),
  });
  passNext = true;  await monitor.runCheck("alt");
  passNext = false; await monitor.runCheck("alt");
  passNext = true;  await monitor.runCheck("alt");

  const history = monitor.getCheckHistory("alt");
  assert.equal(history.length, 3);
  assert.equal(history[0].status, "pass");
  assert.equal(history[1].status, "fail");
  assert.equal(history[2].status, "pass");

  const last2 = monitor.getCheckHistory("alt", 2);
  assert.equal(last2.length, 2);
  assert.equal(last2[0].status, "fail");
  assert.equal(last2[1].status, "pass");
});

test("getCheckStats computes uptime, avg, failures", async () => {
  const monitor = createSyntheticMonitor();
  let nextPass = true;
  monitor.registerCheck({
    id: "stats",
    type: "script",
    target: () => (nextPass ? { status: "pass" } : { status: "fail", error: "x" }),
  });
  // 3 pass, 1 fail = 75% uptime
  nextPass = true;  await monitor.runCheck("stats");
  nextPass = true;  await monitor.runCheck("stats");
  nextPass = false; await monitor.runCheck("stats");
  nextPass = true;  await monitor.runCheck("stats");

  const stats = monitor.getCheckStats("stats", "24h");
  assert.equal(stats.total, 4);
  assert.equal(stats.passes, 3);
  assert.equal(stats.failures, 1);
  assert.equal(stats.uptime, 75);
  assert.ok(stats.avgDurationMs != null && stats.avgDurationMs >= 0);
  assert.equal(stats.lastStatus, "pass");
  assert.ok(stats.lastCheckedAt);
});

test("getCheckStats with empty history returns nulls for metrics", () => {
  const monitor = createSyntheticMonitor();
  monitor.registerCheck({
    id: "empty",
    type: "script",
    target: () => true,
  });
  const stats = monitor.getCheckStats("empty", "1h");
  assert.equal(stats.total, 0);
  assert.equal(stats.uptime, null);
  assert.equal(stats.avgDurationMs, null);
  assert.equal(stats.p95DurationMs, null);
  assert.equal(stats.lastStatus, null);
});

test("getCheckStats respects period window", async () => {
  const monitor = createSyntheticMonitor({ historyLimit: 500 });
  monitor.registerCheck({
    id: "window",
    type: "script",
    target: () => true,
  });
  // Seed one run
  await monitor.runCheck("window");
  // Stats for 1 hour should include it
  const hour = monitor.getCheckStats("window", "1h");
  assert.equal(hour.total, 1);
  // Non-parseable period falls back to 24h default
  const fallback = monitor.getCheckStats("window", "garbage");
  assert.equal(fallback.total, 1);
});

test("runAllChecks runs every registered check and returns results", async () => {
  const monitor = createSyntheticMonitor();
  monitor.registerCheck({ id: "a", type: "script", target: () => true });
  monitor.registerCheck({ id: "b", type: "script", target: () => false });
  const results = await monitor.runAllChecks();
  assert.equal(results.length, 2);
  const ids = results.map((r) => r.id).sort();
  assert.deepEqual(ids, ["a", "b"]);
  const a = results.find((r) => r.id === "a");
  const b = results.find((r) => r.id === "b");
  assert.equal(a.status, "pass");
  assert.equal(b.status, "fail");
});

test("start/stop periodic execution runs checks and can be stopped", async () => {
  const monitor = createSyntheticMonitor();
  let count = 0;
  monitor.registerCheck({
    id: "ticker",
    type: "script",
    target: () => {
      count += 1;
      return { status: "pass" };
    },
  });

  assert.equal(monitor.isRunning(), false);
  monitor.start(30_000); // Long interval; initial run fires immediately
  assert.equal(monitor.isRunning(), true);

  // Wait briefly for the initial async run to complete.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(count >= 1, `expected at least one run, got ${count}`);

  monitor.stop();
  assert.equal(monitor.isRunning(), false);

  const stoppedCount = count;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(count, stoppedCount, "no further runs after stop");
});

test("registerBuiltInChecks seeds all 5 default checks", () => {
  const monitor = createSyntheticMonitor();
  registerBuiltInChecks(monitor, "http://127.0.0.1:9999");
  const ids = monitor.listChecks().map((c) => c.id).sort();
  assert.deepEqual(ids, ["chat", "config", "health_live", "health_ready", "metrics"]);
});

test("parsePeriod handles common suffixes", () => {
  assert.equal(parsePeriod("1h"), 60 * 60 * 1000);
  assert.equal(parsePeriod("24h"), 24 * 60 * 60 * 1000);
  assert.equal(parsePeriod("7d"), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parsePeriod("30m"), 30 * 60 * 1000);
  assert.equal(parsePeriod("45s"), 45 * 1000);
  assert.equal(parsePeriod("500ms"), 500);
  assert.equal(parsePeriod(""), null);
  assert.equal(parsePeriod("bogus"), null);
  assert.equal(parsePeriod(1234), 1234);
});

test("history limit trims to historyLimit entries", async () => {
  const monitor = createSyntheticMonitor({ historyLimit: 3 });
  monitor.registerCheck({
    id: "lim",
    type: "script",
    target: () => true,
  });
  for (let i = 0; i < 6; i++) await monitor.runCheck("lim");
  const history = monitor.getCheckHistory("lim");
  assert.equal(history.length, 3);
});
