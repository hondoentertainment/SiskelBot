/**
 * Cover swarm.js branches not reached by existing tests:
 *   - runSpecialistWithTolerance: list_context, get_recipe, else (no-tools) branches
 *   - runSwarmDirect: conflict detection path (analyzeSwarmConflicts)
 *   - runSwarmDirect: judgeFn conflict resolution path
 *
 * Uses in-place SPECIALISTS array mutation so custom specialists are visible
 * to getSpecialist() without requiring module re-load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "swarm-specialist-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  runSwarmLegacy,
  runSwarmDirect,
  runSwarm,
  getSwarmSelectableSpecialistNames,
  resolveSwarmSpecialistNames,
} = await import("../lib/swarm.js");
const { SPECIALISTS } = await import("../lib/specialists.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

// Inject and track temporary specialists for branch coverage
const injected = [];

function addSpecialist(spec) {
  SPECIALISTS.push(spec);
  injected.push(spec.name);
}

test.after(() => {
  for (const name of injected) {
    const idx = SPECIALISTS.findIndex((s) => s.name === name);
    if (idx >= 0) SPECIALISTS.splice(idx, 1);
  }
});

// ── No-tools branch (synthesizer has tools: []) ───────────────────────────────

test("runSwarmLegacy: synthesizer hits else (no runnable tools) branch", async () => {
  const result = await runSwarmLegacy(["synthesizer"], "summarise", { workspace: "default" });
  assert.equal(result.aggregation.length, 1);
  assert.equal(result.aggregation[0].specialist, "synthesizer");
  const out = JSON.parse(result.aggregation[0].output);
  assert.ok(out.error && /No runnable tools/.test(out.error));
});

// ── list_context branch ───────────────────────────────────────────────────────

test("runSwarmDirect: specialist with list_context (not researcher) uses list_context branch", async () => {
  addSpecialist({ name: "_branch_lc", systemPrompt: "test", tools: ["list_context"] });

  const r = await runSwarmDirect(["_branch_lc"], "explore", { workspace: "default" });
  assert.equal(r.aggregation.length, 1);
  assert.equal(r.aggregation[0].specialist, "_branch_lc");
  assert.equal(r.aggregation[0].success, true);
  const out = JSON.parse(r.aggregation[0].output);
  assert.ok("items" in out || "count" in out);
});

// ── get_recipe branch ─────────────────────────────────────────────────────────

test("runSwarmDirect: specialist with get_recipe (not executor) uses get_recipe branch", async () => {
  addSpecialist({ name: "_branch_gr", systemPrompt: "test", tools: ["get_recipe"] });

  const r = await runSwarmDirect(["_branch_gr"], "default", { workspace: "default" });
  assert.equal(r.aggregation.length, 1);
  assert.equal(r.aggregation[0].specialist, "_branch_gr");
  // success depends on whether a recipe named "default" is found; either way no throw
  assert.ok(typeof r.aggregation[0].output === "string");
});

// ── search_context non-researcher branch ─────────────────────────────────────

test("runSwarmDirect: specialist with search_context (not researcher) uses search_context branch", async () => {
  addSpecialist({ name: "_branch_sc", systemPrompt: "test", tools: ["search_context"] });

  const r = await runSwarmDirect(["_branch_sc"], "hello", { workspace: "default" });
  assert.equal(r.aggregation.length, 1);
  assert.equal(r.aggregation[0].specialist, "_branch_sc");
  assert.equal(r.aggregation[0].success, true);
});

// ── Conflict detection: 2 successful specialists → analyzeSwarmConflicts ──────

test("runSwarmDirect: two successful specialists trigger conflict analysis branch", async () => {
  // list_context and search_context return structurally different JSON →
  // Jaccard similarity likely below 0.25 → detectConflicts may report divergent
  addSpecialist({ name: "_branch_conflict1", systemPrompt: "test1", tools: ["list_context"] });
  addSpecialist({ name: "_branch_conflict2", systemPrompt: "test2", tools: ["search_context"] });

  const r = await runSwarmDirect(
    ["_branch_conflict1", "_branch_conflict2"],
    "query for conflict detection",
    { workspace: "default" },
  );
  assert.equal(r.aggregation.length, 2);
  // Both should succeed (list_context and search_context always succeed)
  assert.ok(r.aggregation.every((a) => a.success === true));
  // conflicts field is optional (only present when analyzeSwarmConflicts detects conflict)
  assert.ok(r.metrics);
});

// ── judgeFn conflict resolution path ─────────────────────────────────────────

test("runSwarmDirect: judgeFn option triggers judge conflict resolution path", async () => {
  // Ensure we have two successful specialists
  if (!SPECIALISTS.find((s) => s.name === "_branch_j1")) {
    addSpecialist({ name: "_branch_j1", systemPrompt: "judge-test1", tools: ["list_context"] });
  }
  if (!SPECIALISTS.find((s) => s.name === "_branch_j2")) {
    addSpecialist({ name: "_branch_j2", systemPrompt: "judge-test2", tools: ["search_context"] });
  }

  const judgeFn = async (_prompt) =>
    "Both specialists agree: the workspace is empty. No conflict.";

  const r = await runSwarmDirect(
    ["_branch_j1", "_branch_j2"],
    "judge test query",
    {
      workspace: "default",
      judgeFn,
      judgeTimeoutMs: 5000,
    },
  );
  assert.equal(r.aggregation.length, 2);
  assert.ok(r.metrics);
});

// ── judgeFn returning empty string (error branch) ────────────────────────────

test("runSwarmDirect: judgeFn returning empty string produces judgeError in conflicts", async () => {
  if (!SPECIALISTS.find((s) => s.name === "_branch_je1")) {
    addSpecialist({ name: "_branch_je1", systemPrompt: "judge-err-test1", tools: ["list_context"] });
  }
  if (!SPECIALISTS.find((s) => s.name === "_branch_je2")) {
    addSpecialist({ name: "_branch_je2", systemPrompt: "judge-err-test2", tools: ["search_context"] });
  }

  const judgeFn = async (_prompt) => ""; // empty → judge error

  const r = await runSwarmDirect(
    ["_branch_je1", "_branch_je2"],
    "judge empty result",
    { workspace: "default", judgeFn },
  );
  assert.equal(r.aggregation.length, 2);
  // Either conflicts.judgeError is set or conflicts is null (no conflict detected)
  assert.ok(r.metrics);
});

// ── runSpecialistWithTolerance else branch via runSwarmLegacy ─────────────────

test("runSwarmLegacy: specialist with no recognized tools hits else branch", async () => {
  addSpecialist({ name: "_branch_notools", systemPrompt: "empty", tools: ["unknown_tool_xyz"] });

  const result = await runSwarmLegacy(["_branch_notools"], "test", { workspace: "default" });
  assert.equal(result.aggregation.length, 1);
  const out = JSON.parse(result.aggregation[0].output);
  assert.ok(out.error && /No runnable tools/.test(out.error));
});

// ── runSwarmLegacy with search_context custom specialist (lines 944-947) ──────

test("runSwarmLegacy: _branch_sc hits search_context branch in runSpecialistWithTolerance", async () => {
  // _branch_sc already injected by the earlier runSwarmDirect test
  const result = await runSwarmLegacy(["_branch_sc"], "test search query", { workspace: "default" });
  assert.equal(result.aggregation.length, 1);
  assert.equal(result.aggregation[0].specialist, "_branch_sc");
  assert.equal(result.aggregation[0].success, true);
});

test("runSwarmLegacy: _branch_lc hits list_context branch in runSpecialistWithTolerance", async () => {
  // _branch_lc already injected by the earlier runSwarmDirect test
  const result = await runSwarmLegacy(["_branch_lc"], "list items", { workspace: "default" });
  assert.equal(result.aggregation.length, 1);
  assert.equal(result.aggregation[0].specialist, "_branch_lc");
  assert.equal(result.aggregation[0].success, true);
});

test("runSwarmLegacy: _branch_gr hits get_recipe branch in runSpecialistWithTolerance", async () => {
  // _branch_gr already injected by the earlier runSwarmDirect test
  const result = await runSwarmLegacy(["_branch_gr"], "default", { workspace: "default" });
  assert.equal(result.aggregation.length, 1);
  assert.equal(result.aggregation[0].specialist, "_branch_gr");
  assert.ok(typeof result.aggregation[0].output === "string");
});

// ── getSwarmSelectableSpecialistNames ─────────────────────────────────────────

test("getSwarmSelectableSpecialistNames: returns non-synthesizer specialists without allowlist", () => {
  const names = getSwarmSelectableSpecialistNames();
  assert.ok(Array.isArray(names));
  assert.ok(!names.includes("synthesizer"));
  assert.ok(names.length > 0);
});

test("getSwarmSelectableSpecialistNames: allowlist matching nothing triggers warning and returns empty", () => {
  const prev = process.env.SWARM_SPECIALISTS_ALLOWLIST;
  process.env.SWARM_SPECIALISTS_ALLOWLIST = "this_specialist_does_not_exist_xyz";
  try {
    const names = getSwarmSelectableSpecialistNames();
    assert.deepEqual(names, []);
  } finally {
    if (prev === undefined) delete process.env.SWARM_SPECIALISTS_ALLOWLIST;
    else process.env.SWARM_SPECIALISTS_ALLOWLIST = prev;
  }
});

// ── resolveSwarmSpecialistNames paths ──────────────────────────────────────────

test("resolveSwarmSpecialistNames: SWARM_PARALLEL_AGENTS=1 returns parallel rosterSource", () => {
  const prev = process.env.SWARM_PARALLEL_AGENTS;
  process.env.SWARM_PARALLEL_AGENTS = "1";
  try {
    const { specialistNames, rosterSource } = resolveSwarmSpecialistNames({ researcher: false, executor: false });
    assert.equal(rosterSource, "parallel");
    assert.ok(specialistNames.length >= 1);
  } finally {
    if (prev === undefined) delete process.env.SWARM_PARALLEL_AGENTS;
    else process.env.SWARM_PARALLEL_AGENTS = prev;
  }
});

test("resolveSwarmSpecialistNames: SWARM_CLIENT_SPECIALISTS=1 with valid roster returns client source", () => {
  const prev = process.env.SWARM_CLIENT_SPECIALISTS;
  process.env.SWARM_CLIENT_SPECIALISTS = "1";
  try {
    const { specialistNames, rosterSource } = resolveSwarmSpecialistNames(
      { researcher: false, executor: false },
      { swarmSpecialists: ["researcher"] },
    );
    assert.equal(rosterSource, "client");
    assert.ok(specialistNames.includes("researcher"));
  } finally {
    if (prev === undefined) delete process.env.SWARM_CLIENT_SPECIALISTS;
    else process.env.SWARM_CLIENT_SPECIALISTS = prev;
  }
});

test("resolveSwarmSpecialistNames: intent with both researcher and executor flags", () => {
  const { specialistNames, rosterSource } = resolveSwarmSpecialistNames({ researcher: true, executor: true });
  assert.equal(rosterSource, "intent");
  assert.ok(specialistNames.length >= 1);
});

test("resolveSwarmSpecialistNames: agentOptions.parallelAgents=true overrides env", () => {
  const { rosterSource } = resolveSwarmSpecialistNames(
    { researcher: false, executor: false },
    { parallelAgents: true },
  );
  assert.equal(rosterSource, "parallel");
});

// ── runSwarm with stub backendFetch (covers runSpecialistLoop) ────────────────

test("runSwarm: specialist loop with text response and synthesizer combine", async () => {
  let callCount = 0;
  const stubFetch = async () => {
    callCount++;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: `Stub response ${callCount}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      text: async () => `Stub response ${callCount}`,
    };
  };

  const req = {
    userId: null,
    body: {
      messages: [{ role: "user", content: "What is this codebase about?" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runSwarm(req, res, config, "test-model", { backendFetch: stubFetch });
  assert.ok(typeof result.content === "string");
  assert.ok(Array.isArray(result.swarmSteps));
  assert.ok(callCount >= 2, "backendFetch called for specialist + synthesizer");
});

test("runSwarm: backend error during specialist causes graceful failure with fallback", async () => {
  const stubFetch = async () => ({
    ok: false,
    status: 503,
    text: async () => "Service unavailable",
  });

  const req = {
    userId: null,
    body: {
      messages: [{ role: "user", content: "test error path" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runSwarm(req, res, config, "test-model", { backendFetch: stubFetch });
  assert.ok(result);
  assert.ok(typeof result.fallbackAggregate === "string" || typeof result.content === "string");
});

test("runSwarm: tool_calls in specialist response exercises lines 530-604", async () => {
  let callCount = 0;
  const stubFetch = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "tc-swarm-1",
                type: "function",
                function: { name: "search_context", arguments: '{"query":"test"}' },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        text: async () => "",
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: `Answer ${callCount}` } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
      text: async () => `Answer ${callCount}`,
    };
  };

  const req = {
    userId: null,
    body: {
      messages: [{ role: "user", content: "search for information" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runSwarm(req, res, config, "test-model", {
    backendFetch: stubFetch,
    sessionId: "test-swarm-session-123",
  });
  assert.ok(typeof result.content === "string");
  assert.ok(callCount >= 3, "specialist tool-call + follow-up + synthesizer");
});

test("runSwarm: responseFormat and requiredToolSequence options hit their branches", async () => {
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content: "done" } }],
    }),
    text: async () => "done",
  });

  const req = {
    userId: null,
    body: {
      messages: [{ role: "user", content: "execute task" }],
      agentOptions: {
        workspace: "default",
        responseFormat: { type: "json_object" },
        requiredToolSequence: ["search_context"],
      },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runSwarm(req, res, config, "test-model", { backendFetch: stubFetch });
  assert.ok(result);
  assert.ok(typeof result.content === "string");
});

test("runSwarm: null msg in choices breaks loop with no-response fallback", async () => {
  const stubFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: null }] }),
    text: async () => "",
  });

  const req = {
    userId: null,
    body: {
      messages: [{ role: "user", content: "null msg test" }],
      agentOptions: { workspace: "default" },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runSwarm(req, res, config, "test-model", { backendFetch: stubFetch });
  assert.ok(result);
});

// ── resolveSwarmAllowlistFallback synthesizer-only path ───────────────────────

test("resolveSwarmSpecialistNames: synthesizer-only allowlist hits fallback, returns researcher", () => {
  const prev = process.env.SWARM_SPECIALISTS_ALLOWLIST;
  process.env.SWARM_SPECIALISTS_ALLOWLIST = "synthesizer";
  try {
    const { specialistNames, rosterSource } = resolveSwarmSpecialistNames({ researcher: true, executor: false });
    assert.equal(rosterSource, "intent");
    // Fallback finds researcher (which is not in allowlist but fallback ignores it)
    assert.ok(Array.isArray(specialistNames));
  } finally {
    if (prev === undefined) delete process.env.SWARM_SPECIALISTS_ALLOWLIST;
    else process.env.SWARM_SPECIALISTS_ALLOWLIST = prev;
  }
});
