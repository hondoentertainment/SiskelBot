/**
 * Phase 68.3: Fact verification tests (agent-output verification).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-fact-verification-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  verifyFact,
  listVerifications,
  getVerification,
  getFactReport,
} = await import("../lib/fact-verification.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

function mockVerifier(verdictByClaim) {
  return async ({ claim }) => {
    const v = verdictByClaim[claim] || { verdict: "unverified", confidence: 0, sourceResults: [] };
    return {
      verdict: v.verdict,
      confidence: v.confidence,
      sourceResults: v.sourceResults || [],
      patternCheck: { passed: true, failed: [] },
    };
  };
}

test("verifyFact requires a claim", async () => {
  await assert.rejects(() => verifyFact({}), /claim/);
});

test("verifyFact persists a verification with verdict and agent context", async () => {
  const verifier = mockVerifier({
    "earth is round": { verdict: "supported", confidence: 0.9 },
  });
  const rec = await verifyFact({
    claim: "earth is round",
    agentRunId: "run-1",
    messageId: "msg-1",
    modelId: "gpt-4",
    verifier,
  });
  assert.ok(rec.id);
  assert.equal(rec.verdict, "supported");
  assert.equal(rec.confidence, 0.9);
  assert.equal(rec.agentRunId, "run-1");
  assert.equal(rec.messageId, "msg-1");
  const fetched = await getVerification(rec.id);
  assert.equal(fetched.id, rec.id);
});

test("verifyFact defaults verdict to unverified when verifier is silent", async () => {
  const verifier = async () => ({});
  const rec = await verifyFact({ claim: "mystery", verifier });
  assert.equal(rec.verdict, "unverified");
});

test("listVerifications filters by agentRunId and verdict", async () => {
  const verifier = mockVerifier({
    "claim-a": { verdict: "supported", confidence: 0.85 },
    "claim-b": { verdict: "unsupported", confidence: 0.1 },
  });
  await verifyFact({ claim: "claim-a", agentRunId: "run-filter", modelId: "gpt-4", verifier });
  await verifyFact({ claim: "claim-b", agentRunId: "run-filter", modelId: "gpt-4", verifier });
  const byRun = await listVerifications({ agentRunId: "run-filter" });
  assert.equal(byRun.length, 2);
  const supported = await listVerifications({ agentRunId: "run-filter", verdict: "supported" });
  assert.equal(supported.length, 1);
});

test("listVerifications orders most recent first", async () => {
  const verifier = mockVerifier({ x: { verdict: "supported", confidence: 1 } });
  const a = await verifyFact({ claim: "x", agentRunId: "order-run", verifier });
  await new Promise((r) => setTimeout(r, 5));
  const b = await verifyFact({ claim: "x", agentRunId: "order-run", verifier });
  const list = await listVerifications({ agentRunId: "order-run" });
  assert.equal(list[0].id, b.id);
  assert.equal(list[1].id, a.id);
});

test("getFactReport aggregates rates and confidence", async () => {
  const verifier = mockVerifier({
    "good-1": { verdict: "supported", confidence: 0.9 },
    "good-2": { verdict: "supported", confidence: 0.8 },
    "meh-1": { verdict: "partial", confidence: 0.5 },
    "bad-1": { verdict: "unsupported", confidence: 0.1 },
    "none-1": { verdict: "no_sources", confidence: 0 },
  });
  await verifyFact({ claim: "good-1", modelId: "m1", verifier });
  await verifyFact({ claim: "good-2", modelId: "m1", verifier });
  await verifyFact({ claim: "meh-1", modelId: "m1", verifier });
  await verifyFact({ claim: "bad-1", modelId: "m1", verifier });
  await verifyFact({ claim: "none-1", modelId: "m1", verifier });
  const report = await getFactReport({ modelId: "m1" });
  assert.equal(report.total, 5);
  assert.equal(report.byVerdict.supported, 2);
  assert.equal(report.byVerdict.partial, 1);
  assert.equal(report.byVerdict.unsupported, 1);
  assert.equal(report.byVerdict.no_sources, 1);
  assert.ok(Math.abs(report.supportRate - 0.4) < 1e-9);
  assert.ok(Math.abs(report.failureRate - 0.2) < 1e-9);
  assert.ok(report.averageConfidence > 0);
});

test("getFactReport handles no data gracefully", async () => {
  const report = await getFactReport({ modelId: "never-used" });
  assert.equal(report.total, 0);
  assert.equal(report.supportRate, 0);
  assert.equal(report.averageConfidence, null);
});

test("getVerification returns null for missing ids", async () => {
  assert.equal(await getVerification("nope"), null);
});

test("verifyFact captures source results from verifier", async () => {
  const verifier = async () => ({
    verdict: "partial",
    confidence: 0.5,
    sourceResults: [
      { sourceId: "s1", name: "src1", score: 0.5, fetched: false },
    ],
  });
  const rec = await verifyFact({ claim: "partial claim", verifier });
  assert.equal(rec.sourceResults.length, 1);
  assert.equal(rec.sourceResults[0].sourceId, "s1");
});
