import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeForLog, sanitizeRequestForLog } from "../lib/log-sanitizer.js";

test("sanitizeForLog returns null/undefined as-is", () => {
  assert.equal(sanitizeForLog(null), null);
  assert.equal(sanitizeForLog(undefined), undefined);
});

test("sanitizeForLog returns primitives as-is", () => {
  assert.equal(sanitizeForLog(42), 42);
  assert.equal(sanitizeForLog("hello"), "hello");
  assert.equal(sanitizeForLog(true), true);
});

test("sanitizeForLog redacts api_key", () => {
  const result = sanitizeForLog({ api_key: "sk-secret123", name: "test" });
  assert.equal(result.api_key, "[REDACTED]");
  assert.equal(result.name, "test");
});

test("sanitizeForLog redacts apiKey (camelCase)", () => {
  const result = sanitizeForLog({ apiKey: "sk-secret123" });
  assert.equal(result.apiKey, "[REDACTED]");
});

test("sanitizeForLog redacts password", () => {
  const result = sanitizeForLog({ password: "hunter2" });
  assert.equal(result.password, "[REDACTED]");
});

test("sanitizeForLog redacts token", () => {
  const result = sanitizeForLog({ token: "abc123" });
  assert.equal(result.token, "[REDACTED]");
});

test("sanitizeForLog redacts authorization", () => {
  const result = sanitizeForLog({ authorization: "Bearer xyz" });
  assert.equal(result.authorization, "[REDACTED]");
});

test("sanitizeForLog redacts secret", () => {
  const result = sanitizeForLog({ secret: "topsecret" });
  assert.equal(result.secret, "[REDACTED]");
});

test("sanitizeForLog redacts cookie", () => {
  const result = sanitizeForLog({ cookie: "session=abc" });
  assert.equal(result.cookie, "[REDACTED]");
});

test("sanitizeForLog redacts x-api-key", () => {
  const result = sanitizeForLog({ "x-api-key": "mykey" });
  assert.equal(result["x-api-key"], "[REDACTED]");
});

test("sanitizeForLog handles nested objects", () => {
  const result = sanitizeForLog({
    user: { name: "Alice", password: "secret" },
    data: "visible",
  });
  assert.equal(result.user.password, "[REDACTED]");
  assert.equal(result.user.name, "Alice");
  assert.equal(result.data, "visible");
});

test("sanitizeForLog handles arrays", () => {
  const result = sanitizeForLog([
    { token: "abc", value: 1 },
    { token: "def", value: 2 },
  ]);
  assert.ok(Array.isArray(result));
  assert.equal(result[0].token, "[REDACTED]");
  assert.equal(result[0].value, 1);
  assert.equal(result[1].token, "[REDACTED]");
});

test("sanitizeForLog does not redact null/undefined values", () => {
  const result = sanitizeForLog({ api_key: null, token: undefined });
  assert.equal(result.api_key, null);
  assert.equal(result.token, undefined);
});

test("sanitizeRequestForLog redacts sensitive headers", () => {
  const req = {
    method: "POST",
    path: "/api/chat",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret",
      "x-api-key": "mykey",
      cookie: "session=abc",
    },
    body: { message: "hello", apiKey: "sk-123" },
  };
  const result = sanitizeRequestForLog(req);
  assert.equal(result.method, "POST");
  assert.equal(result.path, "/api/chat");
  assert.equal(result.headers.authorization, "[REDACTED]");
  assert.equal(result.headers["x-api-key"], "[REDACTED]");
  assert.equal(result.headers.cookie, "[REDACTED]");
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.body.apiKey, "[REDACTED]");
  assert.equal(result.body.message, "hello");
});

test("sanitizeRequestForLog handles null req", () => {
  const result = sanitizeRequestForLog(null);
  assert.deepEqual(result, {});
});
