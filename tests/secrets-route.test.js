import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { mountSecretsRoutes } from "../routes/secrets.js";

function buildApp() {
  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, msg) => res.status(status).json({ error: code, message: msg });
  const noop = (req, res, next) => next();
  const deps = {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError,
    userAuth: noop,
    logRequest: noop,
    isAuthConfigured: () => false,
  };

  mountSecretsRoutes(app, deps);
  return app;
}

const scopeId = () => `test-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`;

test("POST /api/v1/secrets creates a secret", async () => {
  const app = buildApp();
  const id = scopeId();
  const res = await request(app)
    .post("/api/v1/secrets")
    .send({ scopeType: "workspace", scopeId: id, name: "MY_KEY", value: "secret-val", description: "test" });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, "MY_KEY");
  assert.ok(!res.body.encryptedValue, "encryptedValue should not be exposed");
});

test("POST /api/v1/secrets returns 400 for invalid scopeType", async () => {
  const app = buildApp();
  const res = await request(app)
    .post("/api/v1/secrets")
    .send({ scopeType: "invalid", scopeId: "x", name: "K", value: "v" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "INVALID_INPUT");
});

test("POST /api/v1/secrets returns 400 for missing name", async () => {
  const app = buildApp();
  const res = await request(app)
    .post("/api/v1/secrets")
    .send({ scopeType: "workspace", scopeId: "x" });
  assert.equal(res.status, 400);
});

test("POST /api/v1/secrets returns 400 for non-string value", async () => {
  const app = buildApp();
  const res = await request(app)
    .post("/api/v1/secrets")
    .send({ scopeType: "workspace", scopeId: "x", name: "K", value: 42 });
  assert.equal(res.status, 400);
});

test("GET /api/v1/secrets lists secrets", async () => {
  const app = buildApp();
  const id = scopeId();
  await request(app).post("/api/v1/secrets").send({ scopeType: "workspace", scopeId: id, name: "K1", value: "v1" });
  const res = await request(app)
    .get("/api/v1/secrets")
    .query({ scopeType: "workspace", scopeId: id });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.items.some((s) => s.name === "K1"));
});

test("GET /api/v1/secrets returns 400 for missing scopeId", async () => {
  const app = buildApp();
  const res = await request(app)
    .get("/api/v1/secrets")
    .query({ scopeType: "workspace" });
  assert.equal(res.status, 400);
});

test("DELETE /api/v1/secrets/:name deletes a secret", async () => {
  const app = buildApp();
  const id = scopeId();
  await request(app).post("/api/v1/secrets").send({ scopeType: "workspace", scopeId: id, name: "TO_DEL", value: "val" });
  const res = await request(app)
    .delete("/api/v1/secrets/TO_DEL")
    .query({ scopeType: "workspace", scopeId: id });
  assert.equal(res.status, 204);
});

test("DELETE /api/v1/secrets/:name returns 404 for nonexistent secret", async () => {
  const app = buildApp();
  const id = scopeId();
  const res = await request(app)
    .delete("/api/v1/secrets/NONEXISTENT")
    .query({ scopeType: "workspace", scopeId: id });
  assert.equal(res.status, 404);
});
