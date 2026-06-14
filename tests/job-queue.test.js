import test from "node:test";
import assert from "node:assert/strict";
import { createJobQueue } from "../lib/job-queue.js";

// --- add / process / stats ---

test("job-queue: process jobs and track stats", async () => {
  const q = createJobQueue({ concurrency: 2, name: "test-basic" });
  const results = [];

  q.process(async (job) => {
    results.push(job.payload);
    return job.payload * 2;
  });

  const r1 = await q.add({ type: "double", payload: 5 });
  const r2 = await q.add({ type: "double", payload: 10 });

  assert.equal(r1, 10);
  assert.equal(r2, 20);
  assert.deepEqual(results, [5, 10]);

  const stats = q.getStats();
  assert.equal(stats.completed, 2);
  assert.equal(stats.failed, 0);
  assert.equal(stats.pending, 0);
  assert.equal(stats.active, 0);
  assert.ok(stats.avgDuration >= 0);
});

test("job-queue: custom job id is preserved", async () => {
  const q = createJobQueue({ concurrency: 1, name: "test-id" });
  let receivedId;

  q.process(async (job) => {
    receivedId = job.id;
  });

  await q.add({ id: "my-custom-id", type: "test", payload: null });
  assert.equal(receivedId, "my-custom-id");
});

test("job-queue: auto-generates job id when not provided", async () => {
  const q = createJobQueue({ concurrency: 1, name: "test-autoid" });
  let receivedId;

  q.process(async (job) => {
    receivedId = job.id;
  });

  await q.add({ type: "test", payload: null });
  assert.ok(typeof receivedId === "string");
  assert.ok(receivedId.length > 0);
});

// --- concurrency ---

test("job-queue: respects concurrency limit", async () => {
  const q = createJobQueue({ concurrency: 2, name: "test-conc" });
  let maxConcurrent = 0;
  let current = 0;

  q.process(async (job) => {
    current++;
    if (current > maxConcurrent) maxConcurrent = current;
    await new Promise((r) => setTimeout(r, 50));
    current--;
    return job.payload;
  });

  const promises = [];
  for (let i = 0; i < 6; i++) {
    promises.push(q.add({ type: "work", payload: i }));
  }
  await Promise.all(promises);

  assert.ok(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected <= 2`);
  assert.equal(q.getStats().completed, 6);
});

// --- priority ---

test("job-queue: higher priority jobs are processed first", async () => {
  const q = createJobQueue({ concurrency: 1, name: "test-priority" });
  const order = [];

  // Do not register handler yet so jobs queue up
  const p1 = q.add({ type: "low", payload: "low", priority: 1 });
  const p2 = q.add({ type: "high", payload: "high", priority: 10 });
  const p3 = q.add({ type: "med", payload: "med", priority: 5 });

  // Now register handler -- jobs should process in priority order
  q.process(async (job) => {
    order.push(job.payload);
    return job.payload;
  });

  await Promise.all([p1, p2, p3]);

  // High (10) should come first, then med (5), then low (1)
  assert.equal(order[0], "high");
  assert.equal(order[1], "med");
  assert.equal(order[2], "low");
});

// --- backpressure ---

test("job-queue: backpressure blocks add when queue is full", async () => {
  const q = createJobQueue({ concurrency: 1, maxSize: 2, name: "test-bp" });
  const processed = [];
  let resolveBlock;
  const blockPromise = new Promise((r) => { resolveBlock = r; });

  q.process(async (job) => {
    if (job.payload === "blocker") {
      await blockPromise;
    }
    processed.push(job.payload);
    return job.payload;
  });

  // First job will block the processor
  const j1 = q.add({ type: "t", payload: "blocker" });

  // Give it a tick to start processing
  await new Promise((r) => setTimeout(r, 10));

  // These two fill the maxSize=2 pending slots
  const j2 = q.add({ type: "t", payload: "a" });
  const j3 = q.add({ type: "t", payload: "b" });

  // This one should be blocked by backpressure
  let fourthAdded = false;
  const j4Promise = q.add({ type: "t", payload: "c" }).then((r) => {
    fourthAdded = true;
    return r;
  });

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fourthAdded, false, "Fourth job should be blocked by backpressure");

  // Unblock the processor
  resolveBlock();

  await Promise.all([j1, j2, j3, j4Promise]);
  assert.equal(fourthAdded, true);
  assert.equal(q.getStats().completed, 4);
});

// --- retry with exponential backoff ---

test("job-queue: retries failed jobs before dead-lettering", async () => {
  const q = createJobQueue({ concurrency: 1, retries: 3, name: "test-retry", timeout: 5000 });
  let attempts = 0;

  q.process(async () => {
    attempts++;
    if (attempts < 3) {
      throw new Error("transient failure");
    }
    return "success";
  });

  const result = await q.add({ type: "flaky", payload: "data" });
  assert.equal(result, "success");
  assert.equal(attempts, 3);
  assert.equal(q.getStats().completed, 1);
  assert.equal(q.getStats().failed, 0);
  assert.equal(q.getDLQ().length, 0);
});

test("job-queue: dead-letters after max retries exhausted", async () => {
  const q = createJobQueue({ concurrency: 1, retries: 2, name: "test-dlq", timeout: 5000 });

  q.process(async () => {
    throw new Error("permanent failure");
  });

  await assert.rejects(
    () => q.add({ type: "fail", payload: "bad" }),
    { message: "permanent failure" }
  );

  assert.equal(q.getStats().failed, 1);
  const dlq = q.getDLQ();
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0].error, "permanent failure");
  assert.equal(dlq[0].attempts, 2);
  assert.ok(dlq[0].failedAt);
});

test("job-queue: clearDLQ empties dead-letter queue", async () => {
  const q = createJobQueue({ concurrency: 1, retries: 1, name: "test-clear-dlq", timeout: 5000 });

  q.process(async () => { throw new Error("fail"); });

  await assert.rejects(() => q.add({ type: "f", payload: 1 }));
  assert.equal(q.getDLQ().length, 1);

  q.clearDLQ();
  assert.equal(q.getDLQ().length, 0);
});

// --- timeout ---

test("job-queue: times out slow jobs", async () => {
  const q = createJobQueue({ concurrency: 1, retries: 1, timeout: 50, name: "test-timeout" });

  q.process(async () => {
    await new Promise((r) => setTimeout(r, 200));
    return "too late";
  });

  await assert.rejects(
    () => q.add({ type: "slow", payload: null }),
    (err) => {
      assert.ok(err.message.includes("timed out"));
      return true;
    }
  );
});

// --- pause / resume ---

test("job-queue: pause stops processing, resume restarts", async () => {
  const q = createJobQueue({ concurrency: 1, name: "test-pause" });
  const processed = [];

  q.process(async (job) => {
    processed.push(job.payload);
    return job.payload;
  });

  await q.add({ type: "t", payload: 1 });
  assert.deepEqual(processed, [1]);

  q.pause();
  assert.equal(q.paused, true);

  // Queue a job while paused -- it should not process immediately
  const p2 = q.add({ type: "t", payload: 2 });

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(processed, [1], "Should not have processed while paused");

  q.resume();
  await p2;
  assert.deepEqual(processed, [1, 2]);
});

// --- drain ---

test("job-queue: drain resolves when all jobs complete", async () => {
  const q = createJobQueue({ concurrency: 2, name: "test-drain" });

  q.process(async (job) => {
    await new Promise((r) => setTimeout(r, 30));
    return job.payload;
  });

  // Add jobs without awaiting
  q.add({ type: "t", payload: 1 });
  q.add({ type: "t", payload: 2 });
  q.add({ type: "t", payload: 3 });

  await q.drain();

  const stats = q.getStats();
  assert.equal(stats.completed, 3);
  assert.equal(stats.pending, 0);
  assert.equal(stats.active, 0);
});

test("job-queue: drain resolves immediately when queue is empty", async () => {
  const q = createJobQueue({ concurrency: 1, name: "test-drain-empty" });
  q.process(async () => {});
  await q.drain();
  // Should not hang
  assert.ok(true);
});

// --- shutdown ---

test("job-queue: shutdown rejects pending jobs and waits for active", async () => {
  const q = createJobQueue({ concurrency: 1, name: "test-shutdown" });
  let resolveActive;
  const activeBlock = new Promise((r) => { resolveActive = r; });

  q.process(async (job) => {
    if (job.payload === "active") {
      await activeBlock;
    }
    return job.payload;
  });

  // Start an active job
  const pActive = q.add({ type: "t", payload: "active" });

  // Give it a tick to start
  await new Promise((r) => setTimeout(r, 10));

  // Add a pending job
  const pPending = q.add({ type: "t", payload: "pending" });

  // Shutdown should reject the pending job
  const shutdownPromise = q.shutdown();

  await assert.rejects(
    () => pPending,
    (err) => {
      assert.ok(err.message.includes("shut down"));
      return true;
    }
  );

  // Finish the active job
  resolveActive();
  await pActive;
  await shutdownPromise;
});

test("job-queue: add rejects after shutdown", async () => {
  const q = createJobQueue({ concurrency: 1, name: "test-shutdown-add" });
  q.process(async () => {});
  await q.shutdown();

  await assert.rejects(
    () => q.add({ type: "t", payload: "late" }),
    (err) => {
      assert.ok(err.message.includes("shutting down"));
      return true;
    }
  );
});

// --- process requires function ---

test("job-queue: process rejects non-function handler", () => {
  const q = createJobQueue({ name: "test-handler-type" });
  assert.throws(() => q.process("not a function"), { name: "TypeError" });
});

// --- stats shape ---

test("job-queue: getStats returns correct shape", () => {
  const q = createJobQueue({ name: "test-stats-shape" });
  const stats = q.getStats();
  assert.ok("pending" in stats);
  assert.ok("active" in stats);
  assert.ok("completed" in stats);
  assert.ok("failed" in stats);
  assert.ok("avgDuration" in stats);
  assert.ok("dlqSize" in stats);
  assert.equal(stats.pending, 0);
  assert.equal(stats.active, 0);
  assert.equal(stats.completed, 0);
  assert.equal(stats.failed, 0);
  assert.equal(stats.avgDuration, 0);
  assert.equal(stats.dlqSize, 0);
});

// --- queue name ---

test("job-queue: name property is accessible", () => {
  const q = createJobQueue({ name: "my-queue" });
  assert.equal(q.name, "my-queue");
});
