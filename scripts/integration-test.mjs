#!/usr/bin/env node
/**
 * Comprehensive integration test script for SiskelBot.
 * Validates the full stack end-to-end by exercising all major API features.
 *
 * Usage:
 *   node scripts/integration-test.mjs [--url=http://localhost:3000] [--api-key=key]
 *
 * Environment variables:
 *   BASE_URL   - Server URL (default http://localhost:3000)
 *   API_KEY    - API key for authenticated endpoints
 *
 * Exit code 0 if all tests pass, 1 if any fail.
 */

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function getArg(name) {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const BASE_URL = (getArg("url") || process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const API_KEY = getArg("api-key") || process.env.API_KEY || "";

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

async function fetchJson(url, options = {}) {
  const headers = { ...authHeaders(), ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers, redirect: "follow" });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body, headers: Object.fromEntries(res.headers) };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
const results = [];

async function runTest(name, fn) {
  const start = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - start;
    results.push({ name, pass: true, durationMs });
  } catch (err) {
    const durationMs = Date.now() - start;
    results.push({ name, pass: false, durationMs, error: err.message || String(err) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 1. Health
// ---------------------------------------------------------------------------
async function testHealth() {
  await runTest("Health: GET /health/live", async () => {
    const r = await fetchJson(`${BASE_URL}/health/live`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(r.body?.ok === true, "Expected { ok: true }");
  });

  await runTest("Health: GET /health/ready", async () => {
    const r = await fetchJson(`${BASE_URL}/health/ready`);
    // 200 = ready, 503 = not ready but still a valid structured response
    assert(r.status === 200 || r.status === 503, `Expected 200 or 503, got ${r.status}`);
    assert(typeof r.body?.status === "string", "Expected status field in response");
  });

  await runTest("Health: GET /health/integrations", async () => {
    const r = await fetchJson(`${BASE_URL}/health/integrations`);
    assert(r.ok || r.status === 503, `Expected 200 or 503, got ${r.status}`);
    assert(r.body && typeof r.body === "object", "Expected JSON response");
  });
}

// ---------------------------------------------------------------------------
// 2. Config
// ---------------------------------------------------------------------------
async function testConfig() {
  await runTest("Config: GET /config", async () => {
    const r = await fetchJson(`${BASE_URL}/config`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(typeof r.body?.backend === "string", "Expected backend field in config");
  });
}

// ---------------------------------------------------------------------------
// 3. Knowledge (Context)
// ---------------------------------------------------------------------------
async function testKnowledge() {
  let docId;

  await runTest("Knowledge: POST /api/v1/context (create)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/context`, {
      method: "POST",
      body: JSON.stringify({
        title: "Integration Test Doc",
        content: "This is a test document for integration testing.",
      }),
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    assert(r.body?.id, "Expected id in response");
    docId = r.body.id;
  });

  await runTest("Knowledge: GET /api/v1/context (list)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/context`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(Array.isArray(r.body?.items), "Expected items array");
  });

  await runTest("Knowledge: DELETE /api/v1/context/:id", async () => {
    if (!docId) throw new Error("No doc to delete (create failed)");
    const r = await fetchJson(`${BASE_URL}/api/v1/context/${docId}`, { method: "DELETE" });
    assert(r.status === 204, `Expected 204, got ${r.status}`);
  });
}

// ---------------------------------------------------------------------------
// 4. Conversations
// ---------------------------------------------------------------------------
async function testConversations() {
  let convId;

  await runTest("Conversations: POST /api/v1/conversations (create)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/conversations`, {
      method: "POST",
      body: JSON.stringify({
        title: "Integration Test Conversation",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    assert(r.body?.id, "Expected id in response");
    convId = r.body.id;
  });

  await runTest("Conversations: GET /api/v1/conversations (list)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/conversations`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(Array.isArray(r.body?.items), "Expected items array");
  });

  await runTest("Conversations: PUT /api/v1/conversations/:id (update)", async () => {
    if (!convId) throw new Error("No conversation to update (create failed)");
    const r = await fetchJson(`${BASE_URL}/api/v1/conversations/${convId}`, {
      method: "PUT",
      body: JSON.stringify({
        title: "Updated Integration Test Conversation",
      }),
    });
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(r.body?.title === "Updated Integration Test Conversation", "Expected updated title");
  });

  await runTest("Conversations: DELETE /api/v1/conversations/:id", async () => {
    if (!convId) throw new Error("No conversation to delete (create failed)");
    const r = await fetchJson(`${BASE_URL}/api/v1/conversations/${convId}`, { method: "DELETE" });
    assert(r.status === 204, `Expected 204, got ${r.status}`);
  });
}

// ---------------------------------------------------------------------------
// 5. Recipes
// ---------------------------------------------------------------------------
async function testRecipes() {
  let recipeId;

  await runTest("Recipes: POST /api/v1/recipes (create)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/recipes`, {
      method: "POST",
      body: JSON.stringify({
        name: "Integration Test Recipe",
        description: "A recipe created by integration tests.",
        steps: [{ action: "log", message: "test step" }],
      }),
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    assert(r.body?.id, "Expected id in response");
    recipeId = r.body.id;
  });

  await runTest("Recipes: GET /api/v1/recipes (list)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/recipes`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(Array.isArray(r.body?.items), "Expected items array");
  });

  // Cleanup
  if (recipeId) {
    await fetchJson(`${BASE_URL}/api/v1/recipes/${recipeId}`, { method: "DELETE" }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 6. Workspaces
// ---------------------------------------------------------------------------
async function testWorkspaces() {
  let wsId;

  await runTest("Workspaces: POST /api/v1/workspaces (create)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/workspaces`, {
      method: "POST",
      body: JSON.stringify({
        name: "integration-test-ws-" + Date.now(),
      }),
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    assert(r.body?.id || r.body?.workspaceId, "Expected id or workspaceId in response");
    wsId = r.body.id || r.body.workspaceId;
  });

  await runTest("Workspaces: GET /api/v1/workspaces (list)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/workspaces`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(Array.isArray(r.body?.items), "Expected items array");
  });
}

// ---------------------------------------------------------------------------
// 7. Search
// ---------------------------------------------------------------------------
async function testSearch() {
  await runTest("Search: GET /api/v1/knowledge/search?q=test", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/knowledge/search?q=test`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(r.body && typeof r.body === "object", "Expected JSON response");
  });
}

// ---------------------------------------------------------------------------
// 8. MCP
// ---------------------------------------------------------------------------
async function testMcp() {
  await runTest("MCP: POST /mcp (initialize)", async () => {
    const r = await fetchJson(`${BASE_URL}/mcp`, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "integration-test", version: "1.0.0" },
        },
        id: "init-1",
      }),
    });
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(r.body?.jsonrpc === "2.0", "Expected jsonrpc 2.0 in response");
    // initialize should return a result (not an error)
    assert(!r.body?.error || r.body?.result, "Expected result or non-error response");
  });
}

// ---------------------------------------------------------------------------
// 9. Webhooks
// ---------------------------------------------------------------------------
async function testWebhooks() {
  let webhookId;

  await runTest("Webhooks: POST /api/v1/webhooks (create)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/webhooks`, {
      method: "POST",
      body: JSON.stringify({
        url: "https://example.com/webhook-integration-test",
        events: ["message_sent"],
      }),
    });
    // 201 = created, 400 = validation error (localhost not allowed, etc.)
    assert(r.status === 201 || r.status === 400, `Expected 201 or 400, got ${r.status}`);
    if (r.status === 201) {
      assert(r.body?.id, "Expected id in response");
      webhookId = r.body.id;
    }
  });

  await runTest("Webhooks: GET /api/v1/webhooks (list)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/webhooks`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(Array.isArray(r.body?.items), "Expected items array");
  });

  await runTest("Webhooks: DELETE /api/v1/webhooks/:id", async () => {
    if (!webhookId) throw new Error("No webhook to delete (create returned non-201 or failed)");
    const r = await fetchJson(`${BASE_URL}/api/v1/webhooks/${webhookId}`, { method: "DELETE" });
    assert(r.status === 204, `Expected 204, got ${r.status}`);
  });
}

// ---------------------------------------------------------------------------
// 10. OpenAPI
// ---------------------------------------------------------------------------
async function testOpenApi() {
  await runTest("OpenAPI: GET /api/docs/openapi.json", async () => {
    const r = await fetchJson(`${BASE_URL}/api/docs/openapi.json`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(typeof r.body === "object" && r.body !== null, "Expected JSON object");
    assert(r.body.openapi || r.body.swagger, "Expected openapi or swagger field");
    assert(r.body.info && typeof r.body.info.title === "string", "Expected info.title");
    assert(r.body.paths && typeof r.body.paths === "object", "Expected paths object");
  });
}

// ---------------------------------------------------------------------------
// 11. Billing
// ---------------------------------------------------------------------------
async function testBilling() {
  await runTest("Billing: GET /api/v1/billing/plans", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/billing/plans`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(r.body && typeof r.body === "object", "Expected JSON response");
    assert(Array.isArray(r.body.plans), "Expected plans array");
  });
}

// ---------------------------------------------------------------------------
// 12. Agent Memory
// ---------------------------------------------------------------------------
async function testAgentMemory() {
  let memoryId;

  await runTest("Memory: POST /api/v1/memory (add)", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/memory`, {
      method: "POST",
      body: JSON.stringify({
        content: "Integration test memory fact: the sky is blue.",
        category: "fact",
        importance: 3,
      }),
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    assert(r.body?.id || r.body?.memory?.id, "Expected id in response");
    memoryId = r.body.id || r.body.memory?.id;
  });

  await runTest("Memory: GET /api/v1/memory/search?q=sky", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/memory/search?q=sky`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(r.body && typeof r.body === "object", "Expected JSON response");
  });

  // Cleanup
  if (memoryId) {
    await fetchJson(`${BASE_URL}/api/v1/memory/${memoryId}`, { method: "DELETE" }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 13. Models
// ---------------------------------------------------------------------------
async function testModels() {
  await runTest("Models: GET /api/v1/models/quality", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/models/quality`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(r.body && typeof r.body === "object", "Expected JSON response");
  });
}

// ---------------------------------------------------------------------------
// 14. Analytics
// ---------------------------------------------------------------------------
async function testAnalytics() {
  await runTest("Analytics: GET /api/v1/analytics/trends", async () => {
    const r = await fetchJson(`${BASE_URL}/api/v1/analytics/trends`);
    assert(r.ok, `Expected 200, got ${r.status}`);
    assert(r.body && typeof r.body === "object", "Expected JSON response");
  });
}

// ---------------------------------------------------------------------------
// Results table and summary
// ---------------------------------------------------------------------------
function printResults() {
  const nameWidth = Math.max(20, ...results.map((r) => r.name.length)) + 2;

  console.log("");
  console.log("=".repeat(nameWidth + 30));
  console.log(
    "  " +
      "Test".padEnd(nameWidth) +
      "Result".padEnd(10) +
      "Duration"
  );
  console.log("=".repeat(nameWidth + 30));

  for (const r of results) {
    const status = r.pass ? "PASS" : "FAIL";
    const dur = `${r.durationMs}ms`;
    const line = `  ${r.name.padEnd(nameWidth)}${status.padEnd(10)}${dur}`;
    console.log(line);
    if (!r.pass && r.error) {
      console.log(`    -> ${r.error}`);
    }
  }

  console.log("=".repeat(nameWidth + 30));

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log("");
  console.log(
    `  Total: ${results.length}  |  Passed: ${passed}  |  Failed: ${failed}  |  Duration: ${totalDuration}ms`
  );
  console.log("");

  return failed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`SiskelBot Integration Tests`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`API Key: ${API_KEY ? "(provided)" : "(none)"}`);
  console.log("");

  // Run all test groups sequentially (some depend on created resources)
  await testHealth();
  await testConfig();
  await testKnowledge();
  await testConversations();
  await testRecipes();
  await testWorkspaces();
  await testSearch();
  await testMcp();
  await testWebhooks();
  await testOpenApi();
  await testBilling();
  await testAgentMemory();
  await testModels();
  await testAnalytics();

  const failed = printResults();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Integration test runner error:", err);
  process.exit(1);
});
