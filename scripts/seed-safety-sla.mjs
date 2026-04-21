#!/usr/bin/env node
/**
 * Seed lib/safety-sla.js with N days of backfill records.
 *
 * Usage:
 *   node scripts/seed-safety-sla.mjs [--days=90] [--per-day=50]
 *                                    [--classifier=jailbreak]
 *                                    [--precision-target=0.95]
 *                                    [--recall-target=0.90]
 *                                    [--seed=1] [--dry-run]
 *
 * Without --classifier the seeder runs the four built-in safety
 * classifiers (jailbreak, pii-leak, hallucination, brand-safety).
 *
 * The records are synthetic — drawn from a configurable error rate so the
 * dashboard has plausible-shaped data on day one. For real backfill,
 * pipe production traces through `node scripts/seed-safety-sla.mjs
 * --from-stdin` (each line: JSON `{classifierId, prediction, actual,
 * timestamp}`).
 */
import { recordClassification, setSlaTarget } from "../lib/safety-sla.js";
import { stdin as input } from "node:process";
import { createInterface } from "node:readline";

const DEFAULT_CLASSIFIERS = [
  { classifierId: "jailbreak", baseErr: 0.04, fnRate: 0.06 },
  { classifierId: "pii-leak", baseErr: 0.02, fnRate: 0.05 },
  { classifierId: "hallucination", baseErr: 0.08, fnRate: 0.10 },
  { classifierId: "brand-safety", baseErr: 0.03, fnRate: 0.07 },
];

function parseArgs(argv) {
  const opts = {
    days: 90,
    perDay: 50,
    classifier: null,
    precisionTarget: 0.95,
    recallTarget: 0.9,
    seed: 1,
    dryRun: false,
    fromStdin: false,
  };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--from-stdin") opts.fromStdin = true;
    else if (a.startsWith("--days=")) opts.days = Number(a.slice(7));
    else if (a.startsWith("--per-day=")) opts.perDay = Number(a.slice(10));
    else if (a.startsWith("--classifier=")) opts.classifier = a.slice(13);
    else if (a.startsWith("--precision-target="))
      opts.precisionTarget = Number(a.slice(19));
    else if (a.startsWith("--recall-target="))
      opts.recallTarget = Number(a.slice(16));
    else if (a.startsWith("--seed=")) opts.seed = Number(a.slice(7));
  }
  return opts;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function* syntheticSamples(classifier, days, perDay, rng) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  for (let d = days; d >= 1; d -= 1) {
    const dayStart = now - d * dayMs;
    for (let i = 0; i < perDay; i += 1) {
      const actual = rng() < 0.25;
      const errorChance = actual ? classifier.fnRate : classifier.baseErr;
      const noisy = rng() < errorChance;
      const prediction = noisy ? !actual : actual;
      const timestamp = dayStart + Math.floor(rng() * dayMs);
      yield {
        classifierId: classifier.classifierId,
        prediction,
        actual,
        timestamp,
      };
    }
  }
}

async function readStdinSamples() {
  const rl = createInterface({ input });
  const out = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      console.warn(`skipping malformed line: ${trimmed.slice(0, 80)}`);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  const list = opts.classifier
    ? DEFAULT_CLASSIFIERS.filter((c) => c.classifierId === opts.classifier)
    : DEFAULT_CLASSIFIERS;
  if (list.length === 0) {
    console.error(`unknown classifier: ${opts.classifier}`);
    process.exitCode = 1;
    return;
  }

  if (opts.fromStdin) {
    const samples = await readStdinSamples();
    if (opts.dryRun) {
      console.log(`would record ${samples.length} stdin samples`);
      return;
    }
    let n = 0;
    for (const s of samples) {
      try {
        await recordClassification(s);
        n += 1;
      } catch (err) {
        console.warn(`skip: ${err.message}`);
      }
    }
    console.log(`recorded ${n} stdin samples`);
    return;
  }

  for (const cls of list) {
    if (!opts.dryRun) {
      await setSlaTarget({
        classifierId: cls.classifierId,
        precisionTarget: opts.precisionTarget,
        recallTarget: opts.recallTarget,
      });
    }
  }

  let total = 0;
  for (const cls of list) {
    const rng = mulberry32(opts.seed + cls.classifierId.length);
    let n = 0;
    for (const s of syntheticSamples(cls, opts.days, opts.perDay, rng)) {
      if (!opts.dryRun) await recordClassification(s);
      n += 1;
    }
    total += n;
    console.log(
      `${cls.classifierId}: ${opts.dryRun ? "would record" : "recorded"} ${n} samples (${opts.days}d × ${opts.perDay}/day)`
    );
  }
  console.log(`total: ${total}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
