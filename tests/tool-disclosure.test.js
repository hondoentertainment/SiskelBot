/**
 * Phase 53.3: Progressive tool disclosure tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate persisted state under a temp dir.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-tool-disclosure-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  estimateToolTokens,
  estimateBudget,
  rankToolsForDisclosure,
  selectToolsWithinBudget,
  discloseTools,
  tierTools,
  markEssential,
  unmarkEssential,
  getEssentialTools,
  computeContextBudget,
  recordDisclosure,
  getDisclosureStats,
  suggestPinning,
  compactToolDescription,
} = await import("../lib/tool-disclosure.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTool(name, description, extra = {}) {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "search query" },
        ...extra,
      },
      required: ["query"],
    },
  };
}

const SEARCH_TOOL = makeTool("search_context", "Search the knowledge base for relevant documents");
const LIST_TOOL = makeTool("list_context", "List all available context documents");
const EXECUTE_TOOL = makeTool("execute_step", "Execute a recipe step such as build or deploy");
const DELETE_TOOL = makeTool("delete_resource", "Delete a resource permanently");
const UPLOAD_TOOL = makeTool("upload_file", "Upload a file to the workspace");

const SAMPLE_TOOLS = [SEARCH_TOOL, LIST_TOOL, EXECUTE_TOOL, DELETE_TOOL, UPLOAD_TOOL];

// ─── Token estimation ────────────────────────────────────────────────────────

test("estimateToolTokens approximates based on JSON size", () => {
  const small = { name: "x", description: "y", parameters: { type: "object" } };
  const big = {
    name: "complicated_tool",
    description: "A tool with a much longer description that uses more tokens overall",
    parameters: {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
        c: { type: "boolean" },
      },
    },
  };
  const smallTokens = estimateToolTokens(small);
  const bigTokens = estimateToolTokens(big);
  assert.ok(smallTokens > 0);
  assert.ok(bigTokens > smallTokens);
  assert.equal(estimateToolTokens(null), 0);
  assert.equal(estimateToolTokens(undefined), 0);
});

test("estimateBudget subtracts reserved output tokens", () => {
  assert.equal(estimateBudget(8000, 1000), 7000);
  assert.equal(estimateBudget(4000), 3000);
  assert.equal(estimateBudget(500, 1000), 0);
  assert.equal(estimateBudget(0, 0), 0);
});

// ─── Ranking and selection ───────────────────────────────────────────────────

test("rankToolsForDisclosure orders by task relevance", () => {
  const ranked = rankToolsForDisclosure(SAMPLE_TOOLS, {
    task: "search and list context documents for knowledge",
  });
  assert.ok(ranked.length === SAMPLE_TOOLS.length);
  const names = ranked.map((r) => r.name);
  // search_context should be at the top since both name and description match.
  assert.equal(names[0], "search_context");
  // list_context matches "list context documents" and should outrank delete_resource.
  assert.ok(names.indexOf("list_context") < names.indexOf("delete_resource"));
});

test("rankToolsForDisclosure respects usage and essential bonus", () => {
  const ranked = rankToolsForDisclosure(SAMPLE_TOOLS, {
    task: "general task",
    usage: { execute_step: 50 },
    essential: ["upload_file"],
  });
  // upload_file should be near the top thanks to the essential bonus.
  assert.equal(ranked[0].name, "upload_file");
});

test("selectToolsWithinBudget respects budget ceiling", () => {
  const ranked = rankToolsForDisclosure(SAMPLE_TOOLS, { task: "search" });
  const tiny = selectToolsWithinBudget(ranked, 30);
  assert.ok(tiny.tokensUsed <= 30);
  assert.ok(tiny.selected.length < ranked.length || tiny.selected.length === ranked.length);
  const generous = selectToolsWithinBudget(ranked, 100000);
  assert.equal(generous.selected.length, ranked.length);
  assert.equal(generous.excluded.length, 0);
});

test("selectToolsWithinBudget picks top-ranked first", () => {
  const ranked = rankToolsForDisclosure(SAMPLE_TOOLS, { task: "search documents" });
  // Just enough budget for two tools.
  const costFirstTwo = ranked[0].tokens + ranked[1].tokens;
  const result = selectToolsWithinBudget(ranked, costFirstTwo);
  assert.ok(result.selected.length >= 2);
  assert.equal(result.selected[0].name, ranked[0].name);
  assert.equal(result.selected[1].name, ranked[1].name);
});

// ─── discloseTools ───────────────────────────────────────────────────────────

test("discloseTools returns valid selection with summary", async () => {
  const result = await discloseTools(
    SAMPLE_TOOLS,
    { task: "search the docs", workspaceId: "ws-disc-1" },
    { budget: 500 },
  );
  assert.ok(Array.isArray(result.tools));
  assert.ok(result.tools.length > 0);
  assert.ok(result.summary.totalCandidates === SAMPLE_TOOLS.length);
  assert.ok(result.summary.tokensUsed <= result.summary.tokensAvailable);
  assert.equal(typeof result.reasoning, "string");
});

test("discloseTools respects pinnedTools even under tight budget", async () => {
  const result = await discloseTools(
    SAMPLE_TOOLS,
    { task: "unrelated work", workspaceId: "ws-disc-2" },
    { budget: 50, pinnedTools: ["delete_resource"] },
  );
  const names = result.tools.map((t) => t.name);
  assert.ok(names.includes("delete_resource"));
  assert.ok(result.summary.pinnedCount >= 1);
});

test("discloseTools handles empty tool list", async () => {
  const result = await discloseTools([], { task: "anything" }, { budget: 1000 });
  assert.deepEqual(result.tools, []);
  assert.equal(result.summary.totalCandidates, 0);
  assert.equal(result.summary.selectedCount, 0);
});

test("discloseTools with budget too small keeps pinned essentials", async () => {
  await markEssential("search_context", "ws-tight");
  const result = await discloseTools(
    SAMPLE_TOOLS,
    { task: "anything", workspaceId: "ws-tight" },
    { budget: 1 },
  );
  const names = result.tools.map((t) => t.name);
  assert.ok(names.includes("search_context"));
  // Non-essential tools should be excluded when budget is near zero.
  assert.ok(result.summary.selectedCount <= 2);
});

// ─── Tiering ─────────────────────────────────────────────────────────────────

test("tierTools categorizes into essential / commonly_used / rarely_used", () => {
  // Build a bigger pool so percentages split cleanly.
  const tools = [];
  for (let i = 0; i < 20; i++) {
    tools.push(makeTool(`tool_${i}`, `Tool number ${i}`));
  }
  const tiers = tierTools(tools);
  assert.ok(Array.isArray(tiers.essential));
  assert.ok(Array.isArray(tiers.commonly_used));
  assert.ok(Array.isArray(tiers.rarely_used));
  const total = tiers.essential.length + tiers.commonly_used.length + tiers.rarely_used.length;
  assert.equal(total, tools.length);
  assert.ok(tiers.essential.length >= 1);
});

test("tierTools handles empty input", () => {
  const tiers = tierTools([]);
  assert.deepEqual(tiers, { essential: [], commonly_used: [], rarely_used: [] });
});

// ─── Essential persistence ──────────────────────────────────────────────────

test("markEssential + getEssentialTools persists entries", async () => {
  await markEssential("foo_tool", "ws-essential");
  await markEssential("bar_tool", "ws-essential");
  // Marking again is idempotent.
  await markEssential("foo_tool", "ws-essential");
  const list = await getEssentialTools("ws-essential");
  assert.ok(list.includes("foo_tool"));
  assert.ok(list.includes("bar_tool"));
  assert.equal(list.filter((n) => n === "foo_tool").length, 1);
});

test("unmarkEssential removes entries", async () => {
  await markEssential("to_remove", "ws-rm");
  let list = await getEssentialTools("ws-rm");
  assert.ok(list.includes("to_remove"));
  await unmarkEssential("to_remove", "ws-rm");
  list = await getEssentialTools("ws-rm");
  assert.ok(!list.includes("to_remove"));
  // Unmark missing is a no-op.
  await unmarkEssential("never_added", "ws-rm");
});

// ─── Context budget ──────────────────────────────────────────────────────────

test("computeContextBudget accounts for prior messages", () => {
  const empty = computeContextBudget([], 8000);
  assert.equal(empty, 8000);
  const short = computeContextBudget(
    [{ role: "user", content: "hello" }],
    8000,
  );
  assert.ok(short < 8000);
  assert.ok(short > 7990);
  const bigMsg = "x".repeat(4000);
  const big = computeContextBudget([{ role: "user", content: bigMsg }], 8000);
  assert.ok(big < short);
  // Overflow clamps to zero.
  assert.equal(computeContextBudget([{ role: "user", content: "x".repeat(40000) }], 1000), 0);
});

test("computeContextBudget handles null / invalid inputs", () => {
  assert.equal(computeContextBudget(null, 4000), 4000);
  assert.equal(computeContextBudget([null, { notAMsg: 1 }], 4000), 4000);
});

// ─── Disclosure learning ────────────────────────────────────────────────────

test("recordDisclosure persists tools and counts", async () => {
  await recordDisclosure("ws-stats", ["search_context", "list_context"], "search");
  await recordDisclosure("ws-stats", ["search_context"], "search");
  const stats = await getDisclosureStats("ws-stats");
  assert.equal(stats.totalDisclosures, 2);
  const searchRow = stats.topTools.find((t) => t.tool === "search_context");
  assert.ok(searchRow);
  assert.equal(searchRow.count, 2);
});

test("getDisclosureStats aggregates task types", async () => {
  await recordDisclosure("ws-stats2", ["a"], "search");
  await recordDisclosure("ws-stats2", ["b"], "analyze");
  const stats = await getDisclosureStats("ws-stats2");
  assert.ok(stats.taskTypes.includes("search"));
  assert.ok(stats.taskTypes.includes("analyze"));
  assert.equal(stats.uniqueTools, 2);
});

test("suggestPinning returns frequently disclosed tools", async () => {
  for (let i = 0; i < 10; i++) {
    await recordDisclosure("ws-pin", ["frequent_tool", "sometimes_tool"], "search");
  }
  for (let i = 0; i < 5; i++) {
    await recordDisclosure("ws-pin", ["frequent_tool"], "search");
  }
  const suggestions = await suggestPinning("ws-pin");
  assert.ok(suggestions.length >= 1);
  const top = suggestions.find((s) => s.tool === "frequent_tool");
  assert.ok(top);
  assert.ok(top.frequency >= 0.9);
});

test("suggestPinning returns empty when no disclosures", async () => {
  const suggestions = await suggestPinning("ws-empty-pin");
  assert.deepEqual(suggestions, []);
});

// ─── Compact description ────────────────────────────────────────────────────

test("compactToolDescription is shorter than the original", () => {
  const verbose = {
    name: "verbose_tool",
    description:
      "A very wordy description that goes on and on. For example, it might do thing A. It also might do thing B. Examples: example 1, example 2, example 3, and so on forever until we run out of room.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "query", examples: ["ex1", "ex2"] },
      },
    },
  };
  const compact = compactToolDescription(verbose);
  const original = JSON.stringify(verbose);
  const compacted = JSON.stringify(compact);
  assert.ok(compacted.length < original.length);
  assert.ok(!compacted.includes("Examples:"));
  assert.ok(!compact.parameters.properties.q.examples);
});

test("compactToolDescription preserves the parameter schema shape", () => {
  const tool = makeTool("keep_schema", "Search for something. For example, search for a user.");
  const compact = compactToolDescription(tool);
  assert.equal(compact.name, "keep_schema");
  assert.equal(compact.parameters.type, "object");
  assert.deepEqual(compact.parameters.required, ["query"]);
});
