import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/seed-safety-sla.mjs");

test("seed-safety-sla --dry-run reports per-classifier counts", () => {
  const res = spawnSync(
    process.execPath,
    [script, "--days=2", "--per-day=4", "--dry-run"],
    { encoding: "utf8" }
  );
  assert.equal(res.status, 0);
  assert.match(res.stdout, /jailbreak:.*8 samples/);
  assert.match(res.stdout, /total: 32/);
});

test("seed-safety-sla writes records and computeMetrics sees them", async () => {
  const TMP = mkdtempSync(join(tmpdir(), "siskel-seed-sla-"));
  try {
    const res = spawnSync(
      process.execPath,
      [
        script,
        "--days=3",
        "--per-day=10",
        "--classifier=jailbreak",
        "--seed=42",
      ],
      { encoding: "utf8", env: { ...process.env, STORAGE_PATH: TMP } }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /jailbreak: recorded 30 samples/);

    process.env.STORAGE_PATH = TMP;
    const { computeMetrics, getSlaTarget } = await import(
      `../lib/safety-sla.js?cb=${Date.now()}`
    );
    const target = await getSlaTarget("jailbreak");
    assert.ok(target);
    assert.equal(target.precisionTarget, 0.95);
    const metrics = await computeMetrics({ classifierId: "jailbreak" });
    assert.equal(metrics.total, 30);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
});

test("seed-safety-sla rejects unknown classifier", () => {
  const res = spawnSync(
    process.execPath,
    [script, "--classifier=does-not-exist", "--dry-run"],
    { encoding: "utf8" }
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown classifier/);
});
