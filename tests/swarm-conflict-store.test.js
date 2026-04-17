/**
 * Unit tests for lib/swarm-conflict-store.js.
 * Covers recording, listing, getting, clearing, ring-buffer pruning,
 * response truncation, workspace isolation, and env gating.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "swarm-conflict-store-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const {
  recordConflict,
  listConflicts,
  getConflict,
  clearConflicts,
  swarmConflictLogEnabled,
} = await import("../lib/swarm-conflict-store.js");

function sampleEvent(overrides = {}) {
  return {
    type: "polarity",
    similarity: 0.3,
    summary: "Specialists disagree on yes/no",
    specialists: ["researcher", "executor"],
    responses: [
      { specialist: "researcher", output: "Yes, the answer is X." },
      { specialist: "executor", output: "No, the answer is not X." },
    ],
    ...overrides,
  };
}

test("record -> list -> get roundtrip", async () => {
  const ws = `ws-roundtrip-${Date.now()}`;
  const stored = await recordConflict(ws, sampleEvent());
  assert.ok(stored.id, "event should have id");
  assert.ok(stored.ts > 0, "event should have ts");
  assert.equal(stored.type, "polarity");
  assert.equal(stored.similarity, 0.3);
  assert.deepEqual(stored.specialists, ["researcher", "executor"]);
  assert.equal(stored.responses.length, 2);

  const list = await listConflicts(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, stored.id);

  const got = await getConflict(ws, stored.id);
  assert.ok(got);
  assert.equal(got.id, stored.id);
  assert.equal(got.summary, stored.summary);

  const miss = await getConflict(ws, "no-such-id");
  assert.equal(miss, null);
});

test("ring buffer caps at 1000 events; oldest dropped and newest preserved", async () => {
  const ws = `ws-ring-${Date.now()}`;
  for (let i = 0; i < 1005; i++) {
    await recordConflict(ws, sampleEvent({ summary: `event-${i}` }));
  }
  const list = await listConflicts(ws, { limit: 500 });
  assert.equal(list.length, 500, "listConflicts respects limit");

  const all = await listConflicts(ws, { limit: 500 });
  // newest-first; event-1004 should be first
  assert.equal(all[0].summary, "event-1004");

  // verify underlying storage kept only 1000 newest
  const { readJsonPath, getDataDir } = await import("../lib/json-path-store.js");
  const path = join(getDataDir(), "swarm-conflicts", ws, "events.json");
  const blob = await readJsonPath(path, { events: [] });
  assert.equal(blob.events.length, 1000);
  assert.equal(blob.events[0].summary, "event-5", "oldest 5 should have been dropped");
  assert.equal(blob.events[blob.events.length - 1].summary, "event-1004");
});

test("response outputs truncated to 4000 chars on storage", async () => {
  const ws = `ws-trunc-${Date.now()}`;
  const big = "x".repeat(10000);
  const stored = await recordConflict(ws, sampleEvent({
    responses: [
      { specialist: "researcher", output: big },
      { specialist: "executor", output: "ok" },
    ],
  }));
  assert.ok(stored.responses[0].output.length <= 4000);
  assert.equal(stored.responses[0].output.length, 4000);
  assert.equal(stored.responses[1].output, "ok");

  const got = await getConflict(ws, stored.id);
  assert.equal(got.responses[0].output.length, 4000);
});

test("workspace isolation: events do not leak across workspaces", async () => {
  const wsA = `ws-iso-A-${Date.now()}`;
  const wsB = `ws-iso-B-${Date.now()}`;
  await recordConflict(wsA, sampleEvent({ summary: "event-A" }));
  await recordConflict(wsB, sampleEvent({ summary: "event-B" }));

  const listA = await listConflicts(wsA);
  const listB = await listConflicts(wsB);
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 1);
  assert.equal(listA[0].summary, "event-A");
  assert.equal(listB[0].summary, "event-B");
});

test("clearConflicts resets the workspace log", async () => {
  const ws = `ws-clear-${Date.now()}`;
  await recordConflict(ws, sampleEvent());
  await recordConflict(ws, sampleEvent());
  let list = await listConflicts(ws);
  assert.equal(list.length, 2);

  await clearConflicts(ws);
  list = await listConflicts(ws);
  assert.equal(list.length, 0);
});

test("listConflicts respects limit param (default 50, max 500)", async () => {
  const ws = `ws-limit-${Date.now()}`;
  for (let i = 0; i < 75; i++) {
    await recordConflict(ws, sampleEvent({ summary: `ev-${i}` }));
  }
  const defaultList = await listConflicts(ws);
  assert.equal(defaultList.length, 50, "default limit is 50");

  const small = await listConflicts(ws, { limit: 5 });
  assert.equal(small.length, 5);

  // limit over max should be clamped to 500 (but we only have 75)
  const huge = await listConflicts(ws, { limit: 99999 });
  assert.equal(huge.length, 75);
});

test("listConflicts returns newest-first", async () => {
  const ws = `ws-order-${Date.now()}`;
  await recordConflict(ws, sampleEvent({ summary: "first" }));
  await recordConflict(ws, sampleEvent({ summary: "second" }));
  await recordConflict(ws, sampleEvent({ summary: "third" }));
  const list = await listConflicts(ws);
  assert.equal(list[0].summary, "third");
  assert.equal(list[1].summary, "second");
  assert.equal(list[2].summary, "first");
});

test("swarmConflictLogEnabled toggles via env", () => {
  const prev = process.env.SWARM_CONFLICT_LOG;
  try {
    delete process.env.SWARM_CONFLICT_LOG;
    assert.equal(swarmConflictLogEnabled(), true, "default enabled");
    process.env.SWARM_CONFLICT_LOG = "1";
    assert.equal(swarmConflictLogEnabled(), true);
    process.env.SWARM_CONFLICT_LOG = "0";
    assert.equal(swarmConflictLogEnabled(), false);
    process.env.SWARM_CONFLICT_LOG = "false";
    assert.equal(swarmConflictLogEnabled(), false);
    process.env.SWARM_CONFLICT_LOG = "off";
    assert.equal(swarmConflictLogEnabled(), false);
    process.env.SWARM_CONFLICT_LOG = "yes";
    assert.equal(swarmConflictLogEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.SWARM_CONFLICT_LOG;
    else process.env.SWARM_CONFLICT_LOG = prev;
  }
});

test("reconciled and judgeError optional fields are persisted", async () => {
  const ws = `ws-opt-${Date.now()}`;
  const stored = await recordConflict(ws, sampleEvent({
    reconciled: "The correct answer is X.",
    judgeError: "",
  }));
  assert.equal(stored.reconciled, "The correct answer is X.");
  // empty judgeError should not be persisted (non-empty string check)
  // our impl persists only strings; empty string IS a string, gets persisted.
  // Clarify: spec says optional; we persist iff it's a string.
  assert.equal(stored.judgeError, "");

  const stored2 = await recordConflict(ws, sampleEvent());
  assert.equal(stored2.reconciled, undefined);
  assert.equal(stored2.judgeError, undefined);
});
