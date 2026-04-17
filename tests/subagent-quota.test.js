import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  checkSubagentQuota,
  recordSubagentSpawn,
  getSubagentQuotaStats,
  __resetQuotaCountersForTests,
  __internals,
} from "../lib/subagent-quota.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Save and restore env vars touched by the module. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] == null) {
      delete process.env[k];
    } else {
      process.env[k] = String(overrides[k]);
    }
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

const ENV_KEYS = [
  "SUBAGENT_MAX_SPAWNS_PER_HOUR",
  "SUBAGENT_MAX_DEPTH",
  "SUBAGENT_HITL_COST_THRESHOLD_USD",
  "SUBAGENT_HITL_SPAWN_THRESHOLD",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("subagent-quota", () => {
  beforeEach(() => {
    __resetQuotaCountersForTests();
    clearEnv();
  });

  afterEach(() => {
    __resetQuotaCountersForTests();
    clearEnv();
  });

  // ---- 1. Fresh workspace: allowed ----
  it("allows spawn on a fresh workspace", async () => {
    const result = await checkSubagentQuota({
      workspace: "fresh-ws",
      userId: "u1",
      depth: 0,
    });
    assert.equal(result.allowed, true);
  });

  // ---- 2. Hourly quota exhaustion ----
  it("returns SUBAGENT_QUOTA_EXHAUSTED when hourly max is reached", async () => {
    await withEnv({ SUBAGENT_MAX_SPAWNS_PER_HOUR: "3", SUBAGENT_HITL_SPAWN_THRESHOLD: "0" }, async () => {
      const ws = "rate-ws";
      recordSubagentSpawn(ws);
      recordSubagentSpawn(ws);
      recordSubagentSpawn(ws);

      const result = await checkSubagentQuota({
        workspace: ws,
        userId: "u1",
        depth: 0,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.code, "SUBAGENT_QUOTA_EXHAUSTED");
      assert.match(result.reason, /Hourly subagent quota exhausted/);
    });
  });

  // ---- 3. Depth exceeded ----
  it("returns SUBAGENT_DEPTH_EXCEEDED when depth >= maxDepth", async () => {
    await withEnv({ SUBAGENT_MAX_DEPTH: "2" }, async () => {
      const result = await checkSubagentQuota({
        workspace: "depth-ws",
        userId: "u1",
        depth: 2,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.code, "SUBAGENT_DEPTH_EXCEEDED");
      assert.match(result.reason, /Maximum subagent depth exceeded/);
    });
  });

  it("allows spawn when depth is below maxDepth", async () => {
    await withEnv({ SUBAGENT_MAX_DEPTH: "3" }, async () => {
      const result = await checkSubagentQuota({
        workspace: "depth-ws",
        userId: "u1",
        depth: 2,
      });
      assert.equal(result.allowed, true);
    });
  });

  // ---- 4. HITL cost gate ----
  it("returns hitl_required when estimatedCostUsd exceeds threshold", async () => {
    await withEnv({ SUBAGENT_HITL_COST_THRESHOLD_USD: "2.00" }, async () => {
      const result = await checkSubagentQuota({
        workspace: "cost-ws",
        userId: "u1",
        parentSessionId: "sess-1",
        depth: 0,
        estimatedCostUsd: 3.5,
      });
      assert.equal(result.allowed, "hitl_required");
      assert.ok(result.approvalId, "should have an approvalId");
      assert.match(result.reason, /Estimated cost/);
      assert.match(result.reason, /human approval required/);
    });
  });

  it("allows spawn when estimatedCostUsd is below threshold", async () => {
    await withEnv({ SUBAGENT_HITL_COST_THRESHOLD_USD: "5.00" }, async () => {
      const result = await checkSubagentQuota({
        workspace: "cost-ws",
        userId: "u1",
        depth: 0,
        estimatedCostUsd: 4.99,
      });
      assert.equal(result.allowed, true);
    });
  });

  // ---- 5. HITL spawn-count gate ----
  it("returns hitl_required when spawnsThisHour reaches spawn threshold", async () => {
    await withEnv({
      SUBAGENT_HITL_SPAWN_THRESHOLD: "2",
      SUBAGENT_MAX_SPAWNS_PER_HOUR: "100",
    }, async () => {
      const ws = "hitl-spawn-ws";
      recordSubagentSpawn(ws);
      recordSubagentSpawn(ws);

      const result = await checkSubagentQuota({
        workspace: ws,
        userId: "u1",
        parentSessionId: "sess-2",
        depth: 0,
      });
      assert.equal(result.allowed, "hitl_required");
      assert.ok(result.approvalId);
      assert.match(result.reason, /spawn count/i);
    });
  });

  // ---- 6. Window rotation: advance clock past 1 hour ----
  it("resets counter when the hourly window expires", async () => {
    await withEnv({
      SUBAGENT_MAX_SPAWNS_PER_HOUR: "2",
      SUBAGENT_HITL_SPAWN_THRESHOLD: "0",
    }, async () => {
      const ws = "rotation-ws";
      recordSubagentSpawn(ws);
      recordSubagentSpawn(ws);

      // Verify exhausted
      let result = await checkSubagentQuota({ workspace: ws, userId: "u1", depth: 0 });
      assert.equal(result.allowed, false);

      // Manipulate windowStart to simulate time passing (> 1 hour ago)
      const entry = __internals.hourlyCounters.get(ws);
      assert.ok(entry, "counter entry should exist");
      entry.windowStart = Date.now() - 3_600_001;

      // Now the window should rotate and counter resets
      result = await checkSubagentQuota({ workspace: ws, userId: "u1", depth: 0 });
      assert.equal(result.allowed, true);

      // Stats should reflect reset
      const stats = getSubagentQuotaStats(ws);
      assert.equal(stats.spawnsThisHour, 0);
    });
  });

  // ---- 7. Stats returns correct counts ----
  it("getSubagentQuotaStats returns correct values", async () => {
    await withEnv({
      SUBAGENT_MAX_SPAWNS_PER_HOUR: "50",
      SUBAGENT_MAX_DEPTH: "5",
    }, () => {
      const ws = "stats-ws";
      recordSubagentSpawn(ws);
      recordSubagentSpawn(ws);
      recordSubagentSpawn(ws);

      const stats = getSubagentQuotaStats(ws);
      assert.equal(stats.spawnsThisHour, 3);
      assert.equal(stats.maxPerHour, 50);
      assert.equal(stats.maxDepth, 5);
    });
  });

  // ---- 8. Per-workspace isolation ----
  it("workspace A spawns do not affect workspace B", async () => {
    await withEnv({
      SUBAGENT_MAX_SPAWNS_PER_HOUR: "2",
      SUBAGENT_HITL_SPAWN_THRESHOLD: "0",
    }, async () => {
      recordSubagentSpawn("ws-a");
      recordSubagentSpawn("ws-a");

      // ws-a is exhausted
      const resultA = await checkSubagentQuota({ workspace: "ws-a", userId: "u1", depth: 0 });
      assert.equal(resultA.allowed, false);

      // ws-b is unaffected
      const resultB = await checkSubagentQuota({ workspace: "ws-b", userId: "u1", depth: 0 });
      assert.equal(resultB.allowed, true);
    });
  });

  // ---- 9. Thresholds disabled (0) → always allowed (except depth) ----
  it("allows unlimited spawns when maxSpawnsPerHour is 0", async () => {
    await withEnv({
      SUBAGENT_MAX_SPAWNS_PER_HOUR: "0",
      SUBAGENT_HITL_SPAWN_THRESHOLD: "0",
      SUBAGENT_HITL_COST_THRESHOLD_USD: "0",
    }, async () => {
      const ws = "unlimited-ws";
      for (let i = 0; i < 200; i++) recordSubagentSpawn(ws);

      const result = await checkSubagentQuota({
        workspace: ws,
        userId: "u1",
        depth: 0,
        estimatedCostUsd: 999,
      });
      assert.equal(result.allowed, true);
    });
  });

  it("still enforces depth even when rate/cost thresholds are disabled", async () => {
    await withEnv({
      SUBAGENT_MAX_SPAWNS_PER_HOUR: "0",
      SUBAGENT_MAX_DEPTH: "2",
      SUBAGENT_HITL_SPAWN_THRESHOLD: "0",
      SUBAGENT_HITL_COST_THRESHOLD_USD: "0",
    }, async () => {
      const result = await checkSubagentQuota({
        workspace: "unlimited-ws",
        userId: "u1",
        depth: 5,
      });
      assert.equal(result.allowed, false);
      assert.equal(result.code, "SUBAGENT_DEPTH_EXCEEDED");
    });
  });

  // ---- 10. __resetQuotaCountersForTests clears all state ----
  it("__resetQuotaCountersForTests clears all counters", () => {
    recordSubagentSpawn("ws-x");
    recordSubagentSpawn("ws-y");
    assert.equal(__internals.hourlyCounters.size > 0, true);

    __resetQuotaCountersForTests();
    assert.equal(__internals.hourlyCounters.size, 0);

    // Stats for a cleared workspace should show 0
    const stats = getSubagentQuotaStats("ws-x");
    assert.equal(stats.spawnsThisHour, 0);
  });

  // ---- 11. Per-workspace overrides ----
  it("respects per-workspace quota overrides", async () => {
    // Env defaults: maxSpawnsPerHour=100, but workspace override says 1
    await withEnv({ SUBAGENT_HITL_SPAWN_THRESHOLD: "0" }, async () => {
      const ws = "override-ws";
      recordSubagentSpawn(ws);

      const result = await checkSubagentQuota({
        workspace: ws,
        userId: "u1",
        depth: 0,
        workspaceQuotaOverrides: { maxSpawnsPerHour: 1 },
      });
      assert.equal(result.allowed, false);
      assert.equal(result.code, "SUBAGENT_QUOTA_EXHAUSTED");
    });
  });

  it("workspace override for depth takes precedence over env", async () => {
    await withEnv({ SUBAGENT_MAX_DEPTH: "10" }, async () => {
      const result = await checkSubagentQuota({
        workspace: "override-ws",
        userId: "u1",
        depth: 2,
        workspaceQuotaOverrides: { maxDepth: 2 },
      });
      assert.equal(result.allowed, false);
      assert.equal(result.code, "SUBAGENT_DEPTH_EXCEEDED");
    });
  });

  // ---- 12. HITL cost gate disabled when threshold is 0 ----
  it("skips HITL cost gate when threshold is 0", async () => {
    await withEnv({ SUBAGENT_HITL_COST_THRESHOLD_USD: "0" }, async () => {
      const result = await checkSubagentQuota({
        workspace: "no-hitl-ws",
        userId: "u1",
        depth: 0,
        estimatedCostUsd: 999.99,
      });
      assert.equal(result.allowed, true);
    });
  });

  // ---- 13. HITL spawn gate disabled when threshold is 0 ----
  it("skips HITL spawn gate when threshold is 0", async () => {
    await withEnv({
      SUBAGENT_HITL_SPAWN_THRESHOLD: "0",
      SUBAGENT_MAX_SPAWNS_PER_HOUR: "0",
    }, async () => {
      const ws = "no-hitl-spawn-ws";
      for (let i = 0; i < 50; i++) recordSubagentSpawn(ws);

      const result = await checkSubagentQuota({
        workspace: ws,
        userId: "u1",
        depth: 0,
      });
      assert.equal(result.allowed, true);
    });
  });

  // ---- 14. Depth check fires before rate check ----
  it("depth check takes priority over rate check", async () => {
    await withEnv({
      SUBAGENT_MAX_DEPTH: "1",
      SUBAGENT_MAX_SPAWNS_PER_HOUR: "1",
      SUBAGENT_HITL_SPAWN_THRESHOLD: "0",
    }, async () => {
      const ws = "priority-ws";
      recordSubagentSpawn(ws);

      // Both depth and rate are exceeded; depth should win
      const result = await checkSubagentQuota({
        workspace: ws,
        userId: "u1",
        depth: 1,
      });
      assert.equal(result.code, "SUBAGENT_DEPTH_EXCEEDED");
    });
  });

  // ---- 15. Stats with workspace overrides ----
  it("getSubagentQuotaStats respects workspace overrides", () => {
    const stats = getSubagentQuotaStats("any-ws", { maxSpawnsPerHour: 42, maxDepth: 7 });
    assert.equal(stats.maxPerHour, 42);
    assert.equal(stats.maxDepth, 7);
  });
});
