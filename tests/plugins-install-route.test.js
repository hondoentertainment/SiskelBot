/**
 * Tests for the polished plugin install/state/enable/disable/uninstall routes
 * added to routes/plugins.js, including the in-memory job tracker.
 *
 * Uses a minimal Express app with the same deps contract other route modules
 * use (apiRoute / apiError / logRequest + rate-limit no-ops).
 */

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { mountPluginRoutes, INSTALL_JOBS } from "../routes/plugins.js";
import { registry as marketplaceRegistry, installPack, uninstallPack } from "../lib/plugin-marketplace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const STATE_FILE = join(PROJECT_ROOT, "data", "plugins-state.json");
const INSTALLED_FILE = join(PROJECT_ROOT, "data", "marketplace-installed.json");

// Unique-ish workspace id per test to avoid cross-contamination.
function uniqueWorkspace() {
  return "ws_test_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

function registerFakePack(id = "fake-pack-" + Date.now().toString(36)) {
  const manifest = {
    id,
    name: "Fake " + id,
    version: "1.0.0",
    description: "Route-test fake pack",
    author: "Tester",
    category: "test",
    actions: [{ name: "do", type: "builtin", config: { target: "build" } }],
  };
  marketplaceRegistry.set(id, manifest);
  return manifest;
}

function buildApp({ authed = true, installImpl, uninstallImpl } = {}) {
  const app = express();
  app.use(express.json());

  // Track which auth/rate-limit middlewares were invoked for a basic sanity check.
  const calls = { userAuth: 0 };

  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
      app[method](`/api${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    userAuth: (req, res, next) => {
      calls.userAuth++;
      if (!authed) {
        return res.status(401).json({ error: "auth required", code: "UNAUTHORIZED" });
      }
      next();
    },
    logRequest: (req, res, next) => next(),
    pluginsActionsRateLimiter: (req, res, next) => next(),
    marketplaceRateLimiter: (req, res, next) => next(),
    getRegisteredActions: () => new Set(),
    listJsPlugins: () => [],
    execJsPlugin: async () => ({ output: "" }),
    marketplaceListAvailable: () => [],
    marketplaceRegistry,
    marketplaceInstallPack: installImpl || installPack,
    marketplaceUninstallPack: uninstallImpl || uninstallPack,
    marketplaceListInstalled: () => [],
    join,
    __dirname: PROJECT_ROOT,
  };

  mountPluginRoutes(app, deps);
  return { app, calls };
}

async function waitJobDone(app, jobId, workspaceId) {
  for (let i = 0; i < 50; i++) {
    const r = await request(app)
      .get(`/api/v1/plugins/jobs/${encodeURIComponent(jobId)}?workspaceId=${workspaceId}`);
    if (r.status === 200 && (r.body.status === "done" || r.body.status === "error")) return r.body;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("job did not finish in time");
}

function resetPluginTestState() {
  // Clean up only the files created by these tests.
  if (existsSync(STATE_FILE)) rmSync(STATE_FILE, { force: true });
  if (existsSync(INSTALLED_FILE)) rmSync(INSTALLED_FILE, { force: true });
  INSTALL_JOBS.clear();
}

test("install -> job tracking -> done flow", async () => {
  resetPluginTestState();
  const pack = registerFakePack();
  const workspaceId = uniqueWorkspace();
  const { app } = buildApp();

  const res = await request(app)
    .post(`/api/v1/plugins/${pack.id}/install`)
    .send({ workspaceId });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.jobId, "install returns a jobId");

  const job = await waitJobDone(app, res.body.jobId, workspaceId);
  assert.equal(job.status, "done");
  assert.equal(job.progress, 1);
  assert.equal(job.packId, pack.id);

  // state reflects installed+enabled
  const state = await request(app)
    .get(`/api/v1/plugins/${pack.id}/state?workspaceId=${workspaceId}`);
  assert.equal(state.status, 200);
  assert.equal(state.body.installed, true);
  assert.equal(state.body.enabled, true);
  assert.equal(state.body.version, "1.0.0");

  marketplaceRegistry.delete(pack.id);
});

test("double-install short-circuits with alreadyInstalled", async () => {
  resetPluginTestState();
  const pack = registerFakePack();
  const workspaceId = uniqueWorkspace();
  const { app } = buildApp();

  const r1 = await request(app).post(`/api/v1/plugins/${pack.id}/install`).send({ workspaceId });
  await waitJobDone(app, r1.body.jobId, workspaceId);

  const r2 = await request(app).post(`/api/v1/plugins/${pack.id}/install`).send({ workspaceId });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.alreadyInstalled, true, "second install returns alreadyInstalled");

  // And the synthetic job is immediately 'done'.
  const j = await request(app).get(`/api/v1/plugins/jobs/${r2.body.jobId}`);
  assert.equal(j.status, 200);
  assert.equal(j.body.status, "done");
  assert.equal(j.body.alreadyInstalled, true);

  marketplaceRegistry.delete(pack.id);
});

test("enable and disable update install state", async () => {
  resetPluginTestState();
  const pack = registerFakePack();
  const workspaceId = uniqueWorkspace();
  const { app } = buildApp();

  const r = await request(app).post(`/api/v1/plugins/${pack.id}/install`).send({ workspaceId });
  await waitJobDone(app, r.body.jobId, workspaceId);

  const dis = await request(app).post(`/api/v1/plugins/${pack.id}/disable`).send({ workspaceId });
  assert.equal(dis.status, 200);
  assert.equal(dis.body.enabled, false);

  const s1 = await request(app).get(`/api/v1/plugins/${pack.id}/state?workspaceId=${workspaceId}`);
  assert.equal(s1.body.enabled, false);
  assert.equal(s1.body.installed, true);

  const en = await request(app).post(`/api/v1/plugins/${pack.id}/enable`).send({ workspaceId });
  assert.equal(en.status, 200);
  assert.equal(en.body.enabled, true);

  const s2 = await request(app).get(`/api/v1/plugins/${pack.id}/state?workspaceId=${workspaceId}`);
  assert.equal(s2.body.enabled, true);

  marketplaceRegistry.delete(pack.id);
});

test("uninstall removes install state", async () => {
  resetPluginTestState();
  const pack = registerFakePack();
  const workspaceId = uniqueWorkspace();
  const { app } = buildApp();

  const r = await request(app).post(`/api/v1/plugins/${pack.id}/install`).send({ workspaceId });
  await waitJobDone(app, r.body.jobId, workspaceId);

  const del = await request(app).delete(`/api/v1/plugins/${pack.id}?workspaceId=${workspaceId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  const s = await request(app).get(`/api/v1/plugins/${pack.id}/state?workspaceId=${workspaceId}`);
  assert.equal(s.status, 200);
  assert.equal(s.body.installed, false);
  assert.equal(s.body.enabled, false);

  marketplaceRegistry.delete(pack.id);
});

test("404 when enabling/disabling/uninstalling a pack that isn't installed", async () => {
  resetPluginTestState();
  const pack = registerFakePack();
  const workspaceId = uniqueWorkspace();
  const { app } = buildApp();

  const en = await request(app).post(`/api/v1/plugins/${pack.id}/enable`).send({ workspaceId });
  assert.equal(en.status, 404);

  const dis = await request(app).post(`/api/v1/plugins/${pack.id}/disable`).send({ workspaceId });
  assert.equal(dis.status, 404);

  const del = await request(app).delete(`/api/v1/plugins/${pack.id}?workspaceId=${workspaceId}`);
  assert.equal(del.status, 404);

  marketplaceRegistry.delete(pack.id);
});

test("GET /plugins/jobs/:id returns 404 for unknown jobs", async () => {
  resetPluginTestState();
  const { app } = buildApp();
  const res = await request(app).get("/api/v1/plugins/jobs/does-not-exist");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("install reports error job when the installer fails", async () => {
  resetPluginTestState();
  const pack = registerFakePack();
  const workspaceId = uniqueWorkspace();
  const { app } = buildApp({
    installImpl: () => ({ ok: false, error: "boom: registry unreachable" }),
  });

  const r = await request(app).post(`/api/v1/plugins/${pack.id}/install`).send({ workspaceId });
  assert.equal(r.status, 200);
  const job = await waitJobDone(app, r.body.jobId, workspaceId);
  assert.equal(job.status, "error");
  assert.match(job.error, /boom/);

  marketplaceRegistry.delete(pack.id);
});

test("state endpoint requires auth (userAuth middleware applied)", async () => {
  resetPluginTestState();
  const pack = registerFakePack();
  const workspaceId = uniqueWorkspace();
  const { app } = buildApp({ authed: false });

  const state = await request(app).get(`/api/v1/plugins/${pack.id}/state?workspaceId=${workspaceId}`);
  assert.equal(state.status, 401);

  const inst = await request(app).post(`/api/v1/plugins/${pack.id}/install`).send({ workspaceId });
  assert.equal(inst.status, 401);

  const en = await request(app).post(`/api/v1/plugins/${pack.id}/enable`).send({ workspaceId });
  assert.equal(en.status, 401);

  const dis = await request(app).post(`/api/v1/plugins/${pack.id}/disable`).send({ workspaceId });
  assert.equal(dis.status, 401);

  const del = await request(app).delete(`/api/v1/plugins/${pack.id}?workspaceId=${workspaceId}`);
  assert.equal(del.status, 401);

  marketplaceRegistry.delete(pack.id);
});

test.after(() => {
  resetPluginTestState();
});
