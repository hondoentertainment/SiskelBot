/**
 * Tests for the pure pieces of the SPA shell router:
 * compileRoute, matchRoute, and resolve.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { compileRoute, matchRoute, resolve } from "../client/src/router.js";

function buildTable(entries) {
  return entries.map(([pattern, loader]) => ({
    pattern,
    compiled: compileRoute(pattern),
    loader: loader || (() => {})
  }));
}

test("compileRoute extracts param keys from pattern", () => {
  const c = compileRoute("/runs/:id");
  assert.deepEqual(c.keys, ["id"]);
  assert.equal(c.pattern, "/runs/:id");
});

test("compileRoute handles nested params", () => {
  const c = compileRoute("/workspaces/:wid/runs/:rid");
  assert.deepEqual(c.keys, ["wid", "rid"]);
});

test("matchRoute returns params on match, null on miss", () => {
  const c = compileRoute("/runs/:id");
  assert.deepEqual(matchRoute(c, "/runs/abc"), { id: "abc" });
  assert.deepEqual(matchRoute(c, "/runs/abc/"), { id: "abc" }); // trailing slash tolerated
  assert.equal(matchRoute(c, "/runs"), null);
  assert.equal(matchRoute(c, "/other/abc"), null);
});

test("matchRoute decodes URI-encoded params", () => {
  const c = compileRoute("/docs/:slug");
  assert.deepEqual(matchRoute(c, "/docs/hello%20world"), { slug: "hello world" });
});

test("resolve returns match for a registered static route", () => {
  const table = buildTable([
    ["/home", () => "home"],
    ["/chat", () => "chat"]
  ]);
  const r = resolve(table, "/home");
  assert.equal(r.status, "match");
  assert.equal(r.pattern, "/home");
  assert.deepEqual(r.params, {});
  assert.equal(typeof r.loader, "function");
});

test("resolve returns match with params for a :param route", () => {
  const table = buildTable([
    ["/runs/:id", () => "run"]
  ]);
  const r = resolve(table, "/runs/42");
  assert.equal(r.status, "match");
  assert.equal(r.pattern, "/runs/:id");
  assert.deepEqual(r.params, { id: "42" });
});

test("resolve returns notfound for unknown routes", () => {
  const table = buildTable([
    ["/home", () => {}]
  ]);
  const r = resolve(table, "/nope");
  assert.equal(r.status, "notfound");
  assert.equal(r.pattern, null);
  assert.equal(r.loader, null);
});

test("resolve strips query string and hash before matching", () => {
  const table = buildTable([
    ["/knowledge", () => {}]
  ]);
  assert.equal(resolve(table, "/knowledge?q=hi").status, "match");
  assert.equal(resolve(table, "/knowledge#top").status, "match");
});

test("resolve prefers the first matching route (registration order)", () => {
  const table = buildTable([
    ["/runs/new", () => "new"],
    ["/runs/:id", () => "detail"]
  ]);
  const r = resolve(table, "/runs/new");
  assert.equal(r.pattern, "/runs/new");
  assert.deepEqual(r.params, {});
});

test("resolve handles root path", () => {
  const table = buildTable([
    ["/", () => "root"]
  ]);
  const r = resolve(table, "/");
  assert.equal(r.status, "match");
  assert.equal(r.pattern, "/");
});

test("resolve treats empty/undefined path as root", () => {
  const table = buildTable([
    ["/", () => "root"]
  ]);
  assert.equal(resolve(table, "").status, "match");
  assert.equal(resolve(table, undefined).status, "match");
});
