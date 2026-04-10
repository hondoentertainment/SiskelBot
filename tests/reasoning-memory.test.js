/**
 * Tests for lib/reasoning-memory.js — record, get, link, find, detect,
 * summarize, and export reasoning chains.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Use an isolated STORAGE_PATH so tests don't pollute real data.
const tmp = mkdtempSync(join(tmpdir(), "reasoning-mem-"));
process.env.STORAGE_PATH = tmp;

const {
  recordReasoningStep,
  getReasoningChain,
  linkConclusions,
  findRelatedReasoning,
  detectContradictions,
  summarizeReasoning,
  exportReasoning,
  extractStepFromIteration,
  listReasoningConversations,
} = await import("../lib/reasoning-memory.js");

const WS = "rm-test-ws";
const CONV_A = "rm-conv-A-" + Date.now();
const CONV_B = "rm-conv-B-" + Date.now();

test.after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// --- recordReasoningStep + getReasoningChain ---

test("recordReasoningStep stores a step and returns id/createdAt", async () => {
  const result = await recordReasoningStep(CONV_A, {
    workspaceId: WS,
    turnIndex: 0,
    premise: "User asked about deployment",
    inference: "Checked recipe list via list_recipes",
    conclusion: "The workspace has a deploy recipe named prod-deploy",
    confidence: 0.9,
    toolsUsed: ["list_recipes"],
    sources: ["recipe:prod-deploy"],
  });
  assert.ok(result.id);
  assert.ok(result.createdAt);
});

test("recordReasoningStep requires conversationId", async () => {
  await assert.rejects(
    () => recordReasoningStep("", { turnIndex: 0, premise: "p" }),
    /conversationId is required/
  );
});

test("recordReasoningStep requires a step object", async () => {
  await assert.rejects(() => recordReasoningStep(CONV_A, null), /step is required/);
});

test("getReasoningChain returns ordered steps", async () => {
  await recordReasoningStep(CONV_A, {
    workspaceId: WS,
    turnIndex: 1,
    premise: "Recipe exists",
    inference: "Ran execute_step",
    conclusion: "Deployment completed successfully",
    confidence: 0.95,
    toolsUsed: ["execute_step"],
  });
  const chain = await getReasoningChain(CONV_A, WS);
  assert.equal(chain.conversationId, CONV_A);
  assert.ok(chain.steps.length >= 2);
  // Verify turn order
  for (let i = 1; i < chain.steps.length; i++) {
    assert.ok((chain.steps[i].turnIndex || 0) >= (chain.steps[i - 1].turnIndex || 0));
  }
});

test("getReasoningChain returns empty chain for unknown conversation", async () => {
  const chain = await getReasoningChain("nonexistent-xyz", WS);
  assert.equal(chain.steps.length, 0);
  assert.equal(chain.links.length, 0);
});

// --- linkConclusions ---

test("linkConclusions stores a typed link", async () => {
  const chain = await getReasoningChain(CONV_A, WS);
  const [a, b] = chain.steps;
  const link = await linkConclusions(a.id, b.id, "supports", {
    conversationId: CONV_A,
    workspaceId: WS,
  });
  assert.equal(link.relationType, "supports");
  assert.ok(link.id);

  const updated = await getReasoningChain(CONV_A, WS);
  assert.ok(updated.links.some((l) => l.id === link.id));
});

test("linkConclusions rejects invalid relationType", async () => {
  await assert.rejects(
    () => linkConclusions("a", "b", "nonsense", { workspaceId: WS }),
    /relationType must be one of/
  );
});

test("linkConclusions requires both conclusions", async () => {
  await assert.rejects(
    () => linkConclusions("", "b", "supports", { workspaceId: WS }),
    /conclusionA and conclusionB are required/
  );
});

// --- findRelatedReasoning ---

test("findRelatedReasoning finds steps by keyword search", async () => {
  const results = await findRelatedReasoning("deployment", WS);
  assert.ok(results.length >= 1);
  assert.ok(results[0].relevance > 0);
  assert.ok(results[0].step);
  assert.ok(results[0].conversationId);
});

test("findRelatedReasoning returns empty for empty query", async () => {
  const results = await findRelatedReasoning("", WS);
  assert.equal(results.length, 0);
});

test("findRelatedReasoning returns empty for no-match query", async () => {
  const results = await findRelatedReasoning("xyz-completely-unrelated-garble", WS);
  assert.equal(results.length, 0);
});

test("findRelatedReasoning respects limit", async () => {
  const results = await findRelatedReasoning("deployment", WS, { limit: 1 });
  assert.ok(results.length <= 1);
});

// --- detectContradictions ---

test("detectContradictions finds heuristic opposing conclusions", async () => {
  await recordReasoningStep(CONV_B, {
    workspaceId: WS,
    turnIndex: 0,
    premise: "Checked build status",
    inference: "Saw exit code 0",
    conclusion: "The build is passing",
  });
  await recordReasoningStep(CONV_B, {
    workspaceId: WS,
    turnIndex: 1,
    premise: "Re-ran build",
    inference: "Saw exit code 1",
    conclusion: "The build is not passing",
  });
  const contradictions = await detectContradictions(CONV_B, WS);
  assert.ok(contradictions.length >= 1);
  assert.ok(contradictions.some((c) => c.type === "heuristic"));
});

test("detectContradictions finds explicit contradictions via links", async () => {
  const chain = await getReasoningChain(CONV_B, WS);
  const [a, b] = chain.steps;
  await linkConclusions(a.id, b.id, "contradicts", {
    conversationId: CONV_B,
    workspaceId: WS,
  });
  const contradictions = await detectContradictions(CONV_B, WS);
  assert.ok(contradictions.some((c) => c.type === "explicit"));
});

test("detectContradictions returns empty for non-contradictory chain", async () => {
  const convClean = "rm-clean-" + Date.now();
  await recordReasoningStep(convClean, {
    workspaceId: WS,
    turnIndex: 0,
    conclusion: "The sky is blue",
  });
  await recordReasoningStep(convClean, {
    workspaceId: WS,
    turnIndex: 1,
    conclusion: "Grass is green",
  });
  const contradictions = await detectContradictions(convClean, WS);
  assert.equal(contradictions.length, 0);
});

// --- summarizeReasoning ---

test("summarizeReasoning returns narrative + key inferences", async () => {
  const result = await summarizeReasoning(CONV_A, WS);
  assert.ok(typeof result.summary === "string");
  assert.ok(result.summary.length > 0);
  assert.ok(Array.isArray(result.keyInferences));
  assert.ok(result.keyInferences.length >= 1);
  assert.ok(Array.isArray(result.assumptions));
});

test("summarizeReasoning returns empty structure for unknown conversation", async () => {
  const result = await summarizeReasoning("no-such-conv", WS);
  assert.equal(result.summary, "");
  assert.equal(result.keyInferences.length, 0);
  assert.equal(result.assumptions.length, 0);
});

// --- exportReasoning ---

test("exportReasoning markdown produces prose", async () => {
  const md = await exportReasoning(CONV_A, "markdown", WS);
  assert.ok(typeof md === "string");
  assert.ok(md.includes("# Reasoning chain"));
  assert.ok(md.includes("## Steps"));
});

test("exportReasoning graphviz produces a digraph", async () => {
  const dot = await exportReasoning(CONV_A, "graphviz", WS);
  assert.ok(dot.startsWith("digraph"));
  assert.ok(dot.includes("->"));
  assert.ok(dot.endsWith("}"));
});

test("exportReasoning json produces parseable JSON", async () => {
  const json = await exportReasoning(CONV_A, "json", WS);
  const parsed = JSON.parse(json);
  assert.equal(parsed.conversationId, CONV_A);
  assert.ok(Array.isArray(parsed.steps));
});

test("exportReasoning rejects unknown format", async () => {
  await assert.rejects(
    () => exportReasoning(CONV_A, "xml", WS),
    /format must be one of/
  );
});

// --- extractStepFromIteration ---

test("extractStepFromIteration builds a step from tool calls", () => {
  const step = extractStepFromIteration({
    turnIndex: 3,
    toolCalls: [{ name: "search_context", args: { query: "deploy" } }],
    toolResults: [{ content: '{"snippets":[{"title":"deploy"}]}' }],
    modelContent: "Found the deploy docs",
  });
  assert.ok(step);
  assert.equal(step.turnIndex, 3);
  assert.ok(step.premise.includes("search_context"));
  assert.ok(step.toolsUsed.includes("search_context"));
  assert.equal(step.conclusion, "Found the deploy docs");
});

test("extractStepFromIteration returns null for iteration with no tool calls", () => {
  const step = extractStepFromIteration({ turnIndex: 0, toolCalls: [] });
  assert.equal(step, null);
});

// --- listReasoningConversations ---

test("listReasoningConversations returns conversations for workspace", async () => {
  const list = await listReasoningConversations(WS);
  assert.ok(Array.isArray(list));
  assert.ok(list.includes(CONV_A));
  assert.ok(list.includes(CONV_B));
});
