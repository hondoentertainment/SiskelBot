#!/usr/bin/env node
/**
 * Wrapper for lib/chaos-drill.js. Suitable for cron / k8s CronJob /
 * GitHub Actions schedule.
 *
 * Usage:
 *   CHAOS_DRILL_ENABLE=1 node scripts/run-chaos-drill.mjs [--backend=name] [--failures=N]
 *
 * Exits non-zero when the drill assertions fail. Prints a JSON summary
 * to stdout.
 */
import { runChaosDrill } from "../lib/chaos-drill.js";

function parseArgs(argv) {
  const opts = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--backend=")) opts.backend = a.slice(10);
    else if (a.startsWith("--failures=")) opts.failures = Number(a.slice(11));
  }
  return opts;
}

const opts = parseArgs(process.argv);
const result = await runChaosDrill(opts);
console.log(JSON.stringify(result, null, 2));
if (result.summary && result.summary.skipped) {
  process.exit(0);
}
process.exit(result.ok ? 0 : 1);
