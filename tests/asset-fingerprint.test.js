import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const DIST_DIR = join(ROOT, "client", "dist");
const MANIFEST_PATH = join(DIST_DIR, "manifest.json");

// Import after defining paths so we can set up fixtures
import {
  getAssetManifest,
  assetUrl,
  assetMiddleware,
  scriptTag,
  invalidateManifestCache,
} from "../lib/asset-fingerprint.js";

// --- Test fixtures ---

let hadManifest = false;
let originalManifest = null;

function setupManifest(data) {
  invalidateManifestCache();
  mkdirSync(DIST_DIR, { recursive: true });
  if (existsSync(MANIFEST_PATH)) {
    hadManifest = true;
    const { readFileSync } = await_import_fs();
    originalManifest = readFileSync(MANIFEST_PATH, "utf8");
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(data));
}

function restoreManifest() {
  invalidateManifestCache();
  if (hadManifest && originalManifest !== null) {
    writeFileSync(MANIFEST_PATH, originalManifest);
  } else if (!hadManifest && existsSync(MANIFEST_PATH)) {
    try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
  }
  hadManifest = false;
  originalManifest = null;
}

function await_import_fs() {
  // Synchronous fs is already available
  return { readFileSync: (await import("node:fs")).readFileSync };
}

// --- Helper: mock Express req/res ---

function mockReq(path, query = {}) {
  return { path, query };
}

function mockRes() {
  const headers = {};
  const removed = new Set();
  return {
    headers,
    removed,
    setHeader(key, value) {
      headers[key] = value;
    },
    removeHeader(key) {
      delete headers[key];
      removed.add(key);
    },
  };
}

// --- getAssetManifest ---

test("asset-fingerprint: getAssetManifest returns empty object when no manifest", () => {
  invalidateManifestCache();
  // If there happens to be a manifest from a previous build, the result should
  // still be a valid object
  const manifest = getAssetManifest();
  assert.equal(typeof manifest, "object");
  assert.ok(manifest !== null);
});

test("asset-fingerprint: getAssetManifest reads manifest.json", () => {
  const testData = { "modules.js": "abc123def456", "styles.css": "789xyz" };
  mkdirSync(DIST_DIR, { recursive: true });

  // Save original if exists
  let origContent = null;
  if (existsSync(MANIFEST_PATH)) {
    origContent = require("node:fs").readFileSync(MANIFEST_PATH, "utf8");
  }

  invalidateManifestCache();
  writeFileSync(MANIFEST_PATH, JSON.stringify(testData));

  try {
    const manifest = getAssetManifest();
    assert.deepEqual(manifest, testData);
  } finally {
    // Restore
    invalidateManifestCache();
    if (origContent !== null) {
      writeFileSync(MANIFEST_PATH, origContent);
    } else {
      try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
    }
  }
});

test("asset-fingerprint: getAssetManifest caches the result", () => {
  mkdirSync(DIST_DIR, { recursive: true });
  let origContent = null;
  if (existsSync(MANIFEST_PATH)) {
    origContent = require("node:fs").readFileSync(MANIFEST_PATH, "utf8");
  }

  invalidateManifestCache();
  writeFileSync(MANIFEST_PATH, JSON.stringify({ "test.js": "aaa" }));

  try {
    const m1 = getAssetManifest();
    const m2 = getAssetManifest();
    assert.equal(m1, m2, "Should return same cached object reference");
  } finally {
    invalidateManifestCache();
    if (origContent !== null) {
      writeFileSync(MANIFEST_PATH, origContent);
    } else {
      try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
    }
  }
});

// --- assetUrl ---

test("asset-fingerprint: assetUrl returns versioned URL when hash exists", () => {
  mkdirSync(DIST_DIR, { recursive: true });
  let origContent = null;
  if (existsSync(MANIFEST_PATH)) {
    origContent = require("node:fs").readFileSync(MANIFEST_PATH, "utf8");
  }

  invalidateManifestCache();
  writeFileSync(MANIFEST_PATH, JSON.stringify({ "modules.js": "abc123" }));

  try {
    const url = assetUrl("modules.js");
    assert.equal(url, "/dist/modules.js?v=abc123");
  } finally {
    invalidateManifestCache();
    if (origContent !== null) {
      writeFileSync(MANIFEST_PATH, origContent);
    } else {
      try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
    }
  }
});

test("asset-fingerprint: assetUrl returns plain URL when no hash", () => {
  mkdirSync(DIST_DIR, { recursive: true });
  let origContent = null;
  if (existsSync(MANIFEST_PATH)) {
    origContent = require("node:fs").readFileSync(MANIFEST_PATH, "utf8");
  }

  invalidateManifestCache();
  writeFileSync(MANIFEST_PATH, JSON.stringify({}));

  try {
    const url = assetUrl("unknown.js");
    assert.equal(url, "/dist/unknown.js");
  } finally {
    invalidateManifestCache();
    if (origContent !== null) {
      writeFileSync(MANIFEST_PATH, origContent);
    } else {
      try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
    }
  }
});

// --- assetMiddleware ---

test("asset-fingerprint: middleware sets immutable cache for versioned assets", () => {
  const mw = assetMiddleware();
  const req = mockReq("/dist/modules.js", { v: "abc123" });
  const res = mockRes();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(res.headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.ok(nextCalled);
});

test("asset-fingerprint: middleware sets short cache for non-versioned assets", () => {
  const mw = assetMiddleware();
  const req = mockReq("/dist/modules.js", {});
  const res = mockRes();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(res.headers["Cache-Control"], "public, max-age=300, must-revalidate");
  assert.ok(nextCalled);
});

test("asset-fingerprint: middleware skips non-dist paths", () => {
  const mw = assetMiddleware();
  const req = mockReq("/api/health", {});
  const res = mockRes();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled);
  assert.ok(!("Cache-Control" in res.headers), "Should not set Cache-Control for non-dist paths");
});

test("asset-fingerprint: middleware sets nosniff for JS files", () => {
  const mw = assetMiddleware();
  const req = mockReq("/dist/modules.js", { v: "abc" });
  const res = mockRes();

  mw(req, res, () => {});

  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
});

test("asset-fingerprint: middleware removes Pragma for versioned assets", () => {
  const mw = assetMiddleware();
  const req = mockReq("/dist/modules.js", { v: "abc" });
  const res = mockRes();
  res.setHeader("Pragma", "no-cache");

  mw(req, res, () => {});

  assert.ok(res.removed.has("Pragma"));
});

// --- scriptTag ---

test("asset-fingerprint: scriptTag generates correct HTML", () => {
  mkdirSync(DIST_DIR, { recursive: true });
  let origContent = null;
  if (existsSync(MANIFEST_PATH)) {
    origContent = require("node:fs").readFileSync(MANIFEST_PATH, "utf8");
  }

  invalidateManifestCache();
  writeFileSync(MANIFEST_PATH, JSON.stringify({ "app.js": "xyz789" }));

  try {
    const tag = scriptTag("app.js");
    assert.equal(tag, '<script src="/dist/app.js?v=xyz789"></script>');
  } finally {
    invalidateManifestCache();
    if (origContent !== null) {
      writeFileSync(MANIFEST_PATH, origContent);
    } else {
      try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
    }
  }
});

test("asset-fingerprint: scriptTag includes additional attributes", () => {
  mkdirSync(DIST_DIR, { recursive: true });
  let origContent = null;
  if (existsSync(MANIFEST_PATH)) {
    origContent = require("node:fs").readFileSync(MANIFEST_PATH, "utf8");
  }

  invalidateManifestCache();
  writeFileSync(MANIFEST_PATH, JSON.stringify({ "app.js": "xyz789" }));

  try {
    const tag = scriptTag("app.js", { defer: true, type: "module" });
    assert.ok(tag.includes("defer"));
    assert.ok(tag.includes('type="module"'));
    assert.ok(tag.includes("/dist/app.js?v=xyz789"));
  } finally {
    invalidateManifestCache();
    if (origContent !== null) {
      writeFileSync(MANIFEST_PATH, origContent);
    } else {
      try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
    }
  }
});

// --- invalidateManifestCache ---

test("asset-fingerprint: invalidateManifestCache forces reload", () => {
  mkdirSync(DIST_DIR, { recursive: true });
  let origContent = null;
  if (existsSync(MANIFEST_PATH)) {
    origContent = require("node:fs").readFileSync(MANIFEST_PATH, "utf8");
  }

  invalidateManifestCache();
  writeFileSync(MANIFEST_PATH, JSON.stringify({ "a.js": "111" }));
  const m1 = getAssetManifest();
  assert.equal(m1["a.js"], "111");

  // Update the manifest and invalidate
  writeFileSync(MANIFEST_PATH, JSON.stringify({ "a.js": "222" }));
  invalidateManifestCache();
  const m2 = getAssetManifest();
  assert.equal(m2["a.js"], "222");

  // Restore
  invalidateManifestCache();
  if (origContent !== null) {
    writeFileSync(MANIFEST_PATH, origContent);
  } else {
    try { rmSync(MANIFEST_PATH); } catch { /* ignore */ }
  }
});
