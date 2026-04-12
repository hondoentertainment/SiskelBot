/**
 * Phase 51.5: Risky-ops quota tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-riskyops-"));
process.env.STORAGE_PATH = TMP;
process.env.QUOTA_TIER_SAFE_PER_MIN = "1000";
process.env.QUOTA_TIER_COSTLY_PER_MIN = "5";
process.env.QUOTA_TIER_RISKY_PER_MIN = "3";
process.env.QUOTA_TIER_DESTRUCTIVE_PER_HOUR = "2";

const {
  RISKY_TIERS,
  TOOL_TIERS,
  getOperationTier,
  tagOperation,
  checkQuota,
  consumeQuota,
  riskyOpsMiddleware,
  listCounters,
  _reset,
} = await import("../lib/risky-ops-quota.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("RISKY_TIERS are the four canonical tiers", () => {
  assert.deepEqual([...RISKY_TIERS], ["safe", "costly", "risky", "destructive"]);
});

test("TOOL_TIERS tags known tools with sensible defaults", () => {
  assert.equal(TOOL_TIERS.search_context, "safe");
  assert.equal(TOOL_TIERS.web_search, "costly");
  assert.equal(TOOL_TIERS.send_notification, "risky");
  assert.equal(TOOL_TIERS.code_execute, "destructive");
  assert.equal(TOOL_TIERS.query_database, "destructive");
});

test("getOperationTier falls back to 'safe' for unknown tools", () => {
  assert.equal(getOperationTier("totally_unknown"), "safe");
  assert.equal(getOperationTier(""), "safe");
});

test("tagOperation rejects bad input", () => {
  assert.throws(() => tagOperation("", "safe"), /required/);
  assert.throws(() => tagOperation("x", "bogus"), /tier must be/);
});

test("tagOperation overrides the tier for an operation", () => {
  tagOperation("my_op", "risky");
  assert.equal(getOperationTier("my_op"), "risky");
});

test("consumeQuota enforces the risky tier limit", () => {
  _reset();
  // With QUOTA_TIER_RISKY_PER_MIN=3, subject 'u' can consume 3 then is blocked.
  for (let i = 0; i < 3; i += 1) {
    const q = consumeQuota("send_notification", "u");
    assert.equal(q.allowed, true, `call ${i} should succeed`);
  }
  const blocked = consumeQuota("send_notification", "u");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.tier, "risky");
  assert.equal(blocked.remaining, 0);
});

test("consumeQuota enforces destructive per-hour cap", () => {
  _reset();
  assert.equal(consumeQuota("code_execute", "d").allowed, true);
  assert.equal(consumeQuota("code_execute", "d").allowed, true);
  const blocked = consumeQuota("code_execute", "d");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.tier, "destructive");
});

test("consumeQuota isolates subjects", () => {
  _reset();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(consumeQuota("send_notification", "user-a").allowed, true);
  }
  // user-b still has full budget.
  assert.equal(consumeQuota("send_notification", "user-b").allowed, true);
});

test("checkQuota does not consume a slot", () => {
  _reset();
  const first = checkQuota("code_execute", "c");
  assert.equal(first.allowed, true);
  const second = checkQuota("code_execute", "c");
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, first.remaining);
});

test("riskyOpsMiddleware blocks with 429 when quota exhausted", async () => {
  _reset();
  const mw = riskyOpsMiddleware();
  let called = 0;
  const fakeNext = () => { called += 1; };
  // Custom fake req/res.
  function mkRes() {
    const res = {
      headers: {},
      statusCode: 200,
      body: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(s) { this.statusCode = s; return this; },
      json(o) { this.body = o; return this; },
    };
    return res;
  }
  for (let i = 0; i < 3; i += 1) {
    const res = mkRes();
    mw({ body: { tool: "send_notification" }, userId: "x", ip: "1" }, res, fakeNext);
    assert.equal(res.statusCode, 200);
  }
  const res = mkRes();
  mw({ body: { tool: "send_notification" }, userId: "x", ip: "1" }, res, fakeNext);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, "RATE_LIMITED");
  assert.equal(res.body.tier, "risky");
  assert.equal(called, 3);
});

test("listCounters returns a snapshot per (tier, subject)", () => {
  _reset();
  consumeQuota("send_notification", "alpha");
  consumeQuota("send_notification", "beta");
  consumeQuota("code_execute", "alpha");
  const snap = listCounters();
  assert.ok(snap.length >= 3);
  assert.ok(snap.some((c) => c.tier === "risky" && c.subject === "alpha"));
  assert.ok(snap.some((c) => c.tier === "destructive" && c.subject === "alpha"));
});

test("consumeQuota prunes old timestamps by window", () => {
  _reset();
  const now = Date.now();
  // Fill the budget at t=0.
  for (let i = 0; i < 3; i += 1) {
    const q = consumeQuota("send_notification", "p", now);
    assert.equal(q.allowed, true);
  }
  assert.equal(consumeQuota("send_notification", "p", now).allowed, false);
  // A minute later the oldest should have aged out.
  const q = consumeQuota("send_notification", "p", now + 61_000);
  assert.equal(q.allowed, true);
});
