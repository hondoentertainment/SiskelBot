import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePromptPerturbations, scoreFuzzRun } from "../lib/agent-fuzz.js";
import { clusterTrajectories, trajectorySignature } from "../lib/trajectory-anomaly.js";
import { generatePostMortem } from "../lib/post-mortem.js";
import { resolveStagnationIntervention } from "../lib/agent-stagnation.js";
import { findMemoryConflicts } from "../lib/agent-memory.js";
import { assertPromotionGate } from "../lib/model-promotion-gate.js";

describe("phase 72-80 roadmap modules", () => {
  it("fuzz generates perturbations", () => {
    const p = generatePromptPerturbations("Hello world", { count: 4, seed: 2 });
    assert.equal(p.length, 4);
    assert.ok(p.every((x) => typeof x === "string" && x.length > 0));
  });

  it("fuzz scores stagnation", () => {
    const log = Array.from({ length: 6 }, () => ({ name: "search", args: { q: "x" } }));
    const s = scoreFuzzRun({ toolCallsLog: log, iterations: 6, maxIterations: 10 });
    assert.equal(s.stagnant, true);
    assert.equal(s.ok, false);
  });

  it("clusters rare trajectories as anomalies", () => {
    const common = { stopReason: "complete", iteration: 2, toolCalls: [{ name: "a", args: {} }] };
    const rare = { stopReason: "stagnation", iteration: 9, toolCalls: [{ name: "b", args: { z: 1 } }] };
    const r = clusterTrajectories([common, common, common, rare], { rareThreshold: 1 });
    assert.ok(r.anomalies.length >= 1);
    assert.ok(trajectorySignature(rare).length === 16);
  });

  it("post-mortem summarizes failures", () => {
    const pm = generatePostMortem({
      runId: "r1",
      stopReason: "stagnation",
      iteration: 5,
      toolCalls: [{ name: "x", ok: false, error: "nope" }],
    });
    assert.match(pm.summary, /stagnation/);
    assert.ok(pm.rootCauses.length >= 1);
  });

  it("stagnation pattern library resolves intervention", () => {
    const i = resolveStagnationIntervention({ stagnant: true, reason: "exact_cycle: 2-cycle" });
    assert.equal(i.patternId, "exact_cycle");
    assert.ok(i.intervention);
  });

  it("detects memory negation conflicts", () => {
    const c = findMemoryConflicts([
      { id: "1", category: "fact", content: "The API is public" },
      { id: "2", category: "fact", content: "The API is not public" },
    ]);
    assert.equal(c.length, 1);
  });

  it("promotion gate skips unless enabled", async () => {
    delete process.env.MODEL_PROMOTION_GATE;
    const r = await assertPromotionGate({ modelId: "m", version: "1" });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });
});
