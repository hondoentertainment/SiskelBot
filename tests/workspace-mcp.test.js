import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { setSecret } from "../lib/secrets-store.js";
import { saveWorkspaceAgentSettings } from "../lib/workspace-agent-settings.js";
import { getToolCategory } from "../lib/agent-policy.js";
import { runTool } from "../lib/agent-tools.js";
import {
  validateMcpUrl,
  validateStdioCommand,
  registerWorkspaceMcpServer,
  discoverWorkspaceMcpTools,
  invokeWorkspaceMcpTool,
  workspaceMcpToolDefs,
} from "../lib/workspace-mcp.js";
import { mountWorkspaceMcpRoutes } from "../routes/workspace-mcp.js";

function isolate(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "wmcp-"));
    const prevStore = process.env.STORAGE_PATH;
    const prevFlag = process.env.WORKSPACE_MCP_ENABLED;
    process.env.STORAGE_PATH = dir;
    delete process.env.WORKSPACE_MCP_ENABLED;
    try {
      await fn();
    } finally {
      if (prevStore === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = prevStore;
      if (prevFlag === undefined) delete process.env.WORKSPACE_MCP_ENABLED;
      else process.env.WORKSPACE_MCP_ENABLED = prevFlag;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("MCP URLs must be https and on the allowlist", () => {
  assert.equal(validateMcpUrl("http://mcp.example.com/mcp", ["mcp.example.com"]).ok, false);
  assert.equal(validateMcpUrl("https://localhost/mcp", ["localhost"]).ok, false);
  assert.equal(validateMcpUrl("https://mcp.example.com/mcp", []).ok, false);
  assert.equal(validateMcpUrl("https://mcp.example.com/mcp", ["other.example"]).ok, false);
  assert.equal(validateMcpUrl("https://mcp.example.com/mcp", ["mcp.example.com"]).ok, true);
});

test("attached tools stay off until the deployment flag and server are enabled", isolate(async () => {
  const server = await registerWorkspaceMcpServer("default", {
    name: "Docs",
    url: "https://mcp.example.com/mcp",
    allowedHosts: ["mcp.example.com"],
  });
  assert.equal(server.enabled, false);
  await assert.rejects(
    () => discoverWorkspaceMcpTools("default", server.id, { listTools: async () => [] }),
    /WORKSPACE_MCP_ENABLED/,
  );
  process.env.WORKSPACE_MCP_ENABLED = "1";
  await assert.rejects(
    () => discoverWorkspaceMcpTools("default", server.id, { listTools: async () => [] }),
    /Enable the server/,
  );
  const enabled = await registerWorkspaceMcpServer("default", {
    name: "Docs live",
    url: "https://mcp.example.com/mcp",
    allowedHosts: ["mcp.example.com"],
    enabled: true,
    authSecretName: "mcp_token",
  });
  await setSecret("workspace", "default", "mcp_token", "secret-token-value", "mcp");
  let seenAuth = "";
  const tools = await discoverWorkspaceMcpTools("default", enabled.id, {
    listTools: async (_server, headers) => {
      seenAuth = headers.Authorization;
      return [{ name: "search_docs", description: "Search", inputSchema: { type: "object", properties: {} } }];
    },
  });
  assert.equal(seenAuth, "Bearer secret-token-value");
  assert.equal(tools.length, 1);
  assert.equal(getToolCategory(tools[0].name), "network");
  const defs = await workspaceMcpToolDefs("default");
  assert.equal(defs.length, 1);

  let called = 0;
  const ok = await invokeWorkspaceMcpTool(tools[0].name, { q: "hi" }, { workspace: "default", workspaceUserId: "ada" }, {
    callTool: async (_server, headers, original) => {
      called += 1;
      assert.equal(headers.Authorization, "Bearer secret-token-value");
      assert.equal(original, "search_docs");
      return { text: "found" };
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(called, 1);

  await saveWorkspaceAgentSettings("ada", "default", {
    agentPolicy: { deniedTools: [tools[0].name] },
  });
  const denied = await runTool(tools[0].name, {}, { workspace: "default", workspaceUserId: "ada" });
  const body = JSON.parse(denied.content);
  assert.equal(body.code, "POLICY_TOOL_DENIED");
}));

test("MCP attach route rejects a non-https server", isolate(async () => {
  const app = express();
  app.use(express.json());
  mountWorkspaceMcpRoutes(app, {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError: (res, status, code, msg) => res.status(status).json({ error: msg, code }),
    logRequest: (_q, _s, n) => n(),
    userAuth: (req, _res, next) => {
      req.userId = "ada";
      next();
    },
  });
  const bad = await request(app).post("/api/v1/workspaces/default/mcp-servers").send({
    url: "http://mcp.example.com/mcp",
    allowedHosts: ["mcp.example.com"],
  });
  assert.equal(bad.status, 400);
  const saved = await request(app).post("/api/v1/workspaces/default/mcp-servers").send({
    name: "Docs",
    url: "https://mcp.example.com/mcp",
    allowedHosts: ["mcp.example.com"],
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.server.enabled, false);
  assert.equal(saved.body.server.authConfigured, false);
}));

test("stdio MCP stays off unless the command is an allowlisted bare name", isolate(async () => {
  const prevStdio = process.env.WORKSPACE_MCP_STDIO;
  const prevAllow = process.env.WORKSPACE_MCP_STDIO_ALLOWLIST;
  delete process.env.WORKSPACE_MCP_STDIO;
  delete process.env.WORKSPACE_MCP_STDIO_ALLOWLIST;
  try {
    assert.equal(validateStdioCommand("mcp-server", []).ok, false);
    process.env.WORKSPACE_MCP_STDIO = "1";
    assert.match(validateStdioCommand("mcp-server", []).error, /ALLOWLIST/);
    process.env.WORKSPACE_MCP_STDIO_ALLOWLIST = "mcp-server";
    assert.equal(validateStdioCommand("/usr/bin/mcp-server", []).ok, false);
    assert.equal(validateStdioCommand("bash", ["-c", "id"]).ok, false);
    const ok = validateStdioCommand("mcp-server", ["--stdio"]);
    assert.equal(ok.ok, true);
    process.env.WORKSPACE_MCP_ENABLED = "1";
    const server = await registerWorkspaceMcpServer("default", {
      type: "stdio",
      command: "mcp-server",
      args: ["--stdio"],
      enabled: true,
    });
    assert.equal(server.type, "stdio");
    assert.equal(server.command, "mcp-server");
    const tools = await discoverWorkspaceMcpTools("default", server.id, {
      listTools: async (row) => {
        assert.equal(row.type, "stdio");
        assert.equal(row.command, "mcp-server");
        return [{ name: "ping", description: "Ping" }];
      },
    });
    assert.equal(tools[0].originalName, "ping");
    delete process.env.WORKSPACE_MCP_STDIO;
    const blocked = await invokeWorkspaceMcpTool(tools[0].name, {}, { workspace: "default", workspaceUserId: "ada" }, {
      callTool: async () => { throw new Error("should not spawn"); },
    });
    assert.equal(JSON.parse(blocked.content).code, "MCP_STDIO_DISABLED");
  } finally {
    if (prevStdio === undefined) delete process.env.WORKSPACE_MCP_STDIO;
    else process.env.WORKSPACE_MCP_STDIO = prevStdio;
    if (prevAllow === undefined) delete process.env.WORKSPACE_MCP_STDIO_ALLOWLIST;
    else process.env.WORKSPACE_MCP_STDIO_ALLOWLIST = prevAllow;
  }
}));
