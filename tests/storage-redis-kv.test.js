/**
 * Tests for Redis KV enablement and durable-storage detection.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { redisKvEnabled } from "../lib/storage-redis-kv.js";
import { hasDurableStorage } from "../lib/env-data-root.js";

const prev = {
  STORAGE_BACKEND: process.env.STORAGE_BACKEND,
  REDIS_URL: process.env.REDIS_URL,
  UPSTASH_REDIS_URL: process.env.UPSTASH_REDIS_URL,
  KV_URL: process.env.KV_URL,
  VERCEL: process.env.VERCEL,
  DATABASE_URL: process.env.DATABASE_URL,
};

after(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("storage-redis-kv", () => {
  it("redisKvEnabled is false without URL", () => {
    process.env.STORAGE_BACKEND = "redis";
    delete process.env.REDIS_URL;
    delete process.env.UPSTASH_REDIS_URL;
    delete process.env.KV_URL;
    assert.equal(redisKvEnabled(), false);
  });

  it("redisKvEnabled is true with REDIS_URL", () => {
    process.env.STORAGE_BACKEND = "redis";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    assert.equal(redisKvEnabled(), true);
  });

  it("hasDurableStorage accepts redis on Vercel", () => {
    process.env.VERCEL = "1";
    process.env.STORAGE_BACKEND = "redis";
    process.env.REDIS_URL = "rediss://example.upstash.io:6379";
    delete process.env.DATABASE_URL;
    delete process.env.STORAGE_PATH;
    assert.equal(hasDurableStorage(), true);
  });
});
