/**
 * When AGENT_UPFRONT_PLAN=1 and a durable session exists, runUpfrontPlanHook
 * persists planDag/planSummary via updateAgentSessionPlan (Phase 8 groundwork).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "upfront-plan-persist-"));
const prev = {
  STORAGE_PATH: process.env.STORAGE_PATH,
  AGENT_UPFRONT_PLAN: process.env.AGENT_UPFRONT_PLAN,
  AGENT_SESSION_API: process.env.AGENT_SESSION_API,
  AGENT_PERSIST_UPFRONT_PLAN: process.env.AGENT_PERSIST_UPFRONT_PLAN,
};
process.env.STORAGE_PATH = dir;
process.env.AGENT_UPFRONT_PLAN = "1";
process.env.AGENT_SESSION_API = "1";
delete process.env.AGENT_PERSIST_UPFRONT_PLAN;

const { createAgentSession, getAgentSession } = await import("../lib/agent-session.js");
const { runUpfrontPlanHook } = await import("../lib/agent-loop-hooks.js");

test.after(() => {
  if (prev.STORAGE_PATH === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev.STORAGE_PATH;
  if (prev.AGENT_UPFRONT_PLAN === undefined) delete process.env.AGENT_UPFRONT_PLAN;
  else process.env.AGENT_UPFRONT_PLAN = prev.AGENT_UPFRONT_PLAN;
  if (prev.AGENT_SESSION_API === undefined) delete process.env.AGENT_SESSION_API;
  else process.env.AGENT_SESSION_API = prev.AGENT_SESSION_API;
  if (prev.AGENT_PERSIST_UPFRONT_PLAN === undefined) delete process.env.AGENT_PERSIST_UPFRONT_PLAN;
  else process.env.AGENT_PERSIST_UPFRONT_PLAN = prev.AGENT_PERSIST_UPFRONT_PLAN;
  rmSync(dir, { recursive: true, force: true });
});

test("runUpfrontPlanHook persists plan to agent session when enabled", async () => {
  mkdirSync(dir, { recursive: true });
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "plan-persist",
  });
  const stub = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              steps: [{ id: 1, goal: "step one", tool_hint: "search_context" }],
              done_criteria: "done",
            }),
          },
        },
      ],
    }),
  });
  const messages = [];
  const trajCollector = { record() {}, truncate(s) { return s; } };

  const r = await runUpfrontPlanHook({
    messages,
    userMessage: "do something",
    backendFetch: stub,
    url: "http://mock/v1/chat",
    model: "m",
    headers: {},
    trajCollector,
    agentSessionId: session.id,
    storageUserId: "anonymous",
    workspace: "default",
  });

  assert.equal(r.planInjected, true);
  assert.ok(messages.some((m) => m.role === "system" && String(m.content).includes("Task Plan")));

  const row = await getAgentSession(session.id);
  assert.ok(row.planDag && typeof row.planDag === "object");
  assert.equal(row.planDag.kind, "upfront");
  assert.equal(Array.isArray(row.planDag.steps), true);
  assert.equal(row.planDag.steps.length, 1);
  assert.match(String(row.planSummary || ""), /Task Plan/);
});

test("runUpfrontPlanHook skips persistence when AGENT_PERSIST_UPFRONT_PLAN=0", async () => {
  process.env.AGENT_PERSIST_UPFRONT_PLAN = "0";
  try {
    const session = await createAgentSession({
      workspace: "w2",
      ownerStorageUserId: "anonymous",
      title: "no-persist",
    });
    const stub = async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                steps: [{ id: 1, goal: "only" }],
                done_criteria: "x",
              }),
            },
          },
        ],
      }),
    });
    const messages = [];
    await runUpfrontPlanHook({
      messages,
      userMessage: "task",
      backendFetch: stub,
      url: "http://mock/v1/chat",
      model: "m",
      headers: {},
      trajCollector: null,
      agentSessionId: session.id,
      storageUserId: "anonymous",
      workspace: "w2",
    });
    const row = await getAgentSession(session.id);
    assert.equal(row.planDag, undefined);
    assert.equal(row.planSummary, undefined);
  } finally {
    delete process.env.AGENT_PERSIST_UPFRONT_PLAN;
  }
});
