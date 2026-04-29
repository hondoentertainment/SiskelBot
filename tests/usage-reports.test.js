import test from "node:test";
import assert from "node:assert/strict";
import {
  getUsageSummary,
  generateUsageCsv,
  checkUsageThresholds,
  listUsageAlerts,
} from "../lib/usage-reports.js";
import { __resetForTests, recordTokens } from "../lib/tenant-quotas.js";

function makeMockStorage(quotaOverrides = {}, alertItems = []) {
  const alertStore = new Map();
  for (const item of alertItems) {
    alertStore.set(item.id, item);
  }
  return {
    async get(type, id) {
      if (type === "tenant_quotas") return quotaOverrides[id] || null;
      if (type === "usage_alerts") return alertStore.get(id) || null;
      return null;
    },
    async list(type, workspace) {
      if (type === "usage_alerts") {
        const result = [];
        for (const item of alertStore.values()) {
          if (item.workspaceId === workspace) result.push(item);
        }
        return result;
      }
      return [];
    },
    async add(type, item) {
      if (type === "usage_alerts") alertStore.set(item.id, item);
    },
    async remove() {},
    async listWorkspaces() {
      return [];
    },
  };
}

test("getUsageSummary: returns zero stats for new workspace", async () => {
  __resetForTests();
  const summary = await getUsageSummary("new-ws-" + Date.now(), {});
  assert.equal(typeof summary.workspaceId, "string");
  assert.equal(summary.requests, 0);
  assert.equal(summary.inputTokens, 0);
  assert.equal(summary.outputTokens, 0);
  assert.equal(summary.estimatedCostUsd, 0);
  assert.equal(typeof summary.storageBytes, "number");
  assert.deepEqual(summary.topModels, []);
  assert.ok(summary.period.from, "period.from should be set");
  assert.ok(summary.period.to, "period.to should be set");
});

test("getUsageSummary: period defaults to current month", async () => {
  __resetForTests();
  const summary = await getUsageSummary("ws-period-check", {});
  const now = new Date();
  const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  assert.ok(summary.period.from.startsWith(yearMonth.slice(0, 7)), "from should be current month");
});

test("generateUsageCsv: produces valid CSV with header row", async () => {
  __resetForTests();
  const csv = await generateUsageCsv("csv-ws-" + Date.now(), {});
  const lines = csv.trim().split("\n");
  assert.ok(lines.length >= 1, "should have at least header");
  assert.equal(lines[0], "date,requests,input_tokens,output_tokens,estimated_cost_usd");
});

test("generateUsageCsv: covers all days in the requested range", async () => {
  __resetForTests();
  const from = "2026-01-01";
  const to = "2026-01-03";
  const csv = await generateUsageCsv("ws-range", { from, to });
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 4, "header + 3 data rows");
  assert.ok(lines[1].startsWith("2026-01-01,"));
  assert.ok(lines[2].startsWith("2026-01-02,"));
  assert.ok(lines[3].startsWith("2026-01-03,"));
});

test("generateUsageCsv: each data row has 5 comma-separated fields", async () => {
  __resetForTests();
  const csv = await generateUsageCsv("ws-fields", { from: "2026-02-01", to: "2026-02-02" });
  const lines = csv.trim().split("\n");
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    assert.equal(parts.length, 5, `row '${line}' should have 5 fields`);
  }
});

test("checkUsageThresholds: returns no alerts for idle workspace", async () => {
  __resetForTests();
  const storage = makeMockStorage();
  const ws = "idle-ws-" + Date.now();
  const result = await checkUsageThresholds(ws, storage);
  assert.ok(Array.isArray(result.alerts));
  assert.equal(result.alerts.length, 0);
});

test("checkUsageThresholds: returns alert when token usage exceeds 80% of daily limit", async () => {
  __resetForTests();
  const ws = "alert-ws-" + Date.now();
  recordTokens(ws, 85);
  // Override tokensPerDay to 100 so 85 > 80% of 100
  const storage = makeMockStorage({ [ws]: { tokensPerDay: 100 } });
  const result = await checkUsageThresholds(ws, storage);
  assert.ok(Array.isArray(result.alerts));
  const tokenAlert = result.alerts.find((a) => a.type === "tokens_per_day");
  assert.ok(tokenAlert, "should have a tokens_per_day alert");
  assert.equal(tokenAlert.current, 85);
  assert.equal(tokenAlert.limit, 100);
});

test("checkUsageThresholds: persists alert to storage when over threshold", async () => {
  __resetForTests();
  const ws = "persist-ws-" + Date.now();
  recordTokens(ws, 90);
  // Override tokensPerDay to 100 so 90 > 80% of 100
  const storage = makeMockStorage({ [ws]: { tokensPerDay: 100 } });
  await checkUsageThresholds(ws, storage);
  const stored = await listUsageAlerts(ws, storage);
  assert.ok(stored.length > 0, "alert should be persisted to storage");
});

test("listUsageAlerts: returns empty array when storage has no alerts", async () => {
  const storage = makeMockStorage();
  const alerts = await listUsageAlerts("no-alerts-ws", storage);
  assert.deepEqual(alerts, []);
});

test("listUsageAlerts: returns empty array when storage is null", async () => {
  const alerts = await listUsageAlerts("ws-x", null);
  assert.deepEqual(alerts, []);
});

test("getUsageSummary: estimatedCostUsd is non-negative", async () => {
  __resetForTests();
  const summary = await getUsageSummary("cost-check-ws", {});
  assert.ok(summary.estimatedCostUsd >= 0, "estimated cost should be >= 0");
});
