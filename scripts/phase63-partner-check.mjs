#!/usr/bin/env node
/**
 * P1 design-partner burn-in: probe Phase 63 surfaces on a running deployment.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3000 ADMIN_API_KEY=key node scripts/phase63-partner-check.mjs
 */
const BASE_URL = (process.argv[2] || process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const ADMIN_KEY = process.env.ADMIN_API_KEY || process.env.SMOKE_TEST_ADMIN_API_KEY;

async function fetchJson(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (ADMIN_KEY) headers["x-admin-api-key"] = ADMIN_KEY;
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

async function main() {
  const results = [];

  results.push(await probe("GET /health/live", () => fetchJson("/health/live"), (r) => r.ok && r.body?.ok));
  results.push(await probe("GET /config", () => fetchJson("/config"), (r) => r.ok && r.body?.backend));

  if (!ADMIN_KEY) {
    results.push({ name: "admin probes", ok: true, skip: "No ADMIN_API_KEY" });
  } else {
    results.push(await probe("GET /api/v1/pr-review/rules", () => fetchJson("/api/v1/pr-review/rules"), (r) => r.ok && Array.isArray(r.body?.rules)));
    results.push(await probe("GET /api/v1/eval-in-prod/config", () => fetchJson("/api/v1/eval-in-prod/config?workspaceId=default"), (r) => r.ok && typeof r.body?.enabled === "boolean"));
    results.push(await probe("GET /api/v1/eval-in-prod/alerts", () => fetchJson("/api/v1/eval-in-prod/alerts?workspaceId=default"), (r) => r.ok && r.body?.workspaceId));
    results.push(await probe("GET /api/v1/load-shedding/config", () => fetchJson("/api/v1/load-shedding/config"), (r) => r.ok && typeof r.body?.softCapacity === "number"));
    results.push(await probe("GET /api/v1/safety-sla/classifiers", () => fetchJson("/api/v1/safety-sla/classifiers"), (r) => r.ok && Array.isArray(r.body?.classifiers)));
  }

  const failed = results.filter((r) => !r.ok && !r.skip);
  console.log(JSON.stringify({ baseUrl: BASE_URL, results }, null, 2));
  if (failed.length) {
    console.error("Partner check failures:", failed);
    process.exit(1);
  }
}

async function probe(name, fn, pass) {
  try {
    const r = await fn();
    return { name, ok: pass(r), status: r.status };
  } catch (err) {
    return { name, ok: false, error: err.message };
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
