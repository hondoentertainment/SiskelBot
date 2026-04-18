/**
 * Unit tests for lib/trace-share-store.js.
 *
 * Validates sign/verify roundtrip, tamper detection, expiry, revocation,
 * anonymization and scrubbing, TTL cap, and rate-limit counter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-trace-share-store-"));
process.env.STORAGE_PATH = tmpRoot;
process.env.AGENT_TRAJECTORY_TTL_MS = "3600000";
process.env.TRACE_SHARE_SECRET = "test-secret-" + "x".repeat(32);

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function loadModule() {
  const mod = await import("../lib/trace-share-store.js");
  mod._resetForTests();
  return mod;
}

test("signShareToken + verifyShareToken roundtrip returns payload", async () => {
  const m = await loadModule();
  const expiresAt = Date.now() + 60_000;
  const token = m.signShareToken({
    runId: "run-1",
    workspace: "ws-a",
    createdBy: "admin-a",
    expiresAt,
  });
  assert.equal(typeof token, "string");
  assert.ok(token.includes("."));
  const decoded = m.verifyShareToken(token);
  assert.ok(decoded, "should decode");
  assert.equal(decoded.runId, "run-1");
  assert.equal(decoded.workspace, "ws-a");
  assert.equal(decoded.createdBy, "admin-a");
  assert.equal(decoded.expiresAt, expiresAt);
});

test("tampered token (flipped byte in signature) verifies as null", async () => {
  const m = await loadModule();
  const token = m.signShareToken({
    runId: "run-2",
    workspace: "ws",
    createdBy: "a",
    expiresAt: Date.now() + 60_000,
  });
  const [p, s] = token.split(".");
  // Flip a character in the signature
  const flipped = s.charAt(0) === "A" ? "B" + s.slice(1) : "A" + s.slice(1);
  const bad = p + "." + flipped;
  assert.equal(m.verifyShareToken(bad), null);
});

test("tampered token (flipped byte in payload) verifies as null", async () => {
  const m = await loadModule();
  const token = m.signShareToken({
    runId: "run-2b",
    workspace: "ws",
    createdBy: "a",
    expiresAt: Date.now() + 60_000,
  });
  const [p, s] = token.split(".");
  const flipped = p.charAt(0) === "A" ? "B" + p.slice(1) : "A" + p.slice(1);
  const bad = flipped + "." + s;
  assert.equal(m.verifyShareToken(bad), null);
});

test("malformed token verifies as null", async () => {
  const m = await loadModule();
  assert.equal(m.verifyShareToken(""), null);
  assert.equal(m.verifyShareToken("not-a-token"), null);
  assert.equal(m.verifyShareToken("foo.bar.baz"), null);
  assert.equal(m.verifyShareToken(null), null);
});

test("expired token verifies as null", async () => {
  const m = await loadModule();
  // Sign with a very small TTL and wait it out.
  const token = m.signShareToken({
    runId: "run-exp",
    workspace: "ws",
    createdBy: "a",
    expiresAt: Date.now() + 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(m.verifyShareToken(token), null);
});

test("revoked token verifies as null", async () => {
  const m = await loadModule();
  const token = m.signShareToken({
    runId: "run-rev",
    workspace: "ws",
    createdBy: "a",
    expiresAt: Date.now() + 60_000,
  });
  assert.ok(m.verifyShareToken(token));
  m.revokeToken(token);
  assert.equal(m.verifyShareToken(token), null);
});

test("signShareToken rejects TTL greater than 30 days", async () => {
  const m = await loadModule();
  const expiresAt = Date.now() + 31 * 24 * 60 * 60 * 1000;
  assert.throws(
    () =>
      m.signShareToken({
        runId: "r",
        workspace: "w",
        createdBy: "a",
        expiresAt,
      }),
    /30 days/i,
  );
});

test("signShareToken rejects past expiresAt", async () => {
  const m = await loadModule();
  assert.throws(
    () =>
      m.signShareToken({
        runId: "r",
        workspace: "w",
        createdBy: "a",
        expiresAt: Date.now() - 1000,
      }),
    /future/i,
  );
});

test("loadAnonymizedTrace scrubs secrets and PII from tool args + results", async () => {
  const m = await loadModule();
  const { saveTrajectory } = await import("../lib/agent-trajectory.js");
  const runId = "anonymize-test-" + Date.now();
  const workspace = "sensitive-ws-" + Date.now();
  const now = Date.now();
  const at = (off) => new Date(now + off).toISOString();

  const steps = [
    { type: "start", at: at(0) },
    { type: "iteration", iteration: 1, at: at(5) },
    {
      type: "tool_call",
      iteration: 1,
      name: "fetch_allowed_url",
      argsPreview: JSON.stringify({
        url: "https://api.example.com",
        headers: "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456",
        email: "alice@example.com",
      }),
      at: at(10),
    },
    {
      type: "tool_result",
      iteration: 1,
      name: "fetch_allowed_url",
      ok: true,
      preview: "contact: bob@example.com, key=AKIAABCDEFGHIJKLMNOP",
      at: at(100),
    },
    { type: "stop", iteration: 1, reason: "model_finished", at: at(120) },
  ];
  await saveTrajectory(runId, {
    runId,
    workspace,
    sessionId: "sess-xyz",
    userId: "user-xyz",
    recordedAt: at(125),
    stepCount: steps.length,
    steps,
  });

  const token = {
    runId,
    workspace,
    createdBy: "admin-anon",
    expiresAt: Date.now() + 60_000,
  };
  const trace = await m.loadAnonymizedTrace(token);
  assert.ok(trace, "trace returned");
  assert.equal(trace.workspace, "<redacted>");
  assert.equal(trace.runId, runId);

  const serialized = JSON.stringify(trace);
  assert.ok(!/alice@example\.com/.test(serialized), "email should be redacted");
  assert.ok(!/bob@example\.com/.test(serialized), "email should be redacted (in result)");
  assert.ok(!/sk-abcdefghijklmnopqrstuvwxyz/.test(serialized), "openai key should be redacted");
  assert.ok(!/AKIAABCDEFGHIJKLMNOP/.test(serialized), "aws access key id should be redacted");
  // Sanity check scrub markers actually appear
  assert.ok(/REDACTED/.test(serialized), "expected at least one REDACTED marker");
});

test("loadAnonymizedTrace drops workspaceId, userId, sessionId, apiKey fields", async () => {
  const m = await loadModule();
  const { saveTrajectory } = await import("../lib/agent-trajectory.js");
  const runId = "drop-test-" + Date.now();
  const workspace = "ws-drop-" + Date.now();
  const now = Date.now();
  const at = (off) => new Date(now + off).toISOString();

  const steps = [
    { type: "start", at: at(0) },
    { type: "iteration", iteration: 1, at: at(5) },
    {
      type: "tool_call",
      iteration: 1,
      name: "db_query",
      argsPreview: JSON.stringify({
        workspaceId: "ws-secret",
        userId: "u-secret",
        sessionId: "s-secret",
        storageUserId: "su-secret",
        apiKey: "secret-key-value",
        authorization: "Bearer xyz",
        query: "select 1",
      }),
      at: at(10),
    },
    {
      type: "tool_result",
      iteration: 1,
      name: "db_query",
      ok: true,
      preview: "rows=1",
      at: at(50),
    },
    { type: "stop", iteration: 1, reason: "model_finished", at: at(60) },
  ];
  await saveTrajectory(runId, {
    runId,
    workspace,
    sessionId: "sess-xyz",
    recordedAt: at(65),
    stepCount: steps.length,
    steps,
  });

  const token = {
    runId,
    workspace,
    createdBy: "admin-drop",
    expiresAt: Date.now() + 60_000,
  };
  const trace = await m.loadAnonymizedTrace(token);
  assert.ok(trace);
  const serialized = JSON.stringify(trace);
  assert.ok(!/ws-secret/.test(serialized));
  assert.ok(!/u-secret/.test(serialized));
  assert.ok(!/s-secret/.test(serialized));
  assert.ok(!/su-secret/.test(serialized));
  assert.ok(!/secret-key-value/.test(serialized));
  // The db query string is a "safe" arg -> should still be present
  assert.ok(/select 1/.test(serialized), "non-sensitive fields should pass through");
});

test("loadAnonymizedTrace with redactFields=[model] replaces model strings", async () => {
  const m = await loadModule();
  const { saveTrajectory } = await import("../lib/agent-trajectory.js");
  const runId = "model-redact-" + Date.now();
  const workspace = "ws-m-" + Date.now();
  const now = Date.now();
  const at = (off) => new Date(now + off).toISOString();

  const steps = [
    { type: "start", at: at(0), model: "gpt-sensitive" },
    { type: "iteration", iteration: 1, at: at(1) },
    {
      type: "tool_call",
      iteration: 1,
      name: "t",
      argsPreview: JSON.stringify({ model: "gpt-sensitive", q: "hello" }),
      at: at(2),
    },
    { type: "tool_result", iteration: 1, name: "t", ok: true, preview: "ok", at: at(3) },
    { type: "stop", iteration: 1, reason: "model_finished", at: at(4) },
  ];
  await saveTrajectory(runId, {
    runId,
    workspace,
    recordedAt: at(5),
    stepCount: steps.length,
    steps,
  });

  const trace = await m.loadAnonymizedTrace({
    runId,
    workspace,
    createdBy: "admin",
    expiresAt: Date.now() + 60_000,
    redactFields: ["model"],
  });
  assert.ok(trace);
  const serialized = JSON.stringify(trace);
  assert.ok(!/gpt-sensitive/.test(serialized), "model value should be redacted");
});

test("loadAnonymizedTrace returns null for unknown runId", async () => {
  const m = await loadModule();
  const trace = await m.loadAnonymizedTrace({
    runId: "does-not-exist-" + Date.now(),
    workspace: "ws",
    createdBy: "a",
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(trace, null);
});

test("shouldRateLimitCreate returns true after exceeding max within window", async () => {
  const m = await loadModule();
  const ip = "203.0.113.42";
  const max = 3;
  assert.equal(m.shouldRateLimitCreate(ip, max), false);
  assert.equal(m.shouldRateLimitCreate(ip, max), false);
  assert.equal(m.shouldRateLimitCreate(ip, max), false);
  // fourth call exceeds max (>3)
  assert.equal(m.shouldRateLimitCreate(ip, max), true);
  // still rate limited
  assert.equal(m.shouldRateLimitCreate(ip, max), true);
});

test("listMyTokens returns tokens for creator, excludes expired/revoked", async () => {
  const m = await loadModule();
  const tok1 = m.signShareToken({
    runId: "list-1",
    workspace: "w",
    createdBy: "admin-list",
    expiresAt: Date.now() + 60_000,
  });
  m.signShareToken({
    runId: "list-2",
    workspace: "w",
    createdBy: "admin-list",
    expiresAt: Date.now() + 60_000,
  });
  let mine = m.listMyTokens("admin-list");
  assert.equal(mine.length, 2);
  m.revokeToken(tok1);
  mine = m.listMyTokens("admin-list");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].runId, "list-2");
});

test("truncation: long args are truncated to <= 600 + 1 chars", async () => {
  const m = await loadModule();
  const { saveTrajectory } = await import("../lib/agent-trajectory.js");
  const runId = "trunc-" + Date.now();
  const workspace = "ws-t-" + Date.now();
  const big = "x".repeat(2000);
  const now = Date.now();
  const at = (off) => new Date(now + off).toISOString();
  await saveTrajectory(runId, {
    runId,
    workspace,
    recordedAt: at(0),
    stepCount: 4,
    steps: [
      { type: "start", at: at(0) },
      { type: "iteration", iteration: 1, at: at(1) },
      { type: "tool_call", iteration: 1, name: "t", argsPreview: JSON.stringify({ payload: big }), at: at(2) },
      { type: "tool_result", iteration: 1, name: "t", ok: true, preview: big, at: at(3) },
      { type: "stop", iteration: 1, reason: "model_finished", at: at(4) },
    ],
  });
  const trace = await m.loadAnonymizedTrace({
    runId,
    workspace,
    createdBy: "admin",
    expiresAt: Date.now() + 60_000,
  });
  assert.ok(trace);
  const iter1 = trace.iterations.find((x) => x.iteration === 1);
  assert.ok(iter1, "iteration 1 present");
  const tc = iter1.toolCalls[0];
  assert.ok(tc, "tool call present");
  const argStr = typeof tc.argsRedacted === "object" ? tc.argsRedacted.payload : tc.argsRedacted;
  assert.ok(typeof argStr === "string");
  assert.ok(argStr.length <= 601, "args truncated: " + argStr.length);
  assert.ok(argStr.endsWith("…"));
  assert.ok(typeof tc.resultPreview === "string");
  assert.ok(tc.resultPreview.length <= 601);
});
