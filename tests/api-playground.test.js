/**
 * Phase 61.1: API playground unit tests.
 * Uses a temp STORAGE_PATH so tests don't touch data/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-playground-"));
process.env.STORAGE_PATH = tempDir;

const {
  CODE_GENERATORS,
  generateCurl,
  generateJavaScript,
  generatePython,
  generateGo,
  generateRust,
  generateRuby,
  generateCode,
  listSupportedLanguages,
  saveRequest,
  getHistory,
  clearHistory,
  createCollection,
  getCollection,
  listCollections,
  addRequestToCollection,
  removeRequestFromCollection,
  deleteCollection,
  saveEnvironment,
  getEnvironment,
  listEnvironments,
  substituteVariables,
  exportCollection,
  importCollection,
  importPostmanCollection,
  getEndpointsFromSpec,
  generateRequestFromOperation,
} = await import("../lib/api-playground.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ─── Code generators ────────────────────────────────────────────────────────

test("CODE_GENERATORS exposes all six supported languages", () => {
  const langs = Object.keys(CODE_GENERATORS);
  for (const expected of ["curl", "javascript", "python", "go", "rust", "ruby"]) {
    assert.ok(langs.includes(expected), `missing ${expected}`);
  }
  assert.equal(langs.length, 6);
  assert.deepEqual(listSupportedLanguages().sort(), ["curl", "go", "javascript", "python", "ruby", "rust"]);
});

test("generateCurl produces a shell-escaped curl command", () => {
  const code = generateCurl("https://api.example.com/v1/ping", "POST", { hello: "world's" }, {
    "Content-Type": "application/json",
    "X-Token": "abc",
  });
  assert.match(code, /curl -X POST 'https:\/\/api\.example\.com\/v1\/ping'/);
  assert.match(code, /-H 'Content-Type: application\/json'/);
  assert.match(code, /-H 'X-Token: abc'/);
  // body is single-quoted and embedded quotes escaped via '\''
  assert.match(code, /--data '[\s\S]*world'\\''s[\s\S]*'/);
});

test("generateJavaScript produces fetch() code with headers and body", () => {
  const code = generateJavaScript("/api/v1/foo", "POST", { a: 1 }, { "X-Key": "k" });
  assert.match(code, /await fetch\("\/api\/v1\/foo",/);
  assert.match(code, /"method":\s*"POST"/);
  assert.match(code, /"X-Key":\s*"k"/);
  assert.match(code, /"body":/);
  assert.match(code, /console\.log\(data\);/);
});

test("generatePython uses the requests library with data and headers", () => {
  const code = generatePython("https://x.test/path", "PUT", { foo: "bar" }, { Authorization: "Bearer k" });
  assert.match(code, /^import requests/);
  assert.match(code, /url = "https:\/\/x\.test\/path"/);
  assert.match(code, /"Authorization":/);
  assert.match(code, /response = requests\.request\("put", url, headers=headers, data=data\)/);
  assert.match(code, /print\(response\.status_code\)/);
});

test("generateGo emits net/http client code", () => {
  const code = generateGo("https://x.test/", "POST", { ok: true }, { "X-Y": "z" });
  assert.match(code, /package main/);
  assert.match(code, /"net\/http"/);
  assert.match(code, /"strings"/);
  assert.match(code, /http\.NewRequest\("POST"/);
  assert.match(code, /req\.Header\.Set\("X-Y", "z"\)/);
  assert.match(code, /http\.DefaultClient\.Do\(req\)/);
});

test("generateGo skips strings import when no body", () => {
  const code = generateGo("https://x.test/", "GET", null, {});
  assert.doesNotMatch(code, /"strings"/);
  assert.match(code, /http\.NewRequest\("GET",.*, nil\)/);
});

test("generateRust emits reqwest blocking code", () => {
  const code = generateRust("https://x.test/", "POST", "hello", { Accept: "text/plain" });
  assert.match(code, /use reqwest::blocking::Client;/);
  assert.match(code, /Client::new\(\)/);
  assert.match(code, /client\.post\("https:\/\/x\.test\/"\)/);
  assert.match(code, /\.header\("Accept", "text\/plain"\)/);
  assert.match(code, /\.body\("hello"\)/);
  assert.match(code, /\.send\(\)\?;/);
});

test("generateRuby emits net/http request code", () => {
  const code = generateRuby("https://x.test/p", "DELETE", null, { "X-K": "v" });
  assert.match(code, /require "net\/http"/);
  assert.match(code, /URI\("https:\/\/x\.test\/p"\)/);
  assert.match(code, /Net::HTTP::Delete\.new/);
  assert.match(code, /request\["X-K"\] = "v"/);
  assert.match(code, /http\.request\(request\)/);
});

test("generateCode dispatches to the correct language generator", () => {
  const req = { endpoint: "/x", method: "GET", body: null, headers: {} };
  assert.match(generateCode("curl", req), /curl -X GET/);
  assert.match(generateCode("javascript", req), /await fetch/);
  assert.match(generateCode("python", req), /import requests/);
  assert.match(generateCode("go", req), /package main/);
  assert.match(generateCode("rust", req), /reqwest/);
  assert.match(generateCode("ruby", req), /net\/http/);
  assert.throws(() => generateCode("cobol", req), /Unsupported language/);
});

// ─── History ────────────────────────────────────────────────────────────────

test("saveRequest + getHistory round-trip a request", async () => {
  await clearHistory("alice");
  const entry = await saveRequest("alice", {
    endpoint: "/api/v1/ping",
    method: "get",
    body: null,
    headers: {},
    status: 200,
    elapsedMs: 12,
  });
  assert.ok(entry.id, "id assigned");
  assert.equal(entry.method, "GET");
  const hist = await getHistory("alice", 10);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].endpoint, "/api/v1/ping");
});

test("clearHistory empties the user's history", async () => {
  await saveRequest("bob", { endpoint: "/a", method: "POST" });
  await saveRequest("bob", { endpoint: "/b", method: "POST" });
  let hist = await getHistory("bob", 10);
  assert.equal(hist.length, 2);
  await clearHistory("bob");
  hist = await getHistory("bob", 10);
  assert.equal(hist.length, 0);
});

// ─── Collections ────────────────────────────────────────────────────────────

test("createCollection and getCollection round-trip", async () => {
  const col = await createCollection("carol", "My APIs", [
    { endpoint: "/v1/a", method: "GET" },
  ]);
  assert.ok(col.id.startsWith("col_"));
  assert.equal(col.name, "My APIs");
  assert.equal(col.requests.length, 1);
  const fetched = await getCollection(col.id);
  assert.equal(fetched.id, col.id);
  assert.equal(fetched.requests[0].endpoint, "/v1/a");
  const all = await listCollections("carol");
  assert.ok(all.some((c) => c.id === col.id));
});

test("addRequestToCollection appends a request", async () => {
  const col = await createCollection("dave", "c");
  const added = await addRequestToCollection(col.id, {
    endpoint: "/new",
    method: "POST",
    body: { ok: true },
    name: "new req",
  });
  const fetched = await getCollection(col.id);
  assert.equal(fetched.requests.length, 1);
  assert.equal(fetched.requests[0].id, added.id);
  assert.equal(fetched.requests[0].method, "POST");
});

test("removeRequestFromCollection removes by id", async () => {
  const col = await createCollection("eve", "c");
  const a = await addRequestToCollection(col.id, { endpoint: "/x", method: "GET" });
  await addRequestToCollection(col.id, { endpoint: "/y", method: "GET" });
  const result = await removeRequestFromCollection(col.id, a.id);
  assert.equal(result.ok, true);
  const fetched = await getCollection(col.id);
  assert.equal(fetched.requests.length, 1);
  assert.equal(fetched.requests[0].endpoint, "/y");
});

test("deleteCollection marks collection as deleted", async () => {
  const col = await createCollection("frank", "c");
  const del = await deleteCollection(col.id);
  assert.equal(del.ok, true);
  const fetched = await getCollection(col.id);
  assert.equal(fetched, null);
});

// ─── Environments ───────────────────────────────────────────────────────────

test("saveEnvironment and getEnvironment round-trip variables", async () => {
  const env = await saveEnvironment("gina", "staging", {
    BASE_URL: "https://staging.example.com",
    TOKEN: "tok",
  });
  assert.equal(env.name, "staging");
  assert.equal(env.vars.BASE_URL, "https://staging.example.com");
  const fetched = await getEnvironment("gina", "staging");
  assert.deepEqual(fetched.vars, { BASE_URL: "https://staging.example.com", TOKEN: "tok" });
  const list = await listEnvironments("gina");
  assert.ok(list.some((e) => e.name === "staging"));
});

// ─── Variable substitution ──────────────────────────────────────────────────

test("substituteVariables replaces {{var}} tokens recursively", () => {
  const tpl = {
    url: "{{BASE_URL}}/ping",
    headers: { Authorization: "Bearer {{TOKEN}}" },
    body: ["hi {{NAME}}", "literal"],
  };
  const out = substituteVariables(tpl, { BASE_URL: "https://x", TOKEN: "t", NAME: "world" });
  assert.equal(out.url, "https://x/ping");
  assert.equal(out.headers.Authorization, "Bearer t");
  assert.equal(out.body[0], "hi world");
  // Unknown tokens stay as-is
  const unknown = substituteVariables("hello {{MISSING}}", {});
  assert.equal(unknown, "hello {{MISSING}}");
});

// ─── Import / export ────────────────────────────────────────────────────────

test("exportCollection in JSON format is valid JSON with schema tag", () => {
  const col = { name: "N", requests: [{ id: "r1", endpoint: "/p", method: "GET" }] };
  const out = exportCollection(col, "json");
  const parsed = JSON.parse(out);
  assert.equal(parsed.schema, "siskelbot.playground.collection/v1");
  assert.equal(parsed.name, "N");
  assert.equal(parsed.requests.length, 1);
});

test("importCollection round-trips a native JSON export", () => {
  const col = {
    name: "Round",
    requests: [{ id: "r1", endpoint: "/p", method: "POST", body: '{"a":1}', headers: { "X": "y" } }],
  };
  const exported = exportCollection(col, "json");
  const imported = importCollection(exported, "json");
  assert.equal(imported.name, "Round");
  assert.equal(imported.requests.length, 1);
  assert.equal(imported.requests[0].method, "POST");
  assert.equal(imported.requests[0].endpoint, "/p");
});

test("importPostmanCollection transforms Postman v2.1 JSON", () => {
  const postman = {
    info: { name: "Sample" },
    item: [
      {
        name: "Get root",
        request: {
          method: "GET",
          header: [{ key: "X-Test", value: "1" }],
          url: { raw: "https://x.test/" },
        },
      },
      {
        name: "Folder",
        item: [
          {
            name: "Post",
            request: {
              method: "POST",
              header: [],
              url: "https://x.test/p",
              body: { mode: "raw", raw: '{"a":1}' },
            },
          },
        ],
      },
    ],
  };
  const imported = importPostmanCollection(postman);
  assert.equal(imported.name, "Sample");
  assert.equal(imported.requests.length, 2);
  assert.equal(imported.requests[0].endpoint, "https://x.test/");
  assert.equal(imported.requests[0].headers["X-Test"], "1");
  assert.equal(imported.requests[1].method, "POST");
  assert.equal(imported.requests[1].body, '{"a":1}');
});

// ─── OpenAPI integration ────────────────────────────────────────────────────

test("getEndpointsFromSpec parses an OpenAPI 3.0 spec", async () => {
  const spec = {
    openapi: "3.0.0",
    paths: {
      "/widgets": {
        get: { operationId: "listWidgets", summary: "List widgets" },
        post: { operationId: "createWidget", summary: "Create a widget", requestBody: {} },
      },
      "/widgets/{id}": {
        get: {
          operationId: "getWidget",
          parameters: [{ name: "id", in: "path", required: true }],
        },
      },
    },
  };
  const endpoints = await getEndpointsFromSpec(spec);
  assert.equal(endpoints.length, 3);
  const ids = endpoints.map((e) => e.operationId).sort();
  assert.deepEqual(ids, ["createWidget", "getWidget", "listWidgets"]);
  const getWidget = endpoints.find((e) => e.operationId === "getWidget");
  assert.equal(getWidget.method, "GET");
  assert.equal(getWidget.path, "/widgets/{id}");
  assert.equal(getWidget.parameters.length, 1);
});

test("generateRequestFromOperation fills path and query params", async () => {
  const op = {
    method: "GET",
    path: "/widgets/{id}",
    parameters: [
      { name: "id", in: "path" },
      { name: "color", in: "query" },
      { name: "X-Tag", in: "header" },
    ],
    requestBody: null,
  };
  const req = await generateRequestFromOperation(op, { id: "42", color: "red", "X-Tag": "v" });
  assert.equal(req.method, "GET");
  assert.equal(req.endpoint, "/widgets/42?color=red");
  assert.equal(req.headers["X-Tag"], "v");
});
