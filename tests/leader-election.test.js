/**
 * Phase 45: Leader election tests.
 * Tests lock acquisition, release, TTL expiration, and leadership change callbacks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-leader-"));

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("LeaderElection - acquire and release leadership", async () => {
  const { LeaderElection } = await import("../lib/leader-election.js");
  const le = new LeaderElection({ lockDir: tempDir, instanceId: "test-1", ttlMs: 5000 });

  const acquired = await le.acquire();
  assert.equal(acquired, true, "should acquire leadership");

  const isLeader = await le.isLeader();
  assert.equal(isLeader, true, "should be leader after acquire");

  await le.release();
  const afterRelease = await le.isLeader();
  assert.equal(afterRelease, false, "should not be leader after release");

  le.destroy();
});

test("LeaderElection - second instance cannot acquire while first holds lock", async () => {
  const { LeaderElection } = await import("../lib/leader-election.js");
  const le1 = new LeaderElection({ lockDir: tempDir, instanceId: "inst-a", ttlMs: 5000 });
  const le2 = new LeaderElection({ lockDir: tempDir, instanceId: "inst-b", ttlMs: 5000 });

  await le1.acquire();
  const result = await le2.acquire();
  assert.equal(result, false, "second instance should not acquire lock");

  const le2Leader = await le2.isLeader();
  assert.equal(le2Leader, false);

  await le1.release();
  le1.destroy();
  le2.destroy();
});

test("LeaderElection - TTL expiration allows takeover", async () => {
  const { LeaderElection } = await import("../lib/leader-election.js");
  // Use very short TTL for testing
  const le1 = new LeaderElection({ lockDir: tempDir, instanceId: "ttl-a", ttlMs: 50 });
  const le2 = new LeaderElection({ lockDir: tempDir, instanceId: "ttl-b", ttlMs: 5000 });

  await le1.acquire();
  le1._stopRenewal(); // Stop renewal so the lock expires

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, 100));

  const acquired = await le2.acquire();
  assert.equal(acquired, true, "should acquire after TTL expiration");

  const le2Leader = await le2.isLeader();
  assert.equal(le2Leader, true);

  await le2.release();
  le1.destroy();
  le2.destroy();
});

test("LeaderElection - onLeaderChange callback fires", async () => {
  const { LeaderElection } = await import("../lib/leader-election.js");
  const le = new LeaderElection({ lockDir: tempDir, instanceId: "cb-test", ttlMs: 5000 });

  const events = [];
  le.onLeaderChange((isLeader) => events.push(isLeader));

  await le.acquire();
  assert.equal(events.length, 1);
  assert.equal(events[0], true);

  await le.release();
  assert.equal(events.length, 2);
  assert.equal(events[1], false);

  le.destroy();
});

test("LeaderElection - getLeader returns lock info", async () => {
  const { LeaderElection } = await import("../lib/leader-election.js");
  const le = new LeaderElection({ lockDir: tempDir, instanceId: "info-test", ttlMs: 5000 });

  await le.getLeader();
  // Could be null or stale from previous tests - just check type
  await le.acquire();

  const leader = await le.getLeader();
  assert.ok(leader, "getLeader should return info after acquire");
  assert.equal(leader.instanceId, "info-test");
  assert.ok(leader.acquiredAt);
  assert.ok(leader.expiresAt);

  await le.release();
  le.destroy();
});

test("LeaderElection - same instance can re-acquire", async () => {
  const { LeaderElection } = await import("../lib/leader-election.js");
  const le = new LeaderElection({ lockDir: tempDir, instanceId: "reacquire", ttlMs: 5000 });

  await le.acquire();
  const again = await le.acquire();
  assert.equal(again, true, "same instance should re-acquire");

  await le.release();
  le.destroy();
});
