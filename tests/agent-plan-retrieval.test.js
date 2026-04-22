import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "plan-rag-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  planRetrievalEnabled,
  findSimilarTrajectories,
  formatExamplesForPrompt,
} = await import("../lib/agent-plan-retrieval.js");
const { saveTrajectory } = await import("../lib/agent-trajectory.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("planRetrievalEnabled: off by default", () => {
  const prev = process.env.AGENT_PLAN_RAG;
  delete process.env.AGENT_PLAN_RAG;
  try { assert.equal(planRetrievalEnabled(), false); }
  finally { if (prev !== undefined) process.env.AGENT_PLAN_RAG = prev; }
});

test("planRetrievalEnabled: on when flag set", () => {
  const prev = process.env.AGENT_PLAN_RAG;
  process.env.AGENT_PLAN_RAG = "1";
  try { assert.equal(planRetrievalEnabled(), true); }
  finally { if (prev === undefined) delete process.env.AGENT_PLAN_RAG; else process.env.AGENT_PLAN_RAG = prev; }
});

test("findSimilarTrajectories: returns empty on empty input", async () => {
  const r = await findSimilarTrajectories({ userMessage: "" });
  assert.deepEqual(r, []);
});

test("findSimilarTrajectories: finds keyword-matching successful trajectories", async () => {
  await saveTrajectory("rag-run-1", {
    workspace: "rag-ws",
    stepCount: 3,
    steps: [
      { type: "user_message", content: "deploy the staging vercel site" },
      { type: "tool_call", name: "get_recipe" },
      { type: "tool_call", name: "execute_step" },
      { type: "final_answer", content: "done" },
    ],
  });
  await saveTrajectory("rag-run-2", {
    workspace: "rag-ws",
    stepCount: 2,
    steps: [
      { type: "user_message", content: "unrelated weather query" },
      { type: "tool_call", name: "web_search" },
      { type: "final_answer", content: "sunny" },
    ],
  });

  const r = await findSimilarTrajectories({
    userMessage: "deploy my vercel staging site now",
    workspace: "rag-ws",
  });
  assert.ok(Array.isArray(r));
  assert.ok(r.length >= 1);
  assert.ok(r[0].tools.includes("get_recipe"));
});

test("findSimilarTrajectories: skips unsuccessful runs", async () => {
  await saveTrajectory("rag-run-3", {
    workspace: "rag-ws-3",
    stepCount: 2,
    steps: [
      { type: "user_message", content: "deploy vercel" },
      { type: "tool_call", name: "get_recipe" },
      // No final_answer — not successful
    ],
  });
  const r = await findSimilarTrajectories({ userMessage: "deploy vercel", workspace: "rag-ws-3" });
  assert.equal(r.length, 0);
});

test("formatExamplesForPrompt: empty when no examples", () => {
  assert.equal(formatExamplesForPrompt([]), "");
  assert.equal(formatExamplesForPrompt(null), "");
});

test("formatExamplesForPrompt: renders request and tool sequence", () => {
  const s = formatExamplesForPrompt([
    { userMessage: "deploy vercel", tools: ["get_recipe", "execute_step"], score: 0.5 },
  ]);
  assert.ok(s.includes("deploy vercel"));
  assert.ok(s.includes("get_recipe → execute_step"));
});
