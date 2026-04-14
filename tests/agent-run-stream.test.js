/**
 * Tests for lib/agent-run-stream.js.
 *
 * Uses a temp STORAGE_PATH so the real lib/agent-session.js APIs
 * (createAgentSession / appendAgentSessionEvent / updateAgentSessionPlan) can
 * drive the backfill without touching prod data. The trajectory module is
 * used via its public API (saveTrajectory / loadTrajectory).
 *
 * The SSE transport is validated with an in-memory "fake response" object
 * that records writes synchronously — no HTTP needed at this layer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "agent-run-stream-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const sessionMod = await import("../lib/agent-session.js");
const trajMod = await import("../lib/agent-trajectory.js");
const streamMod = await import("../lib/agent-run-stream.js");

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

function makeFakeRes() {
  const chunks = [];
  const headers = {};
  const em = new EventEmitter();
  em.statusCode = 0;
  em.headersSent = false;
  em.ended = false;
  em.headers = headers;
  em.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
  em.getHeader = (k) => headers[k.toLowerCase()];
  em.flushHeaders = function () { this.headersSent = true; };
  em.write = (buf) => { chunks.push(String(buf)); return true; };
  em.end = function (buf) {
    if (buf) chunks.push(String(buf));
    this.ended = true;
    em.emit("close");
    return true;
  };
  Object.defineProperty(em, "body", { get() { return chunks.join(""); } });
  return em;
}

function parseSSE(body) {
  const out = [];
  const blocks = body.split(/\n\n/).filter((b) => b.trim() && !b.startsWith(":"));
  for (const block of blocks) {
    let event = null;
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (event && dataLines.length) {
      let parsed = null;
      try { parsed = JSON.parse(dataLines.join("\n")); } catch (_) {}
      out.push({ event, data: parsed });
    }
  }
  return out;
}

test("streamAgentRun returns 404 when session not found", async () => {
  streamMod.__resetAgentRunStreamForTests();
  const res = makeFakeRes();
  let notFoundCalled = false;
  await streamMod.streamAgentRun({
    sessionId: "does-not-exist",
    res,
    onNotFound: () => {
      notFoundCalled = true;
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Session not found" }));
    },
  });
  assert.equal(notFoundCalled, true);
  assert.equal(res.statusCode, 404);
});

test("streamAgentRun backfills historical events before going live", async () => {
  streamMod.__resetAgentRunStreamForTests();

  const session = await sessionMod.createAgentSession({
    workspace: "wsA",
    ownerStorageUserId: "user-1",
    title: "backfill-test",
    planSummary: "initial plan",
  });

  // Mutate the session so backfill has more than just session_created.
  await sessionMod.updateAgentSessionPlan(session.id, { planSummary: "v2" });
  await sessionMod.setAgentSessionStatus(session.id, "paused");

  // Seed a trajectory for a synthetic run id.
  const runId = "run-test-1";
  await trajMod.saveTrajectory(runId, {
    workspace: "wsA",
    stepCount: 2,
    steps: [
      { kind: "tool_call", tool: "search_context", at: new Date().toISOString() },
      { kind: "tool_result", tool: "search_context", result: "hit", at: new Date().toISOString() },
    ],
  });
  // Link run to session so streamAgentRun knows to load the trajectory.
  await sessionMod.linkRunToAgentSession(session.id, runId);

  const res = makeFakeRes();

  // Drive the emitter after backfill completes.
  const emitter = streamMod.getAgentRunEmitter(session.id);
  // Emit asynchronously so backfill runs first.
  setTimeout(() => {
    emitter.emit("event", { type: "cost.update", payload: { totalUsd: 0.02 } });
    emitter.emit("event", { type: "done", payload: {} });
  }, 50);

  await streamMod.streamAgentRun({ sessionId: session.id, res });

  const events = parseSSE(res.body);
  const types = events.map((e) => e.event);

  // Initial status.change exists.
  assert.ok(types.includes("status.change"), "emits initial status.change");

  // Backfilled plan_updated → plan.update
  assert.ok(types.includes("plan.update"), "emits plan.update for plan_updated session event");

  // Backfilled trajectory steps
  assert.ok(types.includes("tool.call"), "emits tool.call from trajectory backfill");
  assert.ok(types.includes("tool.result"), "emits tool.result from trajectory backfill");

  // Live events after backfill
  assert.ok(types.includes("cost.update"), "emits live cost.update");
  assert.ok(types.includes("done"), "emits live done");

  // Order: backfill (tool.call) must precede live (cost.update).
  const toolCallIdx = types.indexOf("tool.call");
  const costIdx = types.indexOf("cost.update");
  assert.ok(toolCallIdx < costIdx, "backfill precedes live events");

  // Seq monotonic increasing.
  const seqs = events.map((e) => e.data?.seq).filter((s) => Number.isFinite(s));
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] > seqs[i - 1], `seq monotonic at ${i}: ${seqs[i - 1]} → ${seqs[i]}`);
  }

  // Headers were set for SSE.
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.equal(res.headers["cache-control"], "no-cache, no-transform");
  assert.equal(res.headers["connection"], "keep-alive");
  assert.equal(res.headers["x-accel-buffering"], "no");
});

test("publishAgentRunEvent reaches a live subscriber", async () => {
  streamMod.__resetAgentRunStreamForTests();

  const session = await sessionMod.createAgentSession({
    workspace: "wsB",
    ownerStorageUserId: "user-2",
    planSummary: "p",
  });

  const res = makeFakeRes();

  setTimeout(() => {
    streamMod.publishAgentRunEvent(session.id, "artifact.new", { id: "a1", name: "report.txt", mime: "text/plain" });
    streamMod.publishAgentRunEvent(session.id, "done", {});
  }, 50);

  await streamMod.streamAgentRun({ sessionId: session.id, res });

  const events = parseSSE(res.body);
  const artifact = events.find((e) => e.event === "artifact.new");
  assert.ok(artifact, "artifact.new reached the subscriber");
  assert.equal(artifact.data?.payload?.name, "report.txt");
});

test("streamAgentRun closes cleanly when client aborts", async () => {
  streamMod.__resetAgentRunStreamForTests();

  const session = await sessionMod.createAgentSession({
    workspace: "wsC",
    ownerStorageUserId: "user-3",
    planSummary: "p",
  });

  const res = makeFakeRes();
  const req = new EventEmitter();

  const p = streamMod.streamAgentRun({ sessionId: session.id, res, req });
  // Simulate client abort after backfill.
  setTimeout(() => req.emit("close"), 20);
  await p;
  assert.equal(res.ended, true, "response was ended after client close");
});
