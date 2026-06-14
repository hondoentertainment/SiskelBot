/**
 * Tests for routes/agent-tools-discover.js
 *
 * Covers:
 *  1. GET /api/v1/agent/tools returns 200 with tool list
 *  2. Auth is required (userAuth middleware invoked)
 *  3. includeMcp query param is respected
 */
import test from "node:test";
import assert from "node:assert/strict";

async function buildHarness(opts = {}) {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountAgentToolsDiscoverRoutes } = await import(
    "../routes/agent-tools-discover.js"
  );

  const app = express();
  app.use(express.json());

  let authCalled = false;
  let scopeCalled = false;
  let scopeValue = null;

  const apiRoute = (method, path, ...handlers) => {
    app[method](`/api/v1${path}`, ...handlers);
    app[method](`/api${path}`, ...handlers);
  };

  const apiError = (res, status, code, message) => {
    res.status(status).json({ error: message, code });
  };

  const logRequest = (_req, _res, next) => next();

  const userAuth = opts.blockAuth
    ? (_req, res) => {
        authCalled = true;
        res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
      }
    : (req, _res, next) => {
        authCalled = true;
        req.userId = "test-user";
        req.authenticatedViaDeploymentKey = true;
        req.apiKeyScopes = ["read", "write"];
        next();
      };

  const requireScope = (scope) => {
    return (_req, _res, next) => {
      scopeCalled = true;
      scopeValue = scope;
      next();
    };
  };

  mountAgentToolsDiscoverRoutes(app, {
    apiRoute,
    apiError,
    userAuth,
    requireScope,
    logRequest,
  });

  return { request, app, meta: () => ({ authCalled, scopeCalled, scopeValue }) };
}

test("GET /api/v1/agent/tools returns 200 with tool list", async () => {
  const { request, app, meta } = await buildHarness();

  const res = await request(app)
    .get("/api/v1/agent/tools")
    .expect(200);

  assert.ok(Array.isArray(res.body.tools), "tools should be an array");
  assert.ok(typeof res.body.total === "number", "total should be a number");
  assert.equal(res.body.tools.length, res.body.total, "tools.length should match total");

  // Verify tool shape
  for (const t of res.body.tools) {
    assert.ok(typeof t.name === "string" && t.name.length > 0, "tool.name required");
    assert.ok(typeof t.description === "string", "tool.description should be string");
    assert.ok(
      t.source === "static" || t.source === "mcp",
      `tool.source should be static or mcp, got ${t.source}`,
    );
  }

  // Auth middleware should have been called
  const m = meta();
  assert.ok(m.authCalled, "userAuth middleware should have been invoked");
  assert.ok(m.scopeCalled, "requireScope middleware should have been invoked");
  assert.equal(m.scopeValue, "read", "should require read scope");
});

test("GET /api/v1/agent/tools requires auth (401 when blocked)", async () => {
  const { request, app } = await buildHarness({ blockAuth: true });

  const res = await request(app)
    .get("/api/v1/agent/tools")
    .expect(401);

  assert.equal(res.body.code, "UNAUTHORIZED");
});

test("GET /api/v1/agent/tools with workspace param", async () => {
  const { request, app } = await buildHarness();

  const res = await request(app)
    .get("/api/v1/agent/tools?workspace=my-ws")
    .expect(200);

  assert.ok(Array.isArray(res.body.tools));
  assert.ok(res.body.total >= 0);
});

test("GET /api/v1/agent/tools with includeMcp=true (no servers)", async () => {
  const originalEnv = process.env.MCP_SERVERS;
  process.env.MCP_SERVERS = "";

  try {
    const { request, app } = await buildHarness();

    const res = await request(app)
      .get("/api/v1/agent/tools?includeMcp=true")
      .expect(200);

    assert.ok(Array.isArray(res.body.tools));
    // Without MCP servers, all tools should be static
    for (const t of res.body.tools) {
      assert.equal(t.source, "static", "all tools should be static without MCP servers");
    }
  } finally {
    if (originalEnv !== undefined) {
      process.env.MCP_SERVERS = originalEnv;
    } else {
      delete process.env.MCP_SERVERS;
    }
  }
});

test("GET /api/v1/agent/tools with includeMcp=false (default)", async () => {
  const { request, app } = await buildHarness();

  const res = await request(app)
    .get("/api/v1/agent/tools?includeMcp=false")
    .expect(200);

  // All tools should be static when includeMcp is not "true"
  for (const t of res.body.tools) {
    assert.equal(t.source, "static");
  }
});

test("GET /api/v1/agent/tools available at legacy /api path too", async () => {
  const { request, app } = await buildHarness();

  const res = await request(app)
    .get("/api/agent/tools")
    .expect(200);

  assert.ok(Array.isArray(res.body.tools));
  assert.ok(res.body.total > 0);
});
