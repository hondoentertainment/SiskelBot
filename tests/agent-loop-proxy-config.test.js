/**
 * Unit tests for defaultBuildProxyConfig — the fallback proxy config used
 * when a caller doesn't provide its own. Covers all three BACKEND branches
 * plus header behaviors (with/without OPENAI_API_KEY, VLLM_URL trailing
 * slash, default OLLAMA fallback).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { defaultBuildProxyConfig } from "../lib/agent-loop-execute-tools.js";

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("defaultBuildProxyConfig: openai with API key returns authed headers", () => {
  withEnv({ BACKEND: "openai", OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: undefined }, () => {
    const cfg = defaultBuildProxyConfig();
    assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
    assert.equal(cfg.path, "/chat/completions");
    assert.equal(cfg.headers.Authorization, "Bearer sk-test");
    assert.equal(cfg.headers["Content-Type"], "application/json");
  });
});

test("defaultBuildProxyConfig: openai without API key omits Authorization", () => {
  withEnv({ BACKEND: "openai", OPENAI_API_KEY: undefined, OPENAI_BASE_URL: undefined }, () => {
    const cfg = defaultBuildProxyConfig();
    assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
    assert.equal(cfg.headers.Authorization, undefined);
  });
});

test("defaultBuildProxyConfig: openai honors OPENAI_BASE_URL override", () => {
  withEnv({ BACKEND: "openai", OPENAI_BASE_URL: "https://proxy.example/v1", OPENAI_API_KEY: undefined }, () => {
    const cfg = defaultBuildProxyConfig();
    assert.equal(cfg.baseUrl, "https://proxy.example/v1");
  });
});

test("defaultBuildProxyConfig: vllm strips trailing slash from VLLM_URL", () => {
  withEnv({ BACKEND: "vllm", VLLM_URL: "http://vllm.example:9000/" }, () => {
    const cfg = defaultBuildProxyConfig();
    assert.equal(cfg.baseUrl, "http://vllm.example:9000");
    assert.equal(cfg.path, "/v1/chat/completions");
  });
});

test("defaultBuildProxyConfig: vllm falls back to localhost when VLLM_URL unset", () => {
  withEnv({ BACKEND: "vllm", VLLM_URL: undefined }, () => {
    const cfg = defaultBuildProxyConfig();
    assert.equal(cfg.baseUrl, "http://localhost:8000");
  });
});

test("defaultBuildProxyConfig: unknown backend falls through to ollama defaults", () => {
  withEnv({ BACKEND: "mystery", OLLAMA_URL: undefined }, () => {
    const cfg = defaultBuildProxyConfig();
    assert.equal(cfg.baseUrl, "http://localhost:11434");
    assert.equal(cfg.path, "/v1/chat/completions");
  });
});

test("defaultBuildProxyConfig: ollama honors OLLAMA_URL override", () => {
  withEnv({ BACKEND: "ollama", OLLAMA_URL: "http://ollama.example:11500" }, () => {
    const cfg = defaultBuildProxyConfig();
    assert.equal(cfg.baseUrl, "http://ollama.example:11500");
  });
});

test("defaultBuildProxyConfig: BACKEND is lowercased before switch", () => {
  withEnv({ BACKEND: "OPENAI", OPENAI_API_KEY: "sk-z" }, () => {
    const cfg = defaultBuildProxyConfig();
    assert.equal(cfg.path, "/chat/completions");
    assert.equal(cfg.headers.Authorization, "Bearer sk-z");
  });
});

test("defaultBuildProxyConfig: missing BACKEND defaults to ollama", () => {
  withEnv({ BACKEND: undefined }, () => {
    const cfg = defaultBuildProxyConfig();
    assert.equal(cfg.path, "/v1/chat/completions");
    assert.ok(cfg.baseUrl.includes("11434") || cfg.baseUrl.startsWith("http"));
  });
});
