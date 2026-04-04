/**
 * Tests for multi-region failover system:
 * - Leader election (lib/leader-election.js)
 * - Region health monitoring (lib/region-health.js)
 * - Storage replication (lib/storage-replication.js)
 */
import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Leader Election
// ---------------------------------------------------------------------------

describe("LeaderElection", () => {
  let LeaderElection;
  let lockDir;

  beforeEach(async () => {
    lockDir = join(tmpdir(), `siskel-test-leader-${randomUUID()}`);
    mkdirSync(lockDir, { recursive: true });
    // Fresh import to avoid module cache issues with env vars
    const mod = await import(`../lib/leader-election.js?t=${Date.now()}`);
    LeaderElection = mod.LeaderElection;
  });

  afterEach(() => {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {}
  });

  test("acquire returns true when no existing lock", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    const result = await le.acquire();
    assert.equal(result, true);
    le.destroy();
  });

  test("acquire writes lock file", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    await le.acquire();
    const lockPath = join(lockDir, ".leader-lock.json");
    assert.ok(existsSync(lockPath));
    const data = JSON.parse(readFileSync(lockPath, "utf8"));
    assert.equal(data.instanceId, "inst-1");
    assert.equal(typeof data.acquiredAt, "number");
    le.destroy();
  });

  test("second instance cannot acquire while first lock is valid", async () => {
    const le1 = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 60000 });
    const le2 = new LeaderElection({ lockDir, instanceId: "inst-2", ttlMs: 60000 });
    await le1.acquire();
    const result = await le2.acquire();
    assert.equal(result, false);
    le1.destroy();
    le2.destroy();
  });

  test("second instance can acquire after first lock expires", async () => {
    const le1 = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 1 });
    const le2 = new LeaderElection({ lockDir, instanceId: "inst-2", ttlMs: 5000 });
    await le1.acquire();
    le1.destroy(); // stop renewal
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 10));
    const result = await le2.acquire();
    assert.equal(result, true);
    le2.destroy();
  });

  test("isLeader returns true for current leader", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    await le.acquire();
    const result = await le.isLeader();
    assert.equal(result, true);
    le.destroy();
  });

  test("isLeader returns false when not leader", async () => {
    const le1 = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 60000 });
    const le2 = new LeaderElection({ lockDir, instanceId: "inst-2", ttlMs: 60000 });
    await le1.acquire();
    const result = await le2.isLeader();
    assert.equal(result, false);
    le1.destroy();
    le2.destroy();
  });

  test("isLeader returns false when lock expired", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 1 });
    await le.acquire();
    le.destroy(); // stop renewal
    await new Promise((r) => setTimeout(r, 10));
    const result = await le.isLeader();
    assert.equal(result, false);
  });

  test("release clears leadership", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    await le.acquire();
    await le.release();
    const result = await le.isLeader();
    assert.equal(result, false);
    le.destroy();
  });

  test("getLeader returns leader info", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    await le.acquire();
    const leader = await le.getLeader();
    assert.ok(leader);
    assert.equal(leader.instanceId, "inst-1");
    assert.ok(leader.acquiredAt);
    assert.ok(leader.expiresAt);
    le.destroy();
  });

  test("getLeader returns null when no leader", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    const leader = await le.getLeader();
    assert.equal(leader, null);
    le.destroy();
  });

  test("getLeader returns null when lock expired", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 1 });
    await le.acquire();
    le.destroy();
    await new Promise((r) => setTimeout(r, 10));
    const leader = await le.getLeader();
    assert.equal(leader, null);
  });

  test("onLeaderChange fires on acquire", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    let called = false;
    let leaderValue = null;
    le.onLeaderChange((isLeader) => {
      called = true;
      leaderValue = isLeader;
    });
    await le.acquire();
    assert.equal(called, true);
    assert.equal(leaderValue, true);
    le.destroy();
  });

  test("onLeaderChange fires on release", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    const events = [];
    le.onLeaderChange((isLeader) => events.push(isLeader));
    await le.acquire();
    await le.release();
    assert.deepEqual(events, [true, false]);
    le.destroy();
  });

  test("same instance can re-acquire its own lock", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    await le.acquire();
    // Second acquire by same instance should succeed (renew)
    const result = await le.acquire();
    assert.equal(result, true);
    le.destroy();
  });

  test("destroy stops renewal interval", async () => {
    const le = new LeaderElection({ lockDir, instanceId: "inst-1", ttlMs: 5000 });
    await le.acquire();
    assert.ok(le._renewInterval !== null);
    le.destroy();
    assert.equal(le._renewInterval, null);
  });

  test("postgres mode uses provided load/save functions", async () => {
    const store = {};
    const le = new LeaderElection({
      lockDir,
      instanceId: "pg-inst-1",
      ttlMs: 5000,
      usePostgres: true,
      postgresKvLoad: async (key) => store[key] || null,
      postgresKvSave: async (key, value) => { store[key] = value; },
    });
    const result = await le.acquire();
    assert.equal(result, true);
    assert.ok(store["__leader_lock__"]);
    assert.equal(store["__leader_lock__"].instanceId, "pg-inst-1");
    le.destroy();
  });
});

// ---------------------------------------------------------------------------
// Region Health
// ---------------------------------------------------------------------------

describe("RegionHealth", () => {
  let RegionHealth;

  beforeEach(async () => {
    const mod = await import(`../lib/region-health.js?t=${Date.now()}`);
    RegionHealth = mod.RegionHealth;
  });

  test("registerRegion adds a region", () => {
    const rh = new RegionHealth();
    rh.registerRegion("us-west", "https://us-west.example.com");
    const status = rh.getRegionStatus();
    // Should have self + us-west
    const usWest = status.find((r) => r.regionId === "us-west");
    assert.ok(usWest);
    assert.equal(usWest.endpoint, "https://us-west.example.com");
    assert.equal(usWest.status, "unknown");
    rh.destroy();
  });

  test("registerRegion strips trailing slashes", () => {
    const rh = new RegionHealth();
    rh.registerRegion("us-west", "https://us-west.example.com///");
    const status = rh.getRegionStatus();
    const usWest = status.find((r) => r.regionId === "us-west");
    assert.equal(usWest.endpoint, "https://us-west.example.com");
    rh.destroy();
  });

  test("getRegionStatus always includes self as healthy", () => {
    const rh = new RegionHealth();
    const status = rh.getRegionStatus();
    assert.ok(status.length >= 1);
    const self = status.find((r) => r.isSelf === true);
    assert.ok(self);
    assert.equal(self.status, "healthy");
    assert.equal(self.latencyMs, 0);
    assert.equal(self.endpoint, "self");
    rh.destroy();
  });

  test("getActiveRegions returns only healthy regions", () => {
    const rh = new RegionHealth();
    rh.registerRegion("r1", "https://r1.example.com");
    // r1 is "unknown" so only self should be active
    const active = rh.getActiveRegions();
    assert.equal(active.length, 1);
    assert.equal(active[0].isSelf, true);
    rh.destroy();
  });

  test("checkRegions marks region as unreachable on network error", async () => {
    const rh = new RegionHealth();
    // Register a region with a non-routable endpoint
    rh.registerRegion("bad-region", "http://192.0.2.1:1"); // TEST-NET, should fail fast
    await rh.checkRegions();
    const status = rh.getRegionStatus();
    const bad = status.find((r) => r.regionId === "bad-region");
    assert.ok(bad);
    assert.ok(bad.status === "unreachable" || bad.status === "unhealthy");
    assert.ok(bad.error);
    assert.ok(bad.lastChecked);
    rh.destroy();
  });

  test("destroy clears all regions and stops polling", () => {
    const rh = new RegionHealth();
    rh.registerRegion("r1", "https://r1.example.com");
    rh.startPolling();
    rh.destroy();
    assert.equal(rh._regions.size, 0);
    assert.equal(rh._pollInterval, null);
  });

  test("startPolling is no-op when no regions registered", () => {
    const rh = new RegionHealth();
    rh.startPolling();
    assert.equal(rh._pollInterval, null);
    rh.destroy();
  });

  test("stopPolling clears interval", () => {
    const rh = new RegionHealth();
    rh.registerRegion("r1", "https://r1.example.com");
    rh.startPolling();
    assert.ok(rh._pollInterval !== null);
    rh.stopPolling();
    assert.equal(rh._pollInterval, null);
    rh.destroy();
  });
});

// ---------------------------------------------------------------------------
// Storage Replication
// ---------------------------------------------------------------------------

describe("ReplicationManager", () => {
  let ReplicationManager;
  let prevEnableReplication;
  let prevInternalSecret;
  let prevRegions;
  let prevRegionId;

  beforeEach(async () => {
    // Save env
    prevEnableReplication = process.env.ENABLE_REPLICATION;
    prevInternalSecret = process.env.INTERNAL_SECRET;
    prevRegions = process.env.REGIONS;
    prevRegionId = process.env.REGION_ID;

    const mod = await import(`../lib/storage-replication.js?t=${Date.now()}`);
    ReplicationManager = mod.ReplicationManager;
  });

  afterEach(() => {
    // Restore env
    if (prevEnableReplication !== undefined) process.env.ENABLE_REPLICATION = prevEnableReplication;
    else delete process.env.ENABLE_REPLICATION;
    if (prevInternalSecret !== undefined) process.env.INTERNAL_SECRET = prevInternalSecret;
    else delete process.env.INTERNAL_SECRET;
    if (prevRegions !== undefined) process.env.REGIONS = prevRegions;
    else delete process.env.REGIONS;
    if (prevRegionId !== undefined) process.env.REGION_ID = prevRegionId;
    else delete process.env.REGION_ID;
  });

  test("isEnabled returns false when ENABLE_REPLICATION is not set", () => {
    const rm = new ReplicationManager();
    assert.equal(rm.isEnabled(), false);
    rm.destroy();
  });

  test("receive accepts valid payload", () => {
    const rm = new ReplicationManager();
    const result = rm.receive({
      key: "test-key",
      value: { data: "hello" },
      sourceRegion: "us-east",
      clock: { "us-east": 1 },
      timestamp: new Date().toISOString(),
    });
    assert.equal(result.accepted, true);
    rm.destroy();
  });

  test("receive rejects payload with missing key", () => {
    const rm = new ReplicationManager();
    const result = rm.receive({ value: "hello" });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "missing_key");
    rm.destroy();
  });

  test("receive rejects null payload", () => {
    const rm = new ReplicationManager();
    const result = rm.receive(null);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "missing_key");
    rm.destroy();
  });

  test("receive rejects stale clock", () => {
    const rm = new ReplicationManager();
    // First write with clock sum = 3
    rm.receive({
      key: "k1",
      value: "v1",
      sourceRegion: "us-east",
      clock: { "us-east": 3 },
      timestamp: "2025-01-01T00:00:01Z",
    });
    // Second write with lower clock sum = 1
    const result = rm.receive({
      key: "k1",
      value: "v2",
      sourceRegion: "eu-west",
      clock: { "eu-west": 1 },
      timestamp: "2025-01-01T00:00:00Z",
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "stale_clock");
    rm.destroy();
  });

  test("receive accepts higher clock", () => {
    const rm = new ReplicationManager();
    rm.receive({
      key: "k1",
      value: "v1",
      sourceRegion: "us-east",
      clock: { "us-east": 1 },
      timestamp: "2025-01-01T00:00:00Z",
    });
    const result = rm.receive({
      key: "k1",
      value: "v2",
      sourceRegion: "eu-west",
      clock: { "eu-west": 5 },
      timestamp: "2025-01-01T00:00:01Z",
    });
    assert.equal(result.accepted, true);
    rm.destroy();
  });

  test("receive merges vector clocks on accept", () => {
    const rm = new ReplicationManager();
    rm.receive({
      key: "k1",
      value: "v1",
      sourceRegion: "us-east",
      clock: { "us-east": 2 },
      timestamp: "2025-01-01T00:00:00Z",
    });
    rm.receive({
      key: "k1",
      value: "v2",
      sourceRegion: "eu-west",
      clock: { "eu-west": 3 },
      timestamp: "2025-01-01T00:00:01Z",
    });
    const clock = rm.getClockForKey("k1");
    assert.ok(clock);
    assert.equal(clock["us-east"], 2);
    assert.equal(clock["eu-west"], 3);
    rm.destroy();
  });

  test("getClockForKey returns null for unknown key", () => {
    const rm = new ReplicationManager();
    assert.equal(rm.getClockForKey("nonexistent"), null);
    rm.destroy();
  });

  test("replicate is no-op when disabled", async () => {
    const rm = new ReplicationManager();
    const result = await rm.replicate("key", "value");
    assert.deepEqual(result, { sent: 0, failed: 0, errors: [] });
    rm.destroy();
  });

  test("destroy clears regions and clocks", () => {
    const rm = new ReplicationManager();
    rm.receive({
      key: "k1",
      value: "v1",
      sourceRegion: "r1",
      clock: { r1: 1 },
      timestamp: new Date().toISOString(),
    });
    rm.destroy();
    assert.equal(rm._regions.size, 0);
    assert.equal(rm._vectorClocks.size, 0);
  });

  test("equal clock sums with newer timestamp is accepted", () => {
    const rm = new ReplicationManager();
    rm.receive({
      key: "k1",
      value: "v1",
      sourceRegion: "us-east",
      clock: { "us-east": 2 },
      timestamp: "2025-01-01T00:00:00Z",
    });
    // Same clock sum but newer timestamp
    const result = rm.receive({
      key: "k1",
      value: "v2",
      sourceRegion: "eu-west",
      clock: { "eu-west": 2 },
      timestamp: "2025-01-02T00:00:00Z",
    });
    assert.equal(result.accepted, true);
    rm.destroy();
  });

  test("equal clock sums with older timestamp is rejected", () => {
    const rm = new ReplicationManager();
    rm.receive({
      key: "k1",
      value: "v1",
      sourceRegion: "us-east",
      clock: { "us-east": 2 },
      timestamp: "2025-01-02T00:00:00Z",
    });
    // Same clock sum but older timestamp
    const result = rm.receive({
      key: "k1",
      value: "v2",
      sourceRegion: "eu-west",
      clock: { "eu-west": 2 },
      timestamp: "2025-01-01T00:00:00Z",
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "stale_clock");
    rm.destroy();
  });
});

// ---------------------------------------------------------------------------
// internalAuth middleware
// ---------------------------------------------------------------------------

describe("internalAuth middleware", () => {
  let internalAuth;

  beforeEach(async () => {
    const mod = await import(`../lib/storage-replication.js?t=${Date.now()}`);
    internalAuth = mod.internalAuth;
  });

  test("returns 503 when INTERNAL_SECRET is not set", () => {
    const prevSecret = process.env.INTERNAL_SECRET;
    delete process.env.INTERNAL_SECRET;
    try {
      let statusCode = null;
      let body = null;
      const req = { headers: { authorization: "Bearer something" } };
      const res = {
        status(code) { statusCode = code; return this; },
        json(data) { body = data; },
      };
      const next = mock.fn();
      internalAuth(req, res, next);
      assert.equal(statusCode, 503);
      assert.equal(body.error, "internal_sync_not_configured");
      assert.equal(next.mock.callCount(), 0);
    } finally {
      if (prevSecret !== undefined) process.env.INTERNAL_SECRET = prevSecret;
    }
  });

  test("returns 401 when no authorization header", () => {
    const prevSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = "test-secret";
    try {
      let statusCode = null;
      let body = null;
      const req = { headers: {} };
      const res = {
        status(code) { statusCode = code; return this; },
        json(data) { body = data; },
      };
      const next = mock.fn();
      internalAuth(req, res, next);
      assert.equal(statusCode, 401);
      assert.equal(body.error, "unauthorized");
      assert.equal(next.mock.callCount(), 0);
    } finally {
      if (prevSecret !== undefined) process.env.INTERNAL_SECRET = prevSecret;
      else delete process.env.INTERNAL_SECRET;
    }
  });

  test("returns 401 when authorization header is wrong", () => {
    const prevSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = "test-secret";
    try {
      let statusCode = null;
      let body = null;
      const req = { headers: { authorization: "Bearer wrong-secret" } };
      const res = {
        status(code) { statusCode = code; return this; },
        json(data) { body = data; },
      };
      const next = mock.fn();
      internalAuth(req, res, next);
      assert.equal(statusCode, 401);
      assert.equal(body.error, "unauthorized");
      assert.equal(next.mock.callCount(), 0);
    } finally {
      if (prevSecret !== undefined) process.env.INTERNAL_SECRET = prevSecret;
      else delete process.env.INTERNAL_SECRET;
    }
  });

  test("calls next() when authorization header is correct", () => {
    const prevSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = "test-secret";
    try {
      const req = { headers: { authorization: "Bearer test-secret" } };
      const res = {
        status() { return this; },
        json() {},
      };
      const next = mock.fn();
      internalAuth(req, res, next);
      assert.equal(next.mock.callCount(), 1);
    } finally {
      if (prevSecret !== undefined) process.env.INTERNAL_SECRET = prevSecret;
      else delete process.env.INTERNAL_SECRET;
    }
  });
});

// ---------------------------------------------------------------------------
// Singleton getters / resetters
// ---------------------------------------------------------------------------

describe("singleton management", () => {
  test("getLeaderElection returns same instance", async () => {
    const mod = await import(`../lib/leader-election.js?t=${Date.now()}`);
    mod.resetLeaderElection();
    const a = mod.getLeaderElection();
    const b = mod.getLeaderElection();
    assert.equal(a, b);
    mod.resetLeaderElection();
  });

  test("resetLeaderElection clears singleton", async () => {
    const mod = await import(`../lib/leader-election.js?t=${Date.now()}`);
    mod.resetLeaderElection();
    const a = mod.getLeaderElection();
    mod.resetLeaderElection();
    const b = mod.getLeaderElection();
    assert.notEqual(a, b);
    mod.resetLeaderElection();
  });

  test("getRegionHealth returns same instance", async () => {
    const mod = await import(`../lib/region-health.js?t=${Date.now()}`);
    mod.resetRegionHealth();
    const a = mod.getRegionHealth();
    const b = mod.getRegionHealth();
    assert.equal(a, b);
    mod.resetRegionHealth();
  });

  test("resetRegionHealth clears singleton", async () => {
    const mod = await import(`../lib/region-health.js?t=${Date.now()}`);
    mod.resetRegionHealth();
    const a = mod.getRegionHealth();
    mod.resetRegionHealth();
    const b = mod.getRegionHealth();
    assert.notEqual(a, b);
    mod.resetRegionHealth();
  });

  test("getReplicationManager returns same instance", async () => {
    const mod = await import(`../lib/storage-replication.js?t=${Date.now()}`);
    mod.resetReplicationManager();
    const a = mod.getReplicationManager();
    const b = mod.getReplicationManager();
    assert.equal(a, b);
    mod.resetReplicationManager();
  });

  test("resetReplicationManager clears singleton", async () => {
    const mod = await import(`../lib/storage-replication.js?t=${Date.now()}`);
    mod.resetReplicationManager();
    const a = mod.getReplicationManager();
    mod.resetReplicationManager();
    const b = mod.getReplicationManager();
    assert.notEqual(a, b);
    mod.resetReplicationManager();
  });
});
