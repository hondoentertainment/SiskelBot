/**
 * Backpressure tests for lib/realtime-channels.js (wave 2).
 *
 * Confirms that per-subscriber microtask-queued dispatch does not stall
 * the publisher on slow subscribers, that the drop-oldest policy
 * behaves correctly when a queue overflows, that hooks fire with the
 * expected shape, and that per-channel observability counters are
 * wired into stats().
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createChannelRegistry } from "../lib/realtime-channels.js";

async function flush() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("slow subscriber does not block the publisher", async () => {
  const reg = createChannelRegistry();
  const received = [];
  let publisherReturnedAt = 0;
  let firstHandledAt = 0;

  reg.subscribe("slow:1", "c1", (ev) => {
    // Simulate a slow consumer by scheduling the real work behind a
    // setTimeout. Even though this callback returns quickly, the
    // "handled" point is conceptually after the setTimeout fires.
    setTimeout(() => {
      if (firstHandledAt === 0) firstHandledAt = performance.now();
      received.push(ev);
    }, 20);
  });

  const t0 = performance.now();
  for (let i = 0; i < 5; i++) {
    reg.publish("slow:1", { n: i });
  }
  publisherReturnedAt = performance.now();

  // Publisher must return before any setTimeout-delayed handler fires.
  assert.ok(
    publisherReturnedAt - t0 < 20,
    `publisher took ${publisherReturnedAt - t0}ms; expected < 20ms`,
  );

  await wait(80);
  assert.equal(received.length, 5);
  assert.ok(firstHandledAt > publisherReturnedAt);
});

test("queue overflow drops oldest events; subscriber receives last N in order", async () => {
  const reg = createChannelRegistry();
  // Gate the subscriber behind a deferred promise so events pile up in
  // its queue before any of them get drained. This lets us observe the
  // drop-oldest policy deterministically.
  const gate = new Promise((resolve) => setTimeout(resolve, 30));
  const received = [];
  reg.subscribe(
    "bp:overflow",
    "c1",
    async (ev) => {
      await gate;
      received.push(ev);
    },
    { queueCapacity: 256 },
  );

  for (let i = 1; i <= 300; i++) {
    reg.publish("bp:overflow", { n: i });
  }

  // The 300 events went through the queue before the subscriber ran its
  // first callback; 44 oldest should have been dropped. Events 45..300
  // remain.
  await wait(80);

  assert.equal(received.length, 256);
  assert.equal(received[0].payload.n, 45);
  assert.equal(received[received.length - 1].payload.n, 300);
  // Strict in-order delivery of the surviving window.
  for (let i = 1; i < received.length; i++) {
    assert.equal(
      received[i].payload.n,
      received[i - 1].payload.n + 1,
      `out-of-order at index ${i}: ${received[i - 1].payload.n} -> ${received[i].payload.n}`,
    );
  }

  const s = reg.stats();
  assert.equal(s.perChannel["bp:overflow"].totalDropped, 44);
});

test("onSlowSubscriber hook fires with channel, clientId, droppedCount", async () => {
  const reg = createChannelRegistry();
  const warnings = [];
  reg.setSlowSubscriberHook((info) => warnings.push(info));

  // Never-resolving gate: the subscriber callback is still pending when
  // we overflow its queue, forcing drops.
  const gate = new Promise(() => {});
  reg.subscribe(
    "bp:hook",
    "clientX",
    async () => {
      await gate;
    },
    { queueCapacity: 4 },
  );

  for (let i = 0; i < 6; i++) {
    reg.publish("bp:hook", { n: i });
  }
  await flush();
  await wait(10);

  // Capacity 4, 6 publishes -> 2 oldest dropped. First drop always
  // emits a warning.
  assert.ok(warnings.length >= 1, `expected >=1 warning, got ${warnings.length}`);
  const first = warnings[0];
  assert.equal(first.channel, "bp:hook");
  assert.equal(first.clientId, "clientX");
  assert.equal(typeof first.droppedCount, "number");
  assert.ok(first.droppedCount >= 1);
});

test("onSubscriberError fires when subscriber throws; peers still receive", async () => {
  const reg = createChannelRegistry();
  const errors = [];
  reg.setSubscriberErrorHook((channel, clientId, err) => {
    errors.push({ channel, clientId, message: err?.message });
  });

  const good = [];
  reg.subscribe("err:1", "bad", () => {
    throw new Error("kaboom");
  });
  reg.subscribe("err:1", "good", (ev) => good.push(ev));

  reg.publish("err:1", { ok: true });
  reg.publish("err:1", { ok: true });
  await flush();

  assert.equal(errors.length, 2);
  assert.equal(errors[0].channel, "err:1");
  assert.equal(errors[0].clientId, "bad");
  assert.equal(errors[0].message, "kaboom");
  assert.equal(good.length, 2);
});

test("fast subscriber is not held back by a slow peer", async () => {
  const reg = createChannelRegistry();
  const fast = [];
  const slow = [];

  reg.subscribe("mix:1", "fast", (ev) => {
    fast.push({ n: ev.payload.n, at: performance.now() });
  });
  // Slow subscriber does heavy (async) work per event.
  reg.subscribe("mix:1", "slow", async (ev) => {
    await wait(15);
    slow.push({ n: ev.payload.n, at: performance.now() });
  });

  const t0 = performance.now();
  for (let i = 0; i < 5; i++) {
    reg.publish("mix:1", { n: i });
  }
  // After a short pause the fast subscriber should have received
  // everything, even though the slow one is far behind.
  await flush();
  await wait(5);

  assert.equal(fast.length, 5);
  assert.deepEqual(fast.map((x) => x.n), [0, 1, 2, 3, 4]);
  // Fast deliveries all happened well before the slow subscriber would
  // have caught up (5 * 15ms = 75ms minimum for the slow chain).
  for (const f of fast) {
    assert.ok(
      f.at - t0 < 50,
      `fast handler took ${(f.at - t0).toFixed(1)}ms; expected < 50ms`,
    );
  }

  // Give the slow subscriber time to drain so we don't leak timers.
  await wait(120);
  assert.equal(slow.length, 5);
  assert.deepEqual(slow.map((x) => x.n), [0, 1, 2, 3, 4]);
});

test("stats() reports perChannel subscribers, totalDropped, maxQueueDepth", async () => {
  const reg = createChannelRegistry();

  // Sub A overflows its queue.
  const gate = new Promise(() => {});
  reg.subscribe(
    "ch:a",
    "subA",
    async () => {
      await gate;
    },
    { queueCapacity: 3 },
  );
  // Sub B on a different channel, not overflowing.
  reg.subscribe("ch:b", "subB", () => {}, { queueCapacity: 10 });

  for (let i = 0; i < 7; i++) reg.publish("ch:a", { i });
  for (let i = 0; i < 2; i++) reg.publish("ch:b", { i });
  await flush();
  await wait(5);

  const s = reg.stats();
  // Legacy fields preserved.
  assert.equal(typeof s.channels, "number");
  assert.equal(typeof s.subscribers, "number");
  assert.ok(s.channels >= 2);
  assert.ok(s.subscribers >= 2);

  // Per-channel observability.
  assert.equal(s.perChannel["ch:a"].subscribers, 1);
  assert.equal(s.perChannel["ch:a"].totalDropped, 4); // 7 published, cap 3 -> 4 dropped
  assert.ok(s.perChannel["ch:a"].maxQueueDepth >= 3);

  assert.equal(s.perChannel["ch:b"].subscribers, 1);
  assert.equal(s.perChannel["ch:b"].totalDropped, 0);
  assert.ok(s.perChannel["ch:b"].maxQueueDepth <= 2);
});

test("setSubscriberQueueCapacity changes the default for new subscribers", async () => {
  const reg = createChannelRegistry();
  reg.setSubscriberQueueCapacity(2);

  const gate = new Promise(() => {});
  reg.subscribe("cap:1", "c1", async () => {
    await gate;
  });

  for (let i = 0; i < 5; i++) reg.publish("cap:1", { i });
  await flush();
  await wait(5);

  const s = reg.stats();
  // capacity 2, 5 publishes -> 3 dropped.
  assert.equal(s.perChannel["cap:1"].totalDropped, 3);
});

test("sinceSeq replay also flows through the per-subscriber queue", async () => {
  const reg = createChannelRegistry();
  reg.publish("replay:1", { n: 1 });
  reg.publish("replay:1", { n: 2 });
  reg.publish("replay:1", { n: 3 });

  const received = [];
  const { replayed } = reg.subscribe(
    "replay:1",
    "c1",
    (ev) => received.push(ev.payload.n),
    { sinceSeq: 0 },
  );
  assert.equal(replayed, 3);
  // Synchronously nothing should have been delivered yet — replay goes
  // through the same microtask drain as live events.
  assert.equal(received.length, 0);
  // New event racing the backlog replay still lands in FIFO order.
  reg.publish("replay:1", { n: 4 });
  await flush();
  assert.deepEqual(received, [1, 2, 3, 4]);
});
