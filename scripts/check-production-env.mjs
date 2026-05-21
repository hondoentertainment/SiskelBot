#!/usr/bin/env node
/**
 * Print production env checklist and optional live probes.
 * Usage: node scripts/check-production-env.mjs [BASE_URL]
 */
const BASE_URL = (process.argv[2] || process.env.BASE_URL || "").replace(/\/$/, "");

const REQUIRED = [
  { key: "API_KEY", note: "Chat/API auth; /config should show requiresApiKey: true" },
  { key: "SESSION_SECRET", note: "Required when OAuth/SSO enabled" },
];

const STORAGE_ONE_OF = [
  { key: "STORAGE_PATH", note: "Mounted volume path" },
  { key: "STORAGE_BACKEND=postgres + DATABASE_URL", note: "Postgres KV" },
  { key: "STORAGE_BACKEND=sqlite", note: "SQLite KV on persistent host" },
];

const RECOMMENDED = [
  "ADMIN_API_KEY",
  "REQUIRE_DURABLE_STORAGE=1 (on Vercel with volume/postgres)",
  "OTEL_ENABLED=1",
  "SMOKE_TEST_API_KEY + SMOKE_TEST_ADMIN_API_KEY (GitHub Actions secrets)",
];

console.log(JSON.stringify({
  checklist: {
    required: REQUIRED,
    storageOneOf: STORAGE_ONE_OF,
    recommended: RECOMMENDED,
    docs: "docs/PRODUCTION.md",
  },
}, null, 2));

async function probe() {
  if (!BASE_URL) return;
  const checks = [];
  try {
    const cfg = await fetch(`${BASE_URL}/config`).then((r) => r.json());
    checks.push({
      name: "requiresApiKey",
      ok: cfg.requiresApiKey === true,
      value: cfg.requiresApiKey,
    });
    checks.push({
      name: "storageBackend",
      ok: true,
      value: cfg.storageBackend,
    });
  } catch (e) {
    checks.push({ name: "config", ok: false, error: e.message });
  }
  try {
    const live = await fetch(`${BASE_URL}/health/live`).then((r) => r.json());
    checks.push({ name: "health/live", ok: live?.ok === true });
  } catch (e) {
    checks.push({ name: "health/live", ok: false, error: e.message });
  }
  console.log(JSON.stringify({ baseUrl: BASE_URL, probes: checks }, null, 2));
  if (checks.some((c) => c.ok === false)) process.exitCode = 1;
}

await probe();
