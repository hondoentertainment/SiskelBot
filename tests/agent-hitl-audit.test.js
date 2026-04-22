import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "hitl-audit-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  hitlAuditEnabled,
  recordHitlEvent,
  listHitlAudit,
} = await import("../lib/agent-hitl-audit.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("hitlAuditEnabled: off by default", () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  delete process.env.AGENT_HITL_AUDIT;
  try { assert.equal(hitlAuditEnabled(), false); }
  finally { if (prev !== undefined) process.env.AGENT_HITL_AUDIT = prev; }
});

test("recordHitlEvent: no-op when flag off", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  delete process.env.AGENT_HITL_AUDIT;
  try {
    const ok = await recordHitlEvent({ event: "request", token: "abc" });
    assert.equal(ok, false);
  } finally {
    if (prev !== undefined) process.env.AGENT_HITL_AUDIT = prev;
  }
});

test("recordHitlEvent: persists when flag on", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  process.env.AGENT_HITL_AUDIT = "1";
  try {
    const ok = await recordHitlEvent({
      event: "request",
      token: "tok-1",
      userId: "u",
      workspaceId: "audit-ws",
      toolName: "execute_step",
      summary: "deploy staging",
    });
    assert.equal(ok, true);
    const list = await listHitlAudit({ workspaceId: "audit-ws" });
    assert.ok(list.length >= 1);
    const entry = list.find((e) => e.token === "tok-1");
    assert.ok(entry);
    assert.equal(entry.event, "request");
    assert.equal(entry.toolName, "execute_step");
  } finally {
    if (prev === undefined) delete process.env.AGENT_HITL_AUDIT;
    else process.env.AGENT_HITL_AUDIT = prev;
  }
});

test("recordHitlEvent: rejects missing event", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  process.env.AGENT_HITL_AUDIT = "1";
  try {
    const ok = await recordHitlEvent({});
    assert.equal(ok, false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_HITL_AUDIT;
    else process.env.AGENT_HITL_AUDIT = prev;
  }
});

test("listHitlAudit: returns newest-first", async () => {
  const prev = process.env.AGENT_HITL_AUDIT;
  process.env.AGENT_HITL_AUDIT = "1";
  try {
    await recordHitlEvent({ event: "request", token: "t-a", workspaceId: "order-ws" });
    await recordHitlEvent({ event: "approve", token: "t-a", workspaceId: "order-ws" });
    const list = await listHitlAudit({ workspaceId: "order-ws" });
    assert.ok(list.length >= 2);
    assert.equal(list[0].event, "approve");
  } finally {
    if (prev === undefined) delete process.env.AGENT_HITL_AUDIT;
    else process.env.AGENT_HITL_AUDIT = prev;
  }
});
