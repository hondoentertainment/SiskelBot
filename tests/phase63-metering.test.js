/**
 * Phase 63 metering tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-phase63-meter-"));
process.env.STORAGE_PATH = TMP;

const { meterPhase63Operation } = await import("../lib/phase63-metering.js");
const { getRecordsForPeriod } = await import("../lib/usage-tracker.js");
const { listSamples } = await import("../lib/eval-history-store.js");
const { querySamples } = await import("../lib/eval-in-prod.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("meterPhase63Operation records usage and eval-history sample", async () => {
  await meterPhase63Operation({
    workspaceId: "ws-meter",
    feature: "pr-review",
    calls: 1,
    units: 3,
    tags: { reviewId: "abc" },
  });

  const records = await getRecordsForPeriod(1, { workspace: "ws-meter" });
  const hit = records.find((r) => r.feature === "pr-review");
  assert.ok(hit);
  assert.equal(hit.calls, 1);
  assert.equal(hit.model, "pr-review");
  assert.equal(hit.backend, "phase63");

  const samples = await listSamples("ws-meter", { limit: 10 });
  assert.ok(samples.some((s) => s.suite === "phase63" && s.tags?.feature === "pr-review"));
});

test("meterPhase63Operation ignores unknown features", async () => {
  await meterPhase63Operation({ workspaceId: "ws-skip", feature: "unknown-feature", calls: 1 });
  const records = await getRecordsForPeriod(1, { workspace: "ws-skip" });
  assert.equal(records.length, 0);
});

test("meterPhase63Operation records eval-in-prod sample when qualitySignal present", async () => {
  await meterPhase63Operation({
    workspaceId: "ws-quality",
    feature: "test-gen",
    calls: 1,
    units: 2,
    metadata: {
      qualitySignal: { prod: "baseline", candidate: "candidate" },
    },
  });

  const { samples } = await querySamples({ workspaceId: "ws-quality", limit: 10 });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].metadata?.subject, "test-gen");
  assert.equal(samples[0].metadata?.suite, "phase63");
});
