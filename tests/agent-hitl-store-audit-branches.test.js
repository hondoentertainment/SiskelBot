/**
 * Branch-coverage tests for the wave-2 audit-log wiring in agent-hitl-store.
 * Exercises both the flag-off no-op path and the flag-on persistence path
 * for saveHitlState and takeHitlState.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "hitl-audit-branches-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { saveHitlState, takeHitlState } = await import("../lib/agent-hitl-store.js");
const { listHitlAudit } = await import("../lib/agent-hitl-audit.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("saveHitlState: no-ops audit when flag off", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  delete process.env.AGENT_HITL_AUDIT;
  try {
    const token = saveHitlState({
      workspaceId: "audit-branch-off",
      toolCallsSnapshot: [{ id: "tc1", function: { name: "execute_step" } }],
      hitlToolCallIds: ["tc1"],
      hitlArgsById: { tc1: { action: "deploy" } },
    });
    assert.ok(token);
    await new Promise((r) => setImmediate(r));
    const list = await listHitlAudit({ workspaceId: "audit-branch-off" });
    assert.equal(list.length, 0);
  } finally {
    if (prev !== undefined) process.env.AGENT_HITL_AUDIT = prev;
  }
});

test("saveHitlState: writes audit request when flag on", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  process.env.AGENT_HITL_AUDIT = "1";
  try {
    const token = saveHitlState({
      workspaceId: "audit-branch-on",
      toolCallsSnapshot: [{ id: "tc1", function: { name: "execute_step" } }],
      hitlToolCallIds: ["tc1"],
      hitlArgsById: { tc1: { action: "build" } },
    });
    // Wait for any pending best-effort writes
    await new Promise((r) => setTimeout(r, 20));
    const list = await listHitlAudit({ workspaceId: "audit-branch-on" });
    const entry = list.find((e) => e.token === token);
    assert.ok(entry);
    assert.equal(entry.event, "request");
    assert.equal(entry.toolName, "execute_step");
  } finally {
    if (prev === undefined) delete process.env.AGENT_HITL_AUDIT;
    else process.env.AGENT_HITL_AUDIT = prev;
  }
});

test("takeHitlState: writes approve event when flag on", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  process.env.AGENT_HITL_AUDIT = "1";
  try {
    const token = saveHitlState({ workspaceId: "take-approve" });
    takeHitlState(token, { decision: "approve" });
    await new Promise((r) => setTimeout(r, 20));
    const list = await listHitlAudit({ workspaceId: "take-approve" });
    const approved = list.find((e) => e.event === "approve" && e.token === token);
    assert.ok(approved);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HITL_AUDIT;
    else process.env.AGENT_HITL_AUDIT = prev;
  }
});

test("takeHitlState: writes deny event when flag on", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  process.env.AGENT_HITL_AUDIT = "1";
  try {
    const token = saveHitlState({ workspaceId: "take-deny" });
    takeHitlState(token, { decision: "deny" });
    await new Promise((r) => setTimeout(r, 20));
    const list = await listHitlAudit({ workspaceId: "take-deny" });
    const denied = list.find((e) => e.event === "deny" && e.token === token);
    assert.ok(denied);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HITL_AUDIT;
    else process.env.AGENT_HITL_AUDIT = prev;
  }
});

test("takeHitlState: skips audit write without decision", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  process.env.AGENT_HITL_AUDIT = "1";
  try {
    const token = saveHitlState({ workspaceId: "take-no-decision" });
    takeHitlState(token);
    await new Promise((r) => setTimeout(r, 20));
    const list = await listHitlAudit({ workspaceId: "take-no-decision" });
    const decisions = list.filter((e) => ["approve", "deny"].includes(e.event));
    assert.equal(decisions.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HITL_AUDIT;
    else process.env.AGENT_HITL_AUDIT = prev;
  }
});

test("takeHitlState: tolerates unknown decision string", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  process.env.AGENT_HITL_AUDIT = "1";
  try {
    const token = saveHitlState({ workspaceId: "take-unknown" });
    takeHitlState(token, { decision: "maybe" });
    await new Promise((r) => setTimeout(r, 20));
    const list = await listHitlAudit({ workspaceId: "take-unknown" });
    const decisions = list.filter((e) => ["approve", "deny"].includes(e.event));
    assert.equal(decisions.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HITL_AUDIT;
    else process.env.AGENT_HITL_AUDIT = prev;
  }
});
