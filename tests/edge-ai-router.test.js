import test from "node:test";
import assert from "node:assert/strict";

// ─── Complexity analysis (server-side) ──────────────────────────────────────

test("analyzeComplexity returns 1 for empty input", async () => {
  const { analyzeComplexity } = await import("../lib/edge-ai-router.js");
  assert.equal(analyzeComplexity([]), 1);
  assert.equal(analyzeComplexity(null), 1);
});

test("analyzeComplexity is low for a short single-turn prompt", async () => {
  const { analyzeComplexity } = await import("../lib/edge-ai-router.js");
  const score = analyzeComplexity([{ role: "user", content: "hi there" }], {});
  assert.ok(score < 0.2, `expected low score, got ${score}`);
});

test("analyzeComplexity penalises long total prompts", async () => {
  const { analyzeComplexity } = await import("../lib/edge-ai-router.js");
  const long = "x".repeat(2500);
  const score = analyzeComplexity([{ role: "user", content: long }], {});
  assert.ok(score > 0.5, `expected high score for long prompt, got ${score}`);
});

test("analyzeComplexity penalises tool / function calls", async () => {
  const { analyzeComplexity } = await import("../lib/edge-ai-router.js");
  const score = analyzeComplexity(
    [{ role: "user", content: "do something" }],
    { tools: [{ type: "function", function: { name: "foo" } }] },
  );
  assert.ok(score >= 0.3, `expected tool penalty, got ${score}`);
});

test("analyzeComplexity penalises code fences", async () => {
  const { analyzeComplexity } = await import("../lib/edge-ai-router.js");
  const withCode = analyzeComplexity(
    [{ role: "user", content: "explain this:\n```js\nconsole.log(1)\n```" }],
    {},
  );
  const withoutCode = analyzeComplexity(
    [{ role: "user", content: "explain this code" }],
    {},
  );
  assert.ok(withCode > withoutCode);
});

test("analyzeComplexity penalises SQL prompts", async () => {
  const { analyzeComplexity } = await import("../lib/edge-ai-router.js");
  const score = analyzeComplexity(
    [{ role: "user", content: "SELECT id FROM users" }],
    {},
  );
  assert.ok(score >= 0.1);
});

test("analyzeComplexity penalises multi-turn conversations", async () => {
  const { analyzeComplexity } = await import("../lib/edge-ai-router.js");
  const turns = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `turn ${i}`,
  }));
  const score = analyzeComplexity(turns, {});
  assert.ok(score >= 0.2);
});

test("analyzeComplexity caps at 1", async () => {
  const { analyzeComplexity } = await import("../lib/edge-ai-router.js");
  const score = analyzeComplexity(
    [{ role: "user", content: "x".repeat(5000), tool_calls: [{ id: "1" }] }],
    { tools: [{}], functions: [{}], tool_choice: "auto", response_format: { type: "json_object" } },
  );
  assert.ok(score <= 1);
});

// ─── Routing decisions ──────────────────────────────────────────────────────

async function withEnv(overrides, fn) {
  const orig = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    process.env = orig;
  }
}

test("shouldUseEdgeAI returns false when provider is none", async () => {
  await withEnv({ EDGE_AI_PROVIDER: "none", EDGE_AI_URL: "https://x" }, async () => {
    const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
    const r = shouldUseEdgeAI({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.route, false);
    assert.equal(r.reason, "provider_none");
  });
});

test("shouldUseEdgeAI returns false when EDGE_AI_ENABLED=0", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "cloudflare", EDGE_AI_URL: "https://x", EDGE_AI_ENABLED: "0" },
    async () => {
      const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
      const r = shouldUseEdgeAI({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(r.route, false);
      assert.equal(r.reason, "disabled");
    },
  );
});

test("shouldUseEdgeAI returns false when no edge URL is configured", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "cloudflare", EDGE_AI_URL: "", EDGE_AI_ENABLED: "1" },
    async () => {
      const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
      const r = shouldUseEdgeAI({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(r.route, false);
      assert.equal(r.reason, "no_edge_url");
    },
  );
});

test("shouldUseEdgeAI routes simple chat to edge", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "cloudflare", EDGE_AI_URL: "https://ai.example.com", EDGE_AI_ENABLED: "1" },
    async () => {
      const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
      const r = shouldUseEdgeAI({ messages: [{ role: "user", content: "hi" }] });
      assert.equal(r.route, true);
      assert.equal(r.reason, "ok");
      assert.equal(r.provider, "cloudflare");
      assert.ok(typeof r.score === "number" && r.score >= 0);
    },
  );
});

test("shouldUseEdgeAI sends complex chat to origin", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "cloudflare", EDGE_AI_URL: "https://ai.example.com", EDGE_AI_ENABLED: "1" },
    async () => {
      const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
      const r = shouldUseEdgeAI({
        messages: [{ role: "user", content: "x".repeat(3000) }],
        tools: [{ type: "function", function: { name: "foo" } }],
      });
      assert.equal(r.route, false);
      assert.equal(r.reason, "too_complex");
      assert.ok(r.score > 0.7);
    },
  );
});

test("shouldUseEdgeAI honours forced complexity=edge", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "cloudflare", EDGE_AI_URL: "https://ai.example.com", EDGE_AI_ENABLED: "1" },
    async () => {
      const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
      const r = shouldUseEdgeAI({
        messages: [{ role: "user", content: "x".repeat(5000) }],
        complexity: "edge",
      });
      assert.equal(r.route, true);
      assert.equal(r.reason, "forced_edge");
    },
  );
});

test("shouldUseEdgeAI honours forced complexity=origin", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "cloudflare", EDGE_AI_URL: "https://ai.example.com", EDGE_AI_ENABLED: "1" },
    async () => {
      const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
      const r = shouldUseEdgeAI({
        messages: [{ role: "user", content: "hi" }],
        complexity: "origin",
      });
      assert.equal(r.route, false);
      assert.equal(r.reason, "forced_origin");
    },
  );
});

test("shouldUseEdgeAI rejects streaming chat", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "cloudflare", EDGE_AI_URL: "https://ai.example.com", EDGE_AI_ENABLED: "1" },
    async () => {
      const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
      const r = shouldUseEdgeAI({
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      assert.equal(r.route, false);
      assert.equal(r.reason, "streaming");
    },
  );
});

test("shouldUseEdgeAI routes embeddings when input is small", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "cloudflare", EDGE_AI_URL: "https://ai.example.com", EDGE_AI_ENABLED: "1" },
    async () => {
      const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
      const r = shouldUseEdgeAI({ input: "search this" }, { kind: "embedding" });
      assert.equal(r.route, true);
      assert.equal(r.reason, "ok");
    },
  );
});

test("shouldUseEdgeAI rejects giant embedding input", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "cloudflare", EDGE_AI_URL: "https://ai.example.com", EDGE_AI_ENABLED: "1" },
    async () => {
      const { shouldUseEdgeAI } = await import("../lib/edge-ai-router.js");
      const r = shouldUseEdgeAI({ input: "x".repeat(1_000_000) }, { kind: "embedding" });
      assert.equal(r.route, false);
      assert.equal(r.reason, "input_too_large");
    },
  );
});

// ─── Provider detection ────────────────────────────────────────────────────

test("getEdgeAIProvider returns explicit value when set", async () => {
  await withEnv({ EDGE_AI_PROVIDER: "fastly", EDGE_AI_URL: "" }, async () => {
    const { getEdgeAIProvider } = await import("../lib/edge-ai-router.js");
    assert.equal(getEdgeAIProvider(), "fastly");
  });
});

test("getEdgeAIProvider auto-detects cloudflare from URL host", async () => {
  await withEnv(
    {
      EDGE_AI_PROVIDER: "",
      EDGE_AI_URL: "https://siskelbot.workers.dev",
      EDGE_AI_ENABLED: "1",
    },
    async () => {
      const { getEdgeAIProvider } = await import("../lib/edge-ai-router.js");
      assert.equal(getEdgeAIProvider(), "cloudflare");
    },
  );
});

test("getEdgeAIProvider auto-detects fastly from URL host", async () => {
  await withEnv(
    {
      EDGE_AI_PROVIDER: "",
      EDGE_AI_URL: "https://siskelbot.fastly.global.ssl.fastly.net",
      EDGE_AI_ENABLED: "1",
    },
    async () => {
      const { getEdgeAIProvider } = await import("../lib/edge-ai-router.js");
      assert.equal(getEdgeAIProvider(), "fastly");
    },
  );
});

test("getEdgeAIProvider returns none when nothing is configured", async () => {
  await withEnv(
    { EDGE_AI_PROVIDER: "", EDGE_AI_URL: "", EDGE_AI_ENABLED: "" },
    async () => {
      const { getEdgeAIProvider } = await import("../lib/edge-ai-router.js");
      assert.equal(getEdgeAIProvider(), "none");
    },
  );
});

// ─── Model selection ───────────────────────────────────────────────────────

test("selectEdgeModel returns the first chat model for cloudflare by default", async () => {
  const { selectEdgeModel, EDGE_MODELS } = await import("../lib/edge-ai-router.js");
  const m = selectEdgeModel("cloudflare", "chat");
  assert.equal(m, EDGE_MODELS.cloudflare.chat[0]);
});

test("selectEdgeModel honours a preferred model when supported", async () => {
  const { selectEdgeModel } = await import("../lib/edge-ai-router.js");
  const m = selectEdgeModel("cloudflare", "chat", "@cf/mistral/mistral-7b-instruct-v0.2");
  assert.equal(m, "@cf/mistral/mistral-7b-instruct-v0.2");
});

test("selectEdgeModel ignores an unsupported preferred model", async () => {
  const { selectEdgeModel, EDGE_MODELS } = await import("../lib/edge-ai-router.js");
  const m = selectEdgeModel("cloudflare", "chat", "made-up-model");
  assert.equal(m, EDGE_MODELS.cloudflare.chat[0]);
});

test("selectEdgeModel returns null for unknown providers", async () => {
  const { selectEdgeModel } = await import("../lib/edge-ai-router.js");
  assert.equal(selectEdgeModel("nope", "chat"), null);
});

test("selectEdgeModel returns embedding models for fastly", async () => {
  const { selectEdgeModel, EDGE_MODELS } = await import("../lib/edge-ai-router.js");
  const m = selectEdgeModel("fastly", "embedding");
  assert.equal(m, EDGE_MODELS.fastly.embedding[0]);
});

test("EDGE_MODELS has chat and embedding lists for both providers", async () => {
  const { EDGE_MODELS } = await import("../lib/edge-ai-router.js");
  for (const provider of ["cloudflare", "fastly"]) {
    assert.ok(Array.isArray(EDGE_MODELS[provider].chat));
    assert.ok(EDGE_MODELS[provider].chat.length > 0);
    assert.ok(Array.isArray(EDGE_MODELS[provider].embedding));
    assert.ok(EDGE_MODELS[provider].embedding.length > 0);
  }
});

// ─── routeToEdgeAI integration ─────────────────────────────────────────────

test("routeToEdgeAI throws when no edge URL configured", async () => {
  await withEnv({ EDGE_AI_URL: "" }, async () => {
    const { routeToEdgeAI } = await import("../lib/edge-ai-router.js");
    await assert.rejects(
      () => routeToEdgeAI({ messages: [] }),
      (err) => err.code === "EDGE_AI_NOT_CONFIGURED",
    );
  });
});

test("routeToEdgeAI POSTs to the chat path with the request body", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "hi back" } }],
        edge: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json", "X-Edge": "cloudflare", "X-Edge-AI": "hit" } },
    );
  };
  const { routeToEdgeAI } = await import("../lib/edge-ai-router.js");
  const r = await routeToEdgeAI(
    { messages: [{ role: "user", content: "hi" }] },
    { edgeUrl: "https://ai.example.com", fetchImpl: fakeFetch },
  );
  assert.equal(r.ok, true);
  assert.equal(captured.url, "https://ai.example.com/v1/chat/completions/edge");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["Content-Type"], "application/json");
  const sent = JSON.parse(captured.init.body);
  assert.equal(sent.messages[0].content, "hi");
  assert.equal(r.headers["X-Edge"], "cloudflare");
  assert.equal(r.headers["X-Edge-AI"], "hit");
});

test("routeToEdgeAI uses the embedding path for kind=embedding", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const { routeToEdgeAI } = await import("../lib/edge-ai-router.js");
  const r = await routeToEdgeAI(
    { input: "search this" },
    { edgeUrl: "https://ai.example.com", fetchImpl: fakeFetch, kind: "embedding" },
  );
  assert.equal(r.ok, true);
  assert.equal(captured.url, "https://ai.example.com/api/v1/embeddings/edge");
});

test("routeToEdgeAI rejects when the edge returns a non-2xx", async () => {
  const fakeFetch = async () => new Response("nope", { status: 500 });
  const { routeToEdgeAI } = await import("../lib/edge-ai-router.js");
  await assert.rejects(
    () =>
      routeToEdgeAI(
        { messages: [{ role: "user", content: "hi" }] },
        { edgeUrl: "https://ai.example.com", fetchImpl: fakeFetch },
      ),
    (err) => err.code === "EDGE_AI_BAD_STATUS" && err.status === 500,
  );
});

test("routeToEdgeAI strips trailing slash on edge URL", async () => {
  let captured = null;
  const fakeFetch = async (url) => {
    captured = url;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const { routeToEdgeAI } = await import("../lib/edge-ai-router.js");
  await routeToEdgeAI(
    { messages: [{ role: "user", content: "hi" }] },
    { edgeUrl: "https://ai.example.com/", fetchImpl: fakeFetch },
  );
  assert.equal(captured, "https://ai.example.com/v1/chat/completions/edge");
});

// ─── describeEdgeAI ────────────────────────────────────────────────────────

test("describeEdgeAI returns provider config snapshot", async () => {
  await withEnv(
    {
      EDGE_AI_PROVIDER: "cloudflare",
      EDGE_AI_URL: "https://ai.example.com",
      EDGE_AI_ENABLED: "1",
      EDGE_AI_TIMEOUT_MS: "1234",
    },
    async () => {
      const { describeEdgeAI } = await import("../lib/edge-ai-router.js");
      const desc = describeEdgeAI();
      assert.equal(desc.provider, "cloudflare");
      assert.equal(desc.enabled, true);
      assert.equal(desc.url, "https://ai.example.com");
      assert.equal(desc.timeoutMs, 1234);
      assert.ok(Array.isArray(desc.models.chat));
      assert.ok(Array.isArray(desc.models.embedding));
    },
  );
});

// ─── Cloudflare worker complexity scorer agreement ─────────────────────────

test("cloudflare worker analyzeComplexity matches the router scorer", async () => {
  const { analyzeComplexity: routerScore } = await import("../lib/edge-ai-router.js");
  const { analyzeComplexity: workerScore } = await import("../edge/ai/cloudflare-ai-worker.js");
  const cases = [
    { messages: [{ role: "user", content: "hi" }], body: {} },
    { messages: [{ role: "user", content: "x".repeat(2500) }], body: {} },
    { messages: [{ role: "user", content: "do it" }], body: { tools: [{}] } },
    { messages: [{ role: "user", content: "```js\nx\n```" }], body: {} },
  ];
  for (const c of cases) {
    assert.equal(workerScore(c.messages, c.body), routerScore(c.messages, c.body));
  }
});

test("fastly compute analyzeComplexity matches the router scorer", async () => {
  const { analyzeComplexity: routerScore } = await import("../lib/edge-ai-router.js");
  const { analyzeComplexity: fastlyScore } = await import("../edge/ai/fastly-compute.js");
  const cases = [
    { messages: [{ role: "user", content: "hi" }], body: {} },
    { messages: [{ role: "user", content: "SELECT * FROM users" }], body: {} },
    { messages: Array.from({ length: 7 }, () => ({ role: "user", content: "x" })), body: {} },
  ];
  for (const c of cases) {
    assert.equal(fastlyScore(c.messages, c.body), routerScore(c.messages, c.body));
  }
});
