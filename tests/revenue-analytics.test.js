/**
 * Revenue analytics tests: subscription index, customer list, and MRR/ARR
 * summary. Writes subscription snapshots directly (same shape the billing
 * webhook writes) into a temp STORAGE_PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-revenue-"));
process.env.STORAGE_PATH = tempDir;

function writeSub(ws, plan, status) {
  const dir = join(tempDir, "billing-subscriptions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${ws}.json`),
    JSON.stringify({
      plan,
      status,
      stripeCustomerId: `cus_${ws}`,
      stripeSubscriptionId: `sub_${ws}`,
      updatedAt: new Date().toISOString(),
    })
  );
}

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("registerBillingWorkspace is idempotent and listable", async () => {
  const { registerBillingWorkspace, listBillingWorkspaces } = await import("../lib/revenue-analytics.js");
  await registerBillingWorkspace("acme");
  await registerBillingWorkspace("acme");
  await registerBillingWorkspace("globex");
  const all = await listBillingWorkspaces();
  assert.deepEqual(all.sort(), ["acme", "globex"]);
});

test("getRevenueSummary computes MRR/ARR from active paid subscriptions", async () => {
  const { registerBillingWorkspace, getRevenueSummary } = await import("../lib/revenue-analytics.js");
  writeSub("acme", "pro", "active");        // $29
  writeSub("globex", "enterprise", "active"); // $299
  writeSub("initech", "pro", "canceled");   // churned — $0
  await registerBillingWorkspace("initech");

  const summary = await getRevenueSummary();
  assert.equal(summary.mrr, 29 + 299);
  assert.equal(summary.arr, (29 + 299) * 12);
  assert.equal(summary.customers.paying, 2);
  assert.equal(summary.customers.canceled, 1);
  assert.equal(summary.byPlan.pro, 2);
  assert.equal(summary.byPlan.enterprise, 1);
});

test("past_due subscriptions still count toward MRR but are flagged", async () => {
  const { registerBillingWorkspace, getRevenueSummary } = await import("../lib/revenue-analytics.js");
  writeSub("latepay", "pro", "past_due");
  await registerBillingWorkspace("latepay");
  const summary = await getRevenueSummary();
  assert.equal(summary.customers.pastDue, 1);
  assert.equal(summary.mrr, 29 + 299 + 29);
});

test("listCustomers returns rows sorted by price with paying flags", async () => {
  const { listCustomers } = await import("../lib/revenue-analytics.js");
  const customers = await listCustomers({ includeUsage: false });
  assert.equal(customers.length, 4);
  assert.equal(customers[0].workspaceId, "globex", "highest price first");
  assert.equal(customers[0].paying, true);
  const initech = customers.find((c) => c.workspaceId === "initech");
  assert.equal(initech.paying, false);
  assert.equal(initech.priceMonthly, 0);
});

test("listCustomers with usage attaches month usage fields", async () => {
  const { listCustomers } = await import("../lib/revenue-analytics.js");
  const customers = await listCustomers({ includeUsage: true });
  const acme = customers.find((c) => c.workspaceId === "acme");
  assert.ok("tokensThisMonth" in acme);
  assert.ok("costThisMonth" in acme);
});
