#!/usr/bin/env node
/**
 * CLI: install (and optionally start) the quality-jobs scheduler.
 *
 * Usage:
 *   node scripts/install-quality-jobs.js              # install only
 *   node scripts/install-quality-jobs.js --start      # install + start loop
 *   node scripts/install-quality-jobs.js --dry-run    # print plan, no writes
 *
 * Idempotent: running repeatedly preserves lastRunAt / enabled flags for
 * existing jobs.
 */

import {
  installAllJobs,
  startJobs,
  listJobs,
  qualityJobsEnabled,
} from "../lib/agent-quality-scheduler.js";

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    start: args.has("--start"),
    dryRun: args.has("--dry-run"),
    help: args.has("--help") || args.has("-h"),
  };
}

function printHelp() {
  process.stdout.write(
    [
      "install-quality-jobs — register recurring quality agents",
      "",
      "Options:",
      "  --start      After install, start the scheduler loop in this process.",
      "  --dry-run    Print what would be installed without writing state.",
      "  --help, -h   Show this help.",
      "",
      "Enable at runtime with QUALITY_JOBS_ENABLED=1.",
      "",
    ].join("\n"),
  );
}

function formatTable(jobs) {
  const header = ["Name", "Schedule", "Interval", "Enabled", "LastStatus", "LastRunAt"];
  const rows = jobs.map((j) => [
    j.name,
    j.schedule,
    formatInterval(j.intervalMs),
    j.enabled ? "yes" : "no",
    j.lastStatus,
    j.lastRunAt ? new Date(j.lastRunAt).toISOString() : "-",
  ]);
  const all = [header, ...rows];
  const widths = header.map((_, col) =>
    all.reduce((w, row) => Math.max(w, String(row[col] ?? "").length), 0),
  );
  const lines = all.map((row) =>
    row.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  "),
  );
  return lines.join("\n");
}

function formatInterval(ms) {
  if (!Number.isFinite(ms)) return "-";
  if (ms >= 7 * 86_400_000) return `${Math.round(ms / (7 * 86_400_000))}w`;
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${ms}ms`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.dryRun) {
    // Load the planned jobs without mutating state. We import the default
    // spec by calling listJobs after a no-state install — since dry-run
    // promises no writes, we peek via a fresh module load that reads state
    // but writes nothing. The cleanest way is to call installAllJobs into a
    // separate temp STORAGE_PATH, but the simplest is to echo the known spec.
    const planned = [
      { name: "nightly-benchmark", schedule: "nightly 02:00 UTC", intervalMs: 24 * 3_600_000, enabled: true, lastStatus: "idle" },
      { name: "weekly-safety", schedule: "weekly Sunday 03:00 UTC", intervalMs: 7 * 24 * 3_600_000, enabled: true, lastStatus: "idle" },
      { name: "daily-patch-synth", schedule: "daily 04:00 UTC", intervalMs: 24 * 3_600_000, enabled: true, lastStatus: "idle" },
      { name: "hourly-health-score", schedule: "hourly", intervalMs: 3_600_000, enabled: true, lastStatus: "idle" },
    ];
    process.stdout.write("DRY RUN — the following jobs would be installed:\n\n");
    process.stdout.write(formatTable(planned) + "\n");
    return 0;
  }

  const jobs = await installAllJobs();
  process.stdout.write(`Installed ${jobs.length} quality jobs:\n\n`);
  process.stdout.write(formatTable(jobs) + "\n");

  if (args.start) {
    if (!qualityJobsEnabled()) {
      process.stderr.write(
        "\nWARNING: QUALITY_JOBS_ENABLED is not set to 1. --start will still run the loop, " +
          "but the server-boot path skips activation unless this env var is set in production.\n",
      );
    }
    await startJobs();
    process.stdout.write("\nScheduler started. Press Ctrl+C to stop.\n");
    // Keep process alive.
    process.stdin.resume();
  }
  return 0;
}

main().then(
  (code) => process.exit(code || 0),
  (err) => {
    process.stderr.write(`install-quality-jobs failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  },
);
