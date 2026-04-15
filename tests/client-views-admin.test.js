/**
 * Unit tests for the pure helpers exported from
 * client/src/views/admin-view.js. No JSDOM required.
 */

import test from "node:test";
import assert from "node:assert/strict";

if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ appendChild: () => {}, addEventListener: () => {}, setAttribute: () => {}, dataset: {}, classList: { toggle: () => {} } }),
    head: { appendChild: () => {} },
  };
}

const {
  formatAuditEntry,
  summarizeWorkspace,
  redactSensitive,
  formatRelativeTime,
} = await import("../client/src/views/admin-view.js");

test("formatAuditEntry: normalizes missing fields and slices the timestamp", () => {
  const out = formatAuditEntry({
    timestamp: "2024-05-02T18:23:45.123Z",
    action: "login",
    userId: "u1",
    workspaceId: "w1",
    ok: true,
    error: "",
  });
  assert.equal(out.timestamp, "2024-05-02 18:23:45");
  assert.equal(out.action, "login");
  assert.equal(out.userId, "u1");
  assert.equal(out.workspaceId, "w1");
  assert.equal(out.ok, true);
  assert.equal(out.status, "OK");

  const empty = formatAuditEntry(null);
  assert.equal(empty.timestamp, "—");
  assert.equal(empty.action, "—");
  assert.equal(empty.status, "OK"); // default ok = true
  assert.equal(empty.details, "");

  const fail = formatAuditEntry({ ok: false, error: "boom" });
  assert.equal(fail.ok, false);
  assert.equal(fail.status, "FAIL");
  assert.equal(fail.details, "boom");
});

test("summarizeWorkspace: computes percent usage and clamps >100 to 100", () => {
  const a = summarizeWorkspace({
    userId: "alice",
    workspaceId: "ws-a",
    workspaceName: "Alice WS",
    tokensUsed: 500,
    quota: { limit: 1000 },
  });
  assert.equal(a.userId, "alice");
  assert.equal(a.workspaceId, "ws-a");
  assert.equal(a.workspaceName, "Alice WS");
  assert.equal(a.tokensUsed, 500);
  assert.equal(a.limit, 1000);
  assert.equal(a.pct, 50);
  assert.equal(a.hasOverride, false);

  const over = summarizeWorkspace({ workspaceId: "w", tokensUsed: 5000, override: 1000 });
  assert.equal(over.limit, 1000);
  assert.equal(over.pct, 100);
  assert.equal(over.hasOverride, true);

  const noLimit = summarizeWorkspace({ workspaceId: "w" });
  assert.equal(noLimit.limit, 0);
  assert.equal(noLimit.pct, 0);

  const empty = summarizeWorkspace(null);
  assert.equal(empty.workspaceId, "default");
  assert.equal(empty.userId, "—");
});

test("redactSensitive: masks api keys, bearer tokens, long secrets, and emails", () => {
  assert.equal(redactSensitive("sk-ABC1234567890abcdef"), "sk-****");
  assert.equal(redactSensitive("api_deadbeefcafe1234567890"), "api-****");
  assert.equal(redactSensitive("Bearer_ZZZZZZZZZZZZZZZZZZZZ"), "Bearer-****");
  // Raw long alnum token gets its tail masked
  assert.equal(
    redactSensitive("token=aaaaaaaaaaaaaaaaaaaaaaaaaa"),
    "token=aaaa****",
  );
  assert.equal(
    redactSensitive("user alice@example.com bounced"),
    "user al***@example.com bounced",
  );
  // Short strings pass through
  assert.equal(redactSensitive("hello"), "hello");
  assert.equal(redactSensitive(null), "");
  assert.equal(redactSensitive(undefined), "");
});

test("formatRelativeTime: handles ms, ISO, and bogus input", () => {
  const now = Date.UTC(2024, 4, 2, 18, 0, 0);
  assert.equal(formatRelativeTime(now - 1000, now), "just now");
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), "2d ago");
  assert.equal(formatRelativeTime(null), "—");
  assert.equal(formatRelativeTime(""), "—");
  assert.equal(formatRelativeTime("not-a-date"), "—");
  // ISO string input
  const iso = new Date(now - 2 * 60_000).toISOString();
  assert.equal(formatRelativeTime(iso, now), "2m ago");
});

test("formatAuditEntry: redacts sensitive content in details", () => {
  const out = formatAuditEntry({
    timestamp: "2024-01-01T00:00:00Z",
    action: "api_call",
    ok: false,
    error: "failed for user bob@acme.io with token sk-ABCDEFGHIJ1234567890",
  });
  assert.ok(out.details.includes("bo***@acme.io"), `expected email redacted, got: ${out.details}`);
  assert.ok(out.details.includes("sk-****"), `expected sk- redacted, got: ${out.details}`);
  assert.ok(!out.details.includes("bob@"));
});

test("summarizeWorkspace: override takes precedence over quota.limit", () => {
  const w = summarizeWorkspace({
    userId: "u",
    workspaceId: "x",
    tokensUsed: 250,
    quota: { limit: 500 },
    override: 1000,
  });
  assert.equal(w.limit, 1000);
  assert.equal(w.pct, 25);
  assert.equal(w.hasOverride, true);
});
