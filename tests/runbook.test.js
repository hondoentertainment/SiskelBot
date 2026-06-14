/**
 * Tests for lib/runbook.js — getRunbook, listRunbooks,
 * generateIncidentRunbook, generateIncidentReport.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getRunbook,
  listRunbooks,
  generateIncidentRunbook,
  generateIncidentReport,
} from "../lib/runbook.js";

// --- getRunbook ---

test("getRunbook returns a known template with expected fields", () => {
  const rb = getRunbook("high_error_rate");
  assert.ok(rb, "expected a runbook");
  assert.equal(rb.name, "high_error_rate");
  assert.equal(rb.title, "High Error Rate");
  assert.equal(rb.severity, "high");
  assert.ok(Array.isArray(rb.symptoms) && rb.symptoms.length > 0);
  assert.ok(Array.isArray(rb.steps) && rb.steps.length > 0);
  assert.ok(Array.isArray(rb.commands));
  assert.ok(Array.isArray(rb.metrics));
});

test("getRunbook returns null for unknown name", () => {
  assert.equal(getRunbook("does_not_exist"), null);
});

test("getRunbook returns null for missing or non-string input", () => {
  assert.equal(getRunbook(""), null);
  assert.equal(getRunbook(null), null);
  assert.equal(getRunbook(undefined), null);
  assert.equal(getRunbook(42), null);
});

test("getRunbook returns templates for every documented runbook", () => {
  const expected = [
    "high_error_rate",
    "latency_spike",
    "quota_exhausted",
    "backend_down",
    "database_slow",
    "webhook_dlq_growing",
    "memory_leak",
    "disk_full",
  ];
  for (const name of expected) {
    const rb = getRunbook(name);
    assert.ok(rb, `expected runbook for ${name}`);
    assert.equal(rb.name, name);
  }
});

// --- listRunbooks ---

test("listRunbooks returns all runbooks as summaries", () => {
  const list = listRunbooks();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 8, `expected at least 8 runbooks, got ${list.length}`);
  for (const entry of list) {
    assert.ok(entry.name);
    assert.ok(entry.title);
    assert.ok(entry.severity);
    assert.ok(Array.isArray(entry.symptoms));
  }
});

test("listRunbooks summaries include high_error_rate with correct severity", () => {
  const list = listRunbooks();
  const found = list.find((r) => r.name === "high_error_rate");
  assert.ok(found);
  assert.equal(found.severity, "high");
});

// --- generateIncidentRunbook ---

test("generateIncidentRunbook produces enriched runbook for a known type", async () => {
  const incident = {
    type: "high_error_rate",
    severity: "critical",
    startTime: "2026-04-10T12:00:00Z",
    metrics: { errorRate: 0.12 },
    description: "Error rate climbed after deploy v1.23.",
  };
  const generated = await generateIncidentRunbook(incident);

  assert.equal(generated._version, 1);
  assert.ok(generated.incidentId && generated.incidentId.startsWith("inc_"));
  assert.ok(generated.generatedAt);

  assert.equal(generated.incident.type, "high_error_rate");
  // severity override from incident wins over template default
  assert.equal(generated.incident.severity, "critical");
  assert.equal(generated.incident.startTime, "2026-04-10T12:00:00Z");
  assert.deepEqual(generated.incident.metrics, { errorRate: 0.12 });
  assert.equal(generated.incident.description, "Error rate climbed after deploy v1.23.");

  assert.equal(generated.runbook.name, "high_error_rate");
  assert.equal(generated.runbook.title, "High Error Rate");
  assert.ok(Array.isArray(generated.runbook.steps) && generated.runbook.steps.length > 0);
  assert.ok(Array.isArray(generated.runbook.remediation));
  assert.ok(Array.isArray(generated.runbook.prevention));

  // Enriched context is always present (even if empty)
  assert.ok(generated.context);
  assert.ok(Array.isArray(generated.context.recentAudit));
  assert.ok(generated.context.collectedAt);
});

test("generateIncidentRunbook falls back to template severity when not specified", async () => {
  const generated = await generateIncidentRunbook({ type: "latency_spike" });
  assert.equal(generated.incident.severity, "medium");
  assert.equal(generated.runbook.title, "Latency Spike");
});

test("generateIncidentRunbook throws on missing incident", async () => {
  await assert.rejects(() => generateIncidentRunbook(null), /incident is required/);
  await assert.rejects(() => generateIncidentRunbook(undefined), /incident is required/);
});

test("generateIncidentRunbook throws on missing type", async () => {
  await assert.rejects(() => generateIncidentRunbook({}), /incident\.type is required/);
  await assert.rejects(
    () => generateIncidentRunbook({ type: "" }),
    /incident\.type is required/
  );
});

test("generateIncidentRunbook throws on unknown type", async () => {
  await assert.rejects(
    () => generateIncidentRunbook({ type: "nope_unknown" }),
    /Unknown runbook type/
  );
});

test("generateIncidentRunbook defaults startTime to generation time when absent", async () => {
  const before = Date.now();
  const generated = await generateIncidentRunbook({ type: "disk_full" });
  const after = Date.now();
  assert.ok(generated.incident.startTime);
  const t = Date.parse(generated.incident.startTime);
  assert.ok(t >= before && t <= after + 1000);
});

// --- generateIncidentReport ---

test("generateIncidentReport produces a post-mortem with timeline and actions", async () => {
  const incident = {
    id: "inc-42",
    type: "backend_down",
    severity: "critical",
    startTime: "2026-04-10T10:00:00Z",
  };
  const resolution = {
    owner: "alice",
    outcome: "resolved",
    endTime: "2026-04-10T10:30:00Z",
    timeline: [
      { at: "2026-04-10T10:05:00Z", note: "Confirmed backend unreachable" },
      { at: "2026-04-10T10:20:00Z", note: "Restarted backend container" },
      { at: "2026-04-10T10:28:00Z", note: "Circuit breaker closed" },
    ],
    actionsRun: ["restart-backend", "close-circuit-breaker"],
  };

  const report = await generateIncidentReport(incident, resolution);

  assert.equal(report._version, 1);
  assert.ok(report.reportId && report.reportId.startsWith("pm_"));
  assert.ok(report.generatedAt);

  assert.equal(report.incident.id, "inc-42");
  assert.equal(report.incident.type, "backend_down");
  assert.equal(report.incident.severity, "critical");
  assert.equal(report.incident.durationMs, 30 * 60 * 1000);

  assert.equal(report.resolution.owner, "alice");
  assert.equal(report.resolution.outcome, "resolved");
  assert.equal(report.resolution.timeline.length, 3);
  assert.equal(report.resolution.actionsRun.length, 2);

  assert.ok(Array.isArray(report.prevention));

  assert.ok(report.markdown.includes("Post-Mortem"));
  assert.ok(report.markdown.includes("Timeline"));
  assert.ok(report.markdown.includes("Restarted backend container"));
  assert.ok(report.markdown.includes("restart-backend"));
  assert.ok(report.markdown.includes("alice"));
});

test("generateIncidentReport handles missing timeline and actions gracefully", async () => {
  const incident = { id: "inc-1", type: "memory_leak", startTime: "2026-04-10T00:00:00Z" };
  const resolution = { outcome: "mitigated", endTime: "2026-04-10T01:00:00Z" };
  const report = await generateIncidentReport(incident, resolution);
  assert.equal(report.resolution.timeline.length, 0);
  assert.equal(report.resolution.actionsRun.length, 0);
  assert.ok(report.markdown.includes("no timeline entries"));
  assert.ok(report.markdown.includes("no actions"));
  assert.equal(report.incident.durationMs, 60 * 60 * 1000);
});

test("generateIncidentReport handles unknown incident type without throwing", async () => {
  const incident = { id: "x", type: "something_custom", startTime: "2026-04-10T00:00:00Z" };
  const resolution = { outcome: "resolved" };
  const report = await generateIncidentReport(incident, resolution);
  assert.equal(report.incident.type, "something_custom");
  assert.ok(report.markdown.includes("something_custom"));
  assert.deepEqual(report.prevention, []);
});

test("generateIncidentReport throws on missing incident or resolution", async () => {
  await assert.rejects(() => generateIncidentReport(null, {}), /incident is required/);
  await assert.rejects(
    () => generateIncidentReport({ type: "high_error_rate" }, null),
    /resolution is required/
  );
});
