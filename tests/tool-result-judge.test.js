/**
 * Unit tests for lib/tool-result-judge.js — the post-execution result judge.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildJudgePrompt,
  judgeToolResult,
  toolResultJudgeEnabled,
  shouldSkipJudge,
} from "../lib/tool-result-judge.js";

test("buildJudgePrompt: includes tool name, args, result, and user intent", () => {
  const prompt = buildJudgePrompt({
    toolName: "web_search",
    toolArgs: { query: "node.js streaming" },
    toolResult: { results: [{ title: "hit" }] },
    userIntent: "find streaming patterns",
  });
  assert.match(prompt, /web_search/);
  assert.match(prompt, /node\.js streaming/);
  assert.match(prompt, /find streaming patterns/);
  assert.match(prompt, /hit/);
  assert.match(prompt, /STRICT JSON/);
  assert.match(prompt, /satisfactory/);
});

test("buildJudgePrompt: truncates 5000-char result to 2000 chars in prompt", () => {
  const big = "a".repeat(5000);
  const prompt = buildJudgePrompt({
    toolName: "fetch_allowed_url",
    toolArgs: { url: "https://x" },
    toolResult: big,
    userIntent: "get data",
  });
  // The original 5000-char 'a' run cannot appear verbatim.
  assert.equal(prompt.includes(big), false);
  // But a 2000-char 'a' run must be present (the truncated body).
  assert.ok(prompt.includes("a".repeat(2000)));
  // And we should NOT see 2001 consecutive a's in the prompt.
  assert.equal(prompt.includes("a".repeat(2001)), false);
  assert.match(prompt, /truncated/);
});

test("buildJudgePrompt: handles non-serializable (circular) args gracefully", () => {
  const circular = {};
  circular.self = circular;
  const prompt = buildJudgePrompt({
    toolName: "t",
    toolArgs: circular,
    toolResult: "ok",
    userIntent: "q",
  });
  assert.equal(typeof prompt, "string");
  assert.match(prompt, /t/);
});

test("judgeToolResult: happy path → satisfactory:true when LLM says so", async () => {
  let called = 0;
  const callFn = async () => {
    called++;
    return JSON.stringify({ satisfactory: true, confidence: 0.9 });
  };
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ title: "hit" }] },
    userIntent: "something useful",
    callFn,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(v.confidence, 0.9);
  assert.equal(called, 1);
});

test("judgeToolResult: unsatisfactory verdict is surfaced with issue + suggestion", async () => {
  const callFn = async () =>
    JSON.stringify({
      satisfactory: false,
      confidence: 0.85,
      issue: "empty search result",
      suggestion: "retry with broader terms",
    });
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "zzzzzzzz-no-results" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research topic",
    callFn,
  });
  assert.equal(v.satisfactory, false);
  assert.equal(v.issue, "empty search result");
  assert.equal(v.suggestion, "retry with broader terms");
  assert.equal(v.confidence, 0.85);
});

test("judgeToolResult: parses ```json fenced responses", async () => {
  const callFn = async () =>
    '```json\n{"satisfactory": false, "confidence": 0.7, "issue": "off topic", "suggestion": "rephrase"}\n```';
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research",
    callFn,
  });
  assert.equal(v.satisfactory, false);
  assert.equal(v.issue, "off topic");
  assert.equal(v.suggestion, "rephrase");
});

test("judgeToolResult: parses plain ``` fences without json tag", async () => {
  const callFn = async () =>
    '```\n{"satisfactory": true, "confidence": 0.5}\n```';
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research",
    callFn,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(v.confidence, 0.5);
});

test("judgeToolResult: regex-extracts JSON from prose wrapper", async () => {
  const callFn = async () =>
    'Looking at this: {"satisfactory": false, "confidence": 0.6, "issue": "stale"} makes sense.';
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research",
    callFn,
  });
  assert.equal(v.satisfactory, false);
  assert.equal(v.issue, "stale");
});

test("judgeToolResult: malformed response fails open (satisfactory:true)", async () => {
  const callFn = async () => "I cannot answer that, sorry.";
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research",
    callFn,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(v.confidence, 0);
  assert.equal(v.rawResponse, "I cannot answer that, sorry.");
});

test("judgeToolResult: empty LLM response fails open", async () => {
  const callFn = async () => "";
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research",
    callFn,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(v.confidence, 0);
});

test("judgeToolResult: timeout fails open", async () => {
  const callFn = () => new Promise((resolve) => setTimeout(() => resolve("{}"), 500));
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research",
    callFn,
    timeoutMs: 30,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(v.confidence, 0);
});

test("judgeToolResult: callFn that throws fails open", async () => {
  const callFn = async () => {
    throw new Error("backend exploded");
  };
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research",
    callFn,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(v.confidence, 0);
});

test("judgeToolResult: shortcut — ok:false result → satisfactory:false, callFn NOT called", async () => {
  let called = 0;
  const callFn = async () => {
    called++;
    return "{}";
  };
  const v = await judgeToolResult({
    toolName: "fetch_allowed_url",
    toolArgs: { url: "https://x" },
    toolResult: { ok: false, error: "403 forbidden" },
    userIntent: "fetch the page",
    callFn,
  });
  assert.equal(v.satisfactory, false);
  assert.match(v.issue, /tool reported failure/);
  assert.match(v.issue, /403 forbidden/);
  assert.equal(called, 0);
});

test("judgeToolResult: shortcut — ok:false stringified JSON result also short-circuits", async () => {
  let called = 0;
  const callFn = async () => {
    called++;
    return "{}";
  };
  const v = await judgeToolResult({
    toolName: "fetch_allowed_url",
    toolArgs: { url: "https://x" },
    toolResult: JSON.stringify({ ok: false, error: "bad gateway" }),
    userIntent: "fetch the page",
    callFn,
  });
  assert.equal(v.satisfactory, false);
  assert.match(v.issue, /bad gateway/);
  assert.equal(called, 0);
});

test("judgeToolResult: shortcut — empty userIntent → satisfactory:true, callFn NOT called", async () => {
  let called = 0;
  const callFn = async () => {
    called++;
    return "{}";
  };
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [] },
    userIntent: "",
    callFn,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(v.confidence, 0);
  assert.equal(called, 0);
});

test("judgeToolResult: shortcut — whitespace-only userIntent is treated as empty", async () => {
  let called = 0;
  const callFn = async () => {
    called++;
    return "{}";
  };
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: {},
    userIntent: "   \t\n  ",
    callFn,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(called, 0);
});

test("judgeToolResult: shortcut — empty {} result for list_* tool flagged without LLM call", async () => {
  let called = 0;
  const callFn = async () => {
    called++;
    return '{"satisfactory": true}';
  };
  const v = await judgeToolResult({
    toolName: "list_recipes",
    toolArgs: {},
    toolResult: {},
    userIntent: "show me the recipes",
    callFn,
  });
  assert.equal(v.satisfactory, false);
  assert.match(v.issue, /empty result/);
  assert.ok(v.suggestion);
  assert.equal(called, 0);
});

test("judgeToolResult: shortcut — empty array result for search_* tool flagged without LLM call", async () => {
  let called = 0;
  const callFn = async () => {
    called++;
    return '{"satisfactory": true}';
  };
  const v = await judgeToolResult({
    toolName: "search_context",
    toolArgs: { query: "foo" },
    toolResult: [],
    userIntent: "search for foo",
    callFn,
  });
  assert.equal(v.satisfactory, false);
  assert.equal(called, 0);
});

test("judgeToolResult: shortcut — {results: []} for web_search is flagged", async () => {
  let called = 0;
  const callFn = async () => {
    called++;
    return '{"satisfactory": true}';
  };
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "foo" },
    toolResult: { results: [] },
    userIntent: "find foo",
    callFn,
  });
  assert.equal(v.satisfactory, false);
  assert.equal(called, 0);
});

test("judgeToolResult: non-collection tool with empty result still goes to LLM", async () => {
  let called = 0;
  const callFn = async () => {
    called++;
    return JSON.stringify({ satisfactory: true, confidence: 0.4 });
  };
  const v = await judgeToolResult({
    toolName: "remember_workspace_fact",
    toolArgs: { fact: "x" },
    toolResult: {},
    userIntent: "remember this fact",
    callFn,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(called, 1);
});

test("judgeToolResult: clamps out-of-range confidence values", async () => {
  const callFn = async () =>
    JSON.stringify({ satisfactory: true, confidence: 7.5 });
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research",
    callFn,
  });
  assert.equal(v.satisfactory, true);
  assert.equal(v.confidence, 1);
});

test("judgeToolResult: provides default issue when LLM omits one on false verdict", async () => {
  const callFn = async () => JSON.stringify({ satisfactory: false, confidence: 0.4 });
  const v = await judgeToolResult({
    toolName: "web_search",
    toolArgs: { query: "x" },
    toolResult: { results: [{ id: 1 }] },
    userIntent: "research",
    callFn,
  });
  assert.equal(v.satisfactory, false);
  assert.ok(v.issue && v.issue.length > 0);
});

test("shouldSkipJudge: default skip list", () => {
  const before = process.env.JUDGE_SKIP_TOOLS;
  try {
    delete process.env.JUDGE_SKIP_TOOLS;
    assert.equal(shouldSkipJudge("list_context"), true);
    assert.equal(shouldSkipJudge("list_recipes"), true);
    assert.equal(shouldSkipJudge("list_workspace_memory"), true);
    assert.equal(shouldSkipJudge("workspace_git_status"), true);
    assert.equal(shouldSkipJudge("workspace_git_log"), true);
    assert.equal(shouldSkipJudge("workspace_list_dir"), true);
    assert.equal(shouldSkipJudge("web_search"), false);
    assert.equal(shouldSkipJudge("fetch_allowed_url"), false);
    assert.equal(shouldSkipJudge(""), false);
    assert.equal(shouldSkipJudge(null), false);
  } finally {
    if (before === undefined) delete process.env.JUDGE_SKIP_TOOLS;
    else process.env.JUDGE_SKIP_TOOLS = before;
  }
});

test("shouldSkipJudge: honors JUDGE_SKIP_TOOLS env (override, not merge)", () => {
  const before = process.env.JUDGE_SKIP_TOOLS;
  try {
    process.env.JUDGE_SKIP_TOOLS = "web_search,fetch_allowed_url";
    assert.equal(shouldSkipJudge("web_search"), true);
    assert.equal(shouldSkipJudge("fetch_allowed_url"), true);
    // Default-list items are no longer skipped when env overrides the list
    assert.equal(shouldSkipJudge("list_context"), false);
  } finally {
    if (before === undefined) delete process.env.JUDGE_SKIP_TOOLS;
    else process.env.JUDGE_SKIP_TOOLS = before;
  }
});

test("shouldSkipJudge: ignores whitespace and empty entries in env", () => {
  const before = process.env.JUDGE_SKIP_TOOLS;
  try {
    process.env.JUDGE_SKIP_TOOLS = "  web_search , ,  fetch_allowed_url  ";
    assert.equal(shouldSkipJudge("web_search"), true);
    assert.equal(shouldSkipJudge("fetch_allowed_url"), true);
  } finally {
    if (before === undefined) delete process.env.JUDGE_SKIP_TOOLS;
    else process.env.JUDGE_SKIP_TOOLS = before;
  }
});

test("toolResultJudgeEnabled: defaults to false, flips with env", () => {
  const before = process.env.AGENT_TOOL_RESULT_JUDGE;
  try {
    delete process.env.AGENT_TOOL_RESULT_JUDGE;
    assert.equal(toolResultJudgeEnabled(), false);
    process.env.AGENT_TOOL_RESULT_JUDGE = "1";
    assert.equal(toolResultJudgeEnabled(), true);
    process.env.AGENT_TOOL_RESULT_JUDGE = "0";
    assert.equal(toolResultJudgeEnabled(), false);
    process.env.AGENT_TOOL_RESULT_JUDGE = "true"; // only "1" enables
    assert.equal(toolResultJudgeEnabled(), false);
  } finally {
    if (before === undefined) delete process.env.AGENT_TOOL_RESULT_JUDGE;
    else process.env.AGENT_TOOL_RESULT_JUDGE = before;
  }
});
