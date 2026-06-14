/**
 * Tests for the feedback-store integration into the offline prompt tuner.
 * Isolated STORAGE_PATH. Leaves tests/agent-prompt-tuner.test.js untouched so
 * both must pass side-by-side to prove backwards compat.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-prompt-tuner-fb-"));
process.env.STORAGE_PATH = tmpRoot;

const { synthesizePatch } = await import("../lib/agent-prompt-tuner.js");
const { recordRunFailures } = await import("../lib/agent-failure-store.js");
const { recordToolOutcomes } = await import("../lib/agent-genealogy.js");
const { recordFeedback } = await import("../lib/agent-feedback-store.js");

function uniqueWs(tag) {
  return `fb-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

async function seedFeedback(ws, entries) {
  for (const e of entries) {
    await recordFeedback(ws, {
      runId: e.runId || `run-${Math.random().toString(36).slice(2, 8)}`,
      userId: e.userId || "user-1",
      rating: e.rating,
      tags: e.tags,
      comment: e.comment,
      agentResponse: e.agentResponse,
    });
  }
}

test("synthesizePatch: feedback-only workspace (>= MIN_FEEDBACK) produces a patch", async () => {
  const ws = uniqueWs("fb-only");
  // 5 feedback events, all up → meets MIN_FEEDBACK=5 threshold.
  await seedFeedback(ws, [
    { rating: "up" },
    { rating: "up" },
    { rating: "up" },
    { rating: "up" },
    { rating: "up" },
  ]);
  const p = await synthesizePatch(ws);
  // 5 is below MIN_FEEDBACK_SIGNAL_LINE=10 so no line is emitted, no tags, no
  // flagged tools — there's literally nothing to say. synthesizePatch returns
  // null when no sections fire, even if signalOk.
  assert.equal(p, null);

  // But add 5 more with a "hallucination" tag count of 3+ and it should fire.
  await seedFeedback(ws, [
    { rating: "down", tags: ["hallucination"] },
    { rating: "down", tags: ["hallucination"] },
    { rating: "down", tags: ["hallucination"] },
    { rating: "down" },
    { rating: "down" },
  ]);
  const p2 = await synthesizePatch(ws);
  assert.ok(p2, "expected a patch from feedback-only signal with enough tags");
  assert.equal(p2.basis.feedbackTotal, 10);
  assert.ok(p2.content.includes("Human feedback signal"));
  assert.ok(p2.content.includes("Frequent user complaints"));
  assert.ok(p2.content.includes("hallucination(3)"));
});

test("synthesizePatch: tool names in down-feedback comments flag them", async () => {
  const ws = uniqueWs("fb-toolflag");
  // Give genealogy at least one record of web_search so it's a known tool.
  await recordToolOutcomes(ws, [{ tool: "web_search", ok: true }]);
  await seedFeedback(ws, [
    { rating: "down", comment: "the web_search tool returned junk" },
    { rating: "down", comment: "web_search again gave a dead link" },
    { rating: "down", agentResponse: "I'll use web_search to find this." },
    // Two more down events to reach MIN_FEEDBACK_SIGNAL_LINE plus enough total.
    { rating: "down" },
    { rating: "down" },
    { rating: "up" },
    { rating: "up" },
    { rating: "up" },
    { rating: "up" },
    { rating: "up" },
  ]);
  const p = await synthesizePatch(ws);
  assert.ok(p);
  assert.deepEqual(p.basis.toolsFlaggedByUsers, ["web_search"]);
  assert.ok(p.basis.toolsFlagged.includes("web_search"));
  assert.ok(p.content.includes("web_search"));
  assert.ok(p.content.includes("Known-bad tools"));
});

test("synthesizePatch: up-rate < 50% uses complaint-themed guidance line", async () => {
  const ws = uniqueWs("fb-lowrate");
  // 10 events, 2 up, 8 down → 20% positive.
  await seedFeedback(ws, [
    { rating: "up" }, { rating: "up" },
    { rating: "down" }, { rating: "down" }, { rating: "down" }, { rating: "down" },
    { rating: "down" }, { rating: "down" }, { rating: "down" }, { rating: "down" },
  ]);
  const p = await synthesizePatch(ws);
  assert.ok(p);
  assert.ok(p.content.includes("Human feedback signal"));
  assert.ok(p.content.includes("20% positive"));
  assert.ok(
    /directly address the user's question|avoid the failure modes/i.test(p.content),
    "expected complaint-themed guidance for low up-rate",
  );
  assert.equal(p.basis.feedbackTotal, 10);
  assert.ok(Math.abs(p.basis.feedbackUpRate - 0.2) < 1e-9);
});

test("synthesizePatch: multiple complaint tags listed with counts", async () => {
  const ws = uniqueWs("fb-tags");
  const entries = [];
  for (let i = 0; i < 5; i++) entries.push({ rating: "down", tags: ["hallucination"] });
  for (let i = 0; i < 3; i++) entries.push({ rating: "down", tags: ["slow"] });
  for (let i = 0; i < 2; i++) entries.push({ rating: "up" }); // pad to 10 total
  await seedFeedback(ws, entries);
  const p = await synthesizePatch(ws);
  assert.ok(p);
  assert.ok(p.content.includes("Frequent user complaints"));
  assert.ok(p.content.includes("hallucination(5)"));
  assert.ok(p.content.includes("slow(3)"));
  assert.deepEqual(p.basis.topComplaintTags, ["hallucination(5)", "slow(3)"]);
});

test("backwards compat: zero feedback produces byte-identical content and toolsFlagged", async () => {
  // Two workspaces with IDENTICAL automated-signal input, zero feedback either
  // way. Content must match byte-for-byte; basis.toolsFlagged must match.
  const wsA = uniqueWs("compat-a");
  const wsB = uniqueWs("compat-b");

  const outcomes = [
    ...Array.from({ length: 10 }, () => ({ tool: "search_context", ok: true })),
    { tool: "flaky_api", ok: true },
    ...Array.from({ length: 9 }, () => ({ tool: "flaky_api", ok: false })),
  ];
  const fails = [
    { tool: "flaky_api", category: "permission" },
    { tool: "flaky_api", category: "permission" },
    { tool: "flaky_api", category: "not_allowed" },
    { tool: "flaky_api", category: "permission" },
  ];

  await recordToolOutcomes(wsA, outcomes);
  await recordRunFailures(wsA, fails);
  await recordToolOutcomes(wsB, outcomes);
  await recordRunFailures(wsB, fails);

  const pA = await synthesizePatch(wsA);
  const pB = await synthesizePatch(wsB);
  assert.ok(pA && pB);
  assert.equal(pA.content, pB.content, "zero-feedback content must be identical");
  assert.deepEqual(pA.basis.toolsFlagged, pB.basis.toolsFlagged);
  // Known-bad + reliable sections should be present; no feedback sections.
  assert.ok(pA.content.includes("Known-bad tools"));
  assert.ok(pA.content.includes("Reliable tools"));
  assert.ok(!pA.content.includes("Human feedback signal"));
  assert.ok(!pA.content.includes("Frequent user complaints"));
  // Feedback basis fields present but empty.
  assert.equal(pA.basis.feedbackTotal, 0);
  assert.equal(pA.basis.feedbackUpRate, null);
  assert.deepEqual(pA.basis.topComplaintTags, []);
  assert.deepEqual(pA.basis.toolsFlaggedByUsers, []);
});

test("patch stays under 1500 chars with ALL signals maxed out", async () => {
  const ws = uniqueWs("cap");
  // Heavy tool data.
  const outcomes = [];
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < 10; j++) outcomes.push({ tool: `good_${i}`, ok: true });
  }
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < 10; j++) outcomes.push({ tool: `bad_${i}`, ok: j < 2 });
  }
  await recordToolOutcomes(ws, outcomes);
  const fails = [];
  for (let i = 0; i < 30; i++) {
    for (let j = 0; j < 4; j++) fails.push({ tool: `bad_${i}`, category: "permission" });
  }
  await recordRunFailures(ws, fails);
  // Heavy feedback data with lots of tags and tool mentions.
  const fbEntries = [];
  for (let i = 0; i < 40; i++) {
    fbEntries.push({
      rating: i % 3 === 0 ? "up" : "down",
      tags: ["hallucination", "wrong_tool", "slow"],
      comment: `the bad_0 and bad_1 tools messed up again — very slow too`,
    });
  }
  await seedFeedback(ws, fbEntries);

  const p = await synthesizePatch(ws);
  assert.ok(p);
  assert.ok(
    p.content.length <= 1500,
    `content was ${p.content.length} chars`,
  );
  // Feedback sections must survive — they are highest priority.
  assert.ok(p.content.includes("Human feedback signal"));
});

test("basis contains new feedback fields with correct values", async () => {
  const ws = uniqueWs("basis");
  await seedFeedback(ws, [
    { rating: "up" }, { rating: "up" }, { rating: "up" }, { rating: "up" },
    { rating: "up" }, { rating: "up" }, { rating: "up" },
    { rating: "down", tags: ["hallucination"] },
    { rating: "down", tags: ["hallucination"] },
    { rating: "down", tags: ["hallucination"] },
  ]);
  const p = await synthesizePatch(ws);
  assert.ok(p);
  assert.equal(p.basis.feedbackTotal, 10);
  assert.ok(Math.abs(p.basis.feedbackUpRate - 0.7) < 1e-9);
  assert.deepEqual(p.basis.topComplaintTags, ["hallucination(3)"]);
  assert.deepEqual(p.basis.toolsFlaggedByUsers, []);
  // toolsFlagged is union (in this case empty — no automated signal + no
  // user-flagged tools reached threshold).
  assert.deepEqual(p.basis.toolsFlagged, []);
});
