/**
 * Phase 63 default pricing rules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-phase63-pricing-"));
process.env.STORAGE_PATH = TMP;

const { ensurePhase63PricingRules } = await import("../lib/phase63-pricing.js");
const { listPricingRules } = await import("../lib/pricing-engine.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("ensurePhase63PricingRules creates call rules once per feature", async () => {
  await ensurePhase63PricingRules("ws-pricing");
  await ensurePhase63PricingRules("ws-pricing");
  const rules = await listPricingRules("ws-pricing");
  const phase63 = rules.filter((r) => ["pr-review", "repo-rag", "test-gen"].includes(r.modelId));
  assert.equal(phase63.length, 3);
  assert.ok(phase63.every((r) => r.unit === "call"));
});
