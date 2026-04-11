import test from "node:test";
import assert from "node:assert/strict";

const TEST_STORAGE = "/tmp/billing-test-" + Date.now();

test.before(() => {
  process.env.STORAGE_PATH = TEST_STORAGE;
});

await test("createBillingManager returns manager with expected methods", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  assert.equal(typeof mgr.recordUsage, "function");
  assert.equal(typeof mgr.getUsageSummary, "function");
  assert.equal(typeof mgr.checkPlanLimits, "function");
  assert.equal(typeof mgr.getInvoice, "function");
});

await test("recordUsage persists a usage record", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const wsId = "bill-record-" + Date.now();

  const result = await mgr.recordUsage(wsId, { inputTokens: 500, outputTokens: 200 }, "gpt-4");
  assert.equal(result.ok, true);
  assert.ok(result.record);
  assert.equal(result.record.workspaceId, wsId);
  assert.equal(result.record.inputTokens, 500);
  assert.equal(result.record.outputTokens, 200);
  assert.equal(result.record.totalTokens, 700);
  assert.equal(result.record.model, "gpt-4");
  assert.ok(result.record.cost >= 0);
  assert.ok(result.record.timestamp);
  assert.ok(result.record.id.startsWith("bill_"));
});

await test("recordUsage handles numeric token value", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const wsId = "bill-numeric-" + Date.now();

  const result = await mgr.recordUsage(wsId, 1000, "llama3");
  assert.equal(result.ok, true);
  assert.equal(result.record.inputTokens, 1000);
  assert.equal(result.record.outputTokens, 0);
  assert.equal(result.record.totalTokens, 1000);
});

await test("recordUsage handles token object with total", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const wsId = "bill-total-" + Date.now();

  const result = await mgr.recordUsage(wsId, { total: 800 }, "model-x");
  assert.equal(result.ok, true);
  assert.equal(result.record.inputTokens, 800);
  assert.equal(result.record.totalTokens, 800);
});

await test("getUsageSummary returns correct aggregate", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const wsId = "bill-summary-" + Date.now();

  await mgr.recordUsage(wsId, { inputTokens: 1000, outputTokens: 500 }, "gpt-4");
  await mgr.recordUsage(wsId, { inputTokens: 2000, outputTokens: 1000 }, "gpt-4");
  await mgr.recordUsage(wsId, { inputTokens: 500, outputTokens: 250 }, "llama3");

  const summary = await mgr.getUsageSummary(wsId, "30d");
  assert.equal(summary.tokens, 5250);
  assert.equal(summary.inputTokens, 3500);
  assert.equal(summary.outputTokens, 1750);
  assert.equal(summary.requests, 3);
  assert.ok(summary.cost > 0);
  assert.ok(summary.breakdown);
  assert.ok(summary.breakdown.byModel);
  assert.ok(summary.breakdown.byModel["gpt-4"]);
  assert.equal(summary.breakdown.byModel["gpt-4"].requests, 2);
  assert.ok(summary.breakdown.byModel["llama3"]);
  assert.equal(summary.breakdown.byModel["llama3"].requests, 1);
  assert.equal(summary.workspaceId, wsId);
});

await test("getUsageSummary returns zeros for unused workspace", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const wsId = "bill-empty-" + Date.now();

  const summary = await mgr.getUsageSummary(wsId, "30d");
  assert.equal(summary.tokens, 0);
  assert.equal(summary.cost, 0);
  assert.equal(summary.requests, 0);
});

await test("getUsageSummary filters by workspace", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const ws1 = "bill-filter-a-" + Date.now();
  const ws2 = "bill-filter-b-" + Date.now();

  await mgr.recordUsage(ws1, { inputTokens: 100 }, "m1");
  await mgr.recordUsage(ws2, { inputTokens: 200 }, "m1");

  const s1 = await mgr.getUsageSummary(ws1, "30d");
  const s2 = await mgr.getUsageSummary(ws2, "30d");
  assert.equal(s1.tokens, 100);
  assert.equal(s2.tokens, 200);
});

await test("getUsageSummary parses YYYY-MM period", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const wsId = "bill-period-" + Date.now();

  // Record usage (will be in current month)
  await mgr.recordUsage(wsId, { inputTokens: 300 }, "model");
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const summary = await mgr.getUsageSummary(wsId, monthStr);
  assert.equal(summary.period, monthStr);
  assert.equal(summary.tokens, 300);
});

await test("checkPlanLimits returns allowed for free plan under limit", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const { setPlan } = await import("../lib/plans.js");
  const mgr = createBillingManager();
  const wsId = "bill-limits-ok-" + Date.now();

  await setPlan(wsId, "free");
  await mgr.recordUsage(wsId, { inputTokens: 100 }, "model");

  const limits = await mgr.checkPlanLimits(wsId);
  assert.equal(limits.allowed, true);
  assert.equal(limits.plan, "free");
  assert.equal(limits.used, 100);
  assert.equal(limits.limit, 100_000);
  assert.equal(limits.remaining, 99_900);
  assert.equal(limits.overage, 0);
});

await test("checkPlanLimits returns enterprise always allowed", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const { setPlan } = await import("../lib/plans.js");
  const mgr = createBillingManager();
  const wsId = "bill-limits-ent-" + Date.now();

  await setPlan(wsId, "enterprise");
  await mgr.recordUsage(wsId, { inputTokens: 999_999 }, "model");

  const limits = await mgr.checkPlanLimits(wsId);
  assert.equal(limits.allowed, true);
  assert.equal(limits.plan, "enterprise");
  assert.equal(limits.limit, Infinity);
  assert.equal(limits.remaining, Infinity);
});

await test("getInvoice generates valid invoice data", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const { setPlan } = await import("../lib/plans.js");
  const mgr = createBillingManager();
  const wsId = "bill-invoice-" + Date.now();

  await setPlan(wsId, "pro");
  await mgr.recordUsage(wsId, { inputTokens: 5000, outputTokens: 2000 }, "gpt-4");

  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const invoice = await mgr.getInvoice(wsId, monthStr);

  assert.ok(invoice.invoiceId);
  assert.equal(invoice.workspaceId, wsId);
  assert.equal(invoice.period, monthStr);
  assert.equal(invoice.plan.id, "pro");
  assert.equal(invoice.plan.name, "Pro");
  assert.ok(Array.isArray(invoice.lineItems));
  assert.ok(invoice.lineItems.length >= 1);
  assert.ok(invoice.subtotal >= 0);
  assert.equal(invoice.currency, "USD");
  assert.ok(invoice.generatedAt);
  assert.ok(invoice.usage);
  assert.equal(invoice.usage.tokens, 7000);
});

await test("getInvoice includes plan subscription line item", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const { setPlan } = await import("../lib/plans.js");
  const mgr = createBillingManager();
  const wsId = "bill-invoice-line-" + Date.now();

  await setPlan(wsId, "pro");
  await mgr.recordUsage(wsId, { inputTokens: 100 }, "model");

  const invoice = await mgr.getInvoice(wsId);
  const subLine = invoice.lineItems.find((l) => l.description.includes("Monthly Subscription"));
  assert.ok(subLine);
  assert.equal(subLine.total, 29);
});

await test("getInvoice for free plan has no subscription line item", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const wsId = "bill-invoice-free-" + Date.now();

  // Default plan is free, no usage
  const invoice = await mgr.getInvoice(wsId);
  const subLine = invoice.lineItems.find((l) => l.description.includes("Monthly Subscription"));
  assert.equal(subLine, undefined);
  assert.equal(invoice.subtotal, 0);
});

await test("cost computation is positive for non-zero tokens", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const wsId = "bill-cost-" + Date.now();

  const result = await mgr.recordUsage(wsId, { inputTokens: 10000, outputTokens: 5000 }, "gpt-4");
  assert.ok(result.record.cost > 0);
});

await test("cost is zero for zero tokens", async () => {
  const { createBillingManager } = await import("../lib/billing.js");
  const mgr = createBillingManager();
  const wsId = "bill-zero-cost-" + Date.now();

  const result = await mgr.recordUsage(wsId, { inputTokens: 0, outputTokens: 0 }, "model");
  assert.equal(result.record.cost, 0);
  assert.equal(result.record.totalTokens, 0);
});

await test("tenant isolation: scopeQuery adds workspace filter to string", async () => {
  const { scopeQuery } = await import("../lib/tenant-isolation.js");

  const result = scopeQuery("SELECT * FROM records", "ws-123");
  assert.ok(typeof result === "string");
  assert.ok(result.includes("workspace_id"));
  assert.ok(result.includes("ws-123"));
});

await test("tenant isolation: scopeQuery adds workspace to object", async () => {
  const { scopeQuery } = await import("../lib/tenant-isolation.js");

  const result = scopeQuery({ model: "gpt-4" }, "ws-456");
  assert.equal(result.workspaceId, "ws-456");
  assert.equal(result.model, "gpt-4");
});

await test("tenant isolation: scopeQueryParameterized returns safe params", async () => {
  const { scopeQueryParameterized } = await import("../lib/tenant-isolation.js");

  const result = scopeQueryParameterized("SELECT * FROM records", [], "ws-789");
  assert.ok(result.query.includes("$1"));
  assert.ok(result.query.includes("workspace_id"));
  assert.deepEqual(result.params, ["ws-789"]);
});

await test("tenant isolation: validateWorkspaceAccess allows default workspace", async () => {
  const { validateWorkspaceAccess } = await import("../lib/tenant-isolation.js");

  const result = await validateWorkspaceAccess("user1", "default");
  assert.equal(result.allowed, true);
  assert.equal(result.role, "member");
});

await test("tenant isolation: validateWorkspaceAccess rejects empty user", async () => {
  const { validateWorkspaceAccess } = await import("../lib/tenant-isolation.js");

  const result = await validateWorkspaceAccess("", "some-ws");
  assert.equal(result.allowed, false);
  assert.ok(result.error.includes("User ID"));
});

await test("tenant isolation: validateWorkspaceAccess rejects empty workspace", async () => {
  const { validateWorkspaceAccess } = await import("../lib/tenant-isolation.js");

  const result = await validateWorkspaceAccess("user1", "");
  assert.equal(result.allowed, false);
  assert.ok(result.error.includes("Workspace ID"));
});

await test("tenant isolation: filterByWorkspace filters records", async () => {
  const { filterByWorkspace } = await import("../lib/tenant-isolation.js");

  const records = [
    { workspaceId: "ws-1", data: "a" },
    { workspaceId: "ws-2", data: "b" },
    { workspaceId: "ws-1", data: "c" },
  ];

  const filtered = filterByWorkspace(records, "ws-1");
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((r) => r.workspaceId === "ws-1"));
});

await test("tenant isolation: filterByWorkspace returns empty for no match", async () => {
  const { filterByWorkspace } = await import("../lib/tenant-isolation.js");

  const records = [{ workspaceId: "ws-1", data: "a" }];
  const filtered = filterByWorkspace(records, "ws-nonexistent");
  assert.equal(filtered.length, 0);
});

await test("tenant isolation: filterByWorkspace handles empty input", async () => {
  const { filterByWorkspace } = await import("../lib/tenant-isolation.js");

  assert.deepEqual(filterByWorkspace([], "ws-1"), []);
  assert.deepEqual(filterByWorkspace(null, "ws-1"), []);
  assert.deepEqual(filterByWorkspace(undefined, "ws-1"), []);
});

await test("tenant isolation: scopeQuery with WHERE clause adds AND", async () => {
  const { scopeQuery } = await import("../lib/tenant-isolation.js");

  const result = scopeQuery("SELECT * FROM t WHERE status = 'active'", "ws-x");
  assert.ok(result.includes("workspace_id = 'ws-x' AND"));
  assert.ok(result.includes("status = 'active'"));
});

await test("tenant isolation: scopeQuery with empty string returns WHERE", async () => {
  const { scopeQuery } = await import("../lib/tenant-isolation.js");

  const result = scopeQuery("", "ws-y");
  assert.ok(result.includes("WHERE workspace_id = 'ws-y'"));
});
