#!/usr/bin/env node
/**
 * Create Stripe Products/Prices for Pro + Enterprise from lib/plans.js.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/setup-stripe-products.mjs
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe-products.mjs --apply
 *
 * Without --apply: dry-run (prints intended products).
 * With --apply: creates products/prices and prints Vercel env commands.
 */
import { listPlans } from "../lib/plans.js";

const APPLY = process.argv.includes("--apply");
const key = process.env.STRIPE_SECRET_KEY?.trim();

async function main() {
  const paid = listPlans().filter((p) => p.id === "pro" || p.id === "enterprise");
  if (!APPLY) {
    console.log(JSON.stringify({ dryRun: true, plans: paid.map((p) => ({
      id: p.id,
      name: p.name,
      priceMonthly: p.priceMonthly,
    })) }, null, 2));
    console.log("\nRe-run with --apply and STRIPE_SECRET_KEY set to create prices.");
    return;
  }
  if (!key) {
    console.error("STRIPE_SECRET_KEY required with --apply");
    process.exit(2);
  }
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(key, { apiVersion: "2025-03-31.basil" });
  const out = {};
  for (const plan of paid) {
    const product = await stripe.products.create({
      name: `SiskelBot ${plan.name}`,
      metadata: { siskelbot_plan: plan.id },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(Number(plan.priceMonthly) * 100),
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { siskelbot_plan: plan.id },
    });
    out[plan.id] = { productId: product.id, priceId: price.id };
    console.log(`Created ${plan.id}: product=${product.id} price=${price.id}`);
  }
  console.log("\n# Apply to Vercel:");
  console.log(`# export STRIPE_SECRET_KEY=...`);
  console.log(`# export STRIPE_PRO_PRICE_ID=${out.pro.priceId}`);
  console.log(`# export STRIPE_ENTERPRISE_PRICE_ID=${out.enterprise.priceId}`);
  console.log(`# export STRIPE_WEBHOOK_SECRET=whsec_...  # from Stripe Dashboard webhook`);
  console.log("npm run apply:production-env");
  console.log(JSON.stringify({ ok: true, ...out }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
