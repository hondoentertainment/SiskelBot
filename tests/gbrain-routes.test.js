/**
 * Tests for routes/gbrain.js.
 *
 * These tests exercise the HTTP surface of the GBrain routes with supertest
 * and a fake GBrain module injected via `__setGBrainModule`. They intentionally
 * do not depend on the real `lib/gbrain.js` module (which is built in parallel)
 * and cover the unavailable path as well.
 */

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";

import {
  mountGBrainRoutes,
  __setGBrainModule,
  __resetGBrainModuleCache,
} from "../routes/gbrain.js";

const CORTICES = [
  { id: "perception", name: "Perception", description: "Parse input" },
  { id: "memory", name: "Memory", description: "Recall context" },
  { id: "reasoning", name: "Reasoning", description: "Plan & analyze" },
  { id: "planning", name: "Planning", description: "Decompose tasks" },
  { id: "execution", name: "Execution", description: "Run tools" },
  { id: "reflection", name: "Reflection", description: "Self-critique" },
  { id: "learning", name: "Learning", description: "Adapt from outcomes" },
  { id: "emotion", name: "Emotion", description: "Affect & priority" },
];

function makeFakeBrain({ thoughts = [] } = {}) {
  const store = new Map();
  for (const t of thoughts) store.set(t.id, t);

  return {
    CORTICES,
    async think(task, context) {
      const id = `th_${store.size + 1}`;
      const plan = {
        id,
        task,
        strategy: "reasoning",
        confidence: 0.8,
        steps: [{ cortex: "perception" }, { cortex: "reasoning" }],
        createdAt: new Date().toISOString(),
        context: context || {},
      };
      store.set(id, plan);
      return plan;
    },
    async execute(plan, _context) {
      return {
        id: plan.id,
        success: true,
        output: `executed:${plan.id}`,
      };
    },
    async learn(record) {
      return { ok: true, recorded: record };
    },
    async getBrainState() {
      return {
        totalThoughts: store.size,
        successRate: 0.75,
        avgConfidence: 0.82,
        memoryEntries: 4,
        strategyDistribution: { reasoning: 3, planning: 1 },
        cortexActivity: { perception: 0.4, reasoning: 0.9 },
        cortices: CORTICES,
      };
    },
    async getRecentThoughts({ limit = 20, offset = 0 } = {}) {
      const all = [...store.values()];
      const slice = all.slice(offset, offset + limit);
      return { thoughts: slice, total: all.length };
    },
    async getThought(id) {
      return store.get(id) || null;
    },
  };
}

function buildApp(brainModule) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    req.userId = "test-user";
    next();
  });

  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    chatAuth: (req, res, next) => next(),
    requireScope: () => (req, res, next) => next(),
    logRequest: (req, res, next) => next(),
  };

  __resetGBrainModuleCache();
  if (brainModule !== undefined) {
    __setGBrainModule(brainModule);
  }

  mountGBrainRoutes(app, deps);
  return app;
}

test.beforeEach(() => {
  __resetGBrainModuleCache();
});

// ─── /think ──────────────────────────────────────────────────────────────────

test("POST /gbrain/think returns a plan for a valid task", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app)
    .post("/api/v1/gbrain/think")
    .send({ task: "Plan a product launch" });

  assert.equal(res.status, 200);
  assert.equal(res.body.task, "Plan a product launch");
  assert.equal(res.body.strategy, "reasoning");
  assert.equal(typeof res.body.confidence, "number");
  assert.ok(Array.isArray(res.body.steps));
});

test("POST /gbrain/think accepts a task object", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app)
    .post("/api/v1/gbrain/think")
    .send({ task: { text: "research LLM routing" }, context: { foo: "bar" } });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.task, { text: "research LLM routing" });
  assert.deepEqual(res.body.context, { foo: "bar" });
});

test("POST /gbrain/think rejects missing task", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app).post("/api/v1/gbrain/think").send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

test("POST /gbrain/think rejects blank task string", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app).post("/api/v1/gbrain/think").send({ task: "   " });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

test("POST /gbrain/think surfaces underlying errors as 500", async () => {
  const brain = {
    ...makeFakeBrain(),
    async think() { throw new Error("boom"); },
  };
  const app = buildApp(brain);

  const res = await request(app)
    .post("/api/v1/gbrain/think")
    .send({ task: "hello" });

  assert.equal(res.status, 500);
  assert.equal(res.body.code, "GBRAIN_ERROR");
  assert.equal(res.body.error, "boom");
});

// ─── /execute ────────────────────────────────────────────────────────────────

test("POST /gbrain/execute runs a plan", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const plan = { id: "th_1", strategy: "reasoning", steps: [] };
  const res = await request(app)
    .post("/api/v1/gbrain/execute")
    .send({ plan });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.id, "th_1");
});

test("POST /gbrain/execute rejects missing plan", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app).post("/api/v1/gbrain/execute").send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

// ─── /think-and-execute ──────────────────────────────────────────────────────

test("POST /gbrain/think-and-execute chains think + execute", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app)
    .post("/api/v1/gbrain/think-and-execute")
    .send({ task: "deploy to staging" });

  assert.equal(res.status, 200);
  assert.ok(res.body.plan, "plan returned");
  assert.ok(res.body.execution, "execution returned");
  assert.equal(res.body.execution.success, true);
});

test("POST /gbrain/think-and-execute rejects missing task", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app).post("/api/v1/gbrain/think-and-execute").send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

// ─── /learn ──────────────────────────────────────────────────────────────────

test("POST /gbrain/learn records an outcome", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app)
    .post("/api/v1/gbrain/learn")
    .send({ thoughtId: "th_1", success: true, feedback: "nice" });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.recorded.thoughtId, "th_1");
  assert.equal(res.body.recorded.feedback, "nice");
});

test("POST /gbrain/learn rejects empty body", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app).post("/api/v1/gbrain/learn").send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

test("POST /gbrain/learn returns 501 when learn not implemented", async () => {
  const brain = { ...makeFakeBrain() };
  delete brain.learn;
  const app = buildApp(brain);

  const res = await request(app)
    .post("/api/v1/gbrain/learn")
    .send({ thoughtId: "th_1", success: true });

  assert.equal(res.status, 501);
  assert.equal(res.body.code, "NOT_IMPLEMENTED");
});

// ─── /state ──────────────────────────────────────────────────────────────────

test("GET /gbrain/state returns expected shape", async () => {
  const brain = makeFakeBrain();
  // Seed some thoughts so totalThoughts > 0.
  await brain.think("first", {});
  await brain.think("second", {});
  const app = buildApp(brain);

  const res = await request(app).get("/api/v1/gbrain/state");

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.totalThoughts, "number");
  assert.equal(res.body.totalThoughts, 2);
  assert.equal(typeof res.body.successRate, "number");
  assert.equal(typeof res.body.avgConfidence, "number");
  assert.equal(typeof res.body.memoryEntries, "number");
  assert.ok(res.body.strategyDistribution, "strategyDistribution present");
  assert.ok(res.body.cortexActivity, "cortexActivity present");
});

// ─── /thoughts ───────────────────────────────────────────────────────────────

test("GET /gbrain/thoughts returns recent thoughts", async () => {
  const brain = makeFakeBrain();
  for (let i = 0; i < 5; i++) await brain.think(`task ${i}`, {});
  const app = buildApp(brain);

  const res = await request(app).get("/api/v1/gbrain/thoughts");

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.thoughts));
  assert.equal(res.body.thoughts.length, 5);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.offset, 0);
  assert.equal(res.body.total, 5);
});

test("GET /gbrain/thoughts respects limit and offset", async () => {
  const brain = makeFakeBrain();
  for (let i = 0; i < 10; i++) await brain.think(`task ${i}`, {});
  const app = buildApp(brain);

  const res = await request(app)
    .get("/api/v1/gbrain/thoughts?limit=3&offset=2");

  assert.equal(res.status, 200);
  assert.equal(res.body.thoughts.length, 3);
  assert.equal(res.body.limit, 3);
  assert.equal(res.body.offset, 2);
  assert.equal(res.body.total, 10);
});

test("GET /gbrain/thoughts clamps invalid limit/offset", async () => {
  const brain = makeFakeBrain();
  await brain.think("one", {});
  const app = buildApp(brain);

  const res = await request(app).get("/api/v1/gbrain/thoughts?limit=abc&offset=-5");
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 20); // fallback default
  assert.equal(res.body.offset, 0);
});

test("GET /gbrain/thoughts/:id returns single thought", async () => {
  const brain = makeFakeBrain();
  const plan = await brain.think("find-me", {});
  const app = buildApp(brain);

  const res = await request(app).get(`/api/v1/gbrain/thoughts/${plan.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, plan.id);
  assert.equal(res.body.task, "find-me");
});

test("GET /gbrain/thoughts/:id returns 404 for unknown id", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app).get("/api/v1/gbrain/thoughts/does-not-exist");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

// ─── /cortices ───────────────────────────────────────────────────────────────

test("GET /gbrain/cortices returns all 8 cortices", async () => {
  const brain = makeFakeBrain();
  const app = buildApp(brain);

  const res = await request(app).get("/api/v1/gbrain/cortices");

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.cortices));
  assert.equal(res.body.cortices.length, 8);
  const ids = res.body.cortices.map((c) => c.id);
  assert.deepEqual(ids, [
    "perception",
    "memory",
    "reasoning",
    "planning",
    "execution",
    "reflection",
    "learning",
    "emotion",
  ]);
});

// ─── unavailable module ──────────────────────────────────────────────────────

test("returns 503 when GBrain module is unavailable", async () => {
  // Inject null to simulate missing module.
  const app = buildApp(null);

  const stateRes = await request(app).get("/api/v1/gbrain/state");
  assert.equal(stateRes.status, 503);
  assert.equal(stateRes.body.code, "GBRAIN_UNAVAILABLE");

  const thinkRes = await request(app)
    .post("/api/v1/gbrain/think")
    .send({ task: "hello" });
  assert.equal(thinkRes.status, 503);
  assert.equal(thinkRes.body.code, "GBRAIN_UNAVAILABLE");

  const corticesRes = await request(app).get("/api/v1/gbrain/cortices");
  assert.equal(corticesRes.status, 503);
  assert.equal(corticesRes.body.code, "GBRAIN_UNAVAILABLE");
});
