/**
 * Asserts that lib/agent-hitl-store.js publishes hitl.request on save and
 * hitl.resolved on take, wired through the Agent Run per-session emitter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { saveHitlState, takeHitlState } from "../lib/agent-hitl-store.js";
import {
  getAgentRunEmitter,
  disposeAgentRunEmitter,
  __resetAgentRunStreamForTests,
} from "../lib/agent-run-stream.js";

test("saveHitlState publishes hitl.request when the state carries a sessionId", () => {
  __resetAgentRunStreamForTests();
  const sessionId = "sess-hitl-req";
  const emitter = getAgentRunEmitter(sessionId);
  const seen = [];
  emitter.on("event", (ev) => seen.push(ev));

  const state = {
    sessionId,
    hitlToolCallIds: ["tc-1"],
    hitlArgsById: { "tc-1": { action: "build", payload: { target: "prod" } } },
    toolCallsSnapshot: [
      {
        id: "tc-1",
        type: "function",
        function: { name: "execute_step", arguments: "{}" },
      },
    ],
  };
  const token = saveHitlState(state);

  const reqs = seen.filter((e) => e.type === "hitl.request");
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].payload.approvalId, token);
  assert.equal(reqs[0].payload.tool, "execute_step");
  assert.match(String(reqs[0].payload.summary || ""), /execute_step:\s*build/);

  disposeAgentRunEmitter(sessionId);
});

test("takeHitlState publishes hitl.resolved when a decision is provided", () => {
  __resetAgentRunStreamForTests();
  const sessionId = "sess-hitl-res";
  const emitter = getAgentRunEmitter(sessionId);
  const seen = [];
  emitter.on("event", (ev) => seen.push(ev));

  const token = saveHitlState({
    sessionId,
    hitlToolCallIds: ["tc-2"],
    hitlArgsById: { "tc-2": { action: "deploy" } },
    toolCallsSnapshot: [
      {
        id: "tc-2",
        type: "function",
        function: { name: "execute_step", arguments: "{}" },
      },
    ],
  });

  // Sanity: save emitted hitl.request
  const reqs = seen.filter((e) => e.type === "hitl.request");
  assert.equal(reqs.length, 1);

  const taken = takeHitlState(token, { decision: "approve" });
  assert.ok(taken);

  const res = seen.filter((e) => e.type === "hitl.resolved");
  assert.equal(res.length, 1);
  assert.equal(res[0].payload.approvalId, token);
  assert.equal(res[0].payload.decision, "approve");

  disposeAgentRunEmitter(sessionId);
});

test("saveHitlState emits nothing when the state lacks a sessionId", () => {
  __resetAgentRunStreamForTests();
  const sessionId = "sess-hitl-noop";
  const emitter = getAgentRunEmitter(sessionId);
  const seen = [];
  emitter.on("event", (ev) => seen.push(ev));

  saveHitlState({ unrelated: true });

  assert.equal(seen.length, 0);

  disposeAgentRunEmitter(sessionId);
});

test("takeHitlState with no decision emits no hitl.resolved", () => {
  __resetAgentRunStreamForTests();
  const sessionId = "sess-hitl-silent";
  const emitter = getAgentRunEmitter(sessionId);
  const seen = [];
  emitter.on("event", (ev) => seen.push(ev));

  const token = saveHitlState({
    sessionId,
    hitlToolCallIds: ["tc-3"],
    hitlArgsById: { "tc-3": { action: "noop" } },
    toolCallsSnapshot: [
      { id: "tc-3", type: "function", function: { name: "execute_step", arguments: "{}" } },
    ],
  });
  const sizeAfterSave = seen.length;
  takeHitlState(token);
  assert.equal(seen.length, sizeAfterSave);

  disposeAgentRunEmitter(sessionId);
});

test("takeHitlState with decision but no sessionId in state emits nothing", () => {
  __resetAgentRunStreamForTests();
  const sessionId = "sess-hitl-absent";
  const emitter = getAgentRunEmitter(sessionId);
  const seen = [];
  emitter.on("event", (ev) => seen.push(ev));

  const token = saveHitlState({ noSessionHere: true });
  takeHitlState(token, { decision: "deny" });
  assert.equal(seen.length, 0);

  disposeAgentRunEmitter(sessionId);
});
