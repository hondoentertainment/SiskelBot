/**
 * Plugin marketplace remote registry tests.
 * Tests fetchRemoteRegistry, searchRemotePlugins, clearRegistryCache,
 * and installRemotePack with mocked HTTP (global fetch).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchRemoteRegistry,
  searchRemotePlugins,
  clearRegistryCache,
  installRemotePack,
  validateManifest,
  registry,
} from "../lib/plugin-marketplace.js";

// ---------------------------------------------------------------------------
// Mock registry data
// ---------------------------------------------------------------------------

const MOCK_REGISTRY = {
  version: "1.0.0",
  updated: "2026-04-01T00:00:00Z",
  plugins: [
    {
      id: "deploy-pack",
      name: "Deploy Pack",
      version: "2.0.0",
      description: "Deployment automation tools",
      author: "siskelbot",
      tags: ["deploy", "ci"],
    },
    {
      id: "analytics-pack",
      name: "Analytics Pack",
      version: "1.5.0",
      description: "Usage analytics and reporting",
      author: "community",
      tags: ["analytics", "reporting"],
    },
    {
      id: "github-pack",
      name: "GitHub Integration",
      version: "3.1.0",
      description: "GitHub webhook and PR tools",
      author: "siskelbot",
      tags: ["github", "ci"],
    },
  ],
};

const VALID_MANIFEST = {
  id: "deploy-pack",
  name: "Deploy Pack",
  version: "2.0.0",
  description: "Deployment automation tools",
  author: "siskelbot",
  actions: [{ name: "deploy", type: "webhook" }],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(responses) {
  globalThis.fetch = async (url) => {
    const handler = responses[url] || responses["*"];
    if (!handler) {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}), text: async () => "" };
    }
    return handler(url);
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test.afterEach(() => {
  clearRegistryCache();
  restoreFetch();
  delete process.env.PLUGIN_REGISTRY_URL;
  registry.delete("deploy-pack");
});

// ---------------------------------------------------------------------------
// fetchRemoteRegistry
// ---------------------------------------------------------------------------

test("fetchRemoteRegistry returns empty when no registry URL configured", async () => {
  delete process.env.PLUGIN_REGISTRY_URL;
  const result = await fetchRemoteRegistry();
  assert.deepEqual(result.plugins, []);
  assert.equal(result.version, "0.0.0");
});

test("fetchRemoteRegistry fetches and caches remote registry", async () => {
  let fetchCount = 0;
  mockFetch({
    "https://registry.example.com/index.json": async () => {
      fetchCount++;
      return { ok: true, json: async () => MOCK_REGISTRY };
    },
  });

  const result = await fetchRemoteRegistry("https://registry.example.com");
  assert.equal(result.version, "1.0.0");
  assert.equal(result.plugins.length, 3);
  assert.equal(fetchCount, 1);

  // Second call should use cache
  const result2 = await fetchRemoteRegistry("https://registry.example.com");
  assert.equal(result2.plugins.length, 3);
  assert.equal(fetchCount, 1, "should use cached result on second call");
});

test("fetchRemoteRegistry throws on non-OK response", async () => {
  mockFetch({
    "https://bad-registry.example.com/index.json": async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }),
  });

  await assert.rejects(
    () => fetchRemoteRegistry("https://bad-registry.example.com"),
    (err) => {
      assert.match(err.message, /Registry fetch failed.*500/);
      return true;
    }
  );
});

test("fetchRemoteRegistry throws on invalid format (missing plugins array)", async () => {
  mockFetch({
    "https://bad-format.example.com/index.json": async () => ({
      ok: true,
      json: async () => ({ version: "1.0.0" }),
    }),
  });

  await assert.rejects(
    () => fetchRemoteRegistry("https://bad-format.example.com"),
    (err) => {
      assert.match(err.message, /Invalid registry format/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// clearRegistryCache
// ---------------------------------------------------------------------------

test("clearRegistryCache forces fresh fetch on next call", async () => {
  let fetchCount = 0;
  mockFetch({
    "https://registry.example.com/index.json": async () => {
      fetchCount++;
      return { ok: true, json: async () => MOCK_REGISTRY };
    },
  });

  await fetchRemoteRegistry("https://registry.example.com");
  assert.equal(fetchCount, 1);

  clearRegistryCache();

  await fetchRemoteRegistry("https://registry.example.com");
  assert.equal(fetchCount, 2, "should re-fetch after cache cleared");
});

// ---------------------------------------------------------------------------
// searchRemotePlugins
// ---------------------------------------------------------------------------

test("searchRemotePlugins returns all plugins for empty query", async () => {
  mockFetch({
    "https://registry.example.com/index.json": async () => ({
      ok: true,
      json: async () => MOCK_REGISTRY,
    }),
  });

  const results = await searchRemotePlugins("", { registryUrl: "https://registry.example.com" });
  assert.equal(results.length, 3);
});

test("searchRemotePlugins filters by name match", async () => {
  mockFetch({
    "https://registry.example.com/index.json": async () => ({
      ok: true,
      json: async () => MOCK_REGISTRY,
    }),
  });

  const results = await searchRemotePlugins("deploy", { registryUrl: "https://registry.example.com" });
  assert.ok(results.length >= 1);
  assert.equal(results[0].id, "deploy-pack");
});

test("searchRemotePlugins filters by tag", async () => {
  mockFetch({
    "https://registry.example.com/index.json": async () => ({
      ok: true,
      json: async () => MOCK_REGISTRY,
    }),
  });

  const results = await searchRemotePlugins("", {
    tag: "ci",
    registryUrl: "https://registry.example.com",
  });
  assert.equal(results.length, 2);
  const ids = results.map((p) => p.id);
  assert.ok(ids.includes("deploy-pack"));
  assert.ok(ids.includes("github-pack"));
});

test("searchRemotePlugins filters by author", async () => {
  mockFetch({
    "https://registry.example.com/index.json": async () => ({
      ok: true,
      json: async () => MOCK_REGISTRY,
    }),
  });

  const results = await searchRemotePlugins("", {
    author: "community",
    registryUrl: "https://registry.example.com",
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "analytics-pack");
});

test("searchRemotePlugins scores exact name match highest", async () => {
  mockFetch({
    "https://registry.example.com/index.json": async () => ({
      ok: true,
      json: async () => MOCK_REGISTRY,
    }),
  });

  const results = await searchRemotePlugins("Analytics Pack", {
    registryUrl: "https://registry.example.com",
  });
  assert.ok(results.length >= 1);
  assert.equal(results[0].id, "analytics-pack");
});

// ---------------------------------------------------------------------------
// installRemotePack validates manifest
// ---------------------------------------------------------------------------

test("installRemotePack returns error when no registry URL", async () => {
  delete process.env.PLUGIN_REGISTRY_URL;
  const result = await installRemotePack("deploy-pack");
  assert.equal(result.ok, false);
  assert.match(result.error, /No registry URL/);
});

test("installRemotePack returns error for invalid packId", async () => {
  const result = await installRemotePack("INVALID_ID!", "https://registry.example.com");
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid packId/);
});

test("installRemotePack rejects manifest with missing required fields", async () => {
  const badManifest = { id: "deploy-pack", name: "Deploy Pack" };
  mockFetch({
    "https://registry.example.com/index.json": async () => ({
      ok: true,
      json: async () => MOCK_REGISTRY,
    }),
    "https://registry.example.com/packs/deploy-pack/manifest.json": async () => ({
      ok: true,
      json: async () => badManifest,
    }),
  });

  const result = await installRemotePack("deploy-pack", "https://registry.example.com");
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid manifest/);
});

test("installRemotePack succeeds with valid manifest", async () => {
  mockFetch({
    "https://registry.example.com/index.json": async () => ({
      ok: true,
      json: async () => MOCK_REGISTRY,
    }),
    "https://registry.example.com/packs/deploy-pack/manifest.json": async () => ({
      ok: true,
      json: async () => VALID_MANIFEST,
    }),
  });

  const result = await installRemotePack("deploy-pack", "https://registry.example.com");
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, "deploy-pack");
  assert.ok(registry.has("deploy-pack"), "pack should be registered");
});

// ---------------------------------------------------------------------------
// validateManifest (unit)
// ---------------------------------------------------------------------------

test("validateManifest rejects null", () => {
  const result = validateManifest(null);
  assert.equal(result.valid, false);
});

test("validateManifest rejects manifest missing required fields", () => {
  const result = validateManifest({ id: "test" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("name")));
});

test("validateManifest rejects invalid id format", () => {
  const result = validateManifest({
    id: "INVALID_ID",
    name: "Test",
    version: "1.0.0",
    description: "desc",
    author: "me",
    actions: [{ name: "a", type: "webhook" }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("id")));
});

test("validateManifest accepts valid manifest", () => {
  const result = validateManifest(VALID_MANIFEST);
  assert.equal(result.valid, true);
});
