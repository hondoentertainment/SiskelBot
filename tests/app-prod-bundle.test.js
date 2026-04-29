/**
 * Tests for the production-ready /app handler in server.js.
 *
 * The /app handler swaps the dev-only `<script type="module" src="/src/app.js">`
 * tag in client/app.html for the hashed production bundle recorded in
 * client/dist/manifest.json. This test does not import server.js directly
 * (doing so would boot the entire app — OAuth, storage, schedulers, OTEL,
 * and listen sockets). Instead it asserts the substitution contract by
 * mounting a minimal Express app whose /app handler performs the same
 * lookup and substitution as server.js, using a temp workspace that stands
 * in for client/ and client/dist/.
 *
 * Scenarios:
 *   1. With manifest mapping `app` -> `/dist/app-<hash>.js`, GET /app
 *      returns HTML containing the hashed bundle (not `/src/app.js`).
 *   2. Without a manifest, GET /app returns HTML with `/src/app.js` intact.
 *   3. /app always responds with Cache-Control: no-store.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";

// Mirror of the substitution regex used by server.js's renderAppHtml. Keeping
// it in sync with server.js is a one-line change.
const APP_SRC_SCRIPT_RE =
  /<script\s+type="module"\s+src="\/src\/app\.js"\s*>\s*<\/script>/;

function substituteAppEntry(html, entryPath) {
  return html.replace(
    APP_SRC_SCRIPT_RE,
    `<script type="module" src="${entryPath}"></script>`,
  );
}

function renderAppHtml({ htmlPath, manifestPath }) {
  if (!existsSync(htmlPath)) return null;
  const html = readFileSync(htmlPath, "utf8");
  if (!existsSync(manifestPath)) return html;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return html;
  }
  const entry = manifest && manifest.entries && manifest.entries.app;
  if (!entry || typeof entry !== "string") return html;
  return substituteAppEntry(html, entry);
}

const DEV_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="/src/shell/layout.css">
  <title>SiskelBot Console</title>
</head>
<body>
  <div id="sb-root"></div>
  <script type="module" src="/src/app.js"></script>
</body>
</html>
`;

function makeTempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "app-prod-bundle-"));
  const htmlPath = join(root, "app.html");
  const manifestPath = join(root, "dist", "manifest.json");
  writeFileSync(htmlPath, DEV_HTML);
  mkdirSync(dirname(manifestPath), { recursive: true });
  return { root, htmlPath, manifestPath };
}

function writeManifest(manifestPath, entries) {
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: "production",
    bundler: "esbuild",
    entries,
  };
  writeFileSync(manifestPath, JSON.stringify(payload, null, 2) + "\n");
}

function mountAppHandler({ htmlPath, manifestPath }) {
  const app = express();
  app.get("/app", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const html = renderAppHtml({ htmlPath, manifestPath });
    if (html == null) {
      res.status(500).send("app.html missing");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });
  return app;
}

test("substituteAppEntry swaps the /src/app.js script tag", () => {
  const out = substituteAppEntry(DEV_HTML, "/dist/app-ABC123.js");
  assert.ok(
    out.includes('<script type="module" src="/dist/app-ABC123.js"></script>'),
    "expected hashed bundle path in the substituted HTML",
  );
  assert.ok(
    !out.includes('src="/src/app.js"'),
    "expected /src/app.js to be replaced",
  );
});

test("server.js exports the substitution helpers and uses the same regex", () => {
  // Light sanity check that server.js's helper logic matches ours. We do not
  // import server.js here (booting it requires real storage/auth wiring).
  // Instead we re-read the source file and assert the expected tokens are
  // present so future refactors cannot silently drift away from the tested
  // regex shape.
  const serverSrc = readFileSync(
    fileURLToPath(new URL("../server.js", import.meta.url)),
    "utf8",
  );
  assert.ok(
    serverSrc.includes("export function renderAppHtml"),
    "expected server.js to export renderAppHtml",
  );
  assert.ok(
    serverSrc.includes("export function substituteAppEntry"),
    "expected server.js to export substituteAppEntry",
  );
  // Exact regex literal used for substitution.
  assert.ok(
    serverSrc.includes(
      '/<script\\s+type="module"\\s+src="\\/src\\/app\\.js"\\s*>\\s*<\\/script>/',
    ),
    "expected server.js to use the canonical /src/app.js substitution regex",
  );
});

test("GET /app serves the hashed production bundle when manifest exists", async () => {
  const { root, htmlPath, manifestPath } = makeTempWorkspace();
  try {
    writeManifest(manifestPath, { app: "/dist/app-DEADBEEF.js" });
    const app = mountAppHandler({ htmlPath, manifestPath });
    const res = await request(app).get("/app");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.match(res.headers["content-type"] || "", /text\/html/);
    assert.ok(
      res.text.includes('src="/dist/app-DEADBEEF.js"'),
      `expected hashed bundle path, got: ${res.text}`,
    );
    assert.ok(
      !res.text.includes('src="/src/app.js"'),
      "expected dev /src/app.js path to be rewritten",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /app falls back to /src/app.js when no manifest exists", async () => {
  const { root, htmlPath, manifestPath } = makeTempWorkspace();
  try {
    // Intentionally do NOT write a manifest.
    const app = mountAppHandler({ htmlPath, manifestPath });
    const res = await request(app).get("/app");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.ok(
      res.text.includes('src="/src/app.js"'),
      `expected /src/app.js in dev fallback, got: ${res.text}`,
    );
    assert.ok(
      !/\/dist\/app-[A-Za-z0-9]+\.js/.test(res.text),
      "expected no hashed bundle path in dev fallback",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /app always emits Cache-Control: no-store", async () => {
  const { root, htmlPath, manifestPath } = makeTempWorkspace();
  try {
    writeManifest(manifestPath, { app: "/dist/app-CAFEBABE.js" });
    const app = mountAppHandler({ htmlPath, manifestPath });
    const res = await request(app).get("/app");
    assert.equal(res.headers["cache-control"], "no-store");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderAppHtml returns null when the HTML file is missing", () => {
  const missing = join(
    tmpdir(),
    "definitely-does-not-exist-" + Date.now(),
    "app.html",
  );
  const result = renderAppHtml({
    htmlPath: missing,
    manifestPath: missing + ".manifest.json",
  });
  assert.equal(result, null);
});
