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
