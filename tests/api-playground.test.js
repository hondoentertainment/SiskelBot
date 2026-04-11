/**
 * Phase 61.1: api-playground tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-playground-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  saveRequest,
  loadRequest,
  generateCode,
  listLanguages,
  listSavedRequests,
  deleteRequest,
  normalizeRequest,
  generateCurl,
  generateJs,
  generatePython,
} = await import("../lib/api-playground.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("normalizeRequest applies defaults and uppercases method", () => {
  const n = normalizeRequest({ url: "https://example.com", method: "post" });
  assert.equal(n.method, "POST");
  assert.equal(n.url, "https://example.com");
  assert.deepEqual(n.headers, {});
  assert.equal(n.body, null);
});

test("normalizeRequest rejects invalid input", () => {
  assert.throws(() => normalizeRequest(null));
  assert.throws(() => normalizeRequest({ url: "" }));
  assert.throws(() => normalizeRequest({ url: "ok", method: "GARBAGE" }));
});

test("listLanguages returns supported languages", () => {
  const langs = listLanguages();
  assert.ok(langs.includes("curl"));
  assert.ok(langs.includes("js"));
  assert.ok(langs.includes("python"));
});

test("generateCurl produces a valid command", () => {
  const curl = generateCurl({
    method: "POST",
    url: "https://api.example.com/v1/thing",
    headers: { Authorization: "Bearer abc" },
    body: { foo: "bar" },
  });
  assert.ok(curl.includes("curl -X POST"));
  assert.ok(curl.includes("Authorization: Bearer abc"));
  assert.ok(curl.includes("Content-Type: application/json"));
  assert.ok(curl.includes(`--data-raw '{"foo":"bar"}'`));
});

test("generateCurl does not double-set Content-Type when provided", () => {
  const curl = generateCurl({
    method: "POST",
    url: "https://api.example.com",
    headers: { "Content-Type": "text/plain" },
    body: "hello",
  });
  const matches = curl.match(/Content-Type:/g) || [];
  assert.equal(matches.length, 1);
});

test("generateJs produces a fetch snippet with JSON body", () => {
  const js = generateJs({
    method: "POST",
    url: "https://api.example.com",
    headers: {},
    body: { foo: 1 },
  });
  assert.ok(js.includes("await fetch"));
  assert.ok(js.includes(`"method": "POST"`));
  assert.ok(js.includes(`Content-Type`));
  assert.ok(js.includes(`"body"`));
});

test("generatePython produces requests code with JSON body", () => {
  const py = generatePython({
    method: "POST",
    url: "https://api.example.com",
    headers: { Authorization: "Bearer x" },
    body: { foo: true, bar: null },
  });
  assert.ok(py.includes("import requests"));
  assert.ok(py.includes(`url = "https://api.example.com"`));
  assert.ok(py.includes("payload"));
  assert.ok(py.includes("True"));
  assert.ok(py.includes("None"));
  assert.ok(py.includes("requests.request"));
});

test("generateCode dispatches on language", () => {
  const req = { method: "GET", url: "https://x" };
  assert.ok(generateCode(req, "curl").startsWith("curl"));
  assert.ok(generateCode(req, "js").includes("await fetch"));
  assert.ok(generateCode(req, "python").includes("import requests"));
  assert.throws(() => generateCode(req, "ruby"));
});

test("saveRequest persists and loadRequest retrieves", async () => {
  const saved = await saveRequest({
    name: "get-thing",
    method: "GET",
    url: "https://example.com/thing",
  });
  assert.ok(saved.id);
  const loaded = await loadRequest(saved.id);
  assert.ok(loaded);
  assert.equal(loaded.name, "get-thing");
});

test("loadRequest returns null for unknown id", async () => {
  const res = await loadRequest("does-not-exist");
  assert.equal(res, null);
});

test("listSavedRequests returns ordered by createdAt desc", async () => {
  const a = await saveRequest({ method: "GET", url: "https://a" });
  const b = await saveRequest({ method: "GET", url: "https://b" });
  const all = await listSavedRequests();
  assert.ok(all.length >= 2);
  const idxA = all.findIndex((r) => r.id === a.id);
  const idxB = all.findIndex((r) => r.id === b.id);
  assert.ok(idxB <= idxA);
});

test("deleteRequest removes a saved request", async () => {
  const r = await saveRequest({ method: "GET", url: "https://delete.me" });
  const res = await deleteRequest(r.id);
  assert.equal(res.deleted, 1);
  const loaded = await loadRequest(r.id);
  assert.equal(loaded, null);
});

test("saveRequest rejects invalid input", async () => {
  await assert.rejects(() => saveRequest({ method: "GET" }));
  await assert.rejects(() => saveRequest(null));
});
