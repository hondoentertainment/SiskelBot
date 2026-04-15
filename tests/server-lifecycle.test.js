/**
 * Smoke test for lib/server-lifecycle.js — when VERCEL=1 the lifecycle
 * starter is a no-op, which lets us verify the function is callable
 * without binding a port or installing signal handlers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { startServerLifecycle } from "../lib/server-lifecycle.js";

test("startServerLifecycle is a function", () => {
  assert.equal(typeof startServerLifecycle, "function");
});

test("startServerLifecycle is a no-op when VERCEL=1", () => {
  const prev = process.env.VERCEL;
  process.env.VERCEL = "1";
  try {
    const app = express();
    // Should return without attempting to listen or attach handlers.
    const result = startServerLifecycle(app, {
      PORT: 0,
      BACKEND: "ollama",
      VLLM_URL: "http://localhost:8000",
      OLLAMA_URL: "http://localhost:11434",
    });
    assert.equal(result, undefined);
  } finally {
    if (prev === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prev;
  }
});
