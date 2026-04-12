/**
 * Phase 59.2: Load shedding tests.
 *
 * Covers: priority normalization, elastic capacity shedding (soft vs hard),
 * per-priority limits, P0 immunity, release semantics, middleware, shed-event
 * hook, event persistence, configureShedding, stats + reset.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-load-shedding-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  admit,
  admitRequest,
  configureShedding,
  getConfig,
  getShedStats,
  getShedEvents,
  resetShedding,
  setShedEventHook,
  PRIORITY_P0,
  PRIORITY_P1,
  PRIORITY_P2,
  PRIORITY_P3,
  PRIORITY_LABELS,
} = await import("../lib/load-shedding.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test.beforeEach(() => {
  resetShedding();
});

// ─── Priority normalization ────────────────────────────────────────────────

test("priority labels cover P0-P3", () => {
  assert.equal(PRIORITY_LABELS[PRIORITY_P0], "P0_health");
  assert.equal(PRIORITY_LABELS[PRIORITY_P1], "P1_paid");
  assert.equal(PRIORITY_LABELS[PRIORITY_P2], "P2_free");
  assert.equal(PRIORITY_LABELS[PRIORITY_P3], "P3_batch");
});

test("admit normalizes unknown priority values to P2", () => {
  const decision = admit("not-a-number");
  assert.equal(decision.admitted, true);
  assert.equal(decision.priority, PRIORITY_P2);
  decision.release();
});

// ─── Elastic capacity ──────────────────────────────────────────────────────

test("admit shedding P3 first once soft capacity is exceeded", () => {
  configureShedding({ softCapacity: 2, hardCapacity: 10 });
  const holds = [];
  // Fill up to soft with P2.
  holds.push(admit(PRIORITY_P2));
  holds.push(admit(PRIORITY_P2));
  assert.ok(holds.every((h) => h.admitted));
  // Now P3 should be shed immediately.
  const shed = admit(PRIORITY_P3);
  assert.equal(shed.admitted, false);
  assert.equal(shed.reason, "capacity");
  assert.equal(shed.event.type, "agent_shed");
  for (const h of holds) h.release();
});

test("admit sheds P2 when traffic climbs toward the hard ceiling", () => {
  configureShedding({ softCapacity: 4, hardCapacity: 8 });
  const holds = [];
  for (let i = 0; i < 6; i += 1) holds.push(admit(PRIORITY_P1));
  // totalInFlight = 6, midway = 4 + (8 - 4) / 2 = 6 -> P2 should shed.
  const shed = admit(PRIORITY_P2);
  assert.equal(shed.admitted, false);
  assert.equal(shed.reason, "capacity");
  for (const h of holds) h.release();
});

test("admit hits hard ceiling and sheds non-P0", () => {
  configureShedding({ softCapacity: 2, hardCapacity: 3 });
  const holds = [];
  holds.push(admit(PRIORITY_P1));
  holds.push(admit(PRIORITY_P1));
  holds.push(admit(PRIORITY_P1));
  const shed = admit(PRIORITY_P1);
  assert.equal(shed.admitted, false);
  assert.equal(shed.reason, "capacity");
  for (const h of holds) h.release();
});

test("P0 is always admitted even over capacity", () => {
  configureShedding({ softCapacity: 1, hardCapacity: 1 });
  const a = admit(PRIORITY_P1);
  assert.equal(a.admitted, true);
  const b = admit(PRIORITY_P0);
  assert.equal(b.admitted, true);
  a.release();
  b.release();
});

// ─── Per-priority limits ───────────────────────────────────────────────────

test("per-priority limit caps a priority independently", () => {
  configureShedding({
    softCapacity: 100,
    hardCapacity: 1000,
    perPriorityLimits: { 3: 2 },
  });
  const a = admit(PRIORITY_P3);
  const b = admit(PRIORITY_P3);
  const c = admit(PRIORITY_P3);
  assert.equal(a.admitted, true);
  assert.equal(b.admitted, true);
  assert.equal(c.admitted, false);
  assert.equal(c.reason, "per_priority");
  a.release(); b.release();
});

// ─── Release semantics ────────────────────────────────────────────────────

test("release decrements in-flight and is idempotent", () => {
  configureShedding({ softCapacity: 10, hardCapacity: 10 });
  const a = admit(PRIORITY_P2);
  const before = getShedStats().totalInFlight;
  a.release();
  a.release(); // idempotent
  const after = getShedStats().totalInFlight;
  assert.equal(before - after, 1);
});

// ─── Middleware ────────────────────────────────────────────────────────────

test("admitRequest middleware passes when admitted and responds 503 when shed", () => {
  configureShedding({ softCapacity: 0, hardCapacity: 0 });
  const mw = admitRequest(PRIORITY_P2);
  let nextCalled = false;
  let responseStatus = null;
  let responseBody = null;
  const req = { path: "/x", method: "GET" };
  const res = {
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(s) { responseStatus = s; return this; },
    json(body) { responseBody = body; return this; },
    on() {},
  };
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(responseStatus, 503);
  assert.equal(responseBody.error, "load_shed");
  assert.equal(responseBody.priorityLabel, "P2_free");
});

test("admitRequest middleware admits P0 regardless of capacity", () => {
  configureShedding({ softCapacity: 0, hardCapacity: 0 });
  const mw = admitRequest(PRIORITY_P0);
  let nextCalled = false;
  const req = { path: "/health", method: "GET" };
  const res = {
    setHeader() {},
    status() { return this; },
    json() { return this; },
    on() {},
  };
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

// ─── Shed event hook ───────────────────────────────────────────────────────

test("setShedEventHook receives an agent_shed event when shed", () => {
  configureShedding({ softCapacity: 0, hardCapacity: 0 });
  const events = [];
  setShedEventHook((e) => { events.push(e); });
  admit(PRIORITY_P2);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "agent_shed");
  assert.equal(events[0].priorityLabel, "P2_free");
});

// ─── Persistence ──────────────────────────────────────────────────────────

test("getShedEvents returns recent shed events", async () => {
  configureShedding({ softCapacity: 0, hardCapacity: 0 });
  admit(PRIORITY_P2);
  admit(PRIORITY_P3);
  // Allow async persistence to settle.
  await new Promise((r) => setTimeout(r, 20));
  const events = await getShedEvents(10);
  assert.ok(events.length >= 2);
  assert.equal(events[events.length - 1].type, "agent_shed");
});

// ─── Stats + configure ───────────────────────────────────────────────────

test("configureShedding keeps hardCapacity >= softCapacity", () => {
  configureShedding({ softCapacity: 50, hardCapacity: 10 });
  const cfg = getConfig();
  assert.equal(cfg.hardCapacity, 50);
});

test("getShedStats summarizes admissions and sheds", () => {
  configureShedding({ softCapacity: 1, hardCapacity: 1 });
  const a = admit(PRIORITY_P1);
  admit(PRIORITY_P2);
  admit(PRIORITY_P2);
  const stats = getShedStats();
  assert.ok(stats.admitted[PRIORITY_P1] >= 1);
  assert.ok(stats.shed[PRIORITY_P2] >= 1);
  assert.ok(stats.shedRate > 0);
  a.release();
});
