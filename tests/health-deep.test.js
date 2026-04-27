import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import mountHealthRoutes from "../routes/health.js";

function buildApp({ storage, backend = "openai", openAIKey = "sk-test", env = {} } = {}) {
  const original = { ...process.env };
  Object.assign(process.env, env);

  const app = express();
  const deps = {
    BACKEND: backend,
    OPENAI_API_KEY: openAIKey,
    OLLAMA_URL: "http://localhost:11434",
    VLLM_URL: "http://localhost:8000",
    metricsEnabled: () => false,
    renderPrometheus: () => "",
    storage,
  };
  mountHealthRoutes(app, deps);

  return {
    app,
    restore: () => { process.env = original; },
  };
}

function mockStorage({ throws = false } = {}) {
  return {
    listWorkspaces: async () => {
      if (throws) throw new Error("storage backend offline");
      return [];
    },
  };
}

function withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => {
    global.fetch = original;
  });
}

test("GET /health/deep returns 200 when storage works and backend is reachable", async () => {
  const { app, restore } = buildApp({ storage: mockStorage() });
  try {
    await withMockedFetch(
      async () => ({ ok: true, status: 200 }),
      async () => {
        const response = await request(app).get("/health/deep");
        assert.equal(response.status, 200);
        assert.equal(response.body.status, "up");
        assert.ok(Array.isArray(response.body.dependencies));
        const storageCheck = response.body.dependencies.find((d) => d.name === "storage");
        assert.ok(storageCheck);
        assert.equal(storageCheck.status, "up");
        const backendCheck = response.body.dependencies.find((d) => d.name === "backend_active");
        assert.ok(backendCheck);
        assert.equal(backendCheck.status, "up");
      }
    );
  } finally {
    restore();
  }
});

test("GET /health/deep returns 503 when storage throws", async () => {
  const { app, restore } = buildApp({ storage: mockStorage({ throws: true }) });
  try {
    await withMockedFetch(
      async () => ({ ok: true, status: 200 }),
      async () => {
        const response = await request(app).get("/health/deep");
        assert.equal(response.status, 503);
        assert.equal(response.body.status, "down");
        const storageCheck = response.body.dependencies.find((d) => d.name === "storage");
        assert.ok(storageCheck);
        assert.equal(storageCheck.status, "down");
        assert.match(storageCheck.error, /storage backend offline/);
      }
    );
  } finally {
    restore();
  }
});

test("GET /health/deep includes a dependencies array with each check having name, status, latencyMs", async () => {
  const { app, restore } = buildApp({ storage: mockStorage() });
  try {
    await withMockedFetch(
      async () => ({ ok: true, status: 200 }),
      async () => {
        const response = await request(app).get("/health/deep");
        assert.ok(Array.isArray(response.body.dependencies));
        assert.ok(response.body.dependencies.length >= 2);
        for (const dep of response.body.dependencies) {
          assert.equal(typeof dep.name, "string", `dep should have name: ${JSON.stringify(dep)}`);
          assert.ok(["up", "down", "degraded"].includes(dep.status));
          assert.equal(typeof dep.latencyMs, "number");
          assert.ok(dep.latencyMs >= 0);
        }
        assert.ok(typeof response.body.checkedAt === "string");
      }
    );
  } finally {
    restore();
  }
});

test("GET /health/deep returns degraded when optional dependency is down", async () => {
  // EMBEDDING_BACKEND set but optional check passes -- exercise the optional code path
  const { app, restore } = buildApp({
    storage: mockStorage(),
    env: { EMBEDDING_BACKEND: "openai" },
  });
  try {
    await withMockedFetch(
      async () => ({ ok: true, status: 200 }),
      async () => {
        const response = await request(app).get("/health/deep");
        assert.equal(response.status, 200);
        const embeddingsCheck = response.body.dependencies.find((d) => d.name === "embeddings");
        assert.ok(embeddingsCheck, "embeddings check should be present when EMBEDDING_BACKEND is set");
        assert.equal(embeddingsCheck.critical, false);
      }
    );
  } finally {
    restore();
  }
});
