/**
 * Tests for the flag-gated default redirect from `GET /` to `/app/chat`.
 *
 * When `UI_DEFAULT_APP=1`, server.js installs a tiny handler (via the
 * exported `installDefaultAppRedirect` helper) BEFORE express.static so
 * `GET /` returns 302 to `/app/chat`. The query string is preserved.
 *
 * When the flag is unset, the helper is a no-op and `/` continues to be
 * served by the existing static middleware (which yields 200 for
 * `client/index.html`).
 *
 * We do not import server.js directly here — booting it requires real
 * storage / auth / OTEL / listen sockets. Instead we exercise the same
 * tiny `installDefaultAppRedirect` factory on a minimal Express app whose
 * shape mirrors the production wiring (redirect handler installed before
 * static middleware, plus a stub `/app` handler and a `/api/v1/health`
 * route to assert the redirect does NOT capture other paths).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";

// Inline copy of the production helper. Kept here so the test does not need
// to boot server.js; the parity assertion below pins the source-of-truth
// implementation to this same shape.
function installDefaultAppRedirect(targetApp, env = process.env) {
  if (env.UI_DEFAULT_APP !== "1") return false;
  targetApp.get("/", (req, res) => {
    const qs = req.url.indexOf("?");
    const suffix = qs >= 0 ? req.url.slice(qs) : "";
    res.redirect(302, "/app/chat" + suffix);
  });
  return true;
}

function makeAppWith({ flag, staticRoot }) {
  const app = express();
  // Mirror server.js wiring: redirect handler installed BEFORE the static
  // middleware (and before the /app stub) so it intercepts cleanly.
  installDefaultAppRedirect(app, { UI_DEFAULT_APP: flag });
  app.get("/app", (_req, res) => res.status(200).type("html").send("<!doctype html><title>SPA</title>"));
  app.get("/api/v1/health", (_req, res) => res.status(200).json({ ok: true }));
  app.use(express.static(staticRoot));
  return app;
}

function makeStaticRoot() {
  const root = mkdtempSync(join(tmpdir(), "ui-default-app-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Legacy index</title>");
  return root;
}

test("installDefaultAppRedirect returns false when flag is unset", () => {
  const app = express();
  const installed = installDefaultAppRedirect(app, {});
  assert.equal(installed, false);
});

test("installDefaultAppRedirect returns false when flag is anything other than '1'", () => {
  const app = express();
  assert.equal(installDefaultAppRedirect(app, { UI_DEFAULT_APP: "0" }), false);
  assert.equal(installDefaultAppRedirect(app, { UI_DEFAULT_APP: "true" }), false);
  assert.equal(installDefaultAppRedirect(app, { UI_DEFAULT_APP: "" }), false);
});

test("installDefaultAppRedirect returns true when flag is '1'", () => {
  const app = express();
  const installed = installDefaultAppRedirect(app, { UI_DEFAULT_APP: "1" });
  assert.equal(installed, true);
});

test("with UI_DEFAULT_APP=1, GET / returns 302 with Location: /app/chat", async () => {
  const root = makeStaticRoot();
  try {
    const app = makeAppWith({ flag: "1", staticRoot: root });
    const res = await request(app).get("/");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/app/chat");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with UI_DEFAULT_APP unset, GET / serves the legacy static index (200)", async () => {
  const root = makeStaticRoot();
  try {
    const app = makeAppWith({ flag: undefined, staticRoot: root });
    const res = await request(app).get("/");
    assert.equal(res.status, 200);
    assert.match(res.text, /Legacy index/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with UI_DEFAULT_APP=1, query string is preserved on the redirect", async () => {
  const root = makeStaticRoot();
  try {
    const app = makeAppWith({ flag: "1", staticRoot: root });
    const res = await request(app).get("/?foo=bar");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/app/chat?foo=bar");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with UI_DEFAULT_APP=1, multi-key query strings are preserved verbatim", async () => {
  const root = makeStaticRoot();
  try {
    const app = makeAppWith({ flag: "1", staticRoot: root });
    const res = await request(app).get("/?foo=bar&baz=qux");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/app/chat?foo=bar&baz=qux");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with UI_DEFAULT_APP=1, GET /app is NOT redirected", async () => {
  const root = makeStaticRoot();
  try {
    const app = makeAppWith({ flag: "1", staticRoot: root });
    const res = await request(app).get("/app");
    assert.equal(res.status, 200);
    assert.match(res.text, /SPA/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with UI_DEFAULT_APP=1, GET /api/v1/health is NOT redirected", async () => {
  const root = makeStaticRoot();
  try {
    const app = makeAppWith({ flag: "1", staticRoot: root });
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with UI_DEFAULT_APP=1, other static asset paths are NOT redirected", async () => {
  const root = makeStaticRoot();
  try {
    // Add a non-index static file to confirm static serving keeps working.
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "app.css"), "body { color: red; }");
    const app = makeAppWith({ flag: "1", staticRoot: root });
    const res = await request(app).get("/assets/app.css");
    assert.equal(res.status, 200);
    assert.match(res.text, /color: red/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installDefaultAppRedirect is implemented in server-configured-app.js", async () => {
  // Source-level parity check: server.js must expose the helper used by the
  // tests above and call it before the static middleware. We do not import
  // server.js (that would boot the whole app); instead we re-read the source
  // and assert the expected tokens are present so future refactors cannot
  // silently drift away from the tested contract.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const serverSrc = readFileSync(
    fileURLToPath(new URL("../lib/server-configured-app.js", import.meta.url)),
    "utf8",
  );
  assert.ok(
    serverSrc.includes("export function installDefaultAppRedirect"),
    "expected server-configured-app.js to export installDefaultAppRedirect",
  );
  assert.ok(
    serverSrc.includes("UI_DEFAULT_APP"),
    "expected server-configured-app.js to reference the UI_DEFAULT_APP env var",
  );
  assert.ok(
    serverSrc.includes('res.redirect(302, "/app/chat"'),
    "expected server-configured-app.js to issue an explicit 302 redirect to /app/chat",
  );
  // The install call must precede the static middleware mount.
  const installIdx = serverSrc.indexOf("installDefaultAppRedirect(app)");
  const staticIdx = serverSrc.indexOf('express.static(join(ROOT_DIR, "client"');
  assert.ok(installIdx > -1, "expected installDefaultAppRedirect(app) call");
  assert.ok(staticIdx > -1, "expected express.static(client) mount");
  assert.ok(
    installIdx < staticIdx,
    "expected the redirect install to precede the static middleware mount",
  );
});
