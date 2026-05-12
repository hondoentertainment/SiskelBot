#!/usr/bin/env node
/**
 * Load test script for SiskelBot.
 *
 * Usage:
 *   node scripts/load-test.mjs [options]
 *
 * Options:
 *   --url=<url>                  Target server URL (default: http://localhost:3000)
 *   --duration=<sec>             Test duration in seconds (default: 30)
 *   --concurrency=<n>            Number of concurrent workers (default: 10)
 *   --rps=<n>                    Target requests per second (default: 50)
 *   --max-error-rate=<pct>       Max acceptable error rate, percent (default: 5)
 *   --max-p99=<ms>               Max acceptable p99 latency, ms (default: 2000)
 *   --json-output=<path>         Write structured results JSON to this path
 *   --baseline=<path>            Compare against a previous results JSON. Fails when
 *                                p99 regressed >30% or errorRate regressed >100%.
 *                                Missing files are warned about (not fatal).
 *   --update-baseline=<path>     After a passing run, write current results to this
 *                                path so CI can refresh the baseline post-merge.
 *   --help                       Print this help.
 *
 * Baseline note:
 *   The committed baseline at tests/load-baseline.json should be regenerated
 *   periodically by running this script with --update-baseline=tests/load-baseline.json
 *   against a stable build, then committing the result. See the load-baseline.yml
 *   GitHub Actions workflow which automates this via manual dispatch.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node scripts/load-test.mjs [options]

Options:
  --url=<url>                  Target server URL (default: http://localhost:3000)
  --duration=<sec>             Test duration in seconds (default: 30)
  --concurrency=<n>            Number of concurrent workers (default: 10)
  --rps=<n>                    Target requests per second (default: 50)
  --max-error-rate=<pct>       Max acceptable error rate, percent (default: 5)
  --max-p99=<ms>               Max acceptable p99 latency, ms (default: 2000)
  --json-output=<path>         Write structured results JSON to this path
  --baseline=<path>            Compare against a previous results JSON
  --update-baseline=<path>     After a passing run, write results to this path
  --help                       Print this help`);
}

function parseArgs(argv) {
  const defaults = {
    url: 'http://localhost:3000',
    duration: 30,
    concurrency: 10,
    rps: 50,
    maxErrorRate: 5,
    maxP99: 2000,
    jsonOutput: null,
    baseline: null,
    updateBaseline: null,
    help: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      defaults.help = true;
      continue;
    }
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (!m) {
      // Bare flags handled above, otherwise warn.
      if (arg.startsWith('--')) {
        console.error(`Unknown or malformed argument: ${arg}`);
      }
      continue;
    }
    const [, key, val] = m;
    if (key === 'url') defaults.url = val;
    else if (key === 'duration') defaults.duration = Number(val);
    else if (key === 'concurrency') defaults.concurrency = Number(val);
    else if (key === 'rps') defaults.rps = Number(val);
    else if (key === 'max-error-rate') defaults.maxErrorRate = Number(val);
    else if (key === 'max-p99') defaults.maxP99 = Number(val);
    else if (key === 'json-output') defaults.jsonOutput = val;
    else if (key === 'baseline') defaults.baseline = val;
    else if (key === 'update-baseline') defaults.updateBaseline = val;
    else console.error(`Unknown argument: --${key}`);
  }
  return defaults;
}

const opts = parseArgs(process.argv);

if (opts.help) {
  printHelp();
  process.exit(0);
}

if (!Number.isFinite(opts.duration) || opts.duration <= 0) {
  console.error('Invalid --duration: must be a positive number');
  printHelp();
  process.exit(2);
}
if (!Number.isFinite(opts.concurrency) || opts.concurrency <= 0) {
  console.error('Invalid --concurrency: must be a positive number');
  printHelp();
  process.exit(2);
}
if (!Number.isFinite(opts.rps) || opts.rps <= 0) {
  console.error('Invalid --rps: must be a positive number');
  printHelp();
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Endpoint definitions (weighted)
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  // Keep this mix to fast, deterministic routes. LLM proxy (/v1/chat/completions) is
  // intentionally omitted: CI uses BACKEND=ollama without a reachable model and those
  // requests time out, inflating p99 and error rate unrelated to HTTP handler perf.
  { method: 'GET', path: '/health/live', weight: 50 },
  { method: 'GET', path: '/config', weight: 35 },
  { method: 'GET', path: '/api/context?workspace=default', weight: 15 },
];

// Build a cumulative-weight lookup for weighted random selection.
const totalWeight = ENDPOINTS.reduce((s, e) => s + e.weight, 0);
const cumulative = [];
let running = 0;
for (const ep of ENDPOINTS) {
  running += ep.weight;
  cumulative.push({ threshold: running / totalWeight, endpoint: ep });
}

function pickEndpoint() {
  const r = Math.random();
  for (const c of cumulative) {
    if (r < c.threshold) return c.endpoint;
  }
  return cumulative[cumulative.length - 1].endpoint;
}

// ---------------------------------------------------------------------------
// Token bucket rate limiter
// ---------------------------------------------------------------------------

class TokenBucket {
  constructor(rps) {
    this.capacity = rps;
    this.tokens = rps;
    this.interval = 1000 / rps;
    this.last = Date.now();
  }

  async acquire() {
    while (true) {
      const now = Date.now();
      const elapsed = now - this.last;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed / this.interval);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Wait a bit before retrying.
      await new Promise((r) => setTimeout(r, Math.ceil(this.interval)));
    }
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const latencies = [];
let totalRequests = 0;
let successCount = 0;
let clientErrors = 0;
let serverErrors = 0;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------------------

async function warmUp(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health/live`);
    if (!res.ok) {
      console.error(`Warm-up failed: ${res.status}`);
      process.exit(1);
    }
    console.log('Warm-up request succeeded.');
  } catch (err) {
    console.error(`Warm-up failed: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function worker(baseUrl, bucket, endTime) {
  while (Date.now() < endTime) {
    await bucket.acquire();
    if (Date.now() >= endTime) break;

    const ep = pickEndpoint();
    const url = `${baseUrl}${ep.path}`;
    const fetchOpts = { method: ep.method };
    if (ep.body) fetchOpts.body = ep.body;
    if (ep.headers) fetchOpts.headers = ep.headers;

    const start = performance.now();
    try {
      const res = await fetch(url, fetchOpts);
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
      totalRequests++;

      const status = res.status;
      if (status >= 200 && status < 300) successCount++;
      else if (status >= 400 && status < 500) clientErrors++;
      else if (status >= 500) serverErrors++;
      else successCount++; // 3xx treated as success

      // Consume body to free resources.
      await res.text().catch(() => {});
    } catch {
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
      totalRequests++;
      serverErrors++;
    }
  }
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------

const BASELINE_P99_REGRESSION_PCT = 30; // fail if p99 grew by >30%
const BASELINE_ERROR_RATE_REGRESSION_PCT = 100; // fail if errorRate grew by >100%

function loadBaseline(path) {
  if (!path) return null;
  if (!existsSync(path)) {
    console.warn(`[load-test] WARN: baseline file not found at ${path} - skipping baseline comparison`);
    return null;
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.warn(`[load-test] WARN: failed to read baseline ${path}: ${err.message}`);
    return null;
  }
}

function compareToBaseline(current, baseline) {
  // Returns array of failure messages (empty if no regression).
  const failures = [];
  if (!baseline) return failures;

  const basep99 = baseline?.latency?.p99;
  if (Number.isFinite(basep99) && basep99 > 0) {
    const allowed = basep99 * (1 + BASELINE_P99_REGRESSION_PCT / 100);
    if (current.latency.p99 > allowed) {
      const growthPct = ((current.latency.p99 - basep99) / basep99) * 100;
      failures.push(
        `p99 regressed: ${current.latency.p99}ms vs baseline ${basep99}ms (+${growthPct.toFixed(1)}%, threshold +${BASELINE_P99_REGRESSION_PCT}%)`,
      );
    }
  }

  const baseErr = baseline?.errorRate;
  if (Number.isFinite(baseErr)) {
    if (baseErr === 0) {
      // If baseline had zero errors, any non-trivial current error rate is treated
      // as the absolute threshold gate (handled separately). Skip relative check.
    } else {
      const allowed = baseErr * (1 + BASELINE_ERROR_RATE_REGRESSION_PCT / 100);
      if (current.errorRate > allowed) {
        const growthPct = ((current.errorRate - baseErr) / baseErr) * 100;
        failures.push(
          `errorRate regressed: ${(current.errorRate * 100).toFixed(2)}% vs baseline ${(baseErr * 100).toFixed(2)}% (+${growthPct.toFixed(1)}%, threshold +${BASELINE_ERROR_RATE_REGRESSION_PCT}%)`,
        );
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const {
    url,
    duration,
    concurrency,
    rps,
    maxErrorRate,
    maxP99,
    jsonOutput,
    baseline,
    updateBaseline,
  } = opts;

  console.log(
    `Starting load test: ${url} for ${duration}s with ${concurrency} workers @ ${rps} rps`,
  );

  await warmUp(url);

  const bucket = new TokenBucket(rps);
  const endTime = Date.now() + duration * 1000;

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker(url, bucket, endTime));
  }
  await Promise.all(workers);

  // Compute stats.
  const sorted = latencies.slice().sort((a, b) => a - b);
  const p50 = Math.round(percentile(sorted, 50));
  const p95 = Math.round(percentile(sorted, 95));
  const p99 = Math.round(percentile(sorted, 99));
  const max = Math.round(sorted.length ? sorted[sorted.length - 1] : 0);
  const throughput = totalRequests / duration;
  const errors = clientErrors + serverErrors;
  // errorRate as fraction in [0,1] (matches JSON schema in task spec).
  const errorRateFraction = totalRequests > 0 ? errors / totalRequests : 0;
  const errorRatePct = errorRateFraction * 100;
  const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;

  // Print results.
  const fmt = (n) => n.toLocaleString('en-US');
  console.log('');
  console.log(`Load Test Results (${duration}s, ${concurrency} workers)`);
  console.log('─'.repeat(35));
  console.log(`Total requests:  ${fmt(totalRequests)}`);
  console.log(`Successful:      ${fmt(successCount)} (${successRate.toFixed(1)}%)`);
  console.log(
    `Client errors:   ${fmt(clientErrors)} (${(totalRequests > 0 ? (clientErrors / totalRequests) * 100 : 0).toFixed(1)}%)`,
  );
  console.log(
    `Server errors:   ${fmt(serverErrors)} (${(totalRequests > 0 ? (serverErrors / totalRequests) * 100 : 0).toFixed(1)}%)`,
  );
  console.log('');
  console.log('Latency (ms):');
  console.log(`  p50:  ${p50}`);
  console.log(`  p95:  ${p95}`);
  console.log(`  p99:  ${p99}`);
  console.log(`  max:  ${max}`);
  console.log('');
  console.log(`Throughput: ${throughput.toFixed(1)} req/s`);

  // Build the structured result object (used by --json-output and baseline writers).
  // maxErrorRate is in percent on the CLI; store as fraction in JSON for baseline math.
  const maxErrorRateFraction = maxErrorRate / 100;
  const structured = {
    timestamp: new Date().toISOString(),
    url,
    duration,
    concurrency,
    rps,
    totalRequests,
    successful: successCount,
    clientErrors,
    serverErrors,
    errors,
    errorRate: Number(errorRateFraction.toFixed(6)),
    latency: { p50, p95, p99, max },
    throughput: Number(throughput.toFixed(1)),
    thresholds: { maxErrorRate: maxErrorRateFraction, maxP99Ms: maxP99 },
    passed: false,
    failures: [],
  };

  // Always write the legacy results file (kept for backward compat with
  // existing CI artifact uploads).
  const legacyOutPath = resolve('load-test-results.json');
  writeFileSync(
    legacyOutPath,
    JSON.stringify(
      {
        timestamp: structured.timestamp,
        config: { url, duration, concurrency, rps },
        totals: {
          requests: totalRequests,
          successful: successCount,
          clientErrors,
          serverErrors,
        },
        latency: { p50, p95, p99, max },
        throughput: structured.throughput,
        errorRate: Number(errorRatePct.toFixed(2)),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nLegacy results written to ${legacyOutPath}`);

  // Determine threshold failures (absolute).
  const failures = [];
  let p99Failure = null;
  let errFailure = null;
  if (errorRatePct > maxErrorRate) {
    errFailure = `errorRate=${errorRatePct.toFixed(2)}% exceeds ${maxErrorRate}%`;
    failures.push(errFailure);
  }
  if (p99 > maxP99) {
    p99Failure = `p99=${p99}ms exceeds ${maxP99}ms`;
    failures.push(p99Failure);
  }

  // Baseline comparison failures.
  const baselineData = loadBaseline(baseline);
  if (baselineData) {
    const baselineFailures = compareToBaseline(structured, baselineData);
    failures.push(...baselineFailures);
    if (baselineFailures.length === 0) {
      console.log(`\n[load-test] baseline OK (vs ${baseline})`);
    }
  }

  structured.passed = failures.length === 0;
  structured.failures = failures;

  // Write structured JSON output if requested.
  if (jsonOutput) {
    const outPath = resolve(jsonOutput);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(structured, null, 2) + '\n');
    console.log(`Structured results written to ${outPath}`);
  }

  // Format the canonical PASS/FAIL summary.
  if (structured.passed) {
    console.log(
      `\n[load-test] PASS: errorRate=${errorRatePct.toFixed(2)}% (max ${maxErrorRate.toFixed(2)}%), p99=${p99}ms (max ${maxP99}ms)`,
    );

    // Update the baseline only on a passing run.
    if (updateBaseline) {
      const outPath = resolve(updateBaseline);
      mkdirSync(dirname(outPath), { recursive: true });
      const baselineWrite = {
        url: structured.url,
        duration: structured.duration,
        totalRequests: structured.totalRequests,
        errors: structured.errors,
        errorRate: structured.errorRate,
        latency: structured.latency,
        thresholds: structured.thresholds,
        passed: true,
        updatedAt: structured.timestamp,
      };
      writeFileSync(outPath, JSON.stringify(baselineWrite, null, 2) + '\n');
      console.log(`[load-test] Updated baseline at ${outPath}`);
    }
    process.exit(0);
  } else {
    const summary = failures.join(' / ');
    console.error(`\n[load-test] FAIL: ${summary}`);
    console.error('Exit code 1');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
