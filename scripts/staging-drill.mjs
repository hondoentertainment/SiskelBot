#!/usr/bin/env node
/**
 * P2 staging drill: sustained liveness SLO after deploy or fault injection.
 *
 * Polls GET /health/live every INTERVAL_MS for DURATION_MS (default 60s).
 * Exits 0 only if every probe succeeds within PROBE_TIMEOUT_MS.
 *
 * Usage:
 *   STAGING_URL=https://staging.example.com node scripts/staging-drill.mjs
 *   node scripts/staging-drill.mjs https://staging.example.com
 */
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const BASE_URL = (args[0] || process.env.STAGING_URL || process.env.BASE_URL || "").replace(/\/$/, "");
const DURATION_MS = Number(process.env.STAGING_DRILL_DURATION_MS) || 60_000;
const INTERVAL_MS = Number(process.env.STAGING_DRILL_INTERVAL_MS) || 5_000;
const PROBE_TIMEOUT_MS = Number(process.env.STAGING_DRILL_PROBE_TIMEOUT_MS) || 10_000;

async function probeLive(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/health/live`, { signal: controller.signal });
    const body = await res.json().catch(() => null);
    return { ok: res.ok && body?.ok === true, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!BASE_URL) {
    console.error("[staging-drill] STAGING_URL or BASE_URL is required");
    process.exit(2);
  }

  const started = Date.now();
  let attempt = 0;
  let failures = 0;

  console.log(`[staging-drill] target=${BASE_URL} duration=${DURATION_MS}ms interval=${INTERVAL_MS}ms`);

  while (Date.now() - started < DURATION_MS) {
    attempt += 1;
    const result = await probeLive(BASE_URL);
    const elapsed = Date.now() - started;
    if (result.ok) {
      console.log(`[staging-drill] probe ${attempt} ok (${elapsed}ms)`);
    } else {
      failures += 1;
      console.error(
        `[staging-drill] probe ${attempt} FAIL status=${result.status ?? "n/a"} error=${result.error ?? "bad body"}`,
      );
    }
    if (Date.now() - started >= DURATION_MS) break;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  const summary = { attempts: attempt, failures, durationMs: Date.now() - started, sloMet: failures === 0 };
  console.log("[staging-drill] summary:", JSON.stringify(summary));

  if (!summary.sloMet) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[staging-drill] fatal:", err.message);
  process.exit(1);
});
