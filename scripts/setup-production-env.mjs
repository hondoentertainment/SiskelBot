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
  { key: "STRIPE_SECRET_KEY", note: "Live Stripe secret (sk_live_…)" },
  { key: "STRIPE_WEBHOOK_SECRET", note: "Webhook signing secret" },
  { key: "STRIPE_PRO_PRICE_ID", note: "Pro plan price ID" },
  { key: "STRIPE_ENTERPRISE_PRICE_ID", note: "Enterprise plan price ID" },
  { key: "APP_BASE_URL", note: "Public origin, e.g. https://siskelbot.vercel.app" },
  { key: "HEALTH_DEEP_BACKEND_OPTIONAL", value: "1", note: "Backend down → degraded not 503 on Vercel" },
  { key: "ENFORCE_PLAN_LIMITS", value: "1", note: "402 on plan-gated features" },
  { key: "QUOTA_ENABLED", value: "1", note: "Monthly token caps per plan" },
  { key: "OTEL_ENABLED", value: "1", note: "Observability" },
  { key: "LOAD_SHEDDING_PROFILE", value: "staging", note: "Use on staging only" },
  { key: "EVAL_IN_PROD_MIN_JACCARD", value: "0.7", note: "Alert threshold" },
  { key: "EVAL_IN_PROD_ALERT_WEBHOOK", note: "Slack/Discord webhook for quality regressions" },
];

console.log("# Vercel production env (run from repo root)\n");
console.log("# Preferred: npm run apply:production-env  (non-interactive flags + generated secrets)\n");
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
console.log("npm run go-live:verify -- https://siskelbot.vercel.app");
console.log("npm run check:production-env -- https://siskelbot.vercel.app");
