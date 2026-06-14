/**
 * Phase 46-48: Region health and replication tests.
 * Tests region health checking, replication sync, and vector clock conflict resolution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// --- Region Health tests ---

test("RegionHealth - registerRegion and getRegionStatus", async () => {
  const { RegionHealth } = await import("../lib/region-health.js");
  const rh = new RegionHealth();

  rh.registerRegion("us-west", "https://us-west.example.com");
  rh.registerRegion("eu-central", "https://eu.example.com");

  const status = rh.getRegionStatus();
  // Self + 2 registered
  assert.ok(status.length >= 2, "should have at least 2 regions");
  assert.ok(status.some((r) => r.regionId === "us-west"));
  assert.ok(status.some((r) => r.regionId === "eu-central"));
  assert.ok(status.some((r) => r.isSelf === true), "should include self");

  rh.destroy();
});

test("RegionHealth - self region is always healthy", async () => {
  const { RegionHealth } = await import("../lib/region-health.js");
  const rh = new RegionHealth();

  const status = rh.getRegionStatus();
  const self = status.find((r) => r.isSelf);
  assert.ok(self, "should have self");
  assert.equal(self.status, "healthy");

  rh.destroy();
});

test("RegionHealth - checkRegions marks unreachable", async () => {
  const { RegionHealth } = await import("../lib/region-health.js");
  const rh = new RegionHealth();

  // Register a region with unreachable endpoint
  rh.registerRegion("fake-region", "http://127.0.0.1:1");

  await rh.checkRegions();

  const status = rh.getRegionStatus();
  const fake = status.find((r) => r.regionId === "fake-region");
  assert.ok(fake);
  assert.ok(fake.status === "unreachable" || fake.status === "unhealthy", `status should be unreachable/unhealthy, got ${fake.status}`);
  assert.ok(fake.error);
  assert.ok(fake.lastChecked);

  rh.destroy();
});

test("RegionHealth - checkRegions with real local server", async () => {
  const { RegionHealth } = await import("../lib/region-health.js");

  // Start a tiny HTTP server that returns healthy
  const srv = createServer((req, res) => {
    if (req.url === "/health/ready") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "ready" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;

  const rh = new RegionHealth();
  rh.registerRegion("local-test", `http://127.0.0.1:${port}`);

  await rh.checkRegions();

  const status = rh.getRegionStatus();
  const local = status.find((r) => r.regionId === "local-test");
  assert.ok(local);
  assert.equal(local.status, "healthy");
  assert.ok(local.latencyMs >= 0);

  const active = rh.getActiveRegions();
  assert.ok(active.some((r) => r.regionId === "local-test"));

  rh.destroy();
  srv.close();
});

test("RegionHealth - getActiveRegions excludes unhealthy", async () => {
  const { RegionHealth } = await import("../lib/region-health.js");
  const rh = new RegionHealth();

  rh.registerRegion("down-region", "http://127.0.0.1:1");
  await rh.checkRegions();

  const active = rh.getActiveRegions();
  assert.ok(!active.some((r) => r.regionId === "down-region"), "down region should not be active");
  // Self should always be active
  assert.ok(active.some((r) => r.isSelf), "self should be active");

  rh.destroy();
});

// --- Replication Manager tests ---

test("ReplicationManager - receive accepts valid payload", async () => {
  const { ReplicationManager } = await import("../lib/storage-replication.js");
  const rm = new ReplicationManager();

  const result = rm.receive({
    key: "test-key-1",
    value: { data: "hello" },
    sourceRegion: "us-east",
    clock: { "us-east": 1 },
    timestamp: new Date().toISOString(),
  });

  assert.equal(result.accepted, true);
  rm.destroy();
});

test("ReplicationManager - receive rejects stale clock", async () => {
  const { ReplicationManager } = await import("../lib/storage-replication.js");
  const rm = new ReplicationManager();

  // First write
  rm.receive({
    key: "conflict-key",
    value: { v: 1 },
    sourceRegion: "us-east",
    clock: { "us-east": 2 },
    timestamp: new Date().toISOString(),
  });

  // Stale write (lower clock)
  const result = rm.receive({
    key: "conflict-key",
    value: { v: 0 },
    sourceRegion: "eu-west",
    clock: { "eu-west": 1 },
    timestamp: new Date(Date.now() - 10000).toISOString(),
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "stale_clock");
  rm.destroy();
});

test("ReplicationManager - receive accepts newer clock", async () => {
  const { ReplicationManager } = await import("../lib/storage-replication.js");
  const rm = new ReplicationManager();

  rm.receive({
    key: "evolve-key",
    value: { v: 1 },
    sourceRegion: "us-east",
    clock: { "us-east": 1 },
    timestamp: new Date(Date.now() - 5000).toISOString(),
  });

  const result = rm.receive({
    key: "evolve-key",
    value: { v: 2 },
    sourceRegion: "eu-west",
    clock: { "us-east": 1, "eu-west": 1 },
    timestamp: new Date().toISOString(),
  });

  assert.equal(result.accepted, true, "newer clock should be accepted");
  rm.destroy();
});

test("ReplicationManager - receive rejects missing key", async () => {
  const { ReplicationManager } = await import("../lib/storage-replication.js");
  const rm = new ReplicationManager();

  const result = rm.receive({ value: "x" });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "missing_key");
  rm.destroy();
});

test("ReplicationManager - getClockForKey tracks vector clocks", async () => {
  const { ReplicationManager } = await import("../lib/storage-replication.js");
  const rm = new ReplicationManager();

  rm.receive({
    key: "clock-test",
    value: "a",
    sourceRegion: "us-east",
    clock: { "us-east": 3 },
    timestamp: new Date().toISOString(),
  });

  const clock = rm.getClockForKey("clock-test");
  assert.ok(clock);
  assert.equal(clock["us-east"], 3);

  assert.equal(rm.getClockForKey("nonexistent"), null);
  rm.destroy();
});

test("ReplicationManager - isEnabled requires config", async () => {
  const { ReplicationManager } = await import("../lib/storage-replication.js");
  const rm = new ReplicationManager();

  // Without proper env vars, should not be enabled
  assert.equal(rm.isEnabled(), false);
  rm.destroy();
});

test("internalAuth rejects missing secret", async () => {
  const { internalAuth } = await import("../lib/storage-replication.js");
  const origSecret = process.env.INTERNAL_SECRET;
  process.env.INTERNAL_SECRET = "";

  let statusCode = 0;
  let body = {};
  const req = { headers: {} };
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { body = obj; },
  };

  internalAuth(req, res, () => {});
  assert.equal(statusCode, 503);
  assert.equal(body.error, "internal_sync_not_configured");

  process.env.INTERNAL_SECRET = origSecret;
});

test("internalAuth rejects wrong token", async () => {
  const { internalAuth } = await import("../lib/storage-replication.js");
  const origSecret = process.env.INTERNAL_SECRET;
  process.env.INTERNAL_SECRET = "correct-secret";

  let statusCode = 0;
  const req = { headers: { authorization: "Bearer wrong" } };
  const res = {
    status(code) { statusCode = code; return this; },
    json() {},
  };

  internalAuth(req, res, () => {});
  assert.equal(statusCode, 401);

  process.env.INTERNAL_SECRET = origSecret;
});

test("internalAuth accepts correct token", async () => {
  const { internalAuth } = await import("../lib/storage-replication.js");
  const origSecret = process.env.INTERNAL_SECRET;
  process.env.INTERNAL_SECRET = "my-secret";

  let nextCalled = false;
  const req = { headers: { authorization: "Bearer my-secret" } };
  const res = {};

  internalAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  process.env.INTERNAL_SECRET = origSecret;
});
