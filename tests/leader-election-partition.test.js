/**
 * Leader-election under simulated storage partition.
 *
 * Drives two instances against an in-memory KV store whose read/write can
 * be flipped to "partitioned" (throws). Asserts:
 *   - exactly one acquires leadership initially
 *   - when storage partitions, the leader's lock cannot be renewed
 *   - after TTL expiry, the runner-up can take over
 *   - when storage heals, the original leader detects loss correctly
 */
import test from "node:test";
import assert from "node:assert/strict";

const { LeaderElection } = await import("../lib/leader-election.js");

class FakeKv {
  constructor() {
    this.store = new Map();
    this.partitioned = false;
  }
  partition() {
    this.partitioned = true;
  }
  heal() {
    this.partitioned = false;
  }
  load = async (key) => {
    if (this.partitioned) throw new Error("partition: read failed");
    return this.store.get(key) ?? null;
  };
  save = async (key, value) => {
    if (this.partitioned) throw new Error("partition: write failed");
    if (value === null) this.store.delete(key);
    else this.store.set(key, value);
  };
}

function makeElection(kv, instanceId, ttlMs = 200) {
  return new LeaderElection({
    instanceId,
    ttlMs,
    usePostgres: true,
    postgresKvLoad: kv.load,
    postgresKvSave: kv.save,
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("exactly one instance wins initial leadership", async () => {
  const kv = new FakeKv();
  const a = makeElection(kv, "node-a");
  const b = makeElection(kv, "node-b");
  try {
    const aOk = await a.acquire();
    const bOk = await b.acquire();
    assert.equal(aOk, true);
    assert.equal(bOk, false);
    assert.equal(await a.isLeader(), true);
    assert.equal(await b.isLeader(), false);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("leader cannot durably renew across a partition; runner-up takes over after TTL", async () => {
  // Documents current behavior: acquire/save errors are swallowed by
  // leader-election. During partition the leader believes it still
  // holds the lock, but the lock is not actually persisted, so once the
  // partition heals and the original lock expires, a runner-up wins.
  const kv = new FakeKv();
  const a = makeElection(kv, "node-a", 100);
  const b = makeElection(kv, "node-b", 100);
  try {
    assert.equal(await a.acquire(), true);
    assert.equal(await b.acquire(), false);

    kv.partition();
    // During partition acquire() does not throw — errors are swallowed
    // by the underlying _writeLock. The kv map is unchanged.
    await a.acquire();
    kv.heal();

    await wait(150);

    const bTookOver = await b.acquire();
    assert.equal(bTookOver, true);
    assert.equal(await b.isLeader(), true);
    assert.equal(await a.isLeader(), false);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test("a partitioned read returns null leader so getLeader does not lie", async () => {
  const kv = new FakeKv();
  const a = makeElection(kv, "node-a", 500);
  try {
    await a.acquire();
    kv.partition();
    const leader = await a.getLeader();
    assert.equal(leader, null);
    kv.heal();
    const leader2 = await a.getLeader();
    assert.ok(leader2);
    assert.equal(leader2.instanceId, "node-a");
  } finally {
    a.destroy();
  }
});

test("after the leader's lock expires, isLeader reports false promptly", async () => {
  const kv = new FakeKv();
  const a = makeElection(kv, "node-a", 100);
  try {
    await a.acquire();
    kv.partition();
    await wait(150);
    kv.heal();
    assert.equal(await a.isLeader(), false);
  } finally {
    a.destroy();
  }
});
