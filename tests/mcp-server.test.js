import test from "node:test";
import assert from "node:assert/strict";

// Mock knowledge-store and storage before importing
// const mockStorage = {
//   listItems: async () => [],
//   listWorkspaces: async () => [{ id: "default", name: "Default" }],
// };

// const mockKnowledge = {
//   search: async ({ query }) => ({ items: [], query }),
//   list: async () => ({ items: [] }),
//   getDocumentById: async ({ id }) => ({ id, content: "doc content" }),
// };

// We import the module directly — it depends on storage and knowledge-store
// but we test via handleMcpRequest which accepts a ctx for backend calls.
import { handleMcpRequest, getMcpCapabilities } from "../lib/mcp-server.js";

test("getMcpCapabilities returns protocol version and server info", () => {
  const caps = getMcpCapabilities();
  assert.equal(caps.protocolVersion, "2024-11-05");
  assert.equal(caps.serverInfo.name, "siskelbot");
  assert.ok(caps.capabilities.resources);
  assert.ok(caps.capabilities.tools);
});

test("handleMcpRequest initialize returns capabilities", async () => {
  const result = await handleMcpRequest("initialize", {});
  assert.equal(result.protocolVersion, "2024-11-05");
  assert.equal(result.serverInfo.name, "siskelbot");
  assert.ok(result.capabilities);
});

test("handleMcpRequest resources/list returns resources array", async () => {
  const result = await handleMcpRequest("resources/list", {});
  assert.ok(Array.isArray(result.resources));
  assert.ok(result.resources.length > 0);
  const uris = result.resources.map((r) => r.uriTemplate);
  assert.ok(uris.some((u) => u.includes("knowledge")));
  assert.ok(uris.some((u) => u.includes("recipes")));
});

test("handleMcpRequest tools/list returns tools array", async () => {
  const result = await handleMcpRequest("tools/list", {});
  assert.ok(Array.isArray(result.tools));
  assert.ok(result.tools.length > 0);
  const names = result.tools.map((t) => t.name);
  assert.ok(names.includes("search_knowledge"));
  assert.ok(names.includes("chat_completion"));
  assert.ok(names.includes("list_workspaces"));
});

test("handleMcpRequest tools/call search_knowledge returns results", async () => {
  const result = await handleMcpRequest("tools/call", {
    name: "search_knowledge",
    arguments: { query: "test" },
  });
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0].type, "text");
  // The result text should be parseable JSON
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(typeof parsed === "object");
});

test("handleMcpRequest tools/call search_knowledge with empty query returns error", async () => {
  const result = await handleMcpRequest("tools/call", {
    name: "search_knowledge",
    arguments: { query: "" },
  });
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.error);
});

test("handleMcpRequest invalid method returns error", async () => {
  const result = await handleMcpRequest("nonexistent/method", {});
  assert.ok(result.error);
  assert.equal(result.error.code, -32601);
  assert.ok(result.error.message.includes("nonexistent/method"));
});

test("handleMcpRequest tools/call unknown tool returns error", async () => {
  const result = await handleMcpRequest("tools/call", {
    name: "nonexistent_tool",
    arguments: {},
  });
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.error.includes("Unknown tool"));
});

test("handleMcpRequest tools/call chat_completion without backend context returns error", async () => {
  const result = await handleMcpRequest("tools/call", {
    name: "chat_completion",
    arguments: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(parsed.error.includes("backend not configured"));
});

test("handleMcpRequest tools/call chat_completion with empty messages returns error", async () => {
  const result = await handleMcpRequest("tools/call", {
    name: "chat_completion",
    arguments: { messages: [] },
  });
  assert.equal(result.isError, true);
});

test("handleMcpRequest tools/call plan_task without description returns error", async () => {
  const result = await handleMcpRequest("tools/call", {
    name: "plan_task",
    arguments: { description: "" },
  });
  assert.equal(result.isError, true);
});

test("handleMcpRequest tools/call run_recipe without name returns error", async () => {
  const result = await handleMcpRequest("tools/call", {
    name: "run_recipe",
    arguments: { name: "" },
  });
  assert.equal(result.isError, true);
});
