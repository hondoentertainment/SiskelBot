#!/usr/bin/env node
/**
 * Phase 39: Deployment smoke tests.
 * Run after deploy to verify health probes and critical endpoints.
 * Usage: node scripts/smoke-test.js [BASE_URL]
 * Example: node scripts/smoke-test.js https://my-app.vercel.app
 */

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const LIVE_ONLY = process.argv.includes("--live-only");
const BASE_URL = args[0] || process.env.BASE_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY || process.env.SMOKE_TEST_API_KEY;

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, redirect: "follow" });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body, headers: Object.fromEntries(res.headers) };
}

async function main() {
  const results = [];
  const url = BASE_URL.replace(/\/$/, "");

  // 1. Liveness
  try {
    const r = await fetchJson(`${url}/health/live`);
    results.push({ name: "GET /health/live", ok: r.ok && r.body?.ok, status: r.status });
  } catch (e) {
    results.push({ name: "GET /health/live", ok: false, error: e.message });
  }

  // 2. Readiness (skip in --live-only; may 503 if backend down)
  if (!LIVE_ONLY) {
    try {
      const r = await fetchJson(`${url}/health/ready`);
      const ok = r.status === 200 || (r.status === 503 && r.body?.reason);
      results.push({ name: "GET /health/ready", ok, status: r.status });
    } catch (e) {
      results.push({ name: "GET /health/ready", ok: false, error: e.message });
    }
  }

  // 3. Config (unauthenticated)
  try {
    const r = await fetchJson(`${url}/config`);
    results.push({ name: "GET /config", ok: r.ok && r.body?.backend, status: r.status });
  } catch (e) {
    results.push({ name: "GET /config", ok: false, error: e.message });
  }

  // 4. Main page (HTML)
  try {
    const res = await fetch(`${url}/`, { redirect: "follow" });
    const ok = res.ok && (await res.text()).includes("<!DOCTYPE html");
    results.push({ name: "GET /", ok, status: res.status });
  } catch (e) {
    results.push({ name: "GET /", ok: false, error: e.message });
  }

  // 5. Chat completions (skip in --live-only; optional - requires API_KEY and backend)
  if (!LIVE_ONLY && API_KEY) {
    try {
      const r = await fetchJson(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: "Say 'ok' in one word." }],
          max_tokens: 5,
        }),
      });
      const ok = r.ok || r.status === 502 || r.status === 503;
      results.push({ name: "POST /v1/chat/completions", ok, status: r.status });
    } catch (e) {
      results.push({ name: "POST /v1/chat/completions", ok: false, error: e.message });
    }
  } else if (!LIVE_ONLY) {
    results.push({ name: "POST /v1/chat/completions", ok: true, skip: "No API_KEY" });
  }

  // Summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && !r.skip);

  console.log(JSON.stringify({ baseUrl: url, results, passed: `${passed}/${results.length}` }, null, 2));

  if (failed.length > 0) {
    console.error("Smoke test failures:", failed);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
