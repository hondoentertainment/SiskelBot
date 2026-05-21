// CHAOS TEST: leader lock TTL expiry simulates partition — standby takes over, stale leader loses authority.
// Run with: npm run test:chaos
import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "siskel-leader-partition-"));

describe("CHAOS: leader-election partition (TTL takeover)", () => {
  it(
    "standby acquires after TTL expiry; stale leader isLeader() becomes false",
    { timeout: 15_000 },
    async () => {
      const { LeaderElection } = await import("../../lib/leader-election.js");
      const ttlMs = 250;

      const leaderA = new LeaderElection({ lockDir: tempDir, instanceId: "region-a", ttlMs });
      const leaderB = new LeaderElection({ lockDir: tempDir, instanceId: "region-b", ttlMs });

      const acquiredA = await leaderA.acquire();
      assert.equal(acquiredA, true);

      const blockedB = await leaderB.acquire();
      assert.equal(blockedB, false, "standby must not steal active lock");

      // Partition: A stops renewing but does not release (simulates isolated leader).
      leaderA.destroy();

      await new Promise((r) => setTimeout(r, ttlMs + 100));

      const acquiredB = await leaderB.acquire();
      assert.equal(acquiredB, true, "standby should take over after TTL");

      const current = await leaderB.getLeader();
      assert.equal(current?.instanceId, "region-b");

      // Stale A checks leadership after partition heals — must not be leader.
      const leaderA2 = new LeaderElection({ lockDir: tempDir, instanceId: "region-a", ttlMs });
      assert.equal(await leaderA2.isLeader(), false);
      assert.equal(await leaderA2.acquire(), false, "A cannot re-acquire while B holds lock");

      await leaderB.release();
      leaderB.destroy();
      leaderA2.destroy();
    },
  );

  it(
    "sequential acquire after expiry: first wins, second blocked (no dual leadership)",
    { timeout: 15_000 },
    async () => {
      const { LeaderElection } = await import("../../lib/leader-election.js");
      const ttlMs = 200;

      const first = new LeaderElection({ lockDir: tempDir, instanceId: "first", ttlMs });
      await first.acquire();
      first.destroy();

      await new Promise((r) => setTimeout(r, ttlMs + 50));

      const a = new LeaderElection({ lockDir: tempDir, instanceId: "contender-a", ttlMs });
      const b = new LeaderElection({ lockDir: tempDir, instanceId: "contender-b", ttlMs });

      const aWon = await a.acquire();
      assert.equal(aWon, true);
      const bBlocked = await b.acquire();
      assert.equal(bBlocked, false, "second acquire must fail while lock is valid");

      assert.equal(await a.isLeader(), true);
      assert.equal(await b.isLeader(), false);

      await a.release();
      a.destroy();
      b.destroy();
    },
  );
});

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});
