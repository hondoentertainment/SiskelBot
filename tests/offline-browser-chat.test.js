import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  listBrowserChatModels,
  completeOfflineTurn,
  webllmEngine,
} from "../lib/offline-browser-chat.js";
import { mountOfflineModelsRoutes } from "../routes/offline-models.js";

test("browser catalog lists chat models and skips the embedding model", () => {
  const items = listBrowserChatModels();
  assert.ok(items.some((model) => model.id === "tinyllama-1.1b-q4"));
  assert.equal(items.some((model) => model.id === "nomic-embed-text-q4"), false);
  assert.ok(items.every((model) => model.webllmId));
});

test("catalog replies stay local and an injected WebLLM engine is used instead", async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    throw new Error("offline chat must not fetch");
  };
  try {
    const unknown = await completeOfflineTurn({ modelId: "nope", messages: [] });
    assert.equal(unknown.code, "UNKNOWN_MODEL");
    const local = await completeOfflineTurn({
      modelId: "tinyllama-1.1b-q4",
      messages: [{ role: "user", content: "Ship the brief" }],
    });
    assert.equal(local.ok, true);
    assert.equal(local.network, false);
    assert.equal(local.runtime, "catalog");
    assert.match(local.content, /Ship the brief/);
    assert.equal(fetched, 0);

    const engine = webllmEngine(async (id) => {
      assert.equal(id, "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC");
      return {
        chat: { completions: { create: async () => ({ choices: [{ message: { content: "from-webllm" } }] }) } },
      };
    }, { webllmId: "TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC" });
    const remote = await completeOfflineTurn({
      modelId: "tinyllama-1.1b-q4",
      messages: [{ role: "user", content: "hi" }],
      engine,
    });
    assert.equal(remote.runtime, "custom");
    assert.equal(remote.content, "from-webllm");
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("GET /models/offline/browser returns the chat catalog", async () => {
  const app = express();
  mountOfflineModelsRoutes(app, {
    apiRoute: (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers),
    apiError: (res, status, code, msg) => res.status(status).json({ error: msg, code }),
  });
  const res = await request(app).get("/api/v1/models/offline/browser");
  assert.equal(res.status, 200);
  assert.equal(res.body.runtime, "catalog");
  assert.ok(res.body.items.some((model) => model.id === "phi-2-q4"));
});
