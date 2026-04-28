/**
 * Tests for scripts/openapi-diff.mjs.
 *
 * Covers:
 *   1. Identical specs -> no changes
 *   2. Removed endpoint -> reported as breaking
 *   3. Added endpoint -> reported as added
 *   4. Required param added -> reported as breaking
 *   5. Optional param added -> reported as added (not breaking)
 *   6. Exit code 1 on breaking, 0 on additive-only (CLI integration)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { diff, formatMarkdown } from "../scripts/openapi-diff.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/openapi-diff.mjs", import.meta.url));

function specWithPath(path, op = { responses: { 200: { description: "ok" } } }) {
  return {
    openapi: "3.0.3",
    info: { title: "T", version: "1.0.0" },
    paths: { [path]: { get: op } },
  };
}

test("identical specs produce no changes", () => {
  const spec = specWithPath("/foo");
  const r = diff(spec, spec);
  assert.equal(r.breaking.length, 0);
  assert.equal(r.added.length, 0);
});

test("removed endpoint is reported as breaking", () => {
  const oldSpec = specWithPath("/foo");
  const newSpec = { openapi: "3.0.3", info: { version: "1.0.0" }, paths: {} };
  const r = diff(oldSpec, newSpec);
  assert.equal(r.breaking.length, 1);
  assert.equal(r.breaking[0].kind, "endpoint_removed");
  assert.equal(r.breaking[0].path, "/foo");
});

test("removed method on existing path is reported as breaking", () => {
  const oldSpec = {
    paths: { "/foo": { get: { responses: {} }, post: { responses: {} } } },
  };
  const newSpec = {
    paths: { "/foo": { get: { responses: {} } } },
  };
  const r = diff(oldSpec, newSpec);
  assert.ok(r.breaking.some((b) => b.kind === "method_removed" && b.method === "post"));
});

test("added endpoint is reported as added", () => {
  const oldSpec = { paths: {} };
  const newSpec = specWithPath("/bar");
  const r = diff(oldSpec, newSpec);
  assert.equal(r.breaking.length, 0);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].kind, "endpoint_added");
  assert.equal(r.added[0].path, "/bar");
});

test("required param added is reported as breaking", () => {
  const oldSpec = specWithPath("/foo", { responses: {} });
  const newSpec = specWithPath("/foo", {
    parameters: [{ name: "id", in: "query", required: true }],
    responses: {},
  });
  const r = diff(oldSpec, newSpec);
  assert.ok(
    r.breaking.some((b) => b.kind === "required_param_added" && b.param === "id"),
    "expected required_param_added in breaking changes"
  );
});

test("optional param added is reported as added, not breaking", () => {
  const oldSpec = specWithPath("/foo", { responses: {} });
  const newSpec = specWithPath("/foo", {
    parameters: [{ name: "limit", in: "query", required: false }],
    responses: {},
  });
  const r = diff(oldSpec, newSpec);
  assert.equal(r.breaking.length, 0);
  assert.ok(
    r.added.some((a) => a.kind === "optional_param_added" && a.param === "limit"),
    "expected optional_param_added in added changes"
  );
});

test("removed required param is reported as breaking", () => {
  const oldSpec = specWithPath("/foo", {
    parameters: [{ name: "id", in: "query", required: true }],
    responses: {},
  });
  const newSpec = specWithPath("/foo", { responses: {} });
  const r = diff(oldSpec, newSpec);
  assert.ok(r.breaking.some((b) => b.kind === "required_param_removed" && b.param === "id"));
});

test("removed response code is reported as breaking", () => {
  const oldSpec = specWithPath("/foo", { responses: { 200: {}, 404: {} } });
  const newSpec = specWithPath("/foo", { responses: { 200: {} } });
  const r = diff(oldSpec, newSpec);
  assert.ok(r.breaking.some((b) => b.kind === "response_removed" && b.code === "404"));
});

test("formatMarkdown renders breaking + added sections", () => {
  const r = {
    breaking: [{ kind: "endpoint_removed", path: "/old" }],
    added: [{ kind: "endpoint_added", path: "/new" }],
    changed: [],
  };
  const md = formatMarkdown(r, "1.0.0", "1.1.0");
  assert.match(md, /API Changelog: 1\.0\.0 -> 1\.1\.0/);
  assert.match(md, /Breaking changes \(1\)/);
  assert.match(md, /Added \(1\)/);
  assert.match(md, /\/old/);
  assert.match(md, /\/new/);
});

test("formatMarkdown reports no breaking changes when list is empty", () => {
  const md = formatMarkdown({ breaking: [], added: [], changed: [] }, "1.0", "1.0");
  assert.match(md, /No breaking changes/);
});

test("CLI: exit code 0 on identical specs", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-diff-"));
  try {
    const spec = JSON.stringify(specWithPath("/foo"));
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, spec);
    writeFileSync(b, spec);
    const res = spawnSync(process.execPath, [SCRIPT, a, b], { encoding: "utf8" });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: exit code 1 on breaking changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-diff-"));
  try {
    const oldSpec = JSON.stringify(specWithPath("/foo"));
    const newSpec = JSON.stringify({ openapi: "3.0.3", info: { version: "1.0.0" }, paths: {} });
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, oldSpec);
    writeFileSync(b, newSpec);
    const res = spawnSync(process.execPath, [SCRIPT, a, b], { encoding: "utf8" });
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}; stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: exit code 0 on additive-only changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-diff-"));
  try {
    const oldSpec = JSON.stringify(specWithPath("/foo"));
    const newSpec = JSON.stringify({
      openapi: "3.0.3",
      info: { version: "1.0.0" },
      paths: {
        "/foo": { get: { responses: { 200: { description: "ok" } } } },
        "/bar": { get: { responses: { 200: { description: "ok" } } } },
      },
    });
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, oldSpec);
    writeFileSync(b, newSpec);
    const res = spawnSync(process.execPath, [SCRIPT, a, b], { encoding: "utf8" });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --output flag writes changelog to file", () => {
  const dir = mkdtempSync(join(tmpdir(), "openapi-diff-"));
  try {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    const out = join(dir, "changelog.md");
    writeFileSync(a, JSON.stringify(specWithPath("/foo")));
    writeFileSync(
      b,
      JSON.stringify({
        openapi: "3.0.3",
        info: { version: "1.1.0" },
        paths: {
          "/foo": { get: { responses: { 200: { description: "ok" } } } },
          "/baz": { get: { responses: { 200: { description: "ok" } } } },
        },
      })
    );
    const res = spawnSync(process.execPath, [SCRIPT, a, b, `--output=${out}`], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    const md = readFileSync(out, "utf8");
    assert.match(md, /\/baz/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
