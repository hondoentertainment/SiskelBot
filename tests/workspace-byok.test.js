import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import {
  setWorkspaceProviderKey,
  resolveWorkspaceProviderKey,
  applyWorkspaceByok,
  listWorkspaceByok,
  deleteWorkspaceProviderKey,
} from "../lib/workspace-byok.js";
import { mountByokRoutes } from "../routes/byok.js";

function isolate(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "byok-"));
    const prev = process.env.STORAGE_PATH;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.STORAGE_PATH = dir;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = prev;
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("workspace key overrides the env key and is not returned in full", isolate(async () => {
  process.env.OPENAI_API_KEY = "env-key-abcdefgh";
  const saved = await setWorkspaceProviderKey("default", "openai", "workspace-key-wxyz");
  assert.equal(saved.last4, "wxyz");
  assert.equal(JSON.stringify(saved).includes("workspace-key-wxyz"), false);
  const resolved = await resolveWorkspaceProviderKey("default", "openai");
  assert.equal(resolved.source, "workspace");
  assert.equal(resolved.key, "workspace-key-wxyz");
  const config = await applyWorkspaceByok(
    { baseUrl: "https://api.openai.com/v1", path: "/chat/completions", headers: { Authorization: "Bearer env-key-abcdefgh" } },
    "default",
    "openai",
  );
  assert.equal(config.headers.Authorization, "Bearer workspace-key-wxyz");
  const listed = await listWorkspaceByok("default");
  const openai = listed.find((item) => item.provider === "openai");
  assert.equal(openai.last4, "wxyz");
  assert.equal(JSON.stringify(listed).includes("workspace-key-wxyz"), false);
  await deleteWorkspaceProviderKey("default", "openai");
  const fallback = await resolveWorkspaceProviderKey("default", "openai");
  assert.equal(fallback.source, "env");
  const unchanged = await applyWorkspaceByok(
    { headers: { Authorization: "Bearer env-key-abcdefgh" } },
    "default",
    "openai",
  );
  assert.equal(unchanged.headers.Authorization, "Bearer env-key-abcdefgh");
  const local = await applyWorkspaceByok({ headers: {} }, "default", "ollama");
  assert.deepEqual(local.headers, {});
}));

test("BYOK routes store a key and never echo it", isolate(async () => {
  const app = express();
  app.use(express.json());
  mountByokRoutes(app, {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError: (res, status, code, msg) => res.status(status).json({ error: msg, code }),
    logRequest: (_q, _s, n) => n(),
    userAuth: (req, _res, next) => {
      req.userId = "ada";
      next();
    },
  });
  const bad = await request(app).put("/api/v1/workspaces/default/byok").send({ provider: "openai", apiKey: "short" });
  assert.equal(bad.status, 400);
  const unknown = await request(app).put("/api/v1/workspaces/default/byok").send({ provider: "stripe", apiKey: "sk_live_not_allowed" });
  assert.equal(unknown.status, 400);
  const saved = await request(app).put("/api/v1/workspaces/default/byok").send({
    provider: "openai",
    apiKey: "sk-workspace-12345678",
  });
  assert.equal(saved.status, 201);
  assert.equal(JSON.stringify(saved.body).includes("sk-workspace-12345678"), false);
  const listed = await request(app).get("/api/v1/workspaces/default/byok");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.find((item) => item.provider === "openai").last4, "5678");
  const removed = await request(app).delete("/api/v1/workspaces/default/byok/openai");
  assert.equal(removed.status, 200);
}));
