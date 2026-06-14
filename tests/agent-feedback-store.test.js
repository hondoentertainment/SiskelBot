/**
 * Unit tests for lib/agent-feedback-store.js.
 * Covers record + validation, list (newest-first, limit, filters),
 * aggregation, ring-buffer capping, workspace isolation, clear.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "agent-feedback-store-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const {
  recordFeedback,
  listFeedback,
  getFeedback,
  clearFeedback,
  aggregateFeedback,
} = await import("../lib/agent-feedback-store.js");

function goodEvent(overrides = {}) {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    userId: "user-1",
    rating: "up",
    score: 5,
    tags: ["helpful"],
    comment: "Great answer",
    agentResponse: "Here is the response.",
    ...overrides,
  };
}

test("recordFeedback happy path assigns id + ts and returns stored event", async () => {
  const ws = `ws-happy-${Date.now()}`;
  const stored = await recordFeedback(ws, goodEvent());
  assert.ok(stored.id, "id should be generated");
  assert.ok(stored.ts > 0, "ts should be set");
  assert.equal(stored.runId, "run-1");
  assert.equal(stored.sessionId, "sess-1");
  assert.equal(stored.userId, "user-1");
  assert.equal(stored.rating, "up");
  assert.equal(stored.score, 5);
  assert.deepEqual(stored.tags, ["helpful"]);
  assert.equal(stored.comment, "Great answer");

  const got = await getFeedback(ws, stored.id);
  assert.ok(got);
  assert.equal(got.id, stored.id);
});

test("recordFeedback throws when rating is missing", async () => {
  const ws = `ws-no-rating-${Date.now()}`;
  await assert.rejects(
    () => recordFeedback(ws, goodEvent({ rating: undefined })),
    /invalid feedback event.*rating/,
  );
});

test("recordFeedback throws when rating is not up/down", async () => {
  const ws = `ws-bad-rating-${Date.now()}`;
  await assert.rejects(
    () => recordFeedback(ws, goodEvent({ rating: "meh" })),
    /invalid feedback event.*rating/,
  );
});

test("recordFeedback throws when score is out of range", async () => {
  const ws = `ws-bad-score-${Date.now()}`;
  await assert.rejects(
    () => recordFeedback(ws, goodEvent({ score: 0 })),
    /invalid feedback event.*score/,
  );
  await assert.rejects(
    () => recordFeedback(ws, goodEvent({ score: 6 })),
    /invalid feedback event.*score/,
  );
  await assert.rejects(
    () => recordFeedback(ws, goodEvent({ score: 2.5 })),
    /invalid feedback event.*score/,
  );
});

test("recordFeedback truncates comment over 2000 chars (does NOT throw)", async () => {
  const ws = `ws-truncate-${Date.now()}`;
  const big = "x".repeat(3000);
  const stored = await recordFeedback(ws, goodEvent({ comment: big, agentResponse: big }));
  assert.equal(stored.comment.length, 2000);
  assert.equal(stored.agentResponse.length, 2000);
});

test("recordFeedback throws when tags array has more than 10 entries", async () => {
  const ws = `ws-toomany-tags-${Date.now()}`;
  const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
  await assert.rejects(
    () => recordFeedback(ws, goodEvent({ tags })),
    /invalid feedback event.*tags/,
  );
});

test("recordFeedback throws when a tag is non-string", async () => {
  const ws = `ws-nonstring-tag-${Date.now()}`;
  await assert.rejects(
    () => recordFeedback(ws, goodEvent({ tags: ["ok", 42] })),
    /invalid feedback event.*tags.*strings/,
  );
});

test("recordFeedback throws when runId or userId missing", async () => {
  const ws = `ws-missing-ids-${Date.now()}`;
  await assert.rejects(
    () => recordFeedback(ws, goodEvent({ runId: "" })),
    /invalid feedback event.*runId/,
  );
  await assert.rejects(
    () => recordFeedback(ws, goodEvent({ userId: "" })),
    /invalid feedback event.*userId/,
  );
});

test("listFeedback returns newest-first", async () => {
  const ws = `ws-order-${Date.now()}`;
  await recordFeedback(ws, goodEvent({ runId: "first" }));
  await recordFeedback(ws, goodEvent({ runId: "second" }));
  await recordFeedback(ws, goodEvent({ runId: "third" }));
  const list = await listFeedback(ws);
  assert.equal(list[0].runId, "third");
  assert.equal(list[1].runId, "second");
  assert.equal(list[2].runId, "first");
});

test("listFeedback respects limit (default 50, max 500)", async () => {
  const ws = `ws-limit-${Date.now()}`;
  for (let i = 0; i < 75; i++) {
    await recordFeedback(ws, goodEvent({ runId: `r-${i}` }));
  }
  const def = await listFeedback(ws);
  assert.equal(def.length, 50);
  const small = await listFeedback(ws, { limit: 5 });
  assert.equal(small.length, 5);
  const huge = await listFeedback(ws, { limit: 99999 });
  assert.equal(huge.length, 75, "clamped to max 500, only 75 events exist");
});

test("listFeedback filters by runId", async () => {
  const ws = `ws-runfilter-${Date.now()}`;
  await recordFeedback(ws, goodEvent({ runId: "A" }));
  await recordFeedback(ws, goodEvent({ runId: "B" }));
  await recordFeedback(ws, goodEvent({ runId: "A" }));
  const onlyA = await listFeedback(ws, { runId: "A" });
  assert.equal(onlyA.length, 2);
  for (const e of onlyA) assert.equal(e.runId, "A");
});

test("listFeedback filters by rating", async () => {
  const ws = `ws-ratingfilter-${Date.now()}`;
  await recordFeedback(ws, goodEvent({ rating: "up" }));
  await recordFeedback(ws, goodEvent({ rating: "down" }));
  await recordFeedback(ws, goodEvent({ rating: "up" }));
  const ups = await listFeedback(ws, { rating: "up" });
  const downs = await listFeedback(ws, { rating: "down" });
  assert.equal(ups.length, 2);
  assert.equal(downs.length, 1);
  assert.equal(downs[0].rating, "down");
});

test("ring buffer caps at 5000 events", async () => {
  const ws = `ws-ring-${Date.now()}`;
  for (let i = 0; i < 5005; i++) {
    await recordFeedback(ws, goodEvent({ runId: `r-${i}` }));
  }
  const { readJsonPath, getDataDir } = await import("../lib/json-path-store.js");
  const path = join(getDataDir(), "agent-feedback", ws, "events.json");
  const blob = await readJsonPath(path, { events: [] });
  assert.equal(blob.events.length, 5000, "ring buffer caps at 5000");
  // oldest 5 dropped: first remaining should be r-5
  assert.equal(blob.events[0].runId, "r-5");
  assert.equal(blob.events[blob.events.length - 1].runId, "r-5004");
});

test("aggregateFeedback: counts, upRate, avgScore, tagCounts, byDay", async () => {
  const ws = `ws-agg-${Date.now()}`;
  await recordFeedback(ws, goodEvent({ rating: "up", score: 5, tags: ["helpful"] }));
  await recordFeedback(ws, goodEvent({ rating: "up", score: 4, tags: ["helpful", "fast"] }));
  await recordFeedback(ws, goodEvent({ rating: "down", score: 2, tags: ["hallucination"] }));
  await recordFeedback(ws, goodEvent({ rating: "down", score: undefined, tags: ["wrong_tool"] }));

  const agg = await aggregateFeedback(ws);
  assert.equal(agg.total, 4);
  assert.equal(agg.upCount, 2);
  assert.equal(agg.downCount, 2);
  assert.equal(agg.upRate, 0.5);
  // avg of scores 5, 4, 2
  assert.equal(agg.avgScore, (5 + 4 + 2) / 3);
  assert.equal(agg.tagCounts.helpful, 2);
  assert.equal(agg.tagCounts.fast, 1);
  assert.equal(agg.tagCounts.hallucination, 1);
  assert.equal(agg.tagCounts.wrong_tool, 1);
  assert.ok(Array.isArray(agg.byDay));
  // today's bucket should count 2 up / 2 down
  const today = new Date().toISOString().slice(0, 10);
  const bucket = agg.byDay.find((b) => b.date === today);
  assert.ok(bucket, "today's bucket exists");
  assert.equal(bucket.up, 2);
  assert.equal(bucket.down, 2);
});

test("aggregateFeedback returns avgScore=null when no scores present", async () => {
  const ws = `ws-noscore-${Date.now()}`;
  await recordFeedback(ws, goodEvent({ rating: "up", score: undefined }));
  await recordFeedback(ws, goodEvent({ rating: "down", score: undefined }));
  const agg = await aggregateFeedback(ws);
  assert.equal(agg.total, 2);
  assert.equal(agg.avgScore, null);
});

test("aggregateFeedback sinceTs filters older events", async () => {
  const ws = `ws-since-${Date.now()}`;
  await recordFeedback(ws, goodEvent({ rating: "down" }));
  // wait a millisecond or two so ts strictly advances
  await new Promise((r) => setTimeout(r, 5));
  const cutoff = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  await recordFeedback(ws, goodEvent({ rating: "up" }));
  await recordFeedback(ws, goodEvent({ rating: "up" }));

  const agg = await aggregateFeedback(ws, { sinceTs: cutoff });
  assert.equal(agg.total, 2);
  assert.equal(agg.upCount, 2);
  assert.equal(agg.downCount, 0);
});

test("workspace isolation: events do not leak across workspaces", async () => {
  const wsA = `ws-isoA-${Date.now()}`;
  const wsB = `ws-isoB-${Date.now()}`;
  await recordFeedback(wsA, goodEvent({ runId: "A" }));
  await recordFeedback(wsB, goodEvent({ runId: "B" }));
  const listA = await listFeedback(wsA);
  const listB = await listFeedback(wsB);
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 1);
  assert.equal(listA[0].runId, "A");
  assert.equal(listB[0].runId, "B");
});

test("clearFeedback resets the log for the workspace", async () => {
  const ws = `ws-clear-${Date.now()}`;
  await recordFeedback(ws, goodEvent());
  await recordFeedback(ws, goodEvent());
  assert.equal((await listFeedback(ws)).length, 2);
  await clearFeedback(ws);
  assert.equal((await listFeedback(ws)).length, 0);
});
