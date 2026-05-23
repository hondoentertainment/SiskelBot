#!/usr/bin/env node
/**
 * Print Vercel production env setup commands (ops checklist).
 * Does not set secrets — run manually or via `vercel env add`.
 *
 * Usage: node scripts/setup-production-env.mjs
 */
const VARS = [
  { key: "API_KEY", note: "Required — chat/API auth" },
  { key: "ADMIN_API_KEY", note: "Admin routes + smoke probes" },
  { key: "SESSION_SECRET", note: "OAuth/SSO sessions (32+ random bytes)" },
  { key: "STORAGE_BACKEND", value: "postgres", note: "Or sqlite with mounted volume" },
  { key: "DATABASE_URL", note: "When STORAGE_BACKEND=postgres" },
  { key: "REQUIRE_DURABLE_STORAGE", value: "1", note: "Fail boot on ephemeral Vercel disk" },
  { key: "OTEL_ENABLED", value: "1", note: "Observability" },
  { key: "LOAD_SHEDDING_PROFILE", value: "staging", note: "Use on staging only" },
  { key: "EVAL_IN_PROD_MIN_JACCARD", value: "0.7", note: "Alert threshold" },
  { key: "EVAL_IN_PROD_ALERT_WEBHOOK", note: "Slack/Discord webhook for quality regressions" },
];

console.log("# Vercel production env (run from repo root)\n");
for (const v of VARS) {
  console.log(`# ${v.note}`);
  console.log(`npx vercel env add ${v.key} production`);
  if (v.value) console.log(`# suggested: ${v.value}`);
  console.log("");
}

console.log("# GitHub Actions secrets");
console.log("# SMOKE_TEST_API_KEY — same value as API_KEY");
console.log("# SMOKE_TEST_ADMIN_API_KEY — same value as ADMIN_API_KEY");
console.log("# REPLAY_TOKEN_SECRET — enables replay E2E in CI");
console.log("");
console.log("# Verify after deploy:");
console.log("npm run check:production-env -- https://siskelbot.vercel.app");
