import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createHash } from "node:crypto";

async function loadApp(env = {}, opts = {}) {
  const original = { ...process.env };
  Object.assign(process.env, env, { VERCEL: "1" });
  const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
  const { default: app } = await import(moduleUrl.href);
  if (!opts.keepEnv) process.env = original;
  const restore = () => {
    process.env = original;
  };
  return opts.keepEnv ? { app, restore } : app;
}

/** Keeps env until restore(); use for routes that read process.env at request time (e.g. /api/cron). */
async function loadAppKeepEnv(env = {}) {
  const original = { ...process.env };
  Object.assign(process.env, env, { VERCEL: "1" });
  const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
  const { default: app } = await import(moduleUrl.href);
  return { app, restore: () => { process.env = original; } };
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

test("GET /config returns backend defaults", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/config");

  assert.equal(response.status, 200);
  assert.equal(response.body.backend, "ollama");
  assert.equal(response.body.defaultGenerationConfig.max_tokens, 512);
  assert.equal(response.body.requiresApiKey, false);
  assert.ok(response.body.oauthProviders && typeof response.body.oauthProviders === "object");
  assert.equal(response.body.storageBackend, "json");
  assert.equal(response.body.streamAgentFinalEnabled, false);
  assert.equal(response.body.fallbackBackend, null);
  assert.equal(response.body.otelEnabled, false);
  assert.equal(response.body.otelAutoInstrument, true);
  assert.equal(response.body.toolValidationEnabled, true);
  assert.equal(response.body.agentStagnationStop, true);
  assert.equal(response.body.agentRequireCitations, false);
  assert.equal(response.body.agentTrajectoryApi, true);
  assert.equal(response.body.agentSessionApi, true);
  assert.equal(response.body.workspaceFileToolsEnabled, false);
  assert.equal(response.body.workspaceRootConfigured, false);
  assert.equal(response.body.workspaceFileWriteToolsEnabled, false);
  assert.equal(response.body.workspaceGitToolsEnabled, false);
  assert.equal(response.body.workspaceGitWriteEnabled, false);
  assert.equal(response.body.workspaceCommandRunnerConfigured, false);
  assert.equal(response.body.agentBrowserToolsEnabled, false);
  assert.equal(response.body.agentDefaultSystemSet, false);
  assert.equal(response.body.streamSwarmSynth, false);
  assert.equal(response.body.agentPlanReflect, false);
  assert.equal(response.body.agentHooksConfigured, false);
  assert.equal(response.body.agentBudgetToolCalls, null);
  assert.equal(response.body.agentBudgetWallMs, null);
  assert.equal(response.body.agentToolsAllowlist, null);
  assert.equal(response.body.swarmClientSpecialistsAllowed, false);
  assert.equal(response.body.swarmMaxSpecialists, 8);
  assert.ok(Array.isArray(response.body.swarmSelectableSpecialists));
  assert.ok(response.body.swarmSelectableSpecialists.includes("researcher"));
  assert.ok(response.body.swarmSelectableSpecialists.includes("executor"));
  assert.equal(response.body.swarmSpecialistsAllowlist, null);
  assert.equal(response.body.agentMaxIterationsCeiling, 5);
  assert.equal(response.body.agentMaxIterationsClientTunable, true);
  assert.equal(response.body.prometheusEnabled, false);
  assert.equal(response.body.prometheusPath, "/metrics");
});

test("GET /config filters swarmSelectableSpecialists when SWARM_SPECIALISTS_ALLOWLIST is set", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", SWARM_SPECIALISTS_ALLOWLIST: "researcher" });
  try {
    const response = await request(app).get("/config");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.swarmSpecialistsAllowlist, ["researcher"]);
    assert.ok(response.body.swarmSelectableSpecialists.includes("researcher"));
    assert.equal(response.body.swarmSelectableSpecialists.includes("executor"), false);
  } finally {
    restore();
  }
});

test("GET /config sets agentDefaultSystemSet when AGENT_DEFAULT_SYSTEM is set", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", AGENT_DEFAULT_SYSTEM: "Be concise." });
  try {
    const response = await request(app).get("/config");
    assert.equal(response.status, 200);
    assert.equal(response.body.agentDefaultSystemSet, true);
  } finally {
    restore();
  }
});

test("GET /api/agent/trajectory/:runId returns 404 when not found", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get(
    "/api/agent/trajectory/00000000-0000-4000-8000-000000000001"
  );
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "TRAJECTORY_NOT_FOUND");
});

test("GET /auth/me returns 401 when not authenticated", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/auth/me");
  assert.equal(response.status, 401);
  assert.equal(response.body.code, "NOT_AUTHENTICATED");
});

test("GET /auth/logout redirects to /", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/auth/logout");
  assert.ok(response.status === 302 || response.status === 200);
  if (response.status === 302) assert.match(response.headers.location || "", /\//);
});

test("GET / serves the chat shell with PWA link", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/");

  assert.equal(response.status, 200);
  assert.match(response.text, /app\.webmanifest/);
  assert.match(response.text, /Deployment API key/);
});

test("POST /v1/chat/completions requires auth when API_KEY is set", async () => {
  const app = await loadApp({ BACKEND: "ollama", API_KEY: "secret-key" });
  const response = await request(app)
    .post("/v1/chat/completions")
    .send({ model: "llama3.2", messages: [{ role: "user", content: "hello" }] });

  assert.equal(response.status, 401);
  assert.equal(response.body.code, "AUTH_REQUIRED");
  assert.ok(response.body.error);
  assert.ok(response.body.hint);
});

test("API errors return structured format { error, code, hint }", async () => {
  const app = await loadApp({ BACKEND: "ollama", API_KEY: "secret-key" });
  const response = await request(app)
    .post("/v1/chat/completions")
    .send({ model: "llama3.2", messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 401);
  assert.ok(typeof response.body.error === "string");
  assert.ok(typeof response.body.code === "string");
  assert.ok(typeof response.body.hint === "string");
  assert.match(response.body.code, /^[A-Z_]+$/);
});

test("GET /health returns backend, reachable, latencyMs, lastChecked, backends", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/health");

  assert.equal(response.status, 200);
  assert.ok(["ollama", "vllm", "openai"].includes(response.body.backend));
  assert.ok(typeof response.body.reachable === "boolean");
  assert.ok(response.body.latencyMs === null || typeof response.body.latencyMs === "number");
  assert.ok(typeof response.body.lastChecked === "string");
  assert.ok(response.body.backends && typeof response.body.backends === "object");
});

test("GET /health uses cache within TTL (5s)", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const r1 = await request(app).get("/health");
  const r2 = await request(app).get("/health");

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.body.lastChecked, r2.body.lastChecked);
  assert.strictEqual(r2.body.cached, true);
});

test("GET /health?refresh=1 bypasses cache", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const r1 = await request(app).get("/health");
  const r2 = await request(app).get("/health?refresh=1");

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.ok(r2.body.cached === undefined || r2.body.cached === false);
});

// Phase 34: Health probes
test("GET /health/live returns 200 when process is alive", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/health/live");
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, "alive");
});

test("GET /health/ready returns 200 or 503 depending on storage and backend", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/health/ready");
  assert.ok(response.status === 200 || response.status === 503);
  if (response.status === 200) {
    assert.equal(response.body.ok, true);
    assert.equal(response.body.status, "ready");
  }
});

test("Phase 34: responses include X-Request-Id header", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/config");
  assert.ok(response.headers["x-request-id"], "X-Request-Id should be set");
  assert.match(response.headers["x-request-id"], /^[0-9a-f-]{36}$|^[0-9a-f]{8}-[0-9a-f]{4}/);
});

// Phase 36: Prometheus metrics
test("GET /metrics returns 404 when ENABLE_METRICS not set", async () => {
  const app = await loadApp({ BACKEND: "ollama", ENABLE_METRICS: "" });
  const response = await request(app).get("/metrics");
  assert.equal(response.status, 404);
});

test("GET /metrics returns valid Prometheus format when ENABLE_METRICS=1", async () => {
  const app = await loadApp({ BACKEND: "ollama", ENABLE_METRICS: "1" });
  const response = await request(app).get("/metrics");
  assert.equal(response.status, 200);
  assert.ok(
    response.headers["content-type"]?.includes("text/plain"),
    "Content-Type should be text/plain"
  );
  const text = response.text;
  assert.ok(text.length > 0, "Response should not be empty");
  assert.ok(text.includes("# HELP") && text.includes("# TYPE"), "Should have HELP and TYPE lines");
  assert.ok(text.includes("siskelbot_chat_requests_total"), "Should expose Phase 36 chat counter");
  assert.ok(text.includes("siskelbot_tokens_used_total"), "Should expose tokens counter");
  assert.ok(text.includes("siskelbot_active_connections"), "Should expose active connections gauge");
  // Valid Prometheus metric line: name{labels} value or name value (numeric)
  const metricLine = text.split("\n").find((l) => /^[a-z0-9_]+(\{[^}]*\})?\s+[\d.eE+-]+$/.test(l.trim()));
  assert.ok(metricLine, "Should have at least one valid Prometheus metric line");
});

test("GET /metrics returns 401 when METRICS_PROTECTED=1 and no auth", async () => {
  const { app, restore } = await loadAppKeepEnv({
    BACKEND: "ollama",
    ENABLE_METRICS: "1",
    METRICS_PROTECTED: "1",
    METRICS_SECRET: "my-secret",
  });
  try {
    const response = await request(app).get("/metrics");
    assert.equal(response.status, 401);
  } finally {
    restore();
  }
});

test("GET /metrics returns 200 when METRICS_PROTECTED=1 and secret provided", async () => {
  const { app, restore } = await loadAppKeepEnv({
    BACKEND: "ollama",
    ENABLE_METRICS: "1",
    METRICS_PROTECTED: "1",
    METRICS_SECRET: "my-secret",
  });
  try {
    const response = await request(app).get("/metrics?secret=my-secret");
    assert.equal(response.status, 200);
    assert.ok(response.text.includes("siskelbot_chat_requests_total"));
  } finally {
    restore();
  }
});

// --- Phase 4: Toolchain Integration Hub ---

test("GET /api/integrations/status returns { github, vercel } booleans", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/integrations/status");

  assert.equal(response.status, 200);
  assert.equal(typeof response.body.github, "boolean");
  assert.equal(typeof response.body.vercel, "boolean");
  assert.ok(!response.body.github, "github should be false when GITHUB_TOKEN not set");
  assert.ok(!response.body.vercel, "vercel should be false when VERCEL_TOKEN not set");
});

test("GET /api/integrations/status returns github true when GITHUB_TOKEN set", async () => {
  const app = await loadApp({ BACKEND: "ollama", GITHUB_TOKEN: "gh_xxx" });
  const response = await request(app).get("/api/integrations/status");

  assert.equal(response.status, 200);
  assert.strictEqual(response.body.github, true);
});

test("GET /api/integrations/status returns vercel true when VERCEL_TOKEN set", async () => {
  const app = await loadApp({ BACKEND: "ollama", VERCEL_TOKEN: "v_xxx" });
  const response = await request(app).get("/api/integrations/status");

  assert.equal(response.status, 200);
  assert.strictEqual(response.body.vercel, true);
});

test("GET /api/github/repos returns 503 with { error, code, hint } when GITHUB_TOKEN missing", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/github/repos");

  assert.equal(response.status, 503);
  assert.ok(response.body.error);
  assert.equal(response.body.code, "INTEGRATION_UNAVAILABLE");
  assert.ok(response.body.hint);
  assert.match(response.body.hint.toLowerCase(), /github_token/);
});

test("GET /api/vercel/deployments returns 503 with { error, code, hint } when VERCEL_TOKEN missing", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/vercel/deployments");

  assert.equal(response.status, 503);
  assert.ok(response.body.error);
  assert.equal(response.body.code, "INTEGRATION_UNAVAILABLE");
  assert.ok(response.body.hint);
  assert.match(response.body.hint.toLowerCase(), /vercel_token/);
});

test("GET /api/github/repo/:owner/:repo returns 400 with { error, code, hint } for invalid owner", async () => {
  const app = await loadApp({ BACKEND: "ollama", GITHUB_TOKEN: "gh_xxx" });
  // owner "a/b" (slash not allowed) fails validation before any GitHub API call
  const response = await request(app).get("/api/github/repo/a%2Fb/repo");

  assert.equal(response.status, 400);
  assert.ok(response.body.error);
  assert.equal(response.body.code, "INVALID_INPUT");
  assert.ok(response.body.hint);
});

// --- Phase 3: Task Planning (POST /v1/tasks/plan) ---

test("POST /v1/tasks/plan returns 400 when messages is empty", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/v1/tasks/plan")
    .send({ messages: [], model: "llama3.2" });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_BODY");
  assert.ok(response.body.error);
  assert.ok(response.body.hint);
});

test("POST /v1/tasks/plan returns 400 when messages is not an array", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/v1/tasks/plan")
    .send({ messages: "hello", model: "llama3.2" });

  assert.equal(response.status, 400);
  assert.ok(response.body.code);
});

test("POST /v1/tasks/plan requires auth when API_KEY is set", async () => {
  const app = await loadApp({ BACKEND: "ollama", API_KEY: "secret-key" });
  const response = await request(app)
    .post("/v1/tasks/plan")
    .send({ messages: [{ role: "user", content: "deploy this" }], model: "llama3.2" });

  assert.equal(response.status, 401);
  assert.equal(response.body.code, "AUTH_REQUIRED");
});

test("POST /v1/tasks/plan returns 400 PARSE_ERROR on invalid LLM output", async () => {
  const { createServer } = await import("node:http");
  const mockBackend = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "not valid json at all" } }],
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => mockBackend.listen(0, "127.0.0.1", r));
  const port = mockBackend.address().port;
  const app = await loadApp({
    BACKEND: "ollama",
    OLLAMA_URL: `http://127.0.0.1:${port}`,
  });

  const response = await request(app)
    .post("/v1/tasks/plan")
    .send({
      messages: [{ role: "user", content: "plan a task" }],
      model: "llama3.2",
    });

  mockBackend.close();
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "PARSE_ERROR");
  assert.ok(response.body.raw);
});

test("POST /v1/tasks/plan returns 400 VALIDATION_ERROR on invalid schema", async () => {
  const { createServer } = await import("node:http");
  const invalidPlan = JSON.stringify({
    type: "other",
    name: "x",
    steps: [],
  });
  const mockBackend = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "```json\n" + invalidPlan + "\n```" } }],
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => mockBackend.listen(0, "127.0.0.1", r));
  const port = mockBackend.address().port;
  const app = await loadApp({
    BACKEND: "ollama",
    OLLAMA_URL: `http://127.0.0.1:${port}`,
  });

  const response = await request(app)
    .post("/v1/tasks/plan")
    .send({
      messages: [{ role: "user", content: "plan a task" }],
      model: "llama3.2",
    });

  mockBackend.close();
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
  assert.ok(response.body.error);
});

test("POST /v1/tasks/plan returns 200 with plan and raw on valid output", async () => {
  const { createServer } = await import("node:http");
  const validPlan = {
    type: "task",
    id: "plan-1",
    name: "Deploy app",
    steps: [{ action: "build", payload: { cmd: "npm run build" } }],
    requiresApproval: true,
  };
  const rawContent = "```json\n" + JSON.stringify(validPlan) + "\n```";
  const mockBackend = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: rawContent } }],
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => mockBackend.listen(0, "127.0.0.1", r));
  const port = mockBackend.address().port;
  const app = await loadApp({
    BACKEND: "ollama",
    OLLAMA_URL: `http://127.0.0.1:${port}`,
  });

  const response = await request(app)
    .post("/v1/tasks/plan")
    .send({
      messages: [{ role: "user", content: "deploy this app" }],
      model: "llama3.2",
    });

  mockBackend.close();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.plan, validPlan);
  assert.equal(response.body.raw, rawContent);
  assert.equal(response.body.plan.type, "task");
  assert.equal(response.body.plan.requiresApproval, true);
});

// --- Phase 17: Plugins & Extensions ---
test("GET /api/plugins/actions returns registered action names", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const response = await request(app).get("/api/plugins/actions");

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.actions));
  assert.ok(
    response.body.actions.includes("build") && response.body.actions.includes("deploy") && response.body.actions.includes("copy"),
    "built-in actions should be registered"
  );
});

// --- Phase 14: Workspaces & Auth ---
test("GET /api/workspaces returns items when auth not configured", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const response = await request(app).get("/api/workspaces");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
  assert.ok(response.body.items.length >= 1);
});

test("POST /api/workspaces creates workspace when auth not configured", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const response = await request(app).post("/api/workspaces").send({ name: "Test WS" });
  assert.equal(response.status, 201);
  assert.ok(response.body.id);
  assert.equal(response.body.name, "Test WS");
});

test("GET /api/workspaces/:id/agent-settings returns empty defaults", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const created = await request(app).post("/api/workspaces").send({ name: "Agent settings WS" });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const res = await request(app).get(`/api/workspaces/${id}/agent-settings`);
  assert.equal(res.status, 200);
  assert.equal(res.body.workspaceId, id);
  assert.equal(res.body.defaultSystemPrompt, "");
  assert.deepEqual(res.body.memorySnippets, []);
});

test("PUT /api/workspaces/:id/agent-settings persists for GET", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const created = await request(app).post("/api/workspaces").send({ name: "Agent settings WS 2" });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const put = await request(app)
    .put(`/api/workspaces/${id}/agent-settings`)
    .send({ defaultSystemPrompt: "Use metric units.", memorySnippets: ["Project: Acme"] });
  assert.equal(put.status, 200);
  assert.equal(put.body.defaultSystemPrompt, "Use metric units.");
  assert.deepEqual(put.body.memorySnippets, ["Project: Acme"]);
  const get = await request(app).get(`/api/workspaces/${id}/agent-settings`);
  assert.equal(get.status, 200);
  assert.equal(get.body.defaultSystemPrompt, "Use metric units.");
  assert.deepEqual(get.body.memorySnippets, ["Project: Acme"]);
});

test("PUT /api/workspaces/:id/agent-settings persists deniedTools", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const created = await request(app).post("/api/workspaces").send({ name: "Denied tools WS" });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const put = await request(app)
    .put(`/api/workspaces/${id}/agent-settings`)
    .send({
      agentPolicy: { deniedTools: ["execute_step", "unknown_future_tool"] },
    });
  assert.equal(put.status, 200);
  assert.ok(Array.isArray(put.body.agentPolicy?.deniedTools));
  assert.ok(put.body.agentPolicy.deniedTools.includes("execute_step"));
  const get = await request(app).get(`/api/workspaces/${id}/agent-settings`);
  assert.equal(get.status, 200);
  assert.ok(get.body.agentPolicy.deniedTools.includes("execute_step"));
});

test("POST /api/agent/sessions creates session for workspace", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const created = await request(app).post("/api/workspaces").send({ name: "Session holder" });
  assert.equal(created.status, 201);
  const wid = created.body.id;
  const res = await request(app).post("/api/agent/sessions").send({ workspace: wid, title: "T1" });
  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  assert.equal(res.body.workspace, wid);
  assert.equal(res.body.status, "running");
  const list = await request(app).get("/api/agent/sessions").query({ workspace: wid });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length >= 1);
});

test("POST /api/agent/sessions with planSummary and planDag persists plan", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const created = await request(app).post("/api/workspaces").send({ name: "Session plan WS" });
  assert.equal(created.status, 201);
  const wid = created.body.id;
  const res = await request(app)
    .post("/api/agent/sessions")
    .send({
      workspace: wid,
      title: "With plan",
      planSummary: "Phase A",
      planDag: { version: 1, steps: ["read", "act"] },
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.planSummary, "Phase A");
  assert.deepEqual(res.body.planDag, { version: 1, steps: ["read", "act"] });
  const one = await request(app).get(`/api/agent/sessions/${res.body.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.planSummary, "Phase A");
});

test("POST /api/agent/sessions/:id/plan merges plan fields", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const created = await request(app).post("/api/workspaces").send({ name: "Plan route WS" });
  const wid = created.body.id;
  const sess = await request(app).post("/api/agent/sessions").send({ workspace: wid, title: "P" });
  assert.equal(sess.status, 201);
  const sid = sess.body.id;
  const plan = await request(app)
    .post(`/api/agent/sessions/${sid}/plan`)
    .send({ planSummary: "Updated", planDag: { nodes: [{ id: "n1" }] } });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.planSummary, "Updated");
  assert.deepEqual(plan.body.planDag, { nodes: [{ id: "n1" }] });
  const ev = (plan.body.events || []).filter((e) => e.type === "plan_updated");
  assert.ok(ev.length >= 1);
});

test("PUT agent-settings persists browserAllowedHosts", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const created = await request(app).post("/api/workspaces").send({ name: "Browser policy WS" });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const put = await request(app)
    .put(`/api/workspaces/${id}/agent-settings`)
    .send({
      agentPolicy: { browserAllowedHosts: ["docs.example.com", "api.example.com"] },
    });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.agentPolicy.browserAllowedHosts, ["docs.example.com", "api.example.com"]);
  const get = await request(app).get(`/api/workspaces/${id}/agent-settings`);
  assert.equal(get.status, 200);
  assert.deepEqual(get.body.agentPolicy.browserAllowedHosts, ["docs.example.com", "api.example.com"]);
});

test("GET /api/workspaces/:id/agent-memory/stats returns usage", async () => {
  const app = await loadApp({ BACKEND: "ollama", USER_API_KEYS: "" });
  const created = await request(app).post("/api/workspaces").send({ name: "Mem stats WS" });
  assert.equal(created.status, 201);
  const id = created.body.id;
  await request(app)
    .put(`/api/workspaces/${id}/agent-settings`)
    .send({ defaultSystemPrompt: "Use metric units.", memorySnippets: ["one", "two"] });
  const res = await request(app).get(`/api/workspaces/${id}/agent-memory/stats`);
  assert.equal(res.status, 200);
  assert.equal(res.body.workspaceId, id);
  assert.equal(res.body.memory.snippets, 2);
});

test("marketplace install/list/policy routes work for workspace", async () => {
  const { app, restore } = await loadAppKeepEnv({
    BACKEND: "ollama",
    USER_API_KEYS: "",
    MARKETPLACE_TRUSTED_KEY_IDS: "trusted-key",
  });
  try {
    const created = await request(app).post("/api/workspaces").send({ name: "Market WS" });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const unsigned = { id: "pack.demo", version: "1.0.0", tools: [{ name: "build" }] };
    const stable = stableStringify(unsigned);
    const digest = createHash("sha256").update(stable, "utf8").digest("hex");
    const manifest = {
      ...unsigned,
      signature: { algorithm: "sha256", keyId: "trusted-key", value: digest },
    };
    const install = await request(app)
      .post(`/api/workspaces/${id}/marketplace/install`)
      .send({ manifest });
    assert.equal(install.status, 201);
    const list = await request(app).get(`/api/workspaces/${id}/marketplace/packs`);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.packs));
    const policyPut = await request(app)
      .put(`/api/workspaces/${id}/marketplace/policy`)
      .send({ blockedToolNames: ["deploy"] });
    assert.equal(policyPut.status, 200);
    const policyGet = await request(app).get(`/api/workspaces/${id}/marketplace/policy`);
    assert.equal(policyGet.status, 200);
    assert.ok(policyGet.body.policy.blockedToolNames.includes("deploy"));
  } finally {
    restore();
  }
});

// --- Phase 10: Storage CRUD ---
test("POST /api/context requires title", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/context").send({ content: "x" });
  assert.equal(response.status, 400);
  assert.ok(response.body.error);
});

test("POST /api/context creates item with title", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/context").send({ title: "Test Doc", content: "Hello" });
  assert.equal(response.status, 201);
  assert.equal(response.body.title, "Test Doc");
  assert.ok(response.body.id);
});

test("GET /api/context/:id returns 404 for unknown id", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/context/unknown-id-xyz");
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("POST /api/recipes requires name", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/recipes").send({ steps: [] });
  assert.equal(response.status, 400);
  assert.ok(response.body.error);
});

test("GET /api/usage/summary returns structure", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/usage/summary?days=7");
  assert.equal(response.status, 200);
  assert.ok(typeof response.body.totalRequests === "number");
  assert.ok(typeof response.body.byModel === "object");
  assert.ok(typeof response.body.byDay === "object");
});

// --- Phase 16: Schedules API ---
test("GET /api/schedules returns list", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/schedules");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
});

test("POST /api/schedules returns 400 when recipeId missing", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/schedules").send({ cron: "0 9 * * 1-5" });
  assert.equal(response.status, 400);
  assert.ok(response.body.code);
});

test("POST /api/schedules returns 404 when recipe not found", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/schedules")
    .send({ recipeId: "nonexistent-recipe-id", cron: "0 9 * * 1-5" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("POST /api/schedules/run-now/:recipeId requires API_KEY when set", async () => {
  const app = await loadApp({ BACKEND: "ollama", API_KEY: "secret" });
  const response = await request(app).post("/api/schedules/run-now/some-recipe");
  assert.equal(response.status, 401);
});

test("GET /api/cron auth: 401 when secret missing, 200 when provided", async () => {
  const original = { ...process.env };
  Object.assign(process.env, { BACKEND: "ollama", CRON_SECRET: "cron-secret", VERCEL: "1" });
  try {
    const moduleUrl = new URL(`../server.js?test=${Date.now()}`, import.meta.url);
    const { default: app } = await import(moduleUrl.href);
    const res401 = await request(app).get("/api/cron");
    assert.equal(res401.status, 401);
    assert.equal(res401.body.code, "UNAUTHORIZED");
    const res200 = await request(app)
      .get("/api/cron")
      .set("Authorization", "Bearer cron-secret");
    assert.equal(res200.status, 200);
    assert.ok(res200.body.ok === true);
  } finally {
    process.env = original;
  }
});

// --- Phase 24: Backup & Restore ---
test("GET /api/backup returns items when auth not configured", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/backup");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
});

test("POST /api/backup creates backup when auth not configured", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/backup");
  assert.equal(response.status, 201);
  assert.ok(response.body.id);
  assert.ok(response.body.filename);
  assert.ok(response.body.createdAt);
});

test("POST /api/backup/restore/:id returns 404 when backup not found", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/backup/restore/nonexistent-2020-01-01_00-00-00");
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("POST /api/backup returns 403 when BACKUP_ADMIN_KEY set and no key provided", async () => {
  const original = { ...process.env };
  Object.assign(process.env, { BACKEND: "ollama", BACKUP_ADMIN_KEY: "backup-secret", VERCEL: "1" });
  try {
    const moduleUrl = new URL(`../server.js?test=${Date.now()}`, import.meta.url);
    const { default: app } = await import(moduleUrl.href);
    const response = await request(app).post("/api/backup");
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "FORBIDDEN");
  } finally {
    process.env = original;
  }
});

test("GET /api/backup/cron requires secret when BACKUP_ADMIN_KEY set", async () => {
  const original = { ...process.env };
  Object.assign(process.env, { BACKEND: "ollama", BACKUP_ADMIN_KEY: "backup-cron-key", VERCEL: "1" });
  try {
    const moduleUrl = new URL(`../server.js?test=${Date.now()}`, import.meta.url);
    const { default: app } = await import(moduleUrl.href);
    const res401 = await request(app).get("/api/backup/cron");
    assert.equal(res401.status, 401);
    const res200 = await request(app).get("/api/backup/cron?secret=backup-cron-key");
    assert.equal(res200.status, 200);
    assert.ok(res200.body.ok === true);
  } finally {
    process.env = original;
  }
});

// --- Phase 9: Execute step ---
test("POST /api/execute-step returns 503 when ALLOW_RECIPE_STEP_EXECUTION not set", async () => {
  const app = await loadApp({ BACKEND: "ollama", API_KEY: "key" });
  const response = await request(app)
    .post("/api/execute-step")
    .set("Authorization", "Bearer key")
    .send({ step: { action: "copy", payload: {} }, allowExecution: true });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "EXECUTION_DISABLED");
});

test("POST /api/execute-step returns 403 when allowExecution false", async () => {
  const app = await loadApp({
    BACKEND: "ollama",
    API_KEY: "key",
    ALLOW_RECIPE_STEP_EXECUTION: "1",
  });
  const response = await request(app)
    .post("/api/execute-step")
    .set("Authorization", "Bearer key")
    .send({ step: { action: "copy", payload: {} }, allowExecution: false });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "EXECUTION_NOT_ALLOWED");
});

// --- Phase 6: Automations validate ---
test("POST /api/automations/validate returns valid for good recipe", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/automations/validate")
    .send({ name: "Test", steps: [{ action: "build", payload: {} }] });
  assert.equal(response.status, 200);
  assert.equal(response.body.valid, true);
});

// --- OCR endpoint (now fully implemented via Tesseract.js) ---
test("POST /api/ocr returns 400 when no file is attached", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/ocr");
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_BODY");
});

test("POST /api/ocr returns 415 for unsupported MIME type", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/ocr")
    .attach("file", Buffer.from("not an image"), {
      filename: "test.txt",
      contentType: "text/plain",
    });
  assert.equal(response.status, 415);
  assert.equal(response.body.code, "UNSUPPORTED_FORMAT");
});

test("POST /api/ocr returns 400 when file exceeds size limit", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  // 21 MB buffer exceeds the 20 MB limit
  const oversized = Buffer.alloc(21 * 1024 * 1024, 0);
  const response = await request(app)
    .post("/api/ocr")
    .attach("file", oversized, {
      filename: "huge.png",
      contentType: "image/png",
    });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "FILE_TOO_LARGE");
});

test("POST /api/ocr accepts a valid PNG upload", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  // Minimal 1x1 white PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
    "Nl7BcQAAAABJRU5ErkJggg==",
    "base64"
  );
  const response = await request(app)
    .post("/api/ocr")
    .attach("file", png, { filename: "test.png", contentType: "image/png" });
  // Tesseract.js may or may not be installed in test env.
  // 200 means OCR succeeded; 500 with OCR_FAILED means Tesseract not available.
  if (response.status === 200) {
    assert.equal(typeof response.body.text, "string");
    assert.equal(typeof response.body.confidence, "number");
    assert.ok(response.body.confidence >= 0 && response.body.confidence <= 1);
  } else {
    assert.equal(response.status, 500);
    assert.equal(response.body.code, "OCR_FAILED");
  }
});

// --- Phase 28: Embeddings API ---
test("POST /api/embeddings returns 503 when OPENAI_API_KEY not set", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", OPENAI_API_KEY: "" });
  try {
    const response = await request(app)
      .post("/api/embeddings")
      .set("Content-Type", "application/json")
      .send({ text: "hello" });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "EMBEDDINGS_UNAVAILABLE");
    assert.ok(response.body.hint);
    assert.match(response.body.hint, /OPENAI_API_KEY/i);
  } finally {
    restore();
  }
});

test("POST /api/embeddings returns 400 when body missing", async () => {
  // loadApp restores env before requests run; keepEnv so embeddingsAvailable() still sees OPENAI_API_KEY at request time.
  const { app, restore } = await loadAppKeepEnv({
    BACKEND: "ollama",
    API_KEY: "",
    OPENAI_API_KEY: "sk-test-body-validation",
  });
  try {
    const resEmpty = await request(app).post("/api/embeddings").set("Content-Type", "application/json").send({});
    assert.equal(resEmpty.status, 400);
    assert.equal(resEmpty.body.code, "INVALID_BODY");
    assert.ok(resEmpty.body.hint);

    const resNoText = await request(app)
      .post("/api/embeddings")
      .set("Content-Type", "application/json")
      .send({ texts: [] });
    assert.equal(resNoText.status, 400);
  } finally {
    restore();
  }
});

test("POST /api/embeddings returns 200 with embedding when OPENAI_API_KEY set", async () => {
  const { createServer } = await import("node:http");
  const mockEmbedding = new Array(1536).fill(0).map((_, i) => 0.001 * i);
  const mockBackend = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/embeddings") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ object: "embedding", index: 0, embedding: mockEmbedding }],
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => mockBackend.listen(0, "127.0.0.1", r));
  const port = mockBackend.address().port;
  const { app, restore } = await loadAppKeepEnv({
    BACKEND: "ollama",
    OPENAI_API_KEY: "sk-test-key",
    OPENAI_EMBEDDINGS_BASE_URL: `http://127.0.0.1:${port}`,
  });
  try {
    const response = await request(app)
      .post("/api/embeddings")
      .set("Content-Type", "application/json")
      .send({ text: "hello world" });

    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.embedding));
    assert.equal(response.body.embedding.length, 1536);
    assert.equal(response.body.embedding[0], 0);
  } finally {
    mockBackend.close();
    restore();
  }
});

// --- Phase 22: Webhooks ---
test("GET /api/webhooks returns items when auth not configured", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/webhooks?workspace=default");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
});

test("POST /api/webhooks returns 400 when url missing", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/webhooks")
    .set("Content-Type", "application/json")
    .send({ events: ["message_sent"], workspace: "default" });
  assert.equal(response.status, 400);
  assert.ok(response.body.error);
});

test("POST /api/webhooks returns 400 when events empty", async () => {
  const app = await loadApp({ BACKEND: "ollama", ALLOW_WEBHOOK_LOCALHOST: "1" });
  const response = await request(app)
    .post("/api/webhooks")
    .set("Content-Type", "application/json")
    .send({ url: "https://example.com/webhook", events: [], workspace: "default" });
  assert.equal(response.status, 400);
});

test("POST /api/webhooks creates webhook when valid (ALLOW_WEBHOOK_LOCALHOST for https)", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/webhooks")
    .set("Content-Type", "application/json")
    .send({ url: "https://example.com/hook", events: ["message_sent", "plan_created"], workspace: "default" });
  assert.equal(response.status, 201);
  assert.ok(response.body.id);
  assert.equal(response.body.url, "https://example.com/hook");
  assert.deepEqual(response.body.events.sort(), ["message_sent", "plan_created"]);
  assert.ok(response.body.createdAt);
});

// --- Phase 27: Notification Center ---
test("GET /api/notifications returns items", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/notifications?workspace=default");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
});

test("PATCH /api/notifications/mark-all-read returns ok", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .patch("/api/notifications/mark-all-read")
    .query({ workspace: "default" });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
});

// --- Phase 33: Real-Time Sync & Presence ---
test("GET /api/ws-token returns token and url", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/ws-token?workspace=default");
  assert.equal(response.status, 200);
  assert.ok(typeof response.body.token === "string");
  assert.ok(typeof response.body.url === "string");
  assert.match(response.body.url, /\/ws\?token=/);
  assert.match(response.body.url, /workspace=default/);
});

test("GET /api/workspaces/:id/presence returns online when allowed", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/workspaces/default/presence");
  assert.ok(response.status === 200 || response.status === 403);
  if (response.status === 200) {
    assert.ok(Array.isArray(response.body.online));
  }
});

// --- Phase 23: API Versioning & Public API Docs ---

test("GET /api/v1/context returns same as /api/context (versioned route)", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const legacy = await request(app).get("/api/context");
  const v1 = await request(app).get("/api/v1/context");
  assert.equal(legacy.status, 200);
  assert.equal(v1.status, 200);
  assert.deepEqual(legacy.body, v1.body);
});

test("Legacy /api/context returns X-API-Deprecated header", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/context");
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-api-deprecated"], "use /api/v1/");
});

// --- Phase 24: Backup & Restore ---
test("GET /api/backup returns items when no auth (local dev)", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/backup");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
});

test("POST /api/backup creates backup when no auth", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/backup");
  assert.equal(response.status, 201);
  assert.ok(response.body.id);
  assert.ok(response.body.filename);
  assert.ok(response.body.createdAt);
  assert.match(response.body.id, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
});

test("POST /api/backup/restore/:id returns 404 when backup not found", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/backup/restore/nonexistent-2020-01-01_00-00-00");
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("Backup API returns 403 when BACKUP_ADMIN_KEY set and key not provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", BACKUP_ADMIN_KEY: "admin-secret" });
  try {
    const response = await request(app).get("/api/backup");
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "FORBIDDEN");
  } finally {
    restore();
  }
});

test("Backup API returns 200 when BACKUP_ADMIN_KEY provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", BACKUP_ADMIN_KEY: "admin-secret" });
  try {
    const response = await request(app)
      .get("/api/backup")
      .set("Authorization", "Bearer admin-secret");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.items));
  } finally {
    restore();
  }
});

test("GET /api/backup/cron returns 401 when secret required and not provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", BACKUP_ADMIN_KEY: "cron-secret" });
  try {
    const response = await request(app).get("/api/backup/cron");
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "UNAUTHORIZED");
  } finally {
    restore();
  }
});

test("GET /api/backup/cron returns 200 when secret provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", BACKUP_ADMIN_KEY: "cron-secret" });
  try {
    const response = await request(app).get("/api/backup/cron?secret=cron-secret");
    assert.equal(response.status, 200);
    assert.ok(response.body.ok === true);
  } finally {
    restore();
  }
});

test("Versioned /api/v1/context does not return X-API-Deprecated header", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/v1/context");
  assert.equal(response.status, 200);
  assert.ok(!response.headers["x-api-deprecated"] || response.headers["x-api-deprecated"] === undefined);
});

test("GET /api/docs/openapi.json returns OpenAPI spec", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/docs/openapi.json");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(response.body.openapi, "3.0.3");
  assert.ok(response.body.info?.title === "Siskel Bot API");
  assert.ok(response.body.paths && response.body.paths["/api/v1/context"]);
});

test("GET /api/docs returns Swagger UI HTML", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/docs");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"] || "", /text\/html/);
  assert.match(response.text, /swagger-ui/);
  assert.match(response.text, /openapi\.json/);
});

test("GET /docs redirects to /api/docs", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/docs");
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "/api/docs");
});

// --- Phase 32: Evaluation Harness ---
test("GET /eval serves eval UI page", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/eval");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"] || "", /text\/html/);
  assert.match(response.text, /Eval Harness|eval/);
});

test("GET /api/eval/sets returns 401 when eval auth required and no key", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app).get("/api/eval/sets");
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "AUTH_REQUIRED");
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns sets when ADMIN_API_KEY provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app)
      .get("/api/eval/sets")
      .set("Authorization", "Bearer admin-eval-key");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.sets) || Array.isArray(response.body.items));
    const sets = response.body.sets || response.body.items || [];
    assert.ok(sets.some((s) => s.id === "example" && s.name), "example eval set found");
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 400 when no evalSetId or evalSet", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({});
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_BODY");
});

test("POST /api/eval/run returns 404 when evalSetId not found", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({ evalSetId: "nonexistent-eval-set-xyz" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("checkCriteria (lib/eval-runner)", async () => {
  const { checkCriteria } = await import("../lib/eval-runner.js");
  assert.strictEqual(checkCriteria({ expectedContains: "hello" }, "hello world").pass, true);
  assert.strictEqual(checkCriteria({ expectedContains: "hello" }, "hi there").pass, false);
  assert.strictEqual(checkCriteria({ expectedPattern: "\\d+" }, "abc123").pass, true);
  assert.strictEqual(checkCriteria({ expectedJson: ["type", "name"] }, '{"type":"task","name":"x","steps":[]}', { type: "task", name: "x", steps: [] }).pass, true);
  assert.strictEqual(
    checkCriteria({ expectedMinAgentActivityToolCalls: 1 }, "x", null, null).pass,
    false
  );
});

test("runEvalSet returns results structure", async () => {
  const { runEvalSet } = await import("../lib/eval-runner.js");
  const res = await runEvalSet(
    { id: "t", name: "t", cases: [{ id: "c1", prompt: "hi", expectedContains: "hello" }] },
    { baseUrl: "http://localhost:99999", apiKey: null }
  );
  assert.ok(Array.isArray(res.results));
  assert.ok(res.results.length === 1);
  assert.ok(typeof res.passed === "number");
  assert.ok(typeof res.total === "number");
  assert.ok(typeof res.skipped === "number");
  assert.ok(typeof res.durationMs === "number");
});

// --- Phase 32: Evaluation Harness ---
test("GET /api/eval/sets returns 401 when ADMIN_API_KEY set and key not provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app).get("/api/eval/sets");
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "AUTH_REQUIRED");
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns sets when ADMIN_API_KEY provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app)
      .get("/api/eval/sets")
      .set("Authorization", "Bearer admin-eval-key");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.sets));
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns sets when API_KEY provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", API_KEY: "deploy-key" });
  try {
    const response = await request(app)
      .get("/api/eval/sets")
      .set("x-api-key", "deploy-key");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.sets));
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 400 when evalSetId and evalSet missing", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", API_KEY: "deploy-key" });
  try {
    const response = await request(app)
      .post("/api/eval/run")
      .set("x-api-key", "deploy-key")
      .send({});
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "INVALID_BODY");
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 404 when evalSetId not found", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", API_KEY: "deploy-key" });
  try {
    const response = await request(app)
      .post("/api/eval/run")
      .set("x-api-key", "deploy-key")
      .send({ evalSetId: "nonexistent-set-xyz" });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, "NOT_FOUND");
  } finally {
    restore();
  }
});

test("POST /api/eval/run with inline evalSet returns results structure", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", API_KEY: "deploy-key" });
  try {
    const response = await request(app)
      .post("/api/eval/run")
      .set("x-api-key", "deploy-key")
      .send({
        evalSet: {
          id: "inline-test",
          name: "Inline Test",
          cases: [{ id: "c1", prompt: "Say hi", expectedContains: "hi" }],
        },
      });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.results));
    assert.ok(typeof response.body.passed === "number");
    assert.ok(typeof response.body.total === "number");
    assert.ok(typeof response.body.durationMs === "number");
  } finally {
    restore();
  }
});

test("GET /eval serves eval UI", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/eval");
  assert.equal(response.status, 200);
  assert.match(response.text, /Eval Harness|eval/i);
});

// --- Phase 32: Evaluation Harness ---
test("GET /eval serves eval page", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/eval");
  assert.equal(response.status, 200);
  assert.match(response.text, /Eval|eval/i);
});

test("GET /api/eval/sets returns 401 when ADMIN_API_KEY set and key not provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app).get("/api/eval/sets");
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "AUTH_REQUIRED");
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns sets when ADMIN_API_KEY provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app)
      .get("/api/eval/sets")
      .set("Authorization", "Bearer admin-eval-key");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.sets) || response.body.sets !== undefined);
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns sets when no auth (local dev)", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/eval/sets");
  assert.equal(response.status, 200);
  assert.ok(response.body.sets !== undefined);
});

test("POST /api/eval/run returns 400 when evalSetId and evalSet missing", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({});
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_BODY");
});

test("POST /api/eval/run returns 404 when evalSetId not found", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({ evalSetId: "nonexistent-eval-set-id-xyz" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("POST /api/eval/run accepts inline evalSet and returns results", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({
      evalSet: {
        id: "inline",
        name: "Inline Eval",
        cases: [
          { id: "c1", prompt: "Reply with exactly: PASS", expectedContains: "PASS", target: "chat" },
        ],
      },
    });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.results));
  assert.equal(response.body.total, 1);
  assert.ok(typeof response.body.passed === "number");
  assert.ok(typeof response.body.durationMs === "number");
});

// --- Phase 32: Evaluation Harness ---
test("GET /eval serves eval UI", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/eval");
  assert.equal(response.status, 200);
  assert.match(response.text, /Eval|eval/i);
});

test("GET /api/eval/sets returns 401 when ADMIN_API_KEY set and key not provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app).get("/api/eval/sets");
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "AUTH_REQUIRED");
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns sets when key provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app)
      .get("/api/eval/sets")
      .set("Authorization", "Bearer admin-key");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.sets) || response.body.sets);
    if (response.body.sets?.length) {
      assert.ok(response.body.sets.some((s) => s.id && s.name));
    }
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 400 when body invalid", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app)
      .post("/api/eval/run")
      .set("Authorization", "Bearer admin-key")
      .send({});
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "INVALID_BODY");
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 404 when evalSetId not found", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app)
      .post("/api/eval/run")
      .set("Authorization", "Bearer admin-key")
      .send({ evalSetId: "nonexistent-eval-set-xyz" });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, "NOT_FOUND");
  } finally {
    restore();
  }
});

test("POST /api/eval/run accepts evalSet JSON and returns results", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app)
      .post("/api/eval/run")
      .set("Authorization", "Bearer admin-key")
      .send({
        evalSet: {
          id: "test-inline",
          name: "Inline Test",
          cases: [{ id: "c1", prompt: "Reply with only: PASS", expectedContains: "PASS", target: "chat" }],
        },
        model: "llama3.2",
      });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.results));
    assert.equal(typeof response.body.passed, "number");
    assert.equal(typeof response.body.total, "number");
    assert.equal(typeof response.body.skipped, "number");
    assert.equal(typeof response.body.durationMs, "number");
    assert.ok(response.body.total >= 1);
  } finally {
    restore();
  }
});

// --- Phase 32: Evaluation Harness ---
test("GET /eval serves eval page", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/eval");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"] || "", /text\/html/);
  assert.match(response.text, /eval|Eval/i);
});

test("GET /api/eval/sets returns 401 when ADMIN_API_KEY set and key not provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app).get("/api/eval/sets");
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "AUTH_REQUIRED");
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns sets when key provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app)
      .get("/api/eval/sets")
      .set("Authorization", "Bearer admin-key");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.sets));
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 400 when body missing evalSetId and evalSet", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app)
      .post("/api/eval/run")
      .set("Authorization", "Bearer admin-key")
      .send({});
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "INVALID_BODY");
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 404 when evalSetId not found", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app)
      .post("/api/eval/run")
      .set("Authorization", "Bearer admin-key")
      .send({ evalSetId: "nonexistent-set-xyz" });
    assert.equal(response.status, 404);
    assert.equal(response.body.code, "NOT_FOUND");
  } finally {
    restore();
  }
});

test("POST /api/eval/run accepts evalSet JSON in body", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-key" });
  try {
    const response = await request(app)
      .post("/api/eval/run")
      .set("Authorization", "Bearer admin-key")
      .send({
        evalSet: {
          id: "inline",
          name: "Inline Test",
          cases: [{ id: "c1", prompt: "Say OK", target: "chat", expectedContains: "OK" }],
        },
      });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.results));
    assert.equal(response.body.total, 1);
    assert.ok(typeof response.body.passed === "number");
    assert.ok(typeof response.body.skipped === "number");
    assert.ok(typeof response.body.durationMs === "number");
  } finally {
    restore();
  }
});

// --- Phase 32: Evaluation Harness ---
test("GET /eval serves eval page", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/eval");
  assert.equal(response.status, 200);
  assert.match(response.text, /Eval|eval/);
});

test("GET /api/eval/sets returns sets when no auth (local dev)", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/eval/sets");
  assert.equal(response.status, 200);
  assert.ok(response.body.sets !== undefined);
  assert.ok(Array.isArray(response.body.sets));
});

test("GET /api/eval/sets returns 401 when ADMIN_API_KEY set and not provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app).get("/api/eval/sets");
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "AUTH_REQUIRED");
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns 200 when ADMIN_API_KEY provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app)
      .get("/api/eval/sets")
      .set("Authorization", "Bearer admin-eval-key");
    assert.equal(response.status, 200);
    assert.ok(response.body.sets !== undefined);
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 400 when body missing evalSetId and evalSet", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({});
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_BODY");
});

test("POST /api/eval/run returns 404 when evalSetId not found", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({ evalSetId: "nonexistent-set-id-xyz" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("POST /api/eval/run accepts inline evalSet", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({
      evalSet: {
        id: "inline-test",
        name: "Inline",
        cases: [{ id: "c1", prompt: "Say hi", target: "chat", expectedContains: "hi" }],
      },
    });
  assert.equal(response.status, 200);
  assert.ok(typeof response.body.results === "object");
  assert.ok(Array.isArray(response.body.results));
  assert.equal(response.body.total, 1);
  assert.ok(typeof response.body.passed === "number");
  assert.ok(typeof response.body.durationMs === "number");
});

// --- Phase 32: Evaluation Harness ---
test("GET /eval serves eval page", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/eval");
  assert.equal(response.status, 200);
  assert.match(response.text, /Eval|eval/i);
});

test("GET /api/eval/sets returns 200 when no auth (local dev)", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/eval/sets");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.sets));
});

test("GET /api/eval/sets returns sets from data/eval-sets", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/eval/sets");
  assert.equal(response.status, 200);
  const sets = response.body.sets;
  const example = sets.find((s) => s.id === "example");
  assert.ok(example, "example eval set should be loaded from data/eval-sets/example.json");
  assert.equal(example.name, "Example Eval Set");
});

test("GET /api/eval/staging-traces returns traces including shipped example", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/eval/staging-traces");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.traces));
  assert.ok(
    response.body.traces.some((t) => t.name === "example-staging.json"),
    "example-staging.json should be listed from data/eval-sets/traces",
  );
});

test("GET /api/eval/sets returns 401 when ADMIN_API_KEY set and no key", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app).get("/api/eval/sets");
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "AUTH_REQUIRED");
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns 200 when ADMIN_API_KEY provided", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app)
      .get("/api/eval/sets")
      .set("Authorization", "Bearer admin-eval-key");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.sets));
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 400 when no evalSetId or evalSet", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({});
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_BODY");
});

test("POST /api/eval/run returns 404 when evalSetId not found", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({ evalSetId: "nonexistent-eval-set-xyz" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("POST /api/eval/run accepts evalSet JSON and returns results", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({
      evalSet: {
        id: "inline",
        name: "Inline Test",
        cases: [
          { id: "c1", prompt: "Reply with the word: pass", target: "chat", expectedContains: "pass" },
        ],
      },
    });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.results));
  assert.equal(response.body.total, 1);
  assert.ok(typeof response.body.passed === "number");
  assert.ok(typeof response.body.skipped === "number");
  assert.ok(typeof response.body.durationMs === "number");
});

test("POST /api/eval/run with evalSetId loads from file", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({ evalSetId: "example" });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.results));
  assert.ok(response.body.total >= 1);
  assert.ok(typeof response.body.skipped === "number");
  assert.ok(response.body.skipped >= 2, "example.json includes skippable template cases");
});

// --- Phase 32: Evaluation Harness ---
test("GET /eval serves eval page", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/eval");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"] || "", /text\/html/);
  assert.match(response.text, /eval|Eval|Siskel Bot/);
});

test("GET /api/eval/sets returns sets when no auth (local dev)", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/eval/sets");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.sets) || Array.isArray(response.body.items));
  const sets = response.body.sets || response.body.items || [];
  assert.ok(sets.some((s) => s.id === "example"), "example set from data/eval-sets/example.json");
});

test("GET /api/eval/sets requires auth when ADMIN_API_KEY or API_KEY set", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ADMIN_API_KEY: "admin-eval-key" });
  try {
    const response = await request(app).get("/api/eval/sets");
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "AUTH_REQUIRED");
  } finally {
    restore();
  }
});

test("GET /api/eval/sets returns 200 with API_KEY", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", API_KEY: "eval-api-key" });
  try {
    const response = await request(app)
      .get("/api/eval/sets")
      .set("Authorization", "Bearer eval-api-key");
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.sets) || Array.isArray(response.body.items));
  } finally {
    restore();
  }
});

test("POST /api/eval/run returns 400 when no evalSetId or evalSet", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).post("/api/eval/run").send({});
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_BODY");
});

test("POST /api/eval/run returns 404 when evalSetId not found", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app)
    .post("/api/eval/run")
    .send({ evalSetId: "nonexistent-eval-set-xyz" });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("POST /api/eval/run accepts inline evalSet", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const evalSet = {
    id: "inline",
    name: "Inline",
    cases: [
      { id: "c1", prompt: "Reply with exactly: PASS", target: "chat", expectedContains: "PASS" },
    ],
  };
  const response = await request(app).post("/api/eval/run").send({ evalSet });
  if (response.status === 502) {
    assert.ok(response.body.code === "BACKEND_UNREACHABLE" || !response.body.code);
    return;
  }
  assert.equal(response.status, 200);
  assert.ok(typeof response.body.passed === "number");
  assert.ok(typeof response.body.total === "number");
  assert.ok(Array.isArray(response.body.results));
  assert.ok(typeof response.body.durationMs === "number");
});

test("GET /config sets prometheusEnabled when ENABLE_METRICS=1", async () => {
  const { app, restore } = await loadAppKeepEnv({ BACKEND: "ollama", ENABLE_METRICS: "1" });
  try {
    const response = await request(app).get("/config");
    assert.equal(response.status, 200);
    assert.equal(response.body.prometheusEnabled, true);
    assert.equal(response.body.prometheusPath, "/metrics");
  } finally {
    restore();
  }
});

test("GET /api/knowledge/status returns documentCount", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/knowledge/status").query({ workspace: "default" });
  assert.equal(response.status, 200);
  assert.equal(response.body.workspace, "default");
  assert.ok(typeof response.body.documentCount === "number");
});

test("GET /api/agent/trajectories returns items", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const response = await request(app).get("/api/agent/trajectories").query({ workspace: "default" });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.items));
  assert.ok(typeof response.body.total === "number");
});
