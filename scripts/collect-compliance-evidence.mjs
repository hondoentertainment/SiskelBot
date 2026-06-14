#!/usr/bin/env node
/**
 * P3 compliance automation: collect and persist SOC2 evidence snapshot.
 *
 * Usage: node scripts/collect-compliance-evidence.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.STORAGE_PATH) {
  process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "siskel-compliance-"));
}

const { collectAndSave } = await import("../lib/compliance-evidence.js");

const { evidence, key } = await collectAndSave();
console.log(JSON.stringify({ saved: key, collectedAt: evidence?.collectedAt, version: evidence?.version }, null, 2));
