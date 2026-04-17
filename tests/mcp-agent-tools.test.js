import test from "node:test";
import assert from "node:assert/strict";

import {
  profileToMcpTool,
  generateAgentMcpTools,
  handleAgentMcpToolCall,
} from "../lib/mcp-agent-tools.js";

// ── profileToMcpTool ─────────────────────────────────────────────────────────

test("profileToMcpTool generates correct tool name with agent_ prefix", () => {
  const profile = {
    id: "researcher",
    systemPrompt: "You are a research agent.",
  };
  const tool = profileToMcpTool(profile);
  assert.equal(tool.name, "agent_researcher");
});

test("profileToMcpTool truncates description to 200 chars", () => {
  const longPrompt = "A".repeat(300);
  const tool = profileToMcpTool({ id: "test", systemPrompt: longPrompt });
  assert.equal(tool.description.length, 200);
});

test("profileToMcpTool produces valid inputSchema with required goal", () => {
  const tool = profileToMcpTool({
    id: "executor",
    systemPrompt: "Execute tasks.",
  });
  assert.equal(tool.inputSchema.type, "object");
  assert.ok(tool.inputSchema.properties.goal);
  assert.ok(tool.inputSchema.properties.context);
  assert.ok(tool.inputSchema.properties.maxIterations);
  assert.deepEqual(tool.inputSchema.required, ["goal"]);
});

test("profileToMcpTool handles empty systemPrompt gracefully", () => {
  const tool = profileToMcpTool({ id: "empty", systemPrompt: "" });
  assert.equal(tool.description, "");
  assert.equal(tool.name, "agent_empty");
});

// ── generateAgentMcpTools ────────────────────────────────────────────────────

test("generateAgentMcpTools returns 5 built-in tools when no workspace given", async () => {
  const tools = await generateAgentMcpTools();
  assert.equal(tools.length, 5);
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("agent_researcher"));
  assert.ok(names.includes("agent_executor"));
  assert.ok(names.includes("agent_synthesizer"));
  assert.ok(names.includes("agent_code_writer"));
  assert.ok(names.includes("agent_reviewer"));
});

test("generateAgentMcpTools returns tools with valid MCP schema", async () => {
  const tools = await generateAgentMcpTools();
  for (const tool of tools) {
    assert.ok(tool.name.startsWith("agent_"));
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
    assert.deepEqual(tool.inputSchema.required, ["goal"]);
  }
});

// ── handleAgentMcpToolCall ───────────────────────────────────────────────────

test("handleAgentMcpToolCall returns error for invalid tool name", async () => {
  const result = await handleAgentMcpToolCall("badname", { goal: "test" });
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.error.includes("Invalid agent tool name"));
});

test("handleAgentMcpToolCall returns error when goal is missing", async () => {
  const result = await handleAgentMcpToolCall("agent_researcher", {});
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.error.includes("goal is required"));
});

test("handleAgentMcpToolCall returns error when goal is empty string", async () => {
  const result = await handleAgentMcpToolCall("agent_researcher", { goal: "" });
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.error.includes("goal is required"));
});

test("handleAgentMcpToolCall delegates to spawnSubagent and returns result", async () => {
  const mockRunAgentLoop = async () => ({
    content: "Mocked agent result from researcher",
    iteration: 3,
    toolCalls: [],
  });
  const mockBackendFetch = async () => ({ json: async () => ({}) });
  const mockBuildProxyConfig = () => ({
    baseUrl: "http://localhost",
    path: "/v1/chat/completions",
    headers: {},
  });

  const result = await handleAgentMcpToolCall(
    "agent_researcher",
    { goal: "Find information about AI" },
    {
      workspace: "default",
      userId: "test-user",
      runAgentLoop: mockRunAgentLoop,
      backendFetch: mockBackendFetch,
      buildProxyConfig: mockBuildProxyConfig,
    },
  );

  assert.ok(!result.isError, `Expected success but got error: ${JSON.stringify(result)}`);
  assert.equal(result.content[0].type, "text");
  assert.ok(result.content[0].text.includes("Mocked agent result"));
});

test("handleAgentMcpToolCall returns error when spawnSubagent fails", async () => {
  const mockRunAgentLoop = async () => {
    throw new Error("Agent loop exploded");
  };
  const mockBackendFetch = async () => ({ json: async () => ({}) });
  const mockBuildProxyConfig = () => ({
    baseUrl: "http://localhost",
    path: "/v1/chat/completions",
    headers: {},
  });

  const result = await handleAgentMcpToolCall(
    "agent_executor",
    { goal: "Do something" },
    {
      runAgentLoop: mockRunAgentLoop,
      backendFetch: mockBackendFetch,
      buildProxyConfig: mockBuildProxyConfig,
    },
  );

  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.error.includes("Agent loop exploded"));
});

// ── MCP server integration (env guard) ───────────────────────────────────────

test("handleMcpRequest tools/list excludes agent tools when EXPOSE_AGENT_MCP_TOOLS is not set", async () => {
  const original = process.env.EXPOSE_AGENT_MCP_TOOLS;
  delete process.env.EXPOSE_AGENT_MCP_TOOLS;
  try {
    const { handleMcpRequest } = await import("../lib/mcp-server.js");
    const result = await handleMcpRequest("tools/list", {});
    const names = result.tools.map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith("agent_")));
  } finally {
    if (original !== undefined) process.env.EXPOSE_AGENT_MCP_TOOLS = original;
  }
});

test("handleMcpRequest tools/list includes agent tools when EXPOSE_AGENT_MCP_TOOLS=1", async () => {
  const original = process.env.EXPOSE_AGENT_MCP_TOOLS;
  process.env.EXPOSE_AGENT_MCP_TOOLS = "1";
  try {
    const { handleMcpRequest } = await import("../lib/mcp-server.js");
    const result = await handleMcpRequest("tools/list", {});
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes("agent_researcher"));
    assert.ok(names.includes("agent_executor"));
    assert.ok(names.includes("search_knowledge"));
  } finally {
    if (original !== undefined) {
      process.env.EXPOSE_AGENT_MCP_TOOLS = original;
    } else {
      delete process.env.EXPOSE_AGENT_MCP_TOOLS;
    }
  }
});
