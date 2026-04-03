#!/usr/bin/env node
/**
 * Load test script for SiskelBot.
 *
 * Usage:
 *   node scripts/load-test.mjs [--url=http://localhost:3000] [--duration=30]
 *     [--concurrency=10] [--rps=50] [--max-error-rate=5] [--max-p99=2000]
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const defaults = {
    url: 'http://localhost:3000',
    duration: 30,
    concurrency: 10,
    rps: 50,
    maxErrorRate: 5,
    maxP99: 2000,
  };
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--(\w[\w-]*)=(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'url') defaults.url = val;
    else if (key === 'duration') defaults.duration = Number(val);
    else if (key === 'concurrency') defaults.concurrency = Number(val);
    else if (key === 'rps') defaults.rps = Number(val);
    else if (key === 'max-error-rate') defaults.maxErrorRate = Number(val);
    else if (key === 'max-p99') defaults.maxP99 = Number(val);
  }
  return defaults;
}

const opts = parseArgs(process.argv);

// ---------------------------------------------------------------------------
// Endpoint definitions (weighted)
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  { method: 'GET', path: '/health/live', weight: 40 },
  { method: 'GET', path: '/config', weight: 30 },
  { method: 'GET', path: '/api/context?workspace=default', weight: 20 },
  {
    method: 'POST',
    path: '/v1/chat/completions',
    weight: 10,
    body: JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: 'ping' }],
    }),
    headers: { 'Content-Type': 'application/json' },
  },
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { url, duration, concurrency, rps, maxErrorRate, maxP99 } = opts;

  console.log(`Starting load test: ${url} for ${duration}s with ${concurrency} workers @ ${rps} rps`);

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
  const errorRate = totalRequests > 0 ? ((clientErrors + serverErrors) / totalRequests) * 100 : 0;
  const successRate = totalRequests > 0 ? (successCount / totalRequests) * 100 : 0;

  // Print results.
  const fmt = (n) => n.toLocaleString('en-US');
  console.log('');
  console.log(`Load Test Results (${duration}s, ${concurrency} workers)`);
  console.log('\u2500'.repeat(35));
  console.log(`Total requests:  ${fmt(totalRequests)}`);
  console.log(`Successful:      ${fmt(successCount)} (${successRate.toFixed(1)}%)`);
  console.log(`Client errors:   ${fmt(clientErrors)} (${(totalRequests > 0 ? (clientErrors / totalRequests) * 100 : 0).toFixed(1)}%)`);
  console.log(`Server errors:   ${fmt(serverErrors)} (${(totalRequests > 0 ? (serverErrors / totalRequests) * 100 : 0).toFixed(1)}%)`);
  console.log('');
  console.log('Latency (ms):');
  console.log(`  p50:  ${p50}`);
  console.log(`  p95:  ${p95}`);
  console.log(`  p99:  ${p99}`);
  console.log(`  max:  ${max}`);
  console.log('');
  console.log(`Throughput: ${throughput.toFixed(1)} req/s`);

  // Write results to JSON.
  const results = {
    timestamp: new Date().toISOString(),
    config: { url, duration, concurrency, rps },
    totals: {
      requests: totalRequests,
      successful: successCount,
      clientErrors,
      serverErrors,
    },
    latency: { p50, p95, p99, max },
    throughput: Number(throughput.toFixed(1)),
    errorRate: Number(errorRate.toFixed(2)),
  };

  const outPath = resolve('load-test-results.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nResults written to ${outPath}`);

  // Exit with error if thresholds exceeded.
  if (errorRate > maxErrorRate) {
    console.error(`\nFAIL: Error rate ${errorRate.toFixed(2)}% exceeds threshold ${maxErrorRate}%`);
    process.exit(1);
  }
  if (p99 > maxP99) {
    console.error(`\nFAIL: p99 latency ${p99}ms exceeds threshold ${maxP99}ms`);
    process.exit(1);
  }

  console.log('\nPASS: All thresholds met.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
