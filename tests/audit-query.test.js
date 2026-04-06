import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const testDataDir = "/tmp/audit-query-test-" + Date.now();

test.before(() => {
  process.env.STORAGE_PATH = testDataDir;
  mkdirSync(testDataDir, { recursive: true });

  // Write a test execution-audit.json
  const entries = [
    { timestamp: "2025-03-01T10:00:00Z", action: "execute_step", ok: true, userId: "user1", workspaceId: "ws1" },
    { timestamp: "2025-03-02T12:00:00Z", action: "search_context", ok: true, userId: "user2", workspaceId: "ws1" },
    { timestamp: "2025-03-03T14:00:00Z", action: "execute_step", ok: false, userId: "user1", workspaceId: "ws2" },
    { timestamp: "2025-03-04T16:00:00Z", action: "list_context", ok: true, userId: "user1", workspaceId: "ws1" },
    { timestamp: "2025-03-05T18:00:00Z", action: "execute_step", ok: true, userId: "user3", workspaceId: "ws1" },
  ];
  writeFileSync(join(testDataDir, "execution-audit.json"), JSON.stringify(entries));
});

await test("queryAudit returns all entries with default options", async () => {
  const { queryAudit } = await import("../lib/audit-query.js");
  const result = await queryAudit();
  assert.ok(result.entries.length > 0);
  assert.ok(typeof result.total === "number");
});

await test("queryAudit filters by userId", async () => {
  const { queryAudit } = await import("../lib/audit-query.js");
  const result = await queryAudit({ userId: "user1" });
  for (const e of result.entries) {
    assert.equal(e.userId, "user1");
  }
});

await test("queryAudit filters by action", async () => {
  const { queryAudit } = await import("../lib/audit-query.js");
  const result = await queryAudit({ action: "execute_step" });
  for (const e of result.entries) {
    assert.equal(e.action, "execute_step");
  }
});

await test("queryAudit filters by workspaceId", async () => {
  const { queryAudit } = await import("../lib/audit-query.js");
  const result = await queryAudit({ workspaceId: "ws2" });
  for (const e of result.entries) {
    assert.equal(e.workspaceId, "ws2");
  }
});

await test("queryAudit respects limit and cursor", async () => {
  const { queryAudit } = await import("../lib/audit-query.js");
  const result = await queryAudit({ limit: 2, cursor: 0 });
  assert.ok(result.entries.length <= 2);
  if (result.total > 2) {
    assert.ok(result.cursor !== null);
  }
});

await test("queryAudit filters by dateRange", async () => {
  const { queryAudit } = await import("../lib/audit-query.js");
  const result = await queryAudit({
    dateRange: { start: "2025-03-03T00:00:00Z", end: "2025-03-04T23:59:59Z" },
  });
  for (const e of result.entries) {
    const ts = new Date(e.timestamp);
    assert.ok(ts >= new Date("2025-03-03T00:00:00Z"));
    assert.ok(ts <= new Date("2025-03-04T23:59:59Z"));
  }
});

await test("queryAudit returns entries sorted newest first", async () => {
  const { queryAudit } = await import("../lib/audit-query.js");
  const result = await queryAudit();
  for (let i = 1; i < result.entries.length; i++) {
    const prev = new Date(result.entries[i - 1].timestamp).getTime();
    const curr = new Date(result.entries[i].timestamp).getTime();
    assert.ok(prev >= curr, "Entries should be newest first");
  }
});

await test("exportAudit returns JSON format", async () => {
  const { exportAudit } = await import("../lib/audit-query.js");
  const result = await exportAudit({}, "json");
  assert.equal(result.contentType, "application/json");
  assert.ok(result.filename.includes("audit-export"));
  assert.ok(result.filename.endsWith(".json"));
  const parsed = JSON.parse(result.data);
  assert.ok(Array.isArray(parsed));
});

await test("exportAudit returns CSV format", async () => {
  const { exportAudit } = await import("../lib/audit-query.js");
  const result = await exportAudit({}, "csv");
  assert.equal(result.contentType, "text/csv");
  assert.ok(result.filename.endsWith(".csv"));
  const lines = result.data.split("\n");
  assert.ok(lines[0].includes("timestamp"));
  assert.ok(lines[0].includes("action"));
  assert.ok(lines.length > 1);
});
