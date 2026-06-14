import test from "node:test";
import assert from "node:assert/strict";

// ─── Cloudflare worker unit tests ───────────────────────────────────────────

test("worker getCacheConfig returns config for exact match", async () => {
  const { getCacheConfig } = await import("../edge/cloudflare/worker.js");
  const cfg = getCacheConfig("/config");
  assert.ok(cfg);
  assert.equal(cfg.ttl, 30);
  assert.deepEqual(cfg.vary, []);
});

test("worker getCacheConfig returns config for known prefix", async () => {
  const { getCacheConfig } = await import("../edge/cloudflare/worker.js");
  const cfg = getCacheConfig("/api/v1/recipes");
  assert.ok(cfg);
  assert.equal(cfg.ttl, 60);
  assert.deepEqual(cfg.vary, ["workspace"]);
});

test("worker getCacheConfig allows nested paths under a configured prefix", async () => {
  const { getCacheConfig } = await import("../edge/cloudflare/worker.js");
  const cfg = getCacheConfig("/api/v1/recipes/some-id");
  assert.ok(cfg);
  assert.equal(cfg.ttl, 60);
});

test("worker getCacheConfig returns null for unknown paths", async () => {
  const { getCacheConfig } = await import("../edge/cloudflare/worker.js");
  assert.equal(getCacheConfig("/api/v1/agents"), null);
  assert.equal(getCacheConfig("/random"), null);
  assert.equal(getCacheConfig(""), null);
  assert.equal(getCacheConfig(null), null);
});

test("worker buildCacheKey strips non-vary query params", async () => {
  const { buildCacheKey } = await import("../edge/cloudflare/worker.js");
  const url = new URL("https://api.siskelbot.example.com/api/v1/knowledge/search?q=hello&workspace=ws1&junk=123&_=456");
  const config = { ttl: 60, vary: ["q", "workspace"] };
  const key = buildCacheKey(url, config);
  // The key is a Request — extract its URL
  assert.equal(
    key.url,
    "https://api.siskelbot.example.com/api/v1/knowledge/search?q=hello&workspace=ws1",
  );
});

test("worker buildCacheKey sorts vary params for stable keys", async () => {
  const { buildCacheKey } = await import("../edge/cloudflare/worker.js");
  // Different order in URL but same logical key
  const url1 = new URL("https://api.siskelbot.example.com/api/v1/knowledge/search?workspace=ws1&q=hello");
  const url2 = new URL("https://api.siskelbot.example.com/api/v1/knowledge/search?q=hello&workspace=ws1");
  const config = { ttl: 60, vary: ["q", "workspace"] };
  const k1 = buildCacheKey(url1, config);
  const k2 = buildCacheKey(url2, config);
  assert.equal(k1.url, k2.url);
});

test("worker buildCacheKey omits missing vary params", async () => {
  const { buildCacheKey } = await import("../edge/cloudflare/worker.js");
  const url = new URL("https://api.siskelbot.example.com/api/v1/recipes");
  const config = { ttl: 60, vary: ["workspace"] };
  const key = buildCacheKey(url, config);
  assert.equal(key.url, "https://api.siskelbot.example.com/api/v1/recipes");
});

test("worker buildCacheKey produces a path-only key when config has no vary list", async () => {
  const { buildCacheKey } = await import("../edge/cloudflare/worker.js");
  const url = new URL("https://api.siskelbot.example.com/config?foo=bar");
  const config = { ttl: 30, vary: [] };
  const key = buildCacheKey(url, config);
  assert.equal(key.url, "https://api.siskelbot.example.com/config");
});

test("worker addEdgeHeaders preserves status and adds X-Edge headers", async () => {
  const { addEdgeHeaders } = await import("../edge/cloudflare/worker.js");
  const original = new Response("hello", { status: 200, headers: { "Content-Type": "text/plain" } });
  const tagged = addEdgeHeaders(original, "HIT");
  assert.equal(tagged.status, 200);
  assert.equal(tagged.headers.get("X-Edge"), "cloudflare");
  assert.equal(tagged.headers.get("X-Edge-Cache"), "HIT");
  assert.equal(tagged.headers.get("Content-Type"), "text/plain");
  assert.equal(await tagged.text(), "hello");
});

test("worker exports CACHE_CONFIG with all expected paths", async () => {
  const { CACHE_CONFIG } = await import("../edge/cloudflare/worker.js");
  assert.ok(CACHE_CONFIG["/config"]);
  assert.ok(CACHE_CONFIG["/api/v1/knowledge/search"]);
  assert.ok(CACHE_CONFIG["/api/v1/recipes"]);
  assert.ok(CACHE_CONFIG["/api/docs/openapi.json"]);
});

// ─── Worker fetch handler integration with mocked fetch + cache ────────────

function mockCache() {
  const store = new Map();
  return {
    store,
    async match(request) {
      const url = typeof request === "string" ? request : request.url;
      return store.get(url) || undefined;
    },
    async put(request, response) {
      const url = typeof request === "string" ? request : request.url;
      store.set(url, response);
    },
  };
}

test("worker fetch handler responds to /health/live without contacting origin", async () => {
  const worker = (await import("../edge/cloudflare/worker.js")).default;
  let originCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { originCalled = true; return new Response("nope", { status: 500 }); };
  try {
    const req = new Request("https://siskelbot.example.com/health/live");
    const res = await worker.fetch(req, {}, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Edge"), "cloudflare");
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.edge, "cloudflare");
    assert.equal(originCalled, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("worker fetch handler bypasses cache for authenticated requests", async () => {
  const worker = (await import("../edge/cloudflare/worker.js")).default;
  const cache = mockCache();
  const origCaches = globalThis.caches;
  globalThis.caches = { default: cache };
  const origFetch = globalThis.fetch;
  let originCalls = 0;
  globalThis.fetch = async () => {
    originCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const req = new Request("https://siskelbot.example.com/config", {
      headers: { Authorization: "Bearer secret" },
    });
    const res = await worker.fetch(req, { ORIGIN_URL: "https://origin.example.com" }, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Edge-Cache"), "BYPASS");
    assert.equal(originCalls, 1);
    assert.equal(cache.store.size, 0, "auth requests must not populate the cache");
  } finally {
    globalThis.fetch = origFetch;
    if (origCaches === undefined) delete globalThis.caches;
    else globalThis.caches = origCaches;
  }
});

test("worker fetch handler caches a MISS then serves a HIT", async () => {
  const worker = (await import("../edge/cloudflare/worker.js")).default;
  const cache = mockCache();
  const origCaches = globalThis.caches;
  globalThis.caches = { default: cache };
  const origFetch = globalThis.fetch;
  let originCalls = 0;
  globalThis.fetch = async () => {
    originCalls += 1;
    return new Response(JSON.stringify({ backend: "ollama" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const url = "https://siskelbot.example.com/config";
    const ctx = { _pending: [], waitUntil(p) { this._pending.push(p); } };

    const r1 = await worker.fetch(new Request(url), { ORIGIN_URL: "https://origin.example.com" }, ctx);
    assert.equal(r1.headers.get("X-Edge-Cache"), "MISS");
    assert.equal(originCalls, 1);
    // Wait for the cache.put to complete
    await Promise.all(ctx._pending);

    const r2 = await worker.fetch(new Request(url), { ORIGIN_URL: "https://origin.example.com" }, ctx);
    assert.equal(r2.headers.get("X-Edge-Cache"), "HIT");
    assert.equal(originCalls, 1, "second request must be served from cache");
  } finally {
    globalThis.fetch = origFetch;
    if (origCaches === undefined) delete globalThis.caches;
    else globalThis.caches = origCaches;
  }
});

test("worker fetch handler does not cache non-200 responses", async () => {
  const worker = (await import("../edge/cloudflare/worker.js")).default;
  const cache = mockCache();
  const origCaches = globalThis.caches;
  globalThis.caches = { default: cache };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("err", { status: 500 });
  try {
    const ctx = { waitUntil() {} };
    const res = await worker.fetch(
      new Request("https://siskelbot.example.com/config"),
      { ORIGIN_URL: "https://origin.example.com" },
      ctx,
    );
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("X-Edge-Cache"), "MISS");
    assert.equal(cache.store.size, 0);
  } finally {
    globalThis.fetch = origFetch;
    if (origCaches === undefined) delete globalThis.caches;
    else globalThis.caches = origCaches;
  }
});

test("worker fetch handler passes POST through without caching", async () => {
  const worker = (await import("../edge/cloudflare/worker.js")).default;
  const origFetch = globalThis.fetch;
  let originMethod = null;
  globalThis.fetch = async (url, init) => {
    originMethod = init?.method;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const req = new Request("https://siskelbot.example.com/config", { method: "POST", body: "x" });
    const res = await worker.fetch(req, { ORIGIN_URL: "https://origin.example.com" }, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.equal(originMethod, "POST");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ─── lib/edge-cache.js unit tests ──────────────────────────────────────────

test("edge-cache: getEdgeProvider returns 'none' when no credentials configured", async () => {
  const orig = {
    EDGE_PROVIDER: process.env.EDGE_PROVIDER,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID,
    FASTLY_API_TOKEN: process.env.FASTLY_API_TOKEN,
    FASTLY_SERVICE_ID: process.env.FASTLY_SERVICE_ID,
  };
  delete process.env.EDGE_PROVIDER;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ZONE_ID;
  delete process.env.FASTLY_API_TOKEN;
  delete process.env.FASTLY_SERVICE_ID;
  try {
    const { getEdgeProvider } = await import(`../lib/edge-cache.js?t=${Date.now()}`);
    assert.equal(getEdgeProvider(), "none");
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("edge-cache: getEdgeProvider auto-detects cloudflare from credentials", async () => {
  const orig = {
    EDGE_PROVIDER: process.env.EDGE_PROVIDER,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID,
  };
  delete process.env.EDGE_PROVIDER;
  process.env.CLOUDFLARE_API_TOKEN = "tok";
  process.env.CLOUDFLARE_ZONE_ID = "zone";
  try {
    const { getEdgeProvider } = await import(`../lib/edge-cache.js?t=${Date.now()}-cf`);
    assert.equal(getEdgeProvider(), "cloudflare");
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("edge-cache: invalidateEdgeCache is a no-op for provider='none'", async () => {
  const { invalidateEdgeCache } = await import("../lib/edge-cache.js");
  const r = await invalidateEdgeCache({
    paths: ["/config"],
    patterns: ["recipes"],
    provider: "none",
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "none");
  assert.deepEqual(r.purged, ["/config"]);
  assert.deepEqual(r.patternsPurged, ["recipes"]);
});

test("edge-cache: invalidateEdgeCache returns error when cloudflare creds missing", async () => {
  const orig = {
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID,
  };
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ZONE_ID;
  try {
    const { invalidateEdgeCache } = await import("../lib/edge-cache.js");
    const r = await invalidateEdgeCache({
      paths: ["/config"],
      provider: "cloudflare",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "EDGE_NOT_CONFIGURED");
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("edge-cache: invalidateEdgeCache calls cloudflare API with paths as files", async () => {
  const orig = {
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID,
    CLOUDFLARE_HOSTNAME: process.env.CLOUDFLARE_HOSTNAME,
  };
  process.env.CLOUDFLARE_API_TOKEN = "tok";
  process.env.CLOUDFLARE_ZONE_ID = "zone-123";
  process.env.CLOUDFLARE_HOSTNAME = "siskelbot.example.com";

  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ success: true, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { invalidateEdgeCache } = await import("../lib/edge-cache.js");
    const r = await invalidateEdgeCache({
      paths: ["/config", "/api/v1/recipes"],
      patterns: ["recipes-tag"],
      provider: "cloudflare",
      fetchImpl: fakeFetch,
    });
    assert.equal(r.ok, true);
    assert.equal(r.provider, "cloudflare");
    assert.ok(captured.url.includes("/zones/zone-123/purge_cache"));
    const body = JSON.parse(captured.init.body);
    assert.deepEqual(body.files, [
      "https://siskelbot.example.com/config",
      "https://siskelbot.example.com/api/v1/recipes",
    ]);
    assert.deepEqual(body.tags, ["recipes-tag"]);
    assert.equal(captured.init.headers.Authorization, "Bearer tok");
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("edge-cache: invalidateEdgeCache surfaces cloudflare API errors", async () => {
  const orig = {
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ZONE_ID: process.env.CLOUDFLARE_ZONE_ID,
  };
  process.env.CLOUDFLARE_API_TOKEN = "tok";
  process.env.CLOUDFLARE_ZONE_ID = "zone";
  try {
    const { invalidateEdgeCache } = await import("../lib/edge-cache.js");
    const r = await invalidateEdgeCache({
      paths: ["/config"],
      provider: "cloudflare",
      fetchImpl: async () =>
        new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "bad" }] }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, "EDGE_PURGE_FAILED");
    assert.equal(r.status, 400);
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("edge-cache: invalidateEdgeCache fastly per-path PURGE", async () => {
  const orig = {
    FASTLY_API_TOKEN: process.env.FASTLY_API_TOKEN,
    FASTLY_SERVICE_ID: process.env.FASTLY_SERVICE_ID,
    FASTLY_HOSTNAME: process.env.FASTLY_HOSTNAME,
  };
  process.env.FASTLY_API_TOKEN = "ftok";
  process.env.FASTLY_SERVICE_ID = "svc-1";
  process.env.FASTLY_HOSTNAME = "siskelbot.example.com";

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init.method });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const { invalidateEdgeCache } = await import("../lib/edge-cache.js");
    const r = await invalidateEdgeCache({
      paths: ["/config", "/api/v1/recipes"],
      provider: "fastly",
      fetchImpl: fakeFetch,
    });
    assert.equal(r.ok, true);
    assert.equal(r.provider, "fastly");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "PURGE");
    assert.equal(calls[0].url, "https://siskelbot.example.com/config");
    assert.equal(calls[1].url, "https://siskelbot.example.com/api/v1/recipes");
  } finally {
    for (const [k, v] of Object.entries(orig)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("edge-cache: listEdgeProviders reports configuration state", async () => {
  const { listEdgeProviders } = await import("../lib/edge-cache.js");
  const list = listEdgeProviders();
  assert.ok(Array.isArray(list));
  const names = list.map((p) => p.name);
  assert.ok(names.includes("cloudflare"));
  assert.ok(names.includes("fastly"));
  assert.ok(names.includes("active"));
  for (const p of list) {
    assert.equal(typeof p.configured, "boolean");
  }
});

// ─── Route integration: POST /api/v1/edge/invalidate ───────────────────────

test("POST /api/v1/edge/invalidate rejects requests without admin auth", async () => {
  const orig = { ...process.env };
  process.env.VERCEL = "1";
  process.env.ADMIN_API_KEY = "admin-edge-test-key";
  delete process.env.EDGE_PROVIDER;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.FASTLY_API_TOKEN;
  try {
    const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
    const { default: app } = await import(moduleUrl.href);
    const request = (await import("supertest")).default;
    const res = await request(app)
      .post("/api/v1/edge/invalidate")
      .send({ paths: ["/config"] });
    assert.equal(res.status, 401);
  } finally {
    process.env = orig;
  }
});

test("POST /api/v1/edge/invalidate validates input", async () => {
  const orig = { ...process.env };
  process.env.VERCEL = "1";
  process.env.ADMIN_API_KEY = "admin-edge-test-key";
  process.env.EDGE_PROVIDER = "none";
  try {
    const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
    const { default: app } = await import(moduleUrl.href);
    const request = (await import("supertest")).default;
    const res = await request(app)
      .post("/api/v1/edge/invalidate")
      .set("Authorization", "Bearer admin-edge-test-key")
      .send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "INVALID_INPUT");
  } finally {
    process.env = orig;
  }
});

test("POST /api/v1/edge/invalidate succeeds in no-op mode with valid input", async () => {
  const orig = { ...process.env };
  process.env.VERCEL = "1";
  process.env.ADMIN_API_KEY = "admin-edge-test-key";
  process.env.EDGE_PROVIDER = "none";
  try {
    const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
    const { default: app } = await import(moduleUrl.href);
    const request = (await import("supertest")).default;
    const res = await request(app)
      .post("/api/v1/edge/invalidate")
      .set("Authorization", "Bearer admin-edge-test-key")
      .send({ paths: ["/config", "/api/v1/recipes"] });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.provider, "none");
    assert.deepEqual(res.body.purged, ["/config", "/api/v1/recipes"]);
  } finally {
    process.env = orig;
  }
});

test("GET /api/v1/edge/providers returns provider list for admin", async () => {
  const orig = { ...process.env };
  process.env.VERCEL = "1";
  process.env.ADMIN_API_KEY = "admin-edge-test-key";
  try {
    const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
    const { default: app } = await import(moduleUrl.href);
    const request = (await import("supertest")).default;
    const res = await request(app)
      .get("/api/v1/edge/providers")
      .set("Authorization", "Bearer admin-edge-test-key");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.providers));
    const names = res.body.providers.map((p) => p.name);
    assert.ok(names.includes("cloudflare"));
    assert.ok(names.includes("fastly"));
  } finally {
    process.env = orig;
  }
});
