#!/usr/bin/env node
/**
 * CLI: run the mini benchmark suite against a real LLM backend.
 *
 * Examples:
 *   node scripts/run-benchmark-real.js --backend openai --model gpt-4o-mini
 *   node scripts/run-benchmark-real.js --backend anthropic --model claude-sonnet-4-5 --record
 *   node scripts/run-benchmark-real.js --backend ollama --model llama3:8b --output out.json
 *   node scripts/run-benchmark-real.js --backend siskelbot-proxy --model gpt-4o \
 *       --baseUrl http://localhost:3000 --baseline-from <prior-sample-id>
 *
 * This script is data collection, NOT a gate. A low pass-rate is not treated
 * as an error. Exit 2 is reserved for script/infrastructure failures (bad
 * argv, suite load failure, or the harness itself throwing).
 */
import { writeFileSync } from "node:fs";
import { runBenchmarkSuite } from "../lib/benchmark-harness.js";
import { getSuite } from "../lib/benchmark-suites/mini-tasks.js";
import { buildRealAgent } from "../lib/benchmark-real-agent.js";
import { recordSample, listSamples } from "../lib/eval-history-store.js";

const VALID_BACKENDS = new Set(["openai", "anthropic", "ollama", "vllm", "siskelbot-proxy"]);

function parseArgs(argv) {
  const out = {
    backend: null,
    model: null,
    suite: "mini",
    workspace: "default",
    output: null,
    concurrency: 1,
    baseUrl: null,
    record: false,
    baselineFrom: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--backend": out.backend = next; i++; break;
      case "--model": out.model = next; i++; break;
      case "--suite": out.suite = next; i++; break;
      case "--workspace": out.workspace = next; i++; break;
      case "--output": out.output = next; i++; break;
      case "--baseUrl":
      case "--base-url":
        out.baseUrl = next; i++; break;
      case "--concurrency":
        out.concurrency = Math.max(1, Math.min(4, parseInt(next, 10) || 1));
        i++; break;
      case "--record": out.record = true; break;
      case "--baseline-from": out.baselineFrom = next; i++; break;
      case "--help":
      case "-h":
        out.help = true; break;
      default:
        if (a.startsWith("--")) {
          console.error("Unknown flag:", a);
          out.help = true;
        }
    }
  }
  return out;
}

function printHelp() {
  console.log(
    "Usage: node scripts/run-benchmark-real.js --backend <b> --model <m> [options]\n\n" +
    "Required:\n" +
    "  --backend <openai|anthropic|ollama|vllm|siskelbot-proxy>\n" +
    "  --model <model-name>\n\n" +
    "Options:\n" +
    "  --suite <name>            Suite to run (default: mini)\n" +
    "  --workspace <name>        Workspace for recording (default: default)\n" +
    "  --baseUrl <url>           Override backend base URL\n" +
    "  --concurrency <N>         1-4 (default: 1). Higher risks rate limits.\n" +
    "  --output <path.json>      Write the full report to this JSON file\n" +
    "  --record                  Write aggregate to eval-history-store\n" +
    "  --baseline-from <id>      Compare against a prior recorded sample id\n" +
    "  -h, --help                Show this help\n\n" +
    "API keys are read from env: OPENAI_API_KEY, ANTHROPIC_API_KEY. Never logged."
  );
}

function formatTable(results) {
  const rows = [["TASK", "PASS", "TESTS", "DUR(ms)", "ERROR"]];
  for (const r of results) {
    rows.push([
      r.taskId,
      r.passed ? "ok" : "fail",
      `${r.passedTests}/${r.totalTests}`,
      String(r.durationMs),
      r.error ? r.error.slice(0, 40) : "",
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => String(row[i]).length)));
  return rows
    .map((row) => row.map((c, i) => String(c).padEnd(widths[i])).join("  "))
    .join("\n");
}

function formatDelta(baseline, current) {
  if (!baseline || !baseline.metrics) return "(no baseline metrics)";
  const b = baseline.metrics;
  const c = current;
  const passDelta = (c.passRate || 0) - (b.passRate || 0);
  const durDelta = (c.avgDurationMs || 0) - (b.avgDurationMs || 0);
  const passStr = `${passDelta >= 0 ? "+" : ""}${(passDelta * 100).toFixed(1)}pp`;
  const durStr = `${durDelta >= 0 ? "+" : ""}${durDelta}ms`;
  const passedDelta = (c.passed || 0) - (b.passed || 0);
  return `passRate: ${(b.passRate * 100).toFixed(1)}% → ${(c.passRate * 100).toFixed(1)}% (${passStr})  ` +
    `passed: ${b.passed}/${b.total} → ${c.passed}/${c.total} (${passedDelta >= 0 ? "+" : ""}${passedDelta})  ` +
    `avgDur: ${b.avgDurationMs}ms → ${c.avgDurationMs}ms (${durStr})`;
}

async function findBaseline(workspace, sampleId, suite, backend, model) {
  // Pull recent samples; the id match is preferred but we also accept
  // "latest" to mean the most recent benchmark sample for this suite/backend.
  const samples = await listSamples(workspace, {
    kind: "benchmark",
    suite,
    limit: 200,
  });
  if (sampleId === "latest") {
    return samples.find((s) =>
      s.tags && s.tags.backend === backend && s.tags.model === model
    ) || samples[0] || null;
  }
  return samples.find((s) => s.id === sampleId) || null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  if (!args.backend || !VALID_BACKENDS.has(args.backend)) {
    console.error("Error: --backend must be one of", [...VALID_BACKENDS].join(", "));
    printHelp();
    process.exit(2);
  }
  if (!args.model) {
    console.error("Error: --model is required");
    printHelp();
    process.exit(2);
  }

  let suite;
  try {
    suite = getSuite(args.suite);
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(2);
  }

  let agent;
  try {
    agent = buildRealAgent({
      backend: args.backend,
      model: args.model,
      baseUrl: args.baseUrl || undefined,
    });
  } catch (e) {
    console.error("Error building agent:", e.message);
    process.exit(2);
  }

  console.log(
    `Running suite "${args.suite}" (${suite.length} tasks) against ` +
    `${args.backend}/${args.model}  concurrency=${args.concurrency}`
  );

  const started = Date.now();
  let taskResults, aggregate;
  try {
    const result = await runBenchmarkSuite(suite, agent, { concurrency: args.concurrency });
    taskResults = result.taskResults;
    aggregate = result.aggregate;
  } catch (e) {
    console.error("Fatal: benchmark suite threw:", e && e.message ? e.message : e);
    process.exit(2);
  }
  const wallMs = Date.now() - started;

  console.log("");
  console.log(formatTable(taskResults));
  console.log("");
  console.log(
    `Aggregate: passed=${aggregate.passed}/${aggregate.total} ` +
    `(${(aggregate.passRate * 100).toFixed(1)}%) ` +
    `avg=${aggregate.avgDurationMs}ms p50=${aggregate.p50Duration}ms p95=${aggregate.p95Duration}ms ` +
    `wall=${wallMs}ms`
  );

  const report = {
    suite: args.suite,
    agent: { backend: args.backend, model: args.model, baseUrl: args.baseUrl || null },
    concurrency: args.concurrency,
    startedAt: new Date(started).toISOString(),
    wallMs,
    aggregate,
    taskResults,
  };

  if (args.output) {
    writeFileSync(args.output, JSON.stringify(report, null, 2));
    console.log("Wrote", args.output);
  }

  if (args.record) {
    try {
      const saved = await recordSample(args.workspace, {
        ts: Date.now(),
        kind: "benchmark",
        suite: args.suite,
        metrics: {
          passRate: aggregate.passRate,
          total: aggregate.total,
          passed: aggregate.passed,
          avgDurationMs: aggregate.avgDurationMs,
        },
        tags: { backend: args.backend, model: args.model },
      });
      console.log(`Recorded sample id=${saved.id} in workspace=${args.workspace}`);
    } catch (e) {
      console.error("Warning: recordSample failed:", e.message);
    }
  }

  if (args.baselineFrom) {
    try {
      const baseline = await findBaseline(
        args.workspace, args.baselineFrom, args.suite, args.backend, args.model
      );
      if (!baseline) {
        console.log(`Baseline: no sample matching "${args.baselineFrom}" found in workspace "${args.workspace}".`);
      } else {
        console.log(`Baseline ${baseline.id} (${new Date(baseline.ts).toISOString()}):`);
        console.log("  " + formatDelta(baseline, aggregate));
      }
    } catch (e) {
      console.error("Warning: baseline lookup failed:", e.message);
    }
  }

  // Data collection, not a gate. Low pass-rate is NOT an error.
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e && e.stack ? e.stack : e);
  process.exit(2);
});
