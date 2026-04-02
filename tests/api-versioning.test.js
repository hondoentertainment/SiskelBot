import test from "node:test";
import assert from "node:assert/strict";
import {
  versionDetection,
  filterByVersion,
  versionedResponse,
  RESPONSE_SCHEMAS,
  VERSION_CHANGELOG,
} from "../lib/api-versioning.js";

// --- versionDetection middleware ---

function makeFakeReq(path, headers = {}) {
  return { path, headers };
}

function runDetection(req) {
  const mw = versionDetection();
  let called = false;
  mw(req, {}, () => { called = true; });
  return { called, version: req.apiVersion };
}

test("versionDetection: /api/v1/ path sets v1", () => {
  const { called, version } = runDetection(makeFakeReq("/api/v1/chat"));
  assert.equal(version, "v1");
  assert.ok(called);
});

test("versionDetection: /api/v2/ path sets v2", () => {
  const { version } = runDetection(makeFakeReq("/api/v2/chat"));
  assert.equal(version, "v2");
});

test("versionDetection: /api/v2 exact path sets v2", () => {
  const { version } = runDetection(makeFakeReq("/api/v2"));
  assert.equal(version, "v2");
});

test("versionDetection: Accept header vnd.siskelbot.v2+json sets v2", () => {
  const { version } = runDetection(makeFakeReq("/some/path", { accept: "application/vnd.siskelbot.v2+json" }));
  assert.equal(version, "v2");
});

test("versionDetection: Accept header vnd.siskelbot.v1+json sets v1", () => {
  const { version } = runDetection(makeFakeReq("/some/path", { accept: "application/vnd.siskelbot.v1+json" }));
  assert.equal(version, "v1");
});

test("versionDetection: unknown Accept header version falls back to v1", () => {
  const { version } = runDetection(makeFakeReq("/some/path", { accept: "application/vnd.siskelbot.v99+json" }));
  assert.equal(version, "v1");
});

test("versionDetection: no path prefix no header defaults to v1", () => {
  const { version } = runDetection(makeFakeReq("/other"));
  assert.equal(version, "v1");
});

test("versionDetection: path takes precedence over Accept header", () => {
  const { version } = runDetection(makeFakeReq("/api/v1/chat", { accept: "application/vnd.siskelbot.v2+json" }));
  assert.equal(version, "v1");
});

// --- filterByVersion ---

test("filterByVersion: v1 strips extra fields from chat.completion", () => {
  const data = {
    id: "123", object: "chat.completion", created: 1, model: "m",
    choices: [], usage: {}, serverTiming: 42, traceId: "t", cached: true, extra: "x",
  };
  const result = filterByVersion(data, "chat.completion", "v1");
  assert.deepEqual(Object.keys(result).sort(), ["choices", "created", "id", "model", "object", "usage"]);
  assert.equal(result.serverTiming, undefined);
  assert.equal(result.traceId, undefined);
  assert.equal(result.extra, undefined);
});

test("filterByVersion: v2 includes extra fields for chat.completion", () => {
  const data = {
    id: "123", object: "chat.completion", created: 1, model: "m",
    choices: [], usage: {}, serverTiming: 42, traceId: "t", cached: true, extra: "x",
  };
  const result = filterByVersion(data, "chat.completion", "v2");
  assert.equal(result.serverTiming, 42);
  assert.equal(result.traceId, "t");
  assert.equal(result.cached, true);
  assert.equal(result.extra, undefined); // not in v2 schema either
});

test("filterByVersion: unknown schema key returns data unmodified", () => {
  const data = { foo: "bar" };
  const result = filterByVersion(data, "unknown.endpoint", "v1");
  assert.deepEqual(result, data);
});

test("filterByVersion: unknown version returns data unmodified", () => {
  const data = { foo: "bar" };
  const result = filterByVersion(data, "chat.completion", "v99");
  assert.deepEqual(result, data);
});

test("filterByVersion: null data returns null", () => {
  assert.equal(filterByVersion(null, "chat.completion", "v1"), null);
});

test("filterByVersion: array data returns array unmodified", () => {
  const arr = [1, 2, 3];
  assert.deepEqual(filterByVersion(arr, "chat.completion", "v1"), arr);
});

// --- versionedResponse ---

test("versionedResponse: sets X-API-Version header", () => {
  const setHeaders = {};
  let jsonPayload;
  const res = {
    req: { apiVersion: "v2" },
    setHeader(k, v) { setHeaders[k] = v; },
    json(data) { jsonPayload = data; },
  };
  versionedResponse(res, { id: "1", model: "m", choices: [] }, { schemaKey: "chat.completion" });
  assert.equal(setHeaders["X-API-Version"], "v2");
  assert.ok(jsonPayload);
});

test("versionedResponse: sets Sunset header when deprecated", () => {
  const setHeaders = {};
  const res = {
    req: { apiVersion: "v1" },
    setHeader(k, v) { setHeaders[k] = v; },
    json() {},
  };
  versionedResponse(res, {}, { deprecated: true });
  assert.ok(setHeaders["Sunset"]);
});

test("versionedResponse: no Sunset header when not deprecated", () => {
  const setHeaders = {};
  const res = {
    req: { apiVersion: "v1" },
    setHeader(k, v) { setHeaders[k] = v; },
    json() {},
  };
  versionedResponse(res, {}, {});
  assert.equal(setHeaders["Sunset"], undefined);
});

test("versionedResponse: filters response using schemaKey", () => {
  let jsonPayload;
  const res = {
    req: { apiVersion: "v1" },
    setHeader() {},
    json(data) { jsonPayload = data; },
  };
  versionedResponse(res, { id: "1", model: "m", serverTiming: 99 }, { schemaKey: "chat.completion" });
  assert.equal(jsonPayload.serverTiming, undefined);
  assert.equal(jsonPayload.id, "1");
});

test("versionedResponse: version option overrides req.apiVersion", () => {
  const setHeaders = {};
  const res = {
    req: { apiVersion: "v1" },
    setHeader(k, v) { setHeaders[k] = v; },
    json() {},
  };
  versionedResponse(res, {}, { version: "v2" });
  assert.equal(setHeaders["X-API-Version"], "v2");
});

// --- Schema registry ---

test("RESPONSE_SCHEMAS has v1 and v2 keys", () => {
  assert.ok(RESPONSE_SCHEMAS.v1);
  assert.ok(RESPONSE_SCHEMAS.v2);
});

test("v2 chat.completion schema is a superset of v1", () => {
  for (const field of RESPONSE_SCHEMAS.v1["chat.completion"]) {
    assert.ok(RESPONSE_SCHEMAS.v2["chat.completion"].includes(field), `v2 missing v1 field: ${field}`);
  }
});

test("VERSION_CHANGELOG has entries for v1 and v2", () => {
  assert.ok(VERSION_CHANGELOG.v1);
  assert.ok(VERSION_CHANGELOG.v2);
  assert.equal(VERSION_CHANGELOG.v1.status, "stable");
  assert.equal(VERSION_CHANGELOG.v2.status, "current");
});
