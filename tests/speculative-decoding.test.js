/**
 * Phase 58.2: Speculative decoding tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-spec-decode-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createSpeculativeSession,
  generateSpeculative,
  getAcceptanceRate,
  resetStats,
  defaultDraftGen,
  defaultVerify,
  getSession,
  destroySession,
  listSessionStats,
} = await import("../lib/speculative-decoding.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("createSpeculativeSession produces unique ids and defaults", () => {
  const s1 = createSpeculativeSession();
  const s2 = createSpeculativeSession({ random: () => 0.42 });
  assert.notEqual(s1.id, s2.id);
  assert.equal(s1.draftLookahead, 4);
  assert.ok(s1.createdAt);
});

test("getSession / destroySession manage the registry", () => {
  const s = createSpeculativeSession();
  assert.ok(getSession(s.id));
  assert.equal(destroySession(s.id), true);
  assert.equal(getSession(s.id), null);
});

test("defaultDraftGen produces deterministic draft tokens", () => {
  const a = defaultDraftGen("hello", 5);
  const b = defaultDraftGen("hello", 5);
  assert.deepEqual(a, b);
  assert.equal(a.length, 5);
  assert.ok(a[0].startsWith("draft_"));
});

test("defaultVerify returns nonzero acceptance for non-empty draft", () => {
  const k = defaultVerify("prompt", ["a", "b", "c", "d"]);
  assert.ok(k > 0 && k <= 4);
  assert.equal(defaultVerify("", []), 0);
});

test("generateSpeculative produces tokens and records stats", async () => {
  await resetStats();
  const session = createSpeculativeSession({ draftLookahead: 4 });
  const r = await generateSpeculative(session, "prompt", { maxTokens: 16 });
  assert.ok(r.tokens.length > 0);
  assert.ok(r.drafted > 0);
  assert.ok(r.accepted > 0);
  assert.ok(r.rounds > 0);
  assert.ok(r.acceptanceRate > 0 && r.acceptanceRate <= 1);
});

test("generateSpeculative rejects invalid session", async () => {
  await assert.rejects(() => generateSpeculative(null, "p"));
  await assert.rejects(() => generateSpeculative("no-such-id", "p"));
});

test("getAcceptanceRate reflects global stats after resets", async () => {
  await resetStats();
  const s = createSpeculativeSession();
  await generateSpeculative(s, "hello world", { maxTokens: 8 });
  const rate = await getAcceptanceRate();
  assert.ok(rate > 0 && rate <= 1);
  await resetStats();
  const after = await getAcceptanceRate();
  assert.equal(after, 0);
});

test("getAcceptanceRate supports per-session query", async () => {
  await resetStats();
  const a = createSpeculativeSession();
  const b = createSpeculativeSession();
  await generateSpeculative(a, "aaa", { maxTokens: 12 });
  await generateSpeculative(b, "bbbbb", { maxTokens: 12 });
  const ra = await getAcceptanceRate(a.id);
  const rb = await getAcceptanceRate(b.id);
  assert.ok(ra > 0);
  assert.ok(rb > 0);
  const sessions = await listSessionStats();
  assert.ok(sessions[a.id]);
  assert.ok(sessions[b.id]);
});

test("generateSpeculative honors fully-accepting custom verifier", async () => {
  await resetStats();
  const s = createSpeculativeSession({
    draftLookahead: 4,
    draftGen: (_p, n) => Array.from({ length: n }, (_, i) => `t${i}`),
    verify: (_p, draft) => draft.length, // always accept all
  });
  const r = await generateSpeculative(s, "p", { maxTokens: 12 });
  assert.equal(r.accepted, r.drafted);
  assert.equal(r.acceptanceRate, 1);
  assert.equal(r.tokens.length, 12);
});

test("resetStats with sessionId only clears that session", async () => {
  await resetStats();
  const a = createSpeculativeSession();
  const b = createSpeculativeSession();
  await generateSpeculative(a, "a", { maxTokens: 8 });
  await generateSpeculative(b, "b", { maxTokens: 8 });
  await resetStats(a.id);
  const rateA = await getAcceptanceRate(a.id);
  const rateB = await getAcceptanceRate(b.id);
  assert.equal(rateA, 0);
  assert.ok(rateB > 0);
});
