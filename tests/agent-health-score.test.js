/**
 * Tests for the composite agent health-budget score.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-agent-health-score-"));
process.env.STORAGE_PATH = tmpRoot;
process.env.ENABLE_METRICS = "1";

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const {
  scoreFromComponents,
  computeHealthScore,
  emitHealthScoreMetric,
  checkAndAlertHealthScore,
  __resetLastScoreForTests,
  DEFAULT_WEIGHTS,
} = await import("../lib/agent-health-score.js");
const { recordSample } = await import("../lib/eval-history-store.js");
const { recordFeedback } = await import("../lib/agent-feedback-store.js");
const { recordToolOutcomes } = await import("../lib/agent-genealogy.js");
const { recordRunFailures } = await import("../lib/agent-failure-store.js");
const { recordConflict } = await import("../lib/swarm-conflict-store.js");
const metrics = await import("../lib/metrics.js");

test("scoreFromComponents: all positive at 1.0, no penalties -> 0.85", () => {
  const { score } = scoreFromComponents({
    benchmarkPassRate: 1,
    safetyPassRate: 1,
    feedbackUpRate: 1,
    avgToolReliability: 1,
    chronicToolCount: 0,
    conflictsLast24h: 0,
  });
  assert.ok(Math.abs(score - 0.85) < 1e-9, `expected 0.85, got ${score}`);
});

test("sum of positive weights equals 0.85", () => {
  const sum =
    DEFAULT_WEIGHTS.bench +
    DEFAULT_WEIGHTS.safety +
    DEFAULT_WEIGHTS.feedback +
    DEFAULT_WEIGHTS.reliability;
  assert.ok(Math.abs(sum - 0.85) < 1e-9);
});

test("scoreFromComponents: 10+ chronic tools drops score by 0.10", () => {
  const { score, alerts } = scoreFromComponents({
    benchmarkPassRate: 1,
    safetyPassRate: 1,
    feedbackUpRate: 1,
    avgToolReliability: 1,
    chronicToolCount: 12, // > 10, clamps to 1 * w_chronic = 0.10
    conflictsLast24h: 0,
  });
  assert.ok(Math.abs(score - 0.75) < 1e-9, `expected 0.75, got ${score}`);
  assert.ok(alerts.some((a) => /12 chronic tool failures/.test(a)));
});

test("scoreFromComponents: all null -> score 0, status critical", () => {
  const { score, alerts } = scoreFromComponents({
    benchmarkPassRate: null,
    safetyPassRate: null,
    feedbackUpRate: null,
    avgToolReliability: null,
    chronicToolCount: 0,
    conflictsLast24h: 0,
  });
  assert.equal(score, 0);
  // alerts include all four "unavailable" lines
  assert.ok(alerts.some((a) => /benchmark pass rate unavailable/.test(a)));
  assert.ok(alerts.some((a) => /safety pass rate unavailable/.test(a)));
  assert.ok(alerts.some((a) => /feedback up rate unavailable/.test(a)));
  assert.ok(alerts.some((a) => /tool reliability unavailable/.test(a)));
});

test("scoreFromComponents: safety 0.78 triggers below-threshold alert", () => {
  const { alerts } = scoreFromComponents({
    benchmarkPassRate: 0.9,
    safetyPassRate: 0.78,
    feedbackUpRate: 0.8,
    avgToolReliability: 0.85,
    chronicToolCount: 0,
    conflictsLast24h: 0,
  });
  assert.ok(
    alerts.some((a) => /safety pass rate 78% below 0\.90 threshold/.test(a)),
    `alerts: ${JSON.stringify(alerts)}`,
  );
});

test("scoreFromComponents: penalties cap at 10 (do not over-penalize)", () => {
  const { score: a } = scoreFromComponents({
    benchmarkPassRate: 1, safetyPassRate: 1, feedbackUpRate: 1, avgToolReliability: 1,
    chronicToolCount: 10, conflictsLast24h: 10,
  });
  const { score: b } = scoreFromComponents({
    benchmarkPassRate: 1, safetyPassRate: 1, feedbackUpRate: 1, avgToolReliability: 1,
    chronicToolCount: 100, conflictsLast24h: 1000,
  });
  assert.equal(a, b, "penalty should clamp to 1 after 10 items");
  // 0.85 - 0.10 - 0.05 = 0.70
  assert.ok(Math.abs(a - 0.70) < 1e-9);
});

test("status thresholds: healthy/warning/critical buckets", () => {
  // healthy at 0.80
  const h = scoreFromComponents({
    benchmarkPassRate: 1, safetyPassRate: 1, feedbackUpRate: 1,
    avgToolReliability: 0.666667 /* weight 0.15 -> 0.10 */,
    chronicToolCount: 0, conflictsLast24h: 0,
  }).score;
  // warning at around 0.60
  const w = scoreFromComponents({
    benchmarkPassRate: 0.7, safetyPassRate: 0.7, feedbackUpRate: 0.7, avgToolReliability: 0.7,
    chronicToolCount: 0, conflictsLast24h: 0,
  }).score;
  // critical under 0.50
  const c = scoreFromComponents({
    benchmarkPassRate: 0.3, safetyPassRate: 0.3, feedbackUpRate: 0.3, avgToolReliability: 0.3,
    chronicToolCount: 0, conflictsLast24h: 0,
  }).score;
  assert.ok(h >= 0.75, `h should be healthy, got ${h}`);
  assert.ok(w >= 0.50 && w < 0.75, `w should be warning, got ${w}`);
  assert.ok(c < 0.50, `c should be critical, got ${c}`);
});

test("computeHealthScore: empty workspace returns score 0 with status critical", async () => {
  const ws = `wsEmpty-${Date.now()}`;
  const hs = await computeHealthScore(ws);
  assert.equal(hs.workspace, ws.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80));
  assert.equal(hs.score, 0);
  assert.equal(hs.status, "critical");
  assert.equal(hs.components.benchmarkPassRate, null);
  assert.equal(hs.components.safetyPassRate, null);
  assert.equal(hs.components.feedbackUpRate, null);
  assert.equal(hs.components.avgToolReliability, null);
  assert.equal(hs.components.chronicToolCount, 0);
  assert.equal(hs.components.conflictsLast24h, 0);
});

test("computeHealthScore: populated workspace yields a reasonable composite", async () => {
  const ws = `wsPop-${Date.now()}`;
  // Benchmark pass rate 0.9
  await recordSample(ws, { ts: Date.now(), kind: "benchmark", metrics: { passRate: 0.9 } });
  // Safety pass rate 0.95
  await recordSample(ws, { ts: Date.now(), kind: "safety", metrics: { passRate: 0.95 } });
  // Feedback 3 up / 1 down = 0.75
  for (let i = 0; i < 3; i++) {
    await recordFeedback(ws, { runId: `run${i}`, userId: "u", rating: "up" });
  }
  await recordFeedback(ws, { runId: "runDown", userId: "u", rating: "down" });
  // Tool outcomes: 8 success / 2 failure across two tools
  await recordToolOutcomes(ws, [
    { tool: "search_context", ok: true },
    { tool: "search_context", ok: true },
    { tool: "search_context", ok: true },
    { tool: "search_context", ok: false },
    { tool: "list_context", ok: true },
    { tool: "list_context", ok: true },
    { tool: "list_context", ok: true },
    { tool: "list_context", ok: false },
  ]);

  const hs = await computeHealthScore(ws);
  assert.equal(hs.components.benchmarkPassRate, 0.9);
  assert.equal(hs.components.safetyPassRate, 0.95);
  assert.ok(Math.abs(hs.components.feedbackUpRate - 0.75) < 1e-9);
  assert.ok(hs.components.avgToolReliability > 0.6 && hs.components.avgToolReliability <= 1);
  assert.equal(hs.components.chronicToolCount, 0);
  assert.equal(hs.components.conflictsLast24h, 0);
  assert.ok(hs.score > 0.5 && hs.score <= 0.85, `score ${hs.score}`);
  assert.ok(hs.status === "healthy" || hs.status === "warning", `status ${hs.status}`);
});

test("computeHealthScore: chronic failures are counted via chronicScore >= 8", async () => {
  const ws = `wsChronic-${Date.now()}`;
  // permission has weight 5, so 2 permission failures -> chronicScore 10 (>= 8) for tool A.
  await recordRunFailures(ws, [
    { tool: "toolA", category: "permission" },
    { tool: "toolA", category: "permission" },
  ]);
  // toolB: 1 network failure = weight 1 -> chronicScore 1 (< 8), should NOT count.
  await recordRunFailures(ws, [
    { tool: "toolB", category: "network" },
  ]);
  const hs = await computeHealthScore(ws);
  assert.equal(hs.components.chronicToolCount, 1);
});

test("computeHealthScore: only conflicts in last 24h are counted", async () => {
  const ws = `wsConflict-${Date.now()}`;
  // Record a recent conflict via the store (uses Date.now internally).
  await recordConflict(ws, {
    type: "polarity",
    similarity: 0.1,
    summary: "x",
    specialists: ["a", "b"],
    responses: [],
  });
  await recordConflict(ws, {
    type: "numeric",
    similarity: 0.2,
    summary: "y",
    specialists: ["a", "b"],
    responses: [],
  });
  const hs = await computeHealthScore(ws);
  assert.equal(hs.components.conflictsLast24h, 2);
});

test("emitHealthScoreMetric: calls setAgentHealthScore with the computed score", async () => {
  const ws = `wsMetric-${Date.now()}`;
  await recordSample(ws, { ts: Date.now(), kind: "benchmark", metrics: { passRate: 1 } });
  await recordSample(ws, { ts: Date.now(), kind: "safety", metrics: { passRate: 1 } });

  metrics.__resetAgentHealthScoreForTests();
  const score = await emitHealthScoreMetric(ws);
  assert.ok(score > 0);
  // Verify the gauge was set.
  assert.equal(metrics.__getAgentHealthScoreForTests(), score);
  // Verify it renders in Prometheus output with a workspace label.
  const out = metrics.renderPrometheus();
  assert.match(out, /# TYPE siskelbot_agent_health_score gauge/);
  const wsLabel = ws.replace(/[^a-zA-Z0-9_:]/g, "_").slice(0, 64);
  const re = new RegExp(`siskelbot_agent_health_score\\{workspace="${wsLabel}"\\} ${score.toFixed(4)}`);
  assert.match(out, re);
});

test("setAgentHealthScore: no-op when ENABLE_METRICS=0", async () => {
  const orig = process.env.ENABLE_METRICS;
  process.env.ENABLE_METRICS = "0";
  metrics.__resetAgentHealthScoreForTests();
  metrics.setAgentHealthScore(0.9, "wsDisabled");
  assert.equal(metrics.__getAgentHealthScoreForTests(), null);
  const out = metrics.renderPrometheus();
  assert.ok(!out.includes(`workspace="wsDisabled"`));
  if (orig !== undefined) process.env.ENABLE_METRICS = orig;
  else delete process.env.ENABLE_METRICS;
});

test("checkAndAlertHealthScore: flags a > 0.15 drop since last recorded sample", async () => {
  const ws = `wsDelta-${Date.now()}`;
  await __resetLastScoreForTests(ws);

  // Seed a healthy state: benchmark and safety both perfect -> score 0.50.
  await recordSample(ws, { ts: Date.now(), kind: "benchmark", metrics: { passRate: 1 } });
  await recordSample(ws, { ts: Date.now(), kind: "safety", metrics: { passRate: 1 } });
  // First call records the baseline and should not emit (status >= warning, no prev).
  const first = await checkAndAlertHealthScore(ws);
  assert.equal(first.emitted, false);

  // Degrade: add a run of down-votes so feedbackUpRate = 0 and safety drops.
  await recordSample(ws, { ts: Date.now(), kind: "safety", metrics: { passRate: 0.1 } });
  for (let i = 0; i < 5; i++) {
    await recordFeedback(ws, { runId: `bad${i}`, userId: "u", rating: "down" });
  }

  const second = await checkAndAlertHealthScore(ws);
  // Either critical or dropped — both should emit.
  assert.equal(second.emitted || second.reason?.startsWith("webhooks_import_failed") || second.reason?.startsWith("emit_failed"), true);
  assert.ok(second.score < first.score);
});

test("checkAndAlertHealthScore: returns emitted:false with no_alert when healthy & stable", async () => {
  const ws = `wsStable-${Date.now()}`;
  await __resetLastScoreForTests(ws);
  await recordSample(ws, { ts: Date.now(), kind: "benchmark", metrics: { passRate: 1 } });
  await recordSample(ws, { ts: Date.now(), kind: "safety", metrics: { passRate: 1 } });
  await recordToolOutcomes(ws, [
    { tool: "t1", ok: true }, { tool: "t1", ok: true }, { tool: "t1", ok: true },
  ]);
  for (let i = 0; i < 5; i++) {
    await recordFeedback(ws, { runId: `good${i}`, userId: "u", rating: "up" });
  }
  // Prime last-score storage.
  await checkAndAlertHealthScore(ws);
  // Second call: same data -> score stable, not critical -> no alert.
  const r = await checkAndAlertHealthScore(ws);
  assert.equal(r.emitted, false);
  assert.equal(r.reason, "no_alert");
});
