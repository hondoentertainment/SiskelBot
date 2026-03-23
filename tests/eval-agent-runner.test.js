import test from "node:test";
import assert from "node:assert/strict";
import {
  runEvalSet,
  checkCriteria,
  parseSseEvalResponse,
} from "../lib/eval-runner.js";

test("runEvalSet forwards agent eval chat request fields", async () => {
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "hello" } }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };

  const out = await runEvalSet(
    {
      id: "agent-chat",
      name: "Agent chat",
      chatRequestDefaults: {
        agentMode: true,
        agentOptions: { workspace: "eval-workspace", allowExecution: false },
        temperature: 0.1,
      },
      cases: [
        {
          id: "agent-hello",
          prompt: "Say hello in one word.",
          expectedContains: "hello",
          max_tokens: 77,
          chatRequest: {
            swarmMode: true,
            top_p: 0.2,
          },
        },
      ],
    },
    {
      baseUrl: "http://example.test",
      apiKey: "test-key",
      fetchFn,
    }
  );

  assert.equal(out.passed, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://example.test/v1/chat/completions");
  assert.equal(requests[0].body.agentMode, true);
  assert.equal(requests[0].body.swarmMode, true);
  assert.equal(requests[0].body.temperature, 0.1);
  assert.equal(requests[0].body.top_p, 0.2);
  assert.equal(requests[0].body.max_tokens, 77);
  assert.deepEqual(requests[0].body.agentOptions, {
    workspace: "eval-workspace",
    allowExecution: false,
  });
  assert.equal(requests[0].body.stream, false);
  assert.deepEqual(requests[0].body.messages, [
    { role: "user", content: "Say hello in one word." },
  ]);
});

test("runEvalSet parses SSE agent responses", async () => {
  const sseBody = [
    `data: ${JSON.stringify({ type: "agent_activity", toolCalls: [{ id: "t1" }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" }, index: 0 }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" }, index: 0, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const out = await runEvalSet(
    {
      id: "agent-sse",
      name: "Agent SSE",
      cases: [
        {
          id: "sse-case",
          prompt: "Say hello in one word.",
          expectedContains: "hello",
          agentMode: true,
        },
      ],
    },
    {
      baseUrl: "http://example.test",
      fetchFn: async () =>
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    }
  );

  assert.equal(out.passed, 1);
  assert.equal(out.results[0]?.output, "hello");
});

test("parseSseEvalResponse extracts agent_activity toolCalls and assistant text", () => {
  const raw = [
    `data: ${JSON.stringify({
      type: "agent_activity",
      toolCalls: [{ name: "list_context", args: {}, iteration: 1 }],
      swarmSteps: [],
      iteration: 1,
    })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, index: 0, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { content, agentActivity } = parseSseEvalResponse(raw);
  assert.equal(content, "done");
  assert.ok(agentActivity && agentActivity.type === "agent_activity");
  assert.equal(agentActivity.toolCalls[0].name, "list_context");
});

test("parseSseEvalResponse ignores agent_progress SSE events", () => {
  const raw = [
    `data: ${JSON.stringify({ type: "agent_progress", iteration: 1, llmMs: 10, toolsWallMs: 5, tools: [] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, index: 0, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { content, agentActivity } = parseSseEvalResponse(raw);
  assert.equal(content, "hi");
  assert.equal(agentActivity, null);
});

test("checkCriteria enforces expectedAgentActivityToolNames", () => {
  const activity = {
    type: "agent_activity",
    toolCalls: [{ name: "search_context", iteration: 1 }],
  };
  assert.equal(
    checkCriteria(
      { expectedAgentActivityToolNames: ["list_context"] },
      "ok",
      null,
      activity
    ).pass,
    false
  );
  assert.equal(
    checkCriteria(
      { expectedAgentActivityToolNames: ["search_context"], expectedContains: "ok" },
      "ok",
      null,
      activity
    ).pass,
    true
  );
});

test("runEvalSet applies outcome criteria from SSE agent_activity", async () => {
  const sseBody = [
    `data: ${JSON.stringify({
      type: "agent_activity",
      toolCalls: [
        { name: "list_context", iteration: 1 },
        { name: "search_context", iteration: 2 },
      ],
    })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "summary" }, index: 0, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const out = await runEvalSet(
    {
      id: "outcome",
      name: "Outcome",
      cases: [
        {
          id: "tool-order",
          prompt: "List then search.",
          agentMode: true,
          expectedAgentActivityToolSequence: ["list_context", "search_context"],
          expectedMinAgentActivityToolCalls: 2,
          expectedContains: "summary",
        },
      ],
    },
    {
      baseUrl: "http://example.test",
      fetchFn: async () =>
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    }
  );

  assert.equal(out.passed, 1);
  assert.equal(out.skipped, 0);
});

test("runEvalSet skip cases count in total but not in passed", async () => {
  const out = await runEvalSet(
    {
      id: "skip-set",
      name: "Skip",
      cases: [
        { id: "s1", skip: true, skipReason: "template" },
        {
          id: "c2",
          prompt: "x",
          expectedContains: "x",
        },
      ],
    },
    {
      baseUrl: "http://example.test",
      fetchFn: async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "x" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
    }
  );
  assert.equal(out.total, 2);
  assert.equal(out.skipped, 1);
  assert.equal(out.passed, 1);
  assert.equal(out.results.find((r) => r.caseId === "s1")?.skipped, true);
});

test("runEvalSet includes agentActivityHint for SSE agent_activity", async () => {
  const sseBody = [
    `data: ${JSON.stringify({
      type: "agent_activity",
      toolCalls: [{ name: "list_context" }, { name: "search_context" }],
      swarmSteps: [{ specialist: "researcher" }],
    })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const out = await runEvalSet(
    {
      id: "hint",
      name: "Hint",
      cases: [{ id: "h1", prompt: "x", agentMode: true, expectedContains: "ok" }],
    },
    {
      baseUrl: "http://example.test",
      fetchFn: async () =>
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    }
  );
  assert.equal(out.passed, 1);
  const hint = out.results[0]?.agentActivityHint;
  assert.ok(hint && hint.includes("list_context"));
  assert.ok(hint.includes("researcher"));
});
