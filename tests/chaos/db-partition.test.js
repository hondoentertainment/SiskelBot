// CHAOS TEST: storage layer suddenly throws ECONNREFUSED (DB partition)
// EXPECTED: /health/ready 503 fast (no hang), /health/live still 200, /health/deep reports storage:down + overall:down
//
// Run with: npm run test:chaos
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

import mountHealthRoutes from "../../routes/health.js";

function makePartitionedStorage() {
  return {
    listWorkspaces: async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
      err.code = "ECONNREFUSED";
      throw err;
    },
  };
}

function buildApp(storage, env = {}) {
  const original = { ...process.env };
  Object.assign(process.env, env);
  const app = express();
  mountHealthRoutes(app, {
    BACKEND: "openai",
    OPENAI_API_KEY: "sk-chaos",
    OLLAMA_URL: "http://localhost:11434",
    VLLM_URL: "http://localhost:8000",
    metricsEnabled: () => false,
    renderPrometheus: () => "",
    storage,
  });
  return {
    app,
    restore: () => {
      process.env = original;
    },
  };
}

async function withMockedFetch(impl, fn) {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

describe("CHAOS: db partition (storage ECONNREFUSED)", () => {
  it(
    "/health/live still returns 200 (process is alive)",
    { timeout: 10_000 },
    async () => {
      const { app, restore } = buildApp(makePartitionedStorage());
      try {
        const res = await request(app).get("/health/live");
        assert.equal(res.status, 200);
        assert.equal(res.body.ok, true);
      } finally {
        restore();
      }
    },
  );

  it(
    "/health/ready returns 503 within 3 seconds (no hang)",
    { timeout: 10_000 },
    async () => {
      const { app, restore } = buildApp(makePartitionedStorage());
      try {
        await withMockedFetch(
          async () => ({ ok: true, status: 200 }),
          async () => {
            const start = Date.now();
            const res = await request(app).get("/health/ready");
            const elapsed = Date.now() - start;
            assert.equal(res.status, 503);
            assert.equal(res.body.reason, "storage_unavailable");
            assert.ok(
              elapsed < 3000,
              `ready check should not hang (elapsed=${elapsed}ms)`,
            );
          },
        );
      } finally {
        restore();
      }
    },
  );

  it(
    "/health/deep reports storage:down and overall status:down (503)",
    { timeout: 10_000 },
    async () => {
      const { app, restore } = buildApp(makePartitionedStorage());
      try {
        await withMockedFetch(
          async () => ({ ok: true, status: 200 }),
          async () => {
            const res = await request(app).get("/health/deep");
            assert.equal(res.status, 503);
            assert.equal(res.body.status, "down");
            const storageCheck = res.body.dependencies.find(
              (d) => d.name === "storage",
            );
            assert.ok(storageCheck, "storage check must be present");
            assert.equal(storageCheck.status, "down");
            assert.match(storageCheck.error, /ECONNREFUSED/);
          },
        );
      } finally {
        restore();
      }
    },
  );
});
