import test from "node:test";
import assert from "node:assert/strict";

import { createTraceExplorer, normalizeSpan } from "../lib/trace-explorer.js";

/**
 * Build a fake OTel ReadableSpan for tests.
 */
function fakeSpan({
  traceId = "t1",
  spanId = "s1",
  parentSpanId = null,
  name = "op",
  start = 1000,
  end = 1050,
  status = 0, // 0=UNSET, 1=OK, 2=ERROR
  attributes = {},
  service = "siskel-bot",
  events = [],
} = {}) {
  return {
    spanContext: () => ({ traceId, spanId }),
    parentSpanId,
    name,
    // hrTime tuples: [seconds, nanos]
    startTime: [Math.floor(start / 1000), (start % 1000) * 1e6],
    endTime: [Math.floor(end / 1000), (end % 1000) * 1e6],
    status: { code: status },
    attributes,
    events,
    resource: { attributes: { "service.name": service } },
  };
}

await test("normalizeSpan converts an OTel ReadableSpan", () => {
  const s = normalizeSpan(
    fakeSpan({ start: 1500, end: 1800, status: 2, attributes: { foo: "bar" } })
  );
  assert.ok(s);
  assert.equal(s.traceId, "t1");
  assert.equal(s.spanId, "s1");
  assert.equal(s.name, "op");
  assert.equal(s.status, "error");
  assert.equal(s.startTime, 1500);
  assert.equal(s.endTime, 1800);
  assert.equal(s.duration, 300);
  assert.equal(s.attributes.foo, "bar");
  assert.equal(s.service, "siskel-bot");
});

await test("normalizeSpan handles plain object input", () => {
  const s = normalizeSpan({
    traceId: "t",
    spanId: "x",
    parentSpanId: "p",
    name: "plain",
    startTime: 10,
    endTime: 50,
    status: "ok",
  });
  assert.ok(s);
  assert.equal(s.duration, 40);
  assert.equal(s.status, "ok");
});

await test("normalizeSpan rejects garbage", () => {
  assert.equal(normalizeSpan(null), null);
  assert.equal(normalizeSpan({}), null);
  assert.equal(normalizeSpan({ foo: "bar" }), null);
});

await test("recordSpan + getTrace returns spans sorted by startTime", () => {
  const ex = createTraceExplorer();
  ex.recordSpan(fakeSpan({ traceId: "t", spanId: "a", start: 2000, end: 2100 }));
  ex.recordSpan(fakeSpan({ traceId: "t", spanId: "b", start: 1000, end: 1100 }));
  ex.recordSpan(fakeSpan({ traceId: "t", spanId: "c", start: 1500, end: 1600 }));

  const spans = ex.getTrace("t");
  assert.equal(spans.length, 3);
  assert.deepEqual(
    spans.map((s) => s.spanId),
    ["b", "c", "a"]
  );
  assert.equal(ex.getTrace("missing"), null);
});

await test("listTraces returns recent traces with filtering", () => {
  const ex = createTraceExplorer();
  ex.recordSpan(
    fakeSpan({ traceId: "t1", spanId: "r1", name: "GET /foo", start: 1000, end: 1100 })
  );
  ex.recordSpan(
    fakeSpan({
      traceId: "t2",
      spanId: "r2",
      name: "POST /bar",
      start: 2000,
      end: 2500,
      status: 2,
    })
  );
  ex.recordSpan(
    fakeSpan({
      traceId: "t3",
      spanId: "r3",
      name: "agent.loop",
      start: 3000,
      end: 3050,
      service: "worker",
    })
  );

  const all = ex.listTraces();
  assert.equal(all.length, 3);
  // Newest (last-inserted) first
  assert.equal(all[0].traceId, "t3");

  const errors = ex.listTraces({ status: "error" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].traceId, "t2");

  const byName = ex.listTraces({ name: "foo" });
  assert.equal(byName.length, 1);
  assert.equal(byName[0].traceId, "t1");

  const byService = ex.listTraces({ service: "worker" });
  assert.equal(byService.length, 1);
  assert.equal(byService[0].traceId, "t3");

  const byMin = ex.listTraces({ minDuration: 200 });
  assert.equal(byMin.length, 1);
  assert.equal(byMin[0].traceId, "t2");

  const limited = ex.listTraces({ limit: 2 });
  assert.equal(limited.length, 2);
});

await test("listTraces marks a trace as error if any span errored", () => {
  const ex = createTraceExplorer();
  ex.recordSpan(
    fakeSpan({ traceId: "tX", spanId: "root", start: 100, end: 500, status: 1 })
  );
  ex.recordSpan(
    fakeSpan({
      traceId: "tX",
      spanId: "child",
      parentSpanId: "root",
      start: 200,
      end: 400,
      status: 2,
    })
  );
  const [trace] = ex.listTraces();
  assert.equal(trace.status, "error");
  assert.equal(trace.spanCount, 2);
});

await test("getTraceTree builds parent/child structure", () => {
  const ex = createTraceExplorer();
  ex.recordSpan(fakeSpan({ traceId: "t", spanId: "root", start: 0, end: 1000 }));
  ex.recordSpan(
    fakeSpan({
      traceId: "t",
      spanId: "a",
      parentSpanId: "root",
      start: 100,
      end: 400,
    })
  );
  ex.recordSpan(
    fakeSpan({
      traceId: "t",
      spanId: "b",
      parentSpanId: "root",
      start: 500,
      end: 900,
    })
  );
  ex.recordSpan(
    fakeSpan({
      traceId: "t",
      spanId: "a1",
      parentSpanId: "a",
      start: 150,
      end: 300,
    })
  );

  const tree = ex.getTraceTree("t");
  assert.ok(tree);
  assert.equal(tree.spanCount, 4);
  assert.equal(tree.roots.length, 1);
  const root = tree.roots[0];
  assert.equal(root.spanId, "root");
  assert.equal(root.children.length, 2);
  const a = root.children.find((c) => c.spanId === "a");
  assert.ok(a);
  assert.equal(a.children.length, 1);
  assert.equal(a.children[0].spanId, "a1");

  assert.equal(ex.getTraceTree("nope"), null);
});

await test("getTraceTree treats orphan spans as extra roots", () => {
  const ex = createTraceExplorer();
  ex.recordSpan(
    fakeSpan({
      traceId: "t",
      spanId: "orphan",
      parentSpanId: "gone",
      start: 10,
      end: 20,
    })
  );
  const tree = ex.getTraceTree("t");
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].spanId, "orphan");
});

await test("getStats aggregates counters correctly", () => {
  const ex = createTraceExplorer();
  ex.recordSpan(fakeSpan({ traceId: "t1", spanId: "s1", status: 1 }));
  ex.recordSpan(fakeSpan({ traceId: "t1", spanId: "s2", status: 2 }));
  ex.recordSpan(
    fakeSpan({ traceId: "t2", spanId: "s3", status: 1, service: "worker" })
  );

  const stats = ex.getStats();
  assert.equal(stats.totalTraces, 2);
  assert.equal(stats.totalSpans, 3);
  assert.equal(stats.byStatus.ok, 2);
  assert.equal(stats.byStatus.error, 1);
  assert.equal(stats.byService["siskel-bot"], 2);
  assert.equal(stats.byService["worker"], 1);
});

await test("prune removes traces older than retentionMs", () => {
  const ex = createTraceExplorer({ retentionMs: 1000 });
  ex.recordSpan(fakeSpan({ traceId: "old", spanId: "a", start: 0, end: 100 }));
  ex.recordSpan(fakeSpan({ traceId: "new", spanId: "b", start: 5000, end: 5100 }));

  // Prune relative to 6000ms "now" — "old" (lastSeen=100) is older than 6000-1000=5000.
  const removed = ex.prune(6000);
  assert.equal(removed, 1);
  assert.equal(ex.getTrace("old"), null);
  assert.ok(ex.getTrace("new"));
});

await test("prune is a no-op when nothing is stale", () => {
  const ex = createTraceExplorer({ retentionMs: 10_000 });
  ex.recordSpan(fakeSpan({ traceId: "t", spanId: "s", start: 1000, end: 1100 }));
  const removed = ex.prune(1200);
  assert.equal(removed, 0);
  assert.equal(ex.size(), 1);
});

await test("maxTraces evicts oldest traces when capacity is exceeded", () => {
  const ex = createTraceExplorer({ maxTraces: 2 });
  ex.recordSpan(fakeSpan({ traceId: "t1", spanId: "a" }));
  ex.recordSpan(fakeSpan({ traceId: "t2", spanId: "b" }));
  ex.recordSpan(fakeSpan({ traceId: "t3", spanId: "c" }));

  assert.equal(ex.size(), 2);
  assert.equal(ex.getTrace("t1"), null);
  assert.ok(ex.getTrace("t2"));
  assert.ok(ex.getTrace("t3"));
});

await test("recording a new span on an existing trace keeps it from being evicted", () => {
  const ex = createTraceExplorer({ maxTraces: 2 });
  ex.recordSpan(fakeSpan({ traceId: "t1", spanId: "a" }));
  ex.recordSpan(fakeSpan({ traceId: "t2", spanId: "b" }));
  // Touch t1 so t2 is now the oldest
  ex.recordSpan(fakeSpan({ traceId: "t1", spanId: "a2" }));
  ex.recordSpan(fakeSpan({ traceId: "t3", spanId: "c" }));

  assert.ok(ex.getTrace("t1"));
  assert.equal(ex.getTrace("t2"), null);
  assert.ok(ex.getTrace("t3"));
});

await test("clear() empties the buffer", () => {
  const ex = createTraceExplorer();
  ex.recordSpan(fakeSpan({ traceId: "t", spanId: "s" }));
  assert.equal(ex.size(), 1);
  ex.clear();
  assert.equal(ex.size(), 0);
  assert.equal(ex.getTrace("t"), null);
});
