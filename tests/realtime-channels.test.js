/**
 * Unit tests for lib/realtime-channels.js — publish/subscribe, backlog
 * resume, bounded-backlog eviction, unsubscribe semantics.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createChannelRegistry } from "../lib/realtime-channels.js";

test("publish assigns monotonic seq starting at 1", () => {
  const reg = createChannelRegistry();
  const a = reg.publish("chat:1", { msg: "hello" });
  const b = reg.publish("chat:1", { msg: "world" });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(a.channel, "chat:1");
  assert.equal(typeof a.ts, "number");
});

test("subscribe receives live events", () => {
  const reg = createChannelRegistry();
  const received = [];
  reg.subscribe("run:1", "clientA", (ev) => received.push(ev));
  reg.publish("run:1", { step: 1 });
  reg.publish("run:1", { step: 2 });
  assert.equal(received.length, 2);
  assert.deepEqual(received[0].payload, { step: 1 });
  assert.deepEqual(received[1].payload, { step: 2 });
  assert.equal(received[0].seq, 1);
  assert.equal(received[1].seq, 2);
});

test("subscribe with sinceSeq replays backlog events > sinceSeq", () => {
  const reg = createChannelRegistry();
  reg.publish("chat:x", { n: 1 });
  reg.publish("chat:x", { n: 2 });
  reg.publish("chat:x", { n: 3 });
  const received = [];
  const { replayed } = reg.subscribe("chat:x", "c1", (ev) => received.push(ev), { sinceSeq: 1 });
  assert.equal(replayed, 2);
  assert.deepEqual(received.map((e) => e.payload.n), [2, 3]);
});

test("subscribe with no sinceSeq does not replay backlog", () => {
  const reg = createChannelRegistry();
  reg.publish("chat:x", { n: 1 });
  const received = [];
  reg.subscribe("chat:x", "c1", (ev) => received.push(ev));
  assert.equal(received.length, 0);
  reg.publish("chat:x", { n: 2 });
  assert.equal(received.length, 1);
  assert.equal(received[0].payload.n, 2);
});

test("unsubscribe stops future events from being delivered", () => {
  const reg = createChannelRegistry();
  const received = [];
  reg.subscribe("run:42", "c1", (ev) => received.push(ev));
  reg.publish("run:42", { v: 1 });
  const removed = reg.unsubscribe("run:42", "c1");
  assert.equal(removed, true);
  reg.publish("run:42", { v: 2 });
  assert.equal(received.length, 1);
});

test("unsubscribeAll removes a client from all channels", () => {
  const reg = createChannelRegistry();
  let a = 0, b = 0;
  reg.subscribe("chat:a", "c1", () => a++);
  reg.subscribe("chat:b", "c1", () => b++);
  reg.publish("chat:a", {});
  reg.publish("chat:b", {});
  assert.equal(a, 1);
  assert.equal(b, 1);
  const count = reg.unsubscribeAll("c1");
  assert.equal(count, 2);
  reg.publish("chat:a", {});
  reg.publish("chat:b", {});
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test("bounded backlog evicts oldest events past the cap", () => {
  const reg = createChannelRegistry({ backlogSize: 3 });
  for (let i = 1; i <= 10; i++) {
    reg.publish("chat:z", { n: i });
  }
  const backlog = reg.getBacklog("chat:z");
  assert.equal(backlog.length, 3);
  assert.deepEqual(backlog.map((e) => e.payload.n), [8, 9, 10]);
  assert.deepEqual(backlog.map((e) => e.seq), [8, 9, 10]);
});

test("resume after eviction only replays remaining events", () => {
  const reg = createChannelRegistry({ backlogSize: 2 });
  reg.publish("chat:e", { n: 1 });
  reg.publish("chat:e", { n: 2 });
  reg.publish("chat:e", { n: 3 });
  const received = [];
  const { replayed } = reg.subscribe("chat:e", "c1", (ev) => received.push(ev), { sinceSeq: 0 });
  // Only seq 2,3 remain in the backlog; seq 1 was evicted.
  assert.equal(replayed, 2);
  assert.deepEqual(received.map((e) => e.payload.n), [2, 3]);
});

test("publish fans out to multiple subscribers on the same channel", () => {
  const reg = createChannelRegistry();
  const a = [], b = [];
  reg.subscribe("presence:ws1", "clientA", (ev) => a.push(ev));
  reg.subscribe("presence:ws1", "clientB", (ev) => b.push(ev));
  reg.publish("presence:ws1", { who: "alice" });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.deepEqual(a[0].payload, { who: "alice" });
});

test("one subscriber throwing does not prevent others from receiving", () => {
  const reg = createChannelRegistry();
  const good = [];
  reg.subscribe("chat:t", "bad", () => { throw new Error("boom"); });
  reg.subscribe("chat:t", "good", (ev) => good.push(ev));
  // should not throw
  reg.publish("chat:t", { ok: true });
  assert.equal(good.length, 1);
});

test("setRedisAdapter forwards publishes to adapter.publish", () => {
  const reg = createChannelRegistry();
  const calls = [];
  reg.setRedisAdapter({
    publish: (channel, event) => { calls.push({ channel, event }); },
    subscribe: () => {},
  });
  const ev = reg.publish("chat:r", { x: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, "chat:r");
  assert.equal(calls[0].event.seq, ev.seq);
});

test("stats reports channel and subscriber counts", () => {
  const reg = createChannelRegistry();
  reg.subscribe("a", "c1", () => {});
  reg.subscribe("b", "c1", () => {});
  reg.subscribe("b", "c2", () => {});
  const s = reg.stats();
  assert.equal(s.channels, 2);
  assert.equal(s.subscribers, 3);
});

test("publish validates channelId", () => {
  const reg = createChannelRegistry();
  assert.throws(() => reg.publish("", {}), /channelId/);
  assert.throws(() => reg.publish(null, {}), /channelId/);
});

test("subscribe validates args", () => {
  const reg = createChannelRegistry();
  assert.throws(() => reg.subscribe("", "c", () => {}), /channelId/);
  assert.throws(() => reg.subscribe("x", "", () => {}), /clientId/);
  assert.throws(() => reg.subscribe("x", "c", null), /onEvent/);
});
