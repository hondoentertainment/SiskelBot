/**
 * Tests for lib/logger.js — structured JSON logging.
 */
import test from "node:test";
import assert from "node:assert/strict";

// We need to control LOG_FORMAT before importing, so we test by
// manipulating env and dynamically importing the module each time.

test("JSON format: outputs valid JSON with expected fields", async (t) => {
  const original = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "json";
  // Clear module cache by using a query string
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-json1`);
  const log = createLogger("test-module");

  const lines = [];
  const origLog = console.log;
  console.log = (msg) => lines.push(msg);
  try {
    log.info("hello world", { foo: "bar" });
  } finally {
    console.log = origLog;
    if (original !== undefined) process.env.LOG_FORMAT = original;
    else delete process.env.LOG_FORMAT;
  }

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.module, "test-module");
  assert.equal(parsed.message, "hello world");
  assert.equal(parsed.foo, "bar");
  assert.ok(parsed.timestamp, "should have timestamp");
});

test("JSON format: uses console.error for error level", async (t) => {
  const original = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "json";
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-json2`);
  const log = createLogger("err-mod");

  const lines = [];
  const origError = console.error;
  console.error = (msg) => lines.push(msg);
  try {
    log.error("something broke", { code: 500 });
  } finally {
    console.error = origError;
    if (original !== undefined) process.env.LOG_FORMAT = original;
    else delete process.env.LOG_FORMAT;
  }

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, "error");
  assert.equal(parsed.message, "something broke");
  assert.equal(parsed.code, 500);
});

test("JSON format: uses console.warn for warn level", async (t) => {
  const original = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "json";
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-json3`);
  const log = createLogger("warn-mod");

  const lines = [];
  const origWarn = console.warn;
  console.warn = (msg) => lines.push(msg);
  try {
    log.warn("be careful");
  } finally {
    console.warn = origWarn;
    if (original !== undefined) process.env.LOG_FORMAT = original;
    else delete process.env.LOG_FORMAT;
  }

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.module, "warn-mod");
});

test("JSON format: redacts sensitive fields", async (t) => {
  const original = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "json";
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-json4`);
  const log = createLogger("sec");

  const lines = [];
  const origLog = console.log;
  console.log = (msg) => lines.push(msg);
  try {
    log.info("auth attempt", { apiKey: "sk-secret-123", token: "tok-abc", password: "hunter2", user: "alice" });
  } finally {
    console.log = origLog;
    if (original !== undefined) process.env.LOG_FORMAT = original;
    else delete process.env.LOG_FORMAT;
  }

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.apiKey, "[REDACTED]");
  assert.equal(parsed.token, "[REDACTED]");
  assert.equal(parsed.password, "[REDACTED]");
  assert.equal(parsed.user, "alice", "non-sensitive fields should pass through");
});

test("pretty format: outputs module prefix and message", async (t) => {
  const original = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "pretty";
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-pretty1`);
  const log = createLogger("my-mod");

  const calls = [];
  const origLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    log.info("server started");
  } finally {
    console.log = origLog;
    if (original !== undefined) process.env.LOG_FORMAT = original;
    else delete process.env.LOG_FORMAT;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "[my-mod]");
  assert.equal(calls[0][1], "server started");
});

test("pretty format: includes data as formatted JSON", async (t) => {
  const original = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "pretty";
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-pretty2`);
  const log = createLogger("data-mod");

  const calls = [];
  const origLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    log.info("with data", { port: 3000 });
  } finally {
    console.log = origLog;
    if (original !== undefined) process.env.LOG_FORMAT = original;
    else delete process.env.LOG_FORMAT;
  }

  assert.equal(calls.length, 1);
  const dataStr = calls[0][2];
  assert.ok(dataStr.includes('"port": 3000'), "should include pretty-printed data");
});

test("pretty format: error level uses console.error", async (t) => {
  const original = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "pretty";
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-pretty3`);
  const log = createLogger("err-pretty");

  const calls = [];
  const origError = console.error;
  console.error = (...args) => calls.push(args);
  try {
    log.error("fail");
  } finally {
    console.error = origError;
    if (original !== undefined) process.env.LOG_FORMAT = original;
    else delete process.env.LOG_FORMAT;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "[err-pretty]");
  assert.equal(calls[0][1], "fail");
});

test("debug level outputs via console.log in JSON mode", async (t) => {
  const original = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "json";
  const { createLogger } = await import(`../lib/logger.js?t=${Date.now()}-debug`);
  const log = createLogger("dbg");

  const lines = [];
  const origLog = console.log;
  console.log = (msg) => lines.push(msg);
  try {
    log.debug("trace info", { detail: 42 });
  } finally {
    console.log = origLog;
    if (original !== undefined) process.env.LOG_FORMAT = original;
    else delete process.env.LOG_FORMAT;
  }

  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, "debug");
  assert.equal(parsed.detail, 42);
});

test("default export logger uses 'app' module", async (t) => {
  const original = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = "json";
  const { logger } = await import(`../lib/logger.js?t=${Date.now()}-default`);

  const lines = [];
  const origLog = console.log;
  console.log = (msg) => lines.push(msg);
  try {
    logger.info("test");
  } finally {
    console.log = origLog;
    if (original !== undefined) process.env.LOG_FORMAT = original;
    else delete process.env.LOG_FORMAT;
  }

  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.module, "app");
});
