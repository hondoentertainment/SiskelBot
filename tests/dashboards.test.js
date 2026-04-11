/**
 * Tests for lib/dashboards.js — CRUD, widget rendering, cloning, share tokens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-dashboards-"));
process.env.STORAGE_PATH = tempDir;

const {
  createDashboard,
  updateDashboard,
  deleteDashboard,
  listDashboards,
  getDashboard,
  cloneDashboard,
  renderWidget,
  getDashboardData,
  getDashboardByShareToken,
  WIDGET_TYPES,
  DASHBOARD_LIMITS,
} = await import("../lib/dashboards.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// ─── createDashboard ─────────────────────────────────────────────────────────

test("createDashboard creates a new dashboard with empty layout", async () => {
  const dash = await createDashboard("ws-1", "My Dashboard");
  assert.ok(dash.id);
  assert.ok(dash.id.startsWith("dash_"));
  assert.equal(dash.workspaceId, "ws-1");
  assert.equal(dash.name, "My Dashboard");
  assert.deepEqual(dash.layout.widgets, []);
  assert.ok(dash.shareToken);
  assert.ok(dash.createdAt);
  assert.ok(dash.updatedAt);
});

test("createDashboard normalizes provided layout widgets", async () => {
  const dash = await createDashboard("ws-1", "With Widgets", {
    widgets: [
      { type: "metric_card", title: "Requests" },
      { type: "line_chart", config: { metric: "tokens", period: "30d" } },
    ],
  });
  assert.equal(dash.layout.widgets.length, 2);
  assert.equal(dash.layout.widgets[0].type, "metric_card");
  assert.equal(dash.layout.widgets[0].title, "Requests");
  assert.ok(dash.layout.widgets[0].id);
  assert.equal(dash.layout.widgets[1].config.metric, "tokens");
  assert.equal(dash.layout.widgets[1].config.period, "30d");
  // Defaults should be merged in.
  assert.equal(dash.layout.widgets[1].config.granularity, "day");
});

test("createDashboard rejects missing workspaceId", async () => {
  await assert.rejects(() => createDashboard("", "x"), /workspaceId is required/);
});

test("createDashboard rejects missing name", async () => {
  await assert.rejects(() => createDashboard("ws-1", ""), /name is required/);
});

test("createDashboard rejects unknown widget type", async () => {
  await assert.rejects(
    () => createDashboard("ws-1", "Bad", { widgets: [{ type: "nonsense" }] }),
    /unknown widget type/
  );
});

test("createDashboard rejects too many widgets", async () => {
  const widgets = Array.from({ length: DASHBOARD_LIMITS.MAX_WIDGETS_PER_DASHBOARD + 1 }, () => ({
    type: "text",
  }));
  await assert.rejects(
    () => createDashboard("ws-1", "Too many", { widgets }),
    /too many widgets/
  );
});

// ─── getDashboard ────────────────────────────────────────────────────────────

test("getDashboard returns the stored dashboard", async () => {
  const created = await createDashboard("ws-2", "Lookup");
  const fetched = await getDashboard(created.id);
  assert.ok(fetched);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.name, "Lookup");
});

test("getDashboard returns null for unknown id", async () => {
  const fetched = await getDashboard("dash_does_not_exist");
  assert.equal(fetched, null);
});

// ─── listDashboards ──────────────────────────────────────────────────────────

test("listDashboards returns dashboards for a workspace ordered by updatedAt desc", async () => {
  const ws = "ws-list";
  const a = await createDashboard(ws, "A");
  await new Promise((r) => setTimeout(r, 5));
  const b = await createDashboard(ws, "B");
  const list = await listDashboards(ws);
  assert.ok(list.length >= 2);
  const ids = list.map((d) => d.id);
  // B is more recent than A
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
});

test("listDashboards returns empty for unknown workspace", async () => {
  const list = await listDashboards("ws-empty-xyz");
  assert.deepEqual(list, []);
});

// ─── updateDashboard ─────────────────────────────────────────────────────────

test("updateDashboard updates name, description, and layout", async () => {
  const created = await createDashboard("ws-3", "Original");
  await new Promise((r) => setTimeout(r, 5));
  const updated = await updateDashboard(created.id, {
    name: "Renamed",
    description: "An updated description",
    layout: { widgets: [{ type: "metric_card" }, { type: "text", config: { content: "Hi" } }] },
  });
  assert.equal(updated.name, "Renamed");
  assert.equal(updated.description, "An updated description");
  assert.equal(updated.layout.widgets.length, 2);
  assert.notEqual(updated.updatedAt, created.updatedAt);
});

test("updateDashboard rejects empty name", async () => {
  const created = await createDashboard("ws-3", "Has name");
  await assert.rejects(() => updateDashboard(created.id, { name: "   " }), /name cannot be empty/);
});

test("updateDashboard throws for unknown dashboard", async () => {
  await assert.rejects(() => updateDashboard("dash_missing", { name: "x" }), /not found/);
});

// ─── deleteDashboard ─────────────────────────────────────────────────────────

test("deleteDashboard removes the dashboard", async () => {
  const created = await createDashboard("ws-4", "To delete");
  const result = await deleteDashboard(created.id);
  assert.equal(result.ok, true);
  const after = await getDashboard(created.id);
  assert.equal(after, null);
});

test("deleteDashboard returns not found for unknown id", async () => {
  const result = await deleteDashboard("dash_missing_123");
  assert.equal(result.ok, false);
});

// ─── cloneDashboard ──────────────────────────────────────────────────────────

test("cloneDashboard duplicates a dashboard with a new id", async () => {
  const original = await createDashboard("ws-clone", "Original Dashboard", {
    widgets: [
      { type: "metric_card", title: "Reqs", config: { metric: "requests", period: "7d" } },
      { type: "text", config: { content: "Notes" } },
    ],
  });
  const clone = await cloneDashboard(original.id);
  assert.notEqual(clone.id, original.id);
  assert.equal(clone.workspaceId, original.workspaceId);
  assert.equal(clone.name, "Original Dashboard (copy)");
  assert.equal(clone.layout.widgets.length, 2);
  assert.notEqual(clone.shareToken, original.shareToken);
});

test("cloneDashboard accepts a custom name", async () => {
  const original = await createDashboard("ws-clone", "Source");
  const clone = await cloneDashboard(original.id, "My Copy");
  assert.equal(clone.name, "My Copy");
});

test("cloneDashboard throws for unknown dashboard", async () => {
  await assert.rejects(() => cloneDashboard("dash_missing"), /not found/);
});

// ─── share tokens ────────────────────────────────────────────────────────────

test("getDashboardByShareToken resolves to the dashboard", async () => {
  const created = await createDashboard("ws-share", "Shared");
  const fetched = await getDashboardByShareToken(created.shareToken);
  assert.ok(fetched);
  assert.equal(fetched.id, created.id);
});

test("getDashboardByShareToken returns null for unknown token", async () => {
  const fetched = await getDashboardByShareToken("not-a-real-token");
  assert.equal(fetched, null);
});

test("deleteDashboard cleans up share token index", async () => {
  const created = await createDashboard("ws-share2", "Will delete");
  const token = created.shareToken;
  await deleteDashboard(created.id);
  const fetched = await getDashboardByShareToken(token);
  assert.equal(fetched, null);
});

// ─── renderWidget ────────────────────────────────────────────────────────────

test("renderWidget renders text widget", async () => {
  const r = await renderWidget({
    id: "w1",
    type: "text",
    config: { content: "Hello world", markdown: true },
  });
  assert.equal(r.widgetId, "w1");
  assert.equal(r.type, "text");
  assert.equal(r.data.content, "Hello world");
  assert.equal(r.data.markdown, true);
  assert.equal(r.error, undefined);
});

test("renderWidget renders iframe widget", async () => {
  const r = await renderWidget({
    id: "w2",
    type: "iframe",
    config: { url: "https://example.com", height: 300 },
  });
  assert.equal(r.data.url, "https://example.com");
  assert.equal(r.data.height, 300);
});

test("renderWidget renders status widget", async () => {
  const r = await renderWidget({
    id: "w3",
    type: "status",
    config: { service: "api", healthEndpoint: "/health" },
  });
  assert.equal(r.data.service, "api");
  assert.equal(r.data.endpoint, "/health");
  assert.ok(r.data.status);
});

test("renderWidget renders metric_card widget", async () => {
  const r = await renderWidget({
    id: "w4",
    type: "metric_card",
    config: { metric: "requests", period: "7d", format: "number" },
  });
  assert.equal(r.type, "metric_card");
  assert.equal(r.data.metric, "requests");
  assert.equal(r.data.period, "7d");
  assert.equal(typeof r.data.value, "number");
});

test("renderWidget renders line_chart widget", async () => {
  const r = await renderWidget({
    id: "w5",
    type: "line_chart",
    config: { metric: "requests", period: "7d", granularity: "day" },
  });
  assert.equal(r.type, "line_chart");
  assert.ok(Array.isArray(r.data.points));
});

test("renderWidget renders bar_chart widget", async () => {
  const r = await renderWidget({
    id: "w6",
    type: "bar_chart",
    config: { metric: "requests", groupBy: "model" },
  });
  assert.equal(r.type, "bar_chart");
  assert.ok(Array.isArray(r.data.bars));
});

test("renderWidget renders table widget", async () => {
  const r = await renderWidget({
    id: "w7",
    type: "table",
    config: { source: "top_models", columns: ["name", "requests"], limit: 5 },
  });
  assert.equal(r.type, "table");
  assert.deepEqual(r.data.columns, ["name", "requests"]);
  assert.ok(Array.isArray(r.data.rows));
  assert.ok(r.data.rows.length <= 5);
});

test("renderWidget returns error for unknown widget type", async () => {
  const r = await renderWidget({ id: "wbad", type: "nope", config: {} });
  assert.ok(r.error);
});

// ─── getDashboardData ────────────────────────────────────────────────────────

test("getDashboardData renders all widgets in a dashboard", async () => {
  const dash = await createDashboard("ws-data", "Data Dashboard", {
    widgets: [
      { type: "metric_card", title: "M1", config: { metric: "requests", period: "7d" } },
      { type: "text", title: "T1", config: { content: "A note" } },
      { type: "iframe", title: "I1", config: { url: "https://example.com", height: 200 } },
    ],
  });
  const data = await getDashboardData(dash.id);
  assert.equal(data.dashboardId, dash.id);
  assert.equal(data.name, "Data Dashboard");
  assert.equal(data.widgets.length, 3);
  // Each widget should have a widgetId and data field.
  for (const w of data.widgets) {
    assert.ok(w.widgetId);
    assert.ok(w.type);
  }
  // Text widget should round-trip its content.
  const text = data.widgets.find((w) => w.type === "text");
  assert.equal(text.data.content, "A note");
  // Iframe widget should round-trip its url.
  const iframe = data.widgets.find((w) => w.type === "iframe");
  assert.equal(iframe.data.url, "https://example.com");
});

test("getDashboardData throws for unknown dashboard", async () => {
  await assert.rejects(() => getDashboardData("dash_unknown"), /not found/);
});

// ─── widget catalog ──────────────────────────────────────────────────────────

test("WIDGET_TYPES catalog exposes the expected types", () => {
  const expected = ["metric_card", "line_chart", "bar_chart", "table", "text", "iframe", "status"];
  for (const type of expected) {
    assert.ok(WIDGET_TYPES[type], `expected ${type} in WIDGET_TYPES`);
    assert.ok(WIDGET_TYPES[type].name);
    assert.ok(WIDGET_TYPES[type].config);
  }
});
